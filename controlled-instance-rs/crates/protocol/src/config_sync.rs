use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSyncDirection {
    Import,
    Export,
}

impl ConfigSyncDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Import => "import",
            Self::Export => "export",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigSyncProgram {
    pub id: String,
    pub label: String,
    pub directory_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigSyncRequest {
    pub direction: ConfigSyncDirection,
    pub program_ids: Vec<String>,
    pub workspace_folder: String,
}

impl ConfigSyncRequest {
    pub fn normalize(mut self) -> Result<Self, String> {
        self.program_ids = self
            .program_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .collect();
        self.workspace_folder = self.workspace_folder.trim().to_string();
        if self.program_ids.is_empty() || self.program_ids.len() > 20 {
            return Err("Config sync requires between 1 and 20 programs.".to_string());
        }
        if self
            .program_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 120)
        {
            return Err("Config sync program ids are invalid.".to_string());
        }
        let unique = self
            .program_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if unique.len() != self.program_ids.len() {
            return Err("Config sync program ids must be unique.".to_string());
        }
        if self.workspace_folder.is_empty() || self.workspace_folder.len() > 1000 {
            return Err("Config sync workspace folder is invalid.".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSyncItemType {
    File,
    Dir,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncPresetItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: ConfigSyncItemType,
    pub project_path: String,
    pub container_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncPreset {
    pub id: String,
    pub label: String,
    pub project_root: String,
    pub items: Vec<ConfigSyncPresetItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSyncItemStatus {
    Copied,
    SkippedMissingSource,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncItemResult {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: ConfigSyncItemType,
    pub project_path: String,
    pub container_path: String,
    pub source: String,
    pub target: String,
    pub status: ConfigSyncItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncPresetSummary {
    pub id: String,
    pub label: String,
    pub project_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncProgramResult {
    pub preset: ConfigSyncPresetSummary,
    pub direction: ConfigSyncDirection,
    pub items: Vec<ConfigSyncItemResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncBatchResult {
    pub direction: ConfigSyncDirection,
    pub workspace_folder: String,
    pub programs: Vec<ConfigSyncProgramResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeEntry {
    pub name: String,
    pub path: String,
    pub children: Vec<FolderTreeEntry>,
}
