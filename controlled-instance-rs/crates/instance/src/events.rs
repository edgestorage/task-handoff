use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use controlled_instance_protocol::{
    ai_session_transient_subscription_accepts, AiSessionTransientSubscription, EventEnvelope,
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
};
use tokio::sync::{broadcast, mpsc};

const MAX_TRANSIENT_REPLAY_BYTES: usize = 32 * 1024 * 1024;
const MAX_TRANSIENT_REPLAY_EVENTS: usize = 20_000;
const TRANSIENT_REPLAY_LOOKBACK_MINUTES: i64 = 5;
const TRANSIENT_EVENT_TYPES: [&str; 3] = [
    "ai-session.message-delta",
    "ai-session.timeline-item",
    "ai-session.timeline-item-delta",
];

#[derive(Debug)]
struct RetainedTransientEvent {
    event: EventEnvelope<Value>,
    bytes: usize,
}

#[derive(Debug, Default)]
struct ReplayState {
    events: Vec<RetainedTransientEvent>,
    bytes: usize,
}

#[derive(Debug)]
struct TransientEventIdentity {
    session_id: String,
    item_id: Option<String>,
    turn_id: Option<String>,
    settled_timeline_item: bool,
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<EventEnvelope<Value>>,
    clients: Arc<RwLock<HashMap<u64, mpsc::UnboundedSender<EventEnvelope<Value>>>>>,
    next_client: Arc<AtomicU64>,
    sequence: Arc<AtomicU64>,
    replay: Arc<RwLock<ReplayState>>,
}

pub struct EventClientSubscription {
    id: u64,
    clients: Arc<RwLock<HashMap<u64, mpsc::UnboundedSender<EventEnvelope<Value>>>>>,
    receiver: mpsc::UnboundedReceiver<EventEnvelope<Value>>,
}

impl EventClientSubscription {
    pub async fn recv(&mut self) -> Option<EventEnvelope<Value>> {
        self.receiver.recv().await
    }
}

impl Drop for EventClientSubscription {
    fn drop(&mut self) {
        self.clients
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.id);
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(2048)
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender,
            clients: Arc::new(RwLock::new(HashMap::new())),
            next_client: Arc::new(AtomicU64::new(0)),
            sequence: Arc::new(AtomicU64::new(0)),
            replay: Arc::new(RwLock::new(ReplayState::default())),
        }
    }

    pub fn new_event(&self, event_type: impl Into<String>, payload: Value) -> EventEnvelope<Value> {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        EventEnvelope::new(sequence, event_type, payload)
    }

    pub fn publish(&self, event_type: impl Into<String>, payload: Value) -> EventEnvelope<Value> {
        let event = self.new_event(event_type, payload);
        self.prune_settled_transient_replay(&event);
        self.retain_transient(&event);
        let _ = self.sender.send(event.clone());
        self.clients
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|_, sender| sender.send(event.clone()).is_ok());
        event
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope<Value>> {
        self.sender.subscribe()
    }

    pub fn subscribe_client(&self) -> EventClientSubscription {
        let id = self.next_client.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::unbounded_channel();
        self.clients
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, sender);
        EventClientSubscription {
            id,
            clients: self.clients.clone(),
            receiver,
        }
    }

    pub fn latest_revision(&self) -> u64 {
        self.sequence.load(Ordering::SeqCst)
    }

    pub fn retained_event_count(&self) -> usize {
        self.replay
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .events
            .len()
    }

    pub fn replay_since(
        &self,
        replay_since: &str,
        topics: &HashSet<String>,
        subscription: Option<&AiSessionTransientSubscription>,
    ) -> Vec<EventEnvelope<Value>> {
        let requested_at = chrono::DateTime::parse_from_rfc3339(replay_since)
            .ok()
            .map(|value| value.timestamp_millis())
            .unwrap_or_default();
        let lookback = Utc::now() - ChronoDuration::minutes(TRANSIENT_REPLAY_LOOKBACK_MINUTES);
        let cutoff = requested_at.max(lookback.timestamp_millis());
        let cutoff = chrono::DateTime::<Utc>::from_timestamp_millis(cutoff)
            .unwrap_or(lookback)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        self.replay
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .events
            .iter()
            .filter(|retained| {
                retained.event.r#type == "ai-session.message-delta"
                    || retained.event.created_at >= cutoff
            })
            .filter(|retained| subscribed(topics, &retained.event.topic, &retained.event.r#type))
            .filter(|retained| {
                ai_session_transient_subscription_accepts(subscription, &retained.event)
            })
            .map(|retained| retained.event.clone())
            .collect()
    }

    fn retain_transient(&self, event: &EventEnvelope<Value>) {
        if !is_transient(event) {
            return;
        }
        let identity = transient_identity(event);
        let item_key = identity.as_ref().and_then(item_key);
        if identity
            .as_ref()
            .is_some_and(|identity| identity.settled_timeline_item)
        {
            self.drop_item(item_key.as_deref());
            return;
        }
        let bytes = serde_json::to_vec(event)
            .map(|value| value.len())
            .unwrap_or(0);
        let mut replay = self
            .replay
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        replay.events.push(RetainedTransientEvent {
            event: event.clone(),
            bytes,
        });
        replay.bytes = replay.bytes.saturating_add(bytes);
        if event.r#type == "ai-session.timeline-item" {
            if let Some(item_key) = item_key {
                drop_superseded_item_snapshots(&mut replay, &item_key);
            }
        }
        while replay.events.len() > MAX_TRANSIENT_REPLAY_EVENTS
            || replay.bytes > MAX_TRANSIENT_REPLAY_BYTES
        {
            if replay.events.is_empty() {
                break;
            }
            let removed = replay.events.remove(0);
            replay.bytes = replay.bytes.saturating_sub(removed.bytes);
        }
    }

    fn drop_item(&self, item_key: Option<&str>) {
        let Some(item_key) = item_key else {
            return;
        };
        let mut replay = self
            .replay
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        replay
            .events
            .retain(|retained| item_key_for_event(&retained.event).as_deref() != Some(item_key));
        replay.bytes = replay.events.iter().map(|retained| retained.bytes).sum();
    }

    fn prune_settled_transient_replay(&self, event: &EventEnvelope<Value>) {
        if !matches!(
            event.r#type.as_str(),
            "ai-session.snapshot" | "ai-session.patch" | "ai-session.removed"
        ) {
            return;
        }
        let mut removed_sessions = HashSet::new();
        let mut settled_turns = HashSet::new();
        let mut settled_items = HashSet::new();
        if event.r#type == "ai-session.removed" {
            if let Some(session_ids) = event.payload.get("sessionIds").and_then(Value::as_array) {
                removed_sessions.extend(
                    session_ids
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string),
                );
            }
        }
        let sessions = event
            .payload
            .get("snapshot")
            .and_then(|snapshot| snapshot.get("sessions"))
            .or_else(|| event.payload.get("upserted"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for session in sessions {
            let Some(session_id) = session.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(item_id) = session.get("lastMessageItemId").and_then(Value::as_str) {
                settled_items.insert(format!("{session_id}\0{item_id}"));
            }
            let turns = session
                .get("turns")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for turn in &turns {
                if !matches!(
                    turn.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                ) {
                    continue;
                }
                if let Some(turn_id) = turn.get("id").and_then(Value::as_str) {
                    settled_turns.insert(format!("{session_id}\0{turn_id}"));
                }
                if let Some(turn_id) = turn.get("providerTurnId").and_then(Value::as_str) {
                    settled_turns.insert(format!("{session_id}\0{turn_id}"));
                }
            }
            if turns.is_empty()
                && !matches!(
                    session.get("status").and_then(Value::as_str),
                    Some("running" | "waiting")
                )
            {
                removed_sessions.insert(session_id.to_string());
            }
        }
        if removed_sessions.is_empty() && settled_turns.is_empty() && settled_items.is_empty() {
            return;
        }
        let mut replay = self
            .replay
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        replay.events.retain(|retained| {
            let Some(identity) = transient_identity(&retained.event) else {
                return true;
            };
            if identity.settled_timeline_item || removed_sessions.contains(&identity.session_id) {
                return false;
            }
            if identity.turn_id.as_ref().is_some_and(|turn_id| {
                settled_turns.contains(&format!("{}\0{turn_id}", identity.session_id))
            }) {
                return false;
            }
            !identity.item_id.as_ref().is_some_and(|item_id| {
                settled_items.contains(&format!("{}\0{item_id}", identity.session_id))
            })
        });
        replay.bytes = replay.events.iter().map(|retained| retained.bytes).sum();
    }
}

fn subscribed(topics: &HashSet<String>, topic: &str, event_type: &str) -> bool {
    topics.is_empty()
        || topics.contains("*")
        || topics.contains(topic)
        || topics.contains(event_type)
}

fn is_transient(event: &EventEnvelope<Value>) -> bool {
    TRANSIENT_EVENT_TYPES.contains(&event.r#type.as_str())
}

fn transient_identity(event: &EventEnvelope<Value>) -> Option<TransientEventIdentity> {
    if !is_transient(event) {
        return None;
    }
    let session_id = event.payload.get("sessionId")?.as_str()?.to_string();
    let item = event.payload.get("item").and_then(Value::as_object);
    let item_id = item
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .or_else(|| event.payload.get("itemId").and_then(Value::as_str))
        .map(ToString::to_string);
    let turn_id = item
        .and_then(|item| item.get("turnId"))
        .and_then(Value::as_str)
        .or_else(|| event.payload.get("turnId").and_then(Value::as_str))
        .map(ToString::to_string);
    let status = item
        .and_then(|item| item.get("status"))
        .and_then(Value::as_str);
    Some(TransientEventIdentity {
        session_id,
        item_id,
        turn_id,
        settled_timeline_item: event.r#type != "ai-session.message-delta"
            && matches!(status, Some("completed" | "failed")),
    })
}

fn item_key(identity: &TransientEventIdentity) -> Option<String> {
    identity
        .item_id
        .as_ref()
        .map(|item_id| format!("{}\0{item_id}", identity.session_id))
}

fn item_key_for_event(event: &EventEnvelope<Value>) -> Option<String> {
    transient_identity(event).as_ref().and_then(item_key)
}

fn drop_superseded_item_snapshots(replay: &mut ReplayState, item_key: &str) {
    let mut last_snapshot = None;
    let mut last_delta = None;
    for (index, retained) in replay.events.iter().enumerate() {
        if item_key_for_event(&retained.event).as_deref() != Some(item_key) {
            continue;
        }
        if retained.event.r#type == "ai-session.timeline-item" {
            last_snapshot = Some(index);
        } else {
            last_delta = Some(index);
        }
    }
    let Some(last_snapshot) = last_snapshot else {
        return;
    };
    // Node treats a missing delta as index -1, so a snapshot-only replay is
    // still allowed to drop its older snapshots.
    let last_delta = last_delta.map(|index| index as isize).unwrap_or(-1);
    if last_snapshot as isize <= last_delta {
        return;
    }
    replay.events = replay
        .events
        .drain(..)
        .enumerate()
        .filter_map(|(index, retained)| {
            let superseded_snapshot = index as isize > last_delta
                && index < last_snapshot
                && retained.event.r#type == "ai-session.timeline-item"
                && item_key_for_event(&retained.event).as_deref() == Some(item_key);
            (!superseded_snapshot).then_some(retained)
        })
        .collect();
    replay.bytes = replay.events.iter().map(|retained| retained.bytes).sum();
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::event_topic;
    use serde_json::json;

    fn topics(values: &[&str]) -> HashSet<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[tokio::test]
    async fn published_events_advance_sequence_and_reach_subscribers() {
        let bus = EventBus::new(8);
        let mut receiver = bus.subscribe();
        let event = bus.publish("instance.updated", json!({ "ok": true }));
        assert_eq!(event.seq, 1);
        assert_eq!(receiver.recv().await.expect("event").seq, 1);
    }

    #[test]
    fn transient_replay_obeys_scope_and_marks_nothing_until_encoding() {
        let bus = EventBus::new(8);
        bus.publish(
            "ai-session.message-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "itemId": "item", "turnId": "turn", "delta": "a" }),
        );
        bus.publish(
            "ai-session.timeline-item-delta",
            json!({ "instanceId": "ins_2", "sessionId": "ses_2", "itemId": "item2", "turnId": "turn2", "delta": "b" }),
        );
        let mut subscription = AiSessionTransientSubscription::default();
        subscription.message_deltas.instance_ids = vec!["ins_1".to_string()];
        let replay = bus.replay_since(
            &(Utc::now() - ChronoDuration::seconds(10)).to_rfc3339(),
            &topics(&["*"]),
            Some(&subscription),
        );
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].payload["instanceId"], "ins_1");
    }

    #[test]
    fn terminal_timeline_items_and_settled_authority_events_release_replay() {
        let bus = EventBus::new(8);
        bus.publish(
            "ai-session.message-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "itemId": "item_1", "turnId": "turn_1", "delta": "a" }),
        );
        assert_eq!(bus.retained_event_count(), 1);
        bus.publish(
            "ai-session.timeline-item",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "item": { "id": "item_1", "turnId": "turn_1", "status": "completed" } }),
        );
        assert_eq!(bus.retained_event_count(), 0);

        bus.publish(
            "ai-session.message-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "itemId": "item_2", "turnId": "turn_1", "delta": "b" }),
        );
        bus.publish(
            "ai-session.patch",
            json!({ "upserted": [{ "id": "ses_1", "status": "running", "turns": [{ "id": "turn_1", "status": "completed" }] }] }),
        );
        assert_eq!(bus.retained_event_count(), 0);
    }

    #[test]
    fn new_timeline_snapshot_removes_superseded_snapshots_but_keeps_deltas() {
        let bus = EventBus::new(8);
        bus.publish(
            "ai-session.timeline-item",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "item": { "id": "item_1", "turnId": "turn_1", "status": "running", "output": "" } }),
        );
        bus.publish(
            "ai-session.message-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "itemId": "item_1", "turnId": "turn_1", "delta": "a" }),
        );
        bus.publish(
            "ai-session.timeline-item",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "item": { "id": "item_1", "turnId": "turn_1", "status": "running", "output": "a" } }),
        );
        bus.publish(
            "ai-session.timeline-item",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1", "item": { "id": "item_1", "turnId": "turn_1", "status": "running", "output": "ab" } }),
        );
        assert_eq!(bus.retained_event_count(), 3);
        let replay = bus.replay_since(
            &(Utc::now() - ChronoDuration::seconds(10)).to_rfc3339(),
            &topics(&["*"]),
            None,
        );
        assert_eq!(replay[0].r#type, "ai-session.timeline-item");
        assert_eq!(replay[0].payload["item"]["output"], "");
        assert_eq!(replay[1].r#type, "ai-session.message-delta");
        assert_eq!(replay[2].r#type, "ai-session.timeline-item");
        assert_eq!(replay[2].payload["item"]["output"], "ab");
    }

    #[test]
    fn last_revision_tracks_all_events_including_non_transient_events() {
        let bus = EventBus::new(8);
        let direct = bus.new_event("streams.hello", json!({}));
        assert_eq!(direct.seq, 1);
        bus.publish("instance.updated", json!({}));
        assert_eq!(bus.latest_revision(), 2);
        assert_eq!(event_topic("streams.hello"), "system");
    }
}
