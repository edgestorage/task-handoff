use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AiSessionPersistenceSettingsInput {
    pub history_limit: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_retention_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_file_attachment_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AiSessionPersistenceSettings {
    pub schema_version: u32,
    pub history_limit: usize,
    pub attachment_retention_days: u32,
    pub max_file_attachment_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionPersistenceSettingsApplyResult {
    pub applied: bool,
    pub history_limit: usize,
    pub attachment_retention_days: u32,
    pub max_file_attachment_bytes: u64,
    pub removed_history_count: usize,
}
