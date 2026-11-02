use crate::AiSessionAttachmentKind;
use serde::{Deserialize, Serialize};

pub const AI_SESSION_MAX_MESSAGE_ATTACHMENTS: usize = 6;
pub const AI_SESSION_MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
pub const AI_SESSION_MAX_INLINE_FILE_BYTES: u64 = 500 * 1024;
pub const AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES: u64 = AI_SESSION_MAX_INLINE_FILE_BYTES;
pub const AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES: u64 = 40 * 1024 * 1024;
pub const AI_SESSION_ATTACHMENT_UPLOAD_BODY_LIMIT: usize = 21 * 1024 * 1024;
pub const AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES: usize = 256 * 1024;
pub const AI_SESSION_ATTACHMENT_DRAFT_STREAM_BODY_LIMIT: usize = 512 * 1024;
pub const AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS: i64 = 10 * 60 * 1000;
pub const AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS: u32 = 30;
pub const AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS: u32 = 365;
pub const AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES: u64 = AI_SESSION_MAX_ATTACHMENT_BYTES;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiSessionAttachmentScopeType {
    Session,
    CreateRequest,
}

impl AiSessionAttachmentScopeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::CreateRequest => "create-request",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionMessageAttachmentSourceType {
    Inline,
    RuntimePath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionAttachmentDraft {
    pub id: String,
    pub kind: AiSessionAttachmentKind,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionMessageAttachmentMeta {
    pub id: String,
    pub kind: AiSessionAttachmentKind,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub source_type: AiSessionMessageAttachmentSourceType,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_uses_the_existing_public_wire_fields() {
        let draft = AiSessionAttachmentDraft {
            id: "att_0123456789abcdef01234567".to_string(),
            kind: AiSessionAttachmentKind::File,
            name: "notes.txt".to_string(),
            mime: "text/plain".to_string(),
            size: 12,
            expires_at: "2026-11-02T00:00:00.000Z".to_string(),
        };
        let value = serde_json::to_value(draft).expect("serialize");
        assert_eq!(value["kind"], "file");
        assert_eq!(value["expiresAt"], "2026-11-02T00:00:00.000Z");
    }
}
