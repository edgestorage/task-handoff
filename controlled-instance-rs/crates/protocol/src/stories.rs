use serde::{Deserialize, Deserializer, Serialize};

pub const STORY_DEFAULT_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const STORY_DEFAULT_MAX_BATCH_PATHS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentIndexEntry {
    pub title: String,
    pub story_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentPagePagination {
    pub page: u64,
    pub page_size: u64,
    pub total_items: u64,
    pub total_pages: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentPageResult {
    pub story_created_at: String,
    pub documents: Vec<StoryContentIndexEntry>,
    pub pagination: StoryContentPagePagination,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryAgentPagination {
    pub total_items: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryAgentContentListResult {
    pub documents: Vec<StoryContentIndexEntry>,
    pub pagination: StoryAgentPagination,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryContentGetInput {
    pub story_paths: Vec<String>,
    pub destination_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentTransferError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentTransferItem {
    pub story_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<StoryContentTransferError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentGetResult {
    pub items: Vec<StoryContentTransferItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryContentSetInput {
    pub story_path: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present_option"
    )]
    pub title: Option<String>,
    pub source_path: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present_option"
    )]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentSetResult {
    pub title: String,
    pub story_path: String,
    pub revision: String,
    pub size: u64,
}

pub fn validate_story_path(path: &str) -> bool {
    let path = path.trim();
    !path.is_empty()
        && path.chars().count() <= 1024
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

pub fn validate_story_revision(revision: &str) -> bool {
    revision.len() == 64
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("expected a value, not null"));
    }
    T::deserialize(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn story_paths_are_normalized_relative_posix_paths() {
        assert!(validate_story_path("notes/one.md"));
        for invalid in ["", "/etc/passwd", "../secret", "a//b", "a\\b", "a/./b"] {
            assert!(!validate_story_path(invalid), "{invalid}");
        }
    }

    #[test]
    fn story_transfer_models_match_the_node_contract() {
        let value = serde_json::to_value(StoryContentTransferItem {
            story_path: "notes/one.md".to_string(),
            path: Some("/workspace/notes/one.md".to_string()),
            revision: None,
            error: None,
        })
        .expect("item");
        assert_eq!(
            value,
            serde_json::json!({
                "storyPath": "notes/one.md",
                "path": "/workspace/notes/one.md"
            })
        );
    }
}
