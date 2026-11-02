use controlled_instance_core::{atomic::write_atomic, fs_permissions::restrict_path};
use controlled_instance_protocol::{
    AiSessionPersistenceSettings, AiSessionPersistenceSettingsInput,
    AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS, AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS,
    AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES, AI_SESSION_HISTORY_DEFAULT_LIMIT,
    AI_SESSION_HISTORY_MAX_LIMIT, AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AiSessionPersistenceSettingsError {
    #[error("AI session persistence settings are invalid.")]
    Invalid,
    #[error("AI session persistence settings could not be written: {0}")]
    Io(#[from] std::io::Error),
    #[error("AI session persistence settings could not be serialized: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SettingsV1 {
    schema_version: u32,
    history_limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SettingsV2 {
    schema_version: u32,
    history_limit: usize,
    attachment_retention_days: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SettingsV3 {
    schema_version: u32,
    history_limit: usize,
    attachment_retention_days: u32,
    max_file_attachment_bytes: u64,
}

pub struct AiSessionPersistenceSettingsStore {
    file_path: PathBuf,
}

impl AiSessionPersistenceSettingsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file_path: data_dir
                .join("ai-session-persistence")
                .join("settings.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.file_path
    }

    pub fn get(&self) -> AiSessionPersistenceSettings {
        let Ok(bytes) = std::fs::read(&self.file_path) else {
            return Self::defaults();
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            tracing::warn!(
                path = %self.file_path.display(),
                "invalid AI session persistence settings replaced with defaults"
            );
            return Self::defaults();
        };
        if let Ok(settings) = serde_json::from_value::<SettingsV3>(value.clone()) {
            if settings.schema_version == 3
                && valid_history_limit(settings.history_limit)
                && valid_retention_days(settings.attachment_retention_days)
                && valid_max_file_bytes(settings.max_file_attachment_bytes)
            {
                return AiSessionPersistenceSettings {
                    schema_version: 3,
                    history_limit: settings.history_limit,
                    attachment_retention_days: settings.attachment_retention_days,
                    max_file_attachment_bytes: settings.max_file_attachment_bytes,
                };
            }
        }
        if let Ok(settings) = serde_json::from_value::<SettingsV2>(value.clone()) {
            if settings.schema_version == 2
                && valid_history_limit(settings.history_limit)
                && valid_retention_days(settings.attachment_retention_days)
            {
                return AiSessionPersistenceSettings {
                    schema_version: 3,
                    history_limit: settings.history_limit,
                    attachment_retention_days: settings.attachment_retention_days,
                    max_file_attachment_bytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
                };
            }
        }
        if let Ok(settings) = serde_json::from_value::<SettingsV1>(value) {
            if settings.schema_version == 1 && valid_history_limit(settings.history_limit) {
                return AiSessionPersistenceSettings {
                    schema_version: 3,
                    history_limit: settings.history_limit,
                    attachment_retention_days: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
                    max_file_attachment_bytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
                };
            }
        }
        tracing::warn!(
            path = %self.file_path.display(),
            "invalid AI session persistence settings replaced with defaults"
        );
        Self::defaults()
    }

    pub fn put(
        &self,
        input: AiSessionPersistenceSettingsInput,
    ) -> Result<AiSessionPersistenceSettings, AiSessionPersistenceSettingsError> {
        let current = self.get();
        if !valid_history_limit(input.history_limit) {
            return Err(AiSessionPersistenceSettingsError::Invalid);
        }
        let attachment_retention_days = input
            .attachment_retention_days
            .unwrap_or(current.attachment_retention_days);
        let max_file_attachment_bytes = input
            .max_file_attachment_bytes
            .unwrap_or(current.max_file_attachment_bytes);
        if !valid_retention_days(attachment_retention_days)
            || !valid_max_file_bytes(max_file_attachment_bytes)
        {
            return Err(AiSessionPersistenceSettingsError::Invalid);
        }
        let settings = AiSessionPersistenceSettings {
            schema_version: 3,
            history_limit: input.history_limit,
            attachment_retention_days,
            max_file_attachment_bytes,
        };
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
            let _ = restrict_path(parent, 0o700);
        }
        let mut bytes = serde_json::to_vec_pretty(&settings)?;
        bytes.push(b'\n');
        write_atomic(&self.file_path, &bytes, Some(0o600))?;
        Ok(settings)
    }

    pub fn defaults() -> AiSessionPersistenceSettings {
        AiSessionPersistenceSettings {
            schema_version: 3,
            history_limit: AI_SESSION_HISTORY_DEFAULT_LIMIT,
            attachment_retention_days: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
            max_file_attachment_bytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
        }
    }
}

fn valid_history_limit(value: usize) -> bool {
    (1..=AI_SESSION_HISTORY_MAX_LIMIT).contains(&value)
}

fn valid_retention_days(value: u32) -> bool {
    value <= AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS
}

fn valid_max_file_bytes(value: u64) -> bool {
    value > 0 && value <= AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_written_v3_and_read_when_restarted() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionPersistenceSettingsStore::new(root.path());
        assert_eq!(store.get(), AiSessionPersistenceSettingsStore::defaults());
        let settings = store
            .put(AiSessionPersistenceSettingsInput {
                history_limit: 125,
                attachment_retention_days: Some(7),
                max_file_attachment_bytes: Some(2 * 1024 * 1024),
            })
            .expect("put");
        assert_eq!(settings.schema_version, 3);
        assert_eq!(
            AiSessionPersistenceSettingsStore::new(root.path()).get(),
            settings
        );
        let value: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("ai-session-persistence/settings.json"))
                .expect("settings"),
        )
        .expect("json");
        assert_eq!(value["schemaVersion"], 3);
    }

    #[test]
    fn settings_read_v1_and_v2_wire_shapes() {
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("ai-session-persistence");
        std::fs::create_dir_all(&directory).expect("settings dir");
        std::fs::write(
            directory.join("settings.json"),
            br#"{"schemaVersion":1,"historyLimit":12}"#,
        )
        .expect("v1");
        let store = AiSessionPersistenceSettingsStore::new(root.path());
        let settings = store.get();
        assert_eq!(settings.history_limit, 12);
        assert_eq!(
            settings.attachment_retention_days,
            AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS
        );

        std::fs::write(
            directory.join("settings.json"),
            br#"{"schemaVersion":2,"historyLimit":22,"attachmentRetentionDays":14}"#,
        )
        .expect("v2");
        let settings = store.get();
        assert_eq!(settings.history_limit, 22);
        assert_eq!(settings.attachment_retention_days, 14);
        assert_eq!(
            settings.max_file_attachment_bytes,
            AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES
        );
    }

    #[test]
    fn invalid_settings_are_rejected_and_fall_back_to_defaults() {
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("ai-session-persistence");
        std::fs::create_dir_all(&directory).expect("settings dir");
        std::fs::write(
            directory.join("settings.json"),
            br#"{"schemaVersion":3,"historyLimit":0,"attachmentRetentionDays":30,"maxFileAttachmentBytes":500000,"unknown":true}"#,
        )
        .expect("invalid");
        let store = AiSessionPersistenceSettingsStore::new(root.path());
        assert_eq!(store.get(), AiSessionPersistenceSettingsStore::defaults());
        assert!(store
            .put(AiSessionPersistenceSettingsInput {
                history_limit: 501,
                attachment_retention_days: None,
                max_file_attachment_bytes: None,
            })
            .is_err());
    }
}
