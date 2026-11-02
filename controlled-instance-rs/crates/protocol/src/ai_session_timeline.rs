use serde::{Deserialize, Serialize};

pub const AI_SESSION_MAX_TIMELINE_ATTACHMENTS: usize = 6;
pub const AI_SESSION_TIMELINE_SYNC_MAX_ITEMS: usize = 10_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionAttachmentKind {
    Image,
    File,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionAttachmentContentState {
    Available,
    Expired,
    Missing,
}

fn default_attachment_content_state() -> AiSessionAttachmentContentState {
    AiSessionAttachmentContentState::Available
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionConversationAttachment {
    pub id: String,
    pub kind: AiSessionAttachmentKind,
    pub name: String,
    pub mime: String,
    pub size: u64,
    #[serde(default = "default_attachment_content_state")]
    pub content_state: AiSessionAttachmentContentState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionTimelineActivityStatus {
    Running,
    Completed,
    Failed,
    Waiting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AiSessionTimelineItem {
    UserMessage {
        id: String,
        turn_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<AiSessionConversationAttachment>>,
    },
    AiMessage {
        id: String,
        turn_id: String,
        text: String,
    },
    Activity {
        id: String,
        turn_id: String,
        activity_kind: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<AiSessionTimelineActivityStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        paths: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
}

impl AiSessionTimelineItem {
    pub fn id(&self) -> &str {
        match self {
            Self::UserMessage { id, .. }
            | Self::AiMessage { id, .. }
            | Self::Activity { id, .. } => id,
        }
    }

    pub fn turn_id(&self) -> &str {
        match self {
            Self::UserMessage { turn_id, .. }
            | Self::AiMessage { turn_id, .. }
            | Self::Activity { turn_id, .. } => turn_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTimeline {
    pub session_id: String,
    pub provider_session_id: String,
    pub items: Vec<AiSessionTimelineItem>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTurnTimeline {
    pub session_id: String,
    pub turn_id: String,
    pub items: Vec<AiSessionTimelineItem>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionTimelineItemRevision {
    pub id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTimelineVersionedItem {
    pub revision: String,
    pub item: AiSessionTimelineItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AiSessionTimelineSyncRead {
    NotModified {
        revision: String,
    },
    Snapshot {
        revision: String,
        items: Vec<AiSessionTimelineVersionedItem>,
    },
    Delta {
        revision: String,
        upserted: Vec<AiSessionTimelineVersionedItem>,
        removed: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        order: Option<Vec<String>>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timeline_items_keep_the_existing_wire_shape() {
        let item: AiSessionTimelineItem = serde_json::from_value(json!({
            "id": "item-1",
            "turnId": "turn-1",
            "type": "activity",
            "activityKind": "commandExecution",
            "title": "Command",
            "status": "completed",
            "exitCode": 0,
            "durationMs": 12
        }))
        .expect("timeline item");
        let value = serde_json::to_value(item).expect("serialize");
        assert_eq!(value["type"], "activity");
        assert_eq!(value["turnId"], "turn-1");
        assert_eq!(value["activityKind"], "commandExecution");
        assert_eq!(value["exitCode"], 0);
    }

    #[test]
    fn sync_read_uses_the_versioned_discriminators() {
        let snapshot = AiSessionTimelineSyncRead::Snapshot {
            revision: "revision".to_string(),
            items: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(snapshot).expect("serialize")["kind"],
            "snapshot"
        );
        let not_modified = AiSessionTimelineSyncRead::NotModified {
            revision: "revision".to_string(),
        };
        assert_eq!(
            serde_json::to_value(not_modified).expect("serialize")["kind"],
            "not-modified"
        );
    }
}
