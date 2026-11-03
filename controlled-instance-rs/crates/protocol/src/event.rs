use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::{event_id, COMPACT_EVENT_ENVELOPE_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope<T = serde_json::Value> {
    pub v: u8,
    pub id: String,
    pub seq: u64,
    pub r#type: String,
    pub topic: String,
    pub created_at: String,
    pub payload: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<EventScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

impl<T> EventEnvelope<T> {
    pub fn new(seq: u64, event_type: impl Into<String>, payload: T) -> Self {
        let event_type = event_type.into();
        Self {
            v: 1,
            id: event_id(),
            seq,
            topic: event_topic(&event_type).to_string(),
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            r#type: event_type,
            payload,
            replay: None,
            scope: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTransientSubscription {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_since: Option<String>,
    #[serde(default)]
    pub message_deltas: AiSessionMessageDeltaSubscription,
    #[serde(default)]
    pub timeline_all_sessions: bool,
    #[serde(default)]
    pub timeline_sessions: Vec<AiSessionTimelineSubscription>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionMessageDeltaSubscription {
    #[serde(default)]
    pub all_instances: bool,
    #[serde(default)]
    pub instance_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTimelineSubscription {
    pub instance_id: String,
    pub session_id: String,
}

pub fn ai_session_transient_subscription_accepts(
    subscription: Option<&AiSessionTransientSubscription>,
    event: &EventEnvelope<Value>,
) -> bool {
    let Some(subscription) = subscription else {
        return true;
    };
    if !matches!(
        event.r#type.as_str(),
        "ai-session.message-delta" | "ai-session.timeline-item" | "ai-session.timeline-item-delta"
    ) {
        return true;
    }
    let instance_id = event
        .payload
        .get("instanceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            event
                .scope
                .as_ref()
                .and_then(|scope| scope.instance_id.as_deref())
        })
        .unwrap_or_default();
    if event.r#type == "ai-session.message-delta" {
        return subscription.message_deltas.all_instances
            || subscription
                .message_deltas
                .instance_ids
                .iter()
                .any(|candidate| candidate == instance_id);
    }
    let session_id = event
        .payload
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    subscription.timeline_all_sessions
        || subscription
            .timeline_sessions
            .iter()
            .any(|entry| entry.instance_id == instance_id && entry.session_id == session_id)
}

pub fn encode_event(event: &EventEnvelope<Value>, compact: bool, replay: bool) -> String {
    if !compact {
        let mut event = event.clone();
        if replay {
            event.replay = Some(true);
        }
        return serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    }
    let mut encoded = Map::new();
    encoded.insert(
        "v".to_string(),
        Value::String(COMPACT_EVENT_ENVELOPE_VERSION.to_string()),
    );
    encoded.insert("id".to_string(), Value::String(event.id.clone()));
    encoded.insert("type".to_string(), Value::String(event.r#type.clone()));
    encoded.insert(
        "createdAt".to_string(),
        Value::String(event.created_at.clone()),
    );
    encoded.insert("payload".to_string(), compact_payload(event));
    if event.topic != event_topic(&event.r#type) {
        encoded.insert("topic".to_string(), Value::String(event.topic.clone()));
    }
    if replay {
        encoded.insert("replay".to_string(), Value::Bool(true));
    }
    if let Some(scope) = &event.scope {
        let scope = serde_json::to_value(scope).unwrap_or_else(|_| json!({}));
        if scope.as_object().is_some_and(|scope| !scope.is_empty()) {
            encoded.insert("scope".to_string(), scope);
        }
    }
    serde_json::to_string(&encoded).unwrap_or_else(|_| "{}".to_string())
}

fn compact_payload(event: &EventEnvelope<Value>) -> Value {
    let mut payload = event.payload.clone();
    if matches!(
        event.r#type.as_str(),
        "ai-session.message-delta" | "ai-session.timeline-item-delta"
    ) {
        if let Some(payload) = payload.as_object_mut() {
            payload.remove("instanceId");
            payload.remove("nodeId");
            payload.remove("providerSessionId");
        }
    }
    payload
}

pub fn event_topic(event_type: &str) -> &'static str {
    if event_type.starts_with("ai-session.") || event_type.starts_with("ai.session.") {
        return "ai.sessions";
    }
    if event_type.starts_with("app-session.") {
        return "app.sessions";
    }
    if event_type.starts_with("app.management") {
        return "apps";
    }
    if event_type.starts_with("trigger.") {
        return "triggers";
    }
    if event_type.starts_with("instance.") {
        return "instances";
    }
    if event_type.starts_with("node.") {
        return "nodes";
    }
    if event_type.starts_with("project.") {
        return "projects";
    }
    if event_type.starts_with("model.") {
        return "models";
    }
    if event_type.starts_with("image.") {
        return "images";
    }
    if event_type.starts_with("market.") {
        return "market";
    }
    if event_type.starts_with("story.") {
        return "stories";
    }
    if event_type.starts_with("agent.") {
        return "agents";
    }
    "system"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_uses_the_existing_wire_field_names() {
        let event = EventEnvelope::new(7, "ai-session.patch", serde_json::json!({ "ok": true }));
        let encoded = serde_json::to_value(event).expect("event serializes");
        assert_eq!(encoded["v"], 1);
        assert_eq!(encoded["seq"], 7);
        assert_eq!(encoded["type"], "ai-session.patch");
        assert_eq!(encoded["topic"], "ai.sessions");
        assert!(encoded
            .get("createdAt")
            .and_then(|value| value.as_str())
            .is_some());
        assert!(encoded.get("scope").is_none());
    }

    #[test]
    fn topics_match_the_node_projection() {
        assert_eq!(event_topic("app-session.updated"), "app.sessions");
        assert_eq!(event_topic("trigger.updated"), "triggers");
        assert_eq!(event_topic("unknown.updated"), "system");
    }

    #[test]
    fn compact_envelopes_remove_derived_fields() {
        let mut event = EventEnvelope::new(
            9,
            "ai-session.message-delta",
            json!({
                "instanceId": "ins_1",
                "nodeId": "nod_1",
                "sessionId": "ses_1",
                "providerSessionId": "provider",
                "turnId": "turn",
                "itemId": "item",
                "delta": "hello",
                "generatedAt": "2026-11-02T00:00:00.000Z"
            }),
        );
        event.scope = Some(EventScope {
            instance_id: Some("ins_1".to_string()),
            node_id: None,
        });
        let encoded: Value =
            serde_json::from_str(&encode_event(&event, true, true)).expect("compact event");
        assert_eq!(encoded["v"], COMPACT_EVENT_ENVELOPE_VERSION);
        assert!(encoded.get("seq").is_none());
        assert!(encoded.get("topic").is_none());
        assert_eq!(encoded["replay"], true);
        assert!(encoded["payload"].get("instanceId").is_none());
        assert!(encoded["payload"].get("providerSessionId").is_none());
        assert_eq!(encoded["scope"]["instanceId"], "ins_1");
    }

    #[test]
    fn transient_subscriptions_only_accept_their_selected_scope() {
        let mut subscription = AiSessionTransientSubscription::default();
        subscription.message_deltas.instance_ids = vec!["ins_1".to_string()];
        subscription.timeline_sessions = vec![AiSessionTimelineSubscription {
            instance_id: "ins_1".to_string(),
            session_id: "ses_1".to_string(),
        }];
        let delta = EventEnvelope::new(
            1,
            "ai-session.message-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1" }),
        );
        let other = EventEnvelope::new(
            2,
            "ai-session.message-delta",
            json!({ "instanceId": "ins_2", "sessionId": "ses_2" }),
        );
        let timeline = EventEnvelope::new(
            3,
            "ai-session.timeline-item-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_1" }),
        );
        let other_timeline = EventEnvelope::new(
            4,
            "ai-session.timeline-item-delta",
            json!({ "instanceId": "ins_1", "sessionId": "ses_2" }),
        );
        assert!(ai_session_transient_subscription_accepts(
            Some(&subscription),
            &delta
        ));
        assert!(!ai_session_transient_subscription_accepts(
            Some(&subscription),
            &other
        ));
        assert!(ai_session_transient_subscription_accepts(
            Some(&subscription),
            &timeline
        ));
        assert!(!ai_session_transient_subscription_accepts(
            Some(&subscription),
            &other_timeline
        ));
    }
}
