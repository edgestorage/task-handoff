use chrono::{SecondsFormat, Utc};
use controlled_instance_protocol::{AiSessionSummary, AiSessionsSnapshot, AiSessionsState};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use uuid::Uuid;

const EVENT_RETENTION_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone)]
struct RetainedAiSessionEvent {
    event_type: String,
    payload: Value,
    revision: u64,
    created_at_ms: i64,
}

pub(crate) fn event_trace_id(prefix: &str) -> String {
    let millis = Utc::now().timestamp_millis().max(0) as u64;
    let mut value = millis;
    let mut digits = Vec::new();
    if value == 0 {
        digits.push(b'0');
    }
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    digits.reverse();
    let timestamp = String::from_utf8(digits).unwrap_or_else(|_| "0".to_string());
    let random = Uuid::new_v4().simple().to_string();
    format!("{prefix}_{timestamp}_{}", &random[..8])
}

pub struct AiSessionAuthority {
    instance_id: String,
    stream_id: String,
    revision: u64,
    started_at: String,
    last_snapshot: Option<AiSessionsSnapshot>,
    history: VecDeque<RetainedAiSessionEvent>,
}

pub struct AiSessionAuthorityEvent {
    pub event_type: String,
    pub payload: Value,
}

impl AiSessionAuthority {
    pub fn new(
        instance_id: impl Into<String>,
        stream_id: impl Into<String>,
        started_at: String,
    ) -> Self {
        Self {
            instance_id: instance_id.into(),
            stream_id: stream_id.into(),
            revision: 0,
            started_at,
            last_snapshot: None,
            history: VecDeque::new(),
        }
    }

    pub fn state(&self, snapshot: AiSessionsSnapshot) -> AiSessionsState {
        AiSessionsState {
            stream_id: self.stream_id.clone(),
            revision: self.revision,
            // State reads do not prune. Match the source owner by deriving
            // this observation time from retained history, falling back to
            // process start after delta pruning. Revision orders the stream.
            last_event_at: self
                .history
                .back()
                .and_then(|event| event.payload["meta"]["generatedAt"].as_str())
                .unwrap_or(&self.started_at)
                .to_string(),
            snapshot,
        }
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn published_snapshot(&self) -> Option<&AiSessionsSnapshot> {
        self.last_snapshot.as_ref()
    }

    pub fn earliest_retained_revision(&self) -> u64 {
        self.history
            .front()
            .map(|event| event.revision)
            .unwrap_or(self.revision.saturating_add(1))
    }

    pub fn retained_event_count(&self) -> usize {
        self.history.len()
    }

    pub fn prepare(
        &mut self,
        snapshot: AiSessionsSnapshot,
        reason: &str,
    ) -> Option<AiSessionAuthorityEvent> {
        self.prepare_with_clocks(snapshot, reason, now_iso, || Utc::now().timestamp_millis())
    }

    fn prepare_with_clocks(
        &mut self,
        snapshot: AiSessionsSnapshot,
        reason: &str,
        generated_at: impl FnOnce() -> String,
        now_ms: impl FnOnce() -> i64,
    ) -> Option<AiSessionAuthorityEvent> {
        let change = project_authority_change(self.last_snapshot.as_ref(), &snapshot)?;
        self.revision = self.revision.saturating_add(1);
        let meta = self.event_meta_at(reason, generated_at());
        let (event_type, payload) = match change {
            AuthorityChange::Snapshot => (
                "ai-session.snapshot",
                json!({ "meta": meta, "snapshot": snapshot }),
            ),
            AuthorityChange::Patch { upserted, removed } => (
                "ai-session.patch",
                json!({ "meta": meta, "upserted": upserted, "removed": removed }),
            ),
        };
        self.last_snapshot = Some(snapshot);
        self.remember(event_type, &payload, now_ms());
        Some(AiSessionAuthorityEvent {
            event_type: event_type.to_string(),
            payload,
        })
    }

    pub fn snapshot_payload(&self, snapshot: AiSessionsSnapshot, reason: &str) -> Value {
        let meta = self.event_meta(reason);
        json!({ "meta": meta, "snapshot": snapshot })
    }

    fn event_meta(&self, reason: &str) -> Value {
        self.event_meta_at(reason, now_iso())
    }

    fn event_meta_at(&self, reason: &str, generated_at: String) -> Value {
        let mut meta = json!({
            "streamId": self.stream_id,
            "instanceId": self.instance_id,
            "revision": self.revision,
            "traceId": event_trace_id("ais_evt"),
            "generatedAt": generated_at,
            "reason": reason,
        });
        if let (Some(object), Some(node_id)) = (
            meta.as_object_mut(),
            std::env::var("TASK_HANDOFF_NODE_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        ) {
            object.insert("nodeId".to_string(), Value::String(node_id));
        }
        if self.revision > 0 {
            meta.as_object_mut().expect("meta object").insert(
                "previousRevision".to_string(),
                json!(self.revision.saturating_sub(1)),
            );
        }
        meta
    }

    pub fn delta(&mut self, stream_id: &str, since_revision: f64) -> Value {
        self.delta_at(stream_id, since_revision, Utc::now().timestamp_millis())
    }

    fn delta_at(&mut self, stream_id: &str, since_revision: f64, now_ms: i64) -> Value {
        // Retention also expires while the stream is idle. Match the Node
        // delta owner: prune before evaluating continuity or stream identity.
        self.prune_history(now_ms);
        let latest_revision = self.revision;
        let earliest_retained_revision = self
            .history
            .front()
            .map(|event| event.revision)
            .unwrap_or(latest_revision.saturating_add(1));
        if stream_id != self.stream_id || since_revision > latest_revision as f64 {
            return delta_response(
                &self.stream_id,
                &self.instance_id,
                since_revision,
                latest_revision,
                earliest_retained_revision,
                true,
                Vec::new(),
            );
        }
        if since_revision == latest_revision as f64 {
            return delta_response(
                &self.stream_id,
                &self.instance_id,
                since_revision,
                latest_revision,
                earliest_retained_revision,
                false,
                Vec::new(),
            );
        }
        let events = self
            .history
            .iter()
            .filter(|event| event.revision as f64 > since_revision)
            .collect::<Vec<_>>();
        let sync_required = events
            .first()
            .is_none_or(|event| event.revision as f64 != since_revision + 1.0);
        let events = if sync_required {
            Vec::new()
        } else {
            events
                .into_iter()
                .map(|event| json!({ "type": event.event_type, "payload": event.payload }))
                .collect()
        };
        delta_response(
            &self.stream_id,
            &self.instance_id,
            since_revision,
            latest_revision,
            earliest_retained_revision,
            sync_required,
            events,
        )
    }

    fn remember(&mut self, event_type: &str, payload: &Value, now: i64) {
        self.prune_history(now);
        self.history.push_back(RetainedAiSessionEvent {
            event_type: event_type.to_string(),
            payload: payload.clone(),
            revision: self.revision,
            created_at_ms: now,
        });
    }

    fn prune_history(&mut self, now: i64) {
        while self
            .history
            .front()
            .is_some_and(|event| event.created_at_ms < now - EVENT_RETENTION_MS)
        {
            self.history.pop_front();
        }
    }
}

enum AuthorityChange {
    Snapshot,
    Patch {
        upserted: Vec<AiSessionSummary>,
        removed: Vec<String>,
    },
}

fn project_authority_change(
    previous: Option<&AiSessionsSnapshot>,
    next: &AiSessionsSnapshot,
) -> Option<AuthorityChange> {
    let Some(previous) = previous else {
        return Some(AuthorityChange::Snapshot);
    };
    let previous_by_id = previous
        .sessions
        .iter()
        .map(|session| (session.id.as_str(), session))
        .collect::<HashMap<_, _>>();
    let next_ids = next
        .sessions
        .iter()
        .map(|session| session.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let upserted = next
        .sessions
        .iter()
        .filter(|session| {
            previous_by_id
                .get(session.id.as_str())
                .is_none_or(|previous_session| *previous_session != *session)
        })
        .cloned()
        .collect::<Vec<_>>();
    let removed = previous
        .sessions
        .iter()
        .filter(|session| !next_ids.contains(session.id.as_str()))
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    if upserted.is_empty() && removed.is_empty() {
        None
    } else {
        Some(AuthorityChange::Patch { upserted, removed })
    }
}

fn delta_response(
    stream_id: &str,
    instance_id: &str,
    since_revision: f64,
    latest_revision: u64,
    earliest_retained_revision: u64,
    sync_required: bool,
    events: Vec<Value>,
) -> Value {
    json!({
        "streamId": stream_id,
        "instanceId": instance_id,
        "sinceRevision": js_number_value(since_revision),
        "latestRevision": latest_revision,
        "earliestRetainedRevision": earliest_retained_revision,
        "syncRequired": sync_required,
        "events": events,
    })
}

fn js_number_value(number: f64) -> Value {
    if number >= 0.0 && number <= u64::MAX as f64 && number.fract() == 0.0 {
        json!(number as u64)
    } else {
        json!(number)
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    mod removal_parity {
        use super::*;
        type Authority = AiSessionAuthority;
        type Snapshot = AiSessionsSnapshot;
        const TOPIC: &str = "ai";
        fn publish(authority: &mut Authority, snapshot: Snapshot, revision: u64) -> Option<Value> {
            let offset = (revision as i64 - 1) * 1000;
            authority
                .prepare_with_clocks(
                    snapshot,
                    if revision == 1 {
                        "startup"
                    } else {
                        "control-action"
                    },
                    || at(offset),
                    || START_MS + offset,
                )
                .map(|event| json!({"type":event.event_type,"payload":event.payload}))
        }
        include!("session_removal_parity.rs");
    }
    mod epoch_parity {
        use super::*;
        type Authority = AiSessionAuthority;
        type Snapshot = AiSessionsSnapshot;
        const TOPIC: &str = "ai";
        include!("session_epoch_parity.rs");
    }
    mod clock_parity {
        include!("ai_session_clock_parity.rs");
    }
    use controlled_instance_protocol::AiSessionsSnapshot;

    fn snapshot(updated_at: &str, sessions: Vec<AiSessionSummary>) -> AiSessionsSnapshot {
        AiSessionsSnapshot {
            running_count: sessions
                .iter()
                .filter(|session| session.status == "running")
                .count() as u64,
            waiting_count: sessions
                .iter()
                .filter(|session| session.status == "waiting")
                .count() as u64,
            stale_count: 0,
            sessions,
            updated_at: updated_at.to_string(),
        }
    }

    fn summary(id: &str, title: &str) -> AiSessionSummary {
        let value = json!({
            "id": id,
            "agent": "codex",
            "creationSource": "ai-session",
            "title": title,
            "status": "running",
            "phase": "thinking",
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        });
        serde_json::from_value(value).expect("summary")
    }

    #[test]
    fn trace_ids_use_base36_millis_and_a_short_random_suffix() {
        let trace = event_trace_id("ais_evt");
        let parts = trace.split('_').collect::<Vec<_>>();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "ais");
        assert_eq!(parts[1], "evt");
        assert!(parts[2]
            .chars()
            .all(|value| value.is_ascii_alphanumeric() && !value.is_ascii_uppercase()));
        assert_eq!(parts[3].len(), 8);
        assert!(parts[3].chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn expired_delta_without_another_publish_matches_node_golden() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/ai-session-authority-parity.json"
        ))
        .expect("Node golden");
        let mut authority = AiSessionAuthority::new(
            "inst_authority",
            "<stream>",
            "2026-11-02T00:00:00.000Z".to_string(),
        );
        for (index, story) in [
            None,
            Some("story-one"),
            Some("story-offline"),
            Some("story-after-reconnect"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut session = summary("ses_authority", "Initial title");
            session.status = "idle".to_string();
            session.phase = "unknown".to_string();
            session.provider_session_id = Some("provider-authority".to_string());
            session.story_id = story.map(str::to_string);
            authority
                .prepare(
                    snapshot("2026-11-02T00:00:00.000Z", vec![session]),
                    if index == 0 {
                        "startup"
                    } else {
                        "control-action"
                    },
                )
                .expect("publish");
        }
        // Advance the retention age without sleeping or publishing a new event.
        // This is owner-level time control; transport is covered separately.
        for event in &mut authority.history {
            event.created_at_ms -= EVENT_RETENTION_MS + 1;
        }
        let mut expected = fixture["expected"]["expired"].clone();
        expected["instanceId"] = json!("inst_authority");
        let actual = authority.delta("<stream>", 2.0);
        assert_eq!(
            actual, expected,
            "C05: expired history must require a snapshot"
        );
    }

    #[test]
    fn first_change_is_a_snapshot_and_later_changes_are_ordered_patches() {
        let mut authority =
            AiSessionAuthority::new("ins_1", "ais_1", "2026-11-02T00:00:00.000Z".to_string());
        let first = authority
            .prepare(
                snapshot("2026-11-02T00:00:00.000Z", vec![summary("ses_1", "One")]),
                "startup",
            )
            .expect("snapshot");
        assert_eq!(first.event_type, "ai-session.snapshot");
        assert_eq!(first.payload["meta"]["revision"], 1);
        assert_eq!(first.payload["meta"]["previousRevision"], 0);
        assert!(authority
            .prepare(
                snapshot("2026-11-02T00:00:01.000Z", vec![summary("ses_1", "One")]),
                "control-action"
            )
            .is_none());

        let patch = authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:02.000Z",
                    vec![summary("ses_1", "Renamed")],
                ),
                "control-action",
            )
            .expect("patch");
        assert_eq!(patch.event_type, "ai-session.patch");
        assert_eq!(patch.payload["meta"]["revision"], 2);
        assert_eq!(patch.payload["meta"]["previousRevision"], 1);
        assert_eq!(patch.payload["upserted"][0]["title"], "Renamed");

        let delta = authority.delta("ais_1", 1.0);
        assert_eq!(delta["syncRequired"], false);
        assert_eq!(delta["events"][0]["type"], "ai-session.patch");
        assert_eq!(authority.delta("other", 1.0)["syncRequired"], true);
    }
}
