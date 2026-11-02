use controlled_instance_core::atomic::{read_json, write_json_atomic};
use controlled_instance_protocol::{mint_entity_id, AppProfile};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::AppRuntimeError;

const PROFILE_REGISTRY_VERSION: u32 = 1;
const DEFAULT_PROFILE_NAME: &str = "Default";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromiumProfileRecord {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChromiumProfileRegistry {
    #[serde(default = "registry_version")]
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_profile_id: Option<String>,
    #[serde(default)]
    profiles: Vec<ChromiumProfileRecord>,
}

fn registry_version() -> u32 {
    PROFILE_REGISTRY_VERSION
}

#[derive(Clone)]
pub struct ChromiumProfileStore {
    root: Arc<PathBuf>,
    mutation: Arc<Mutex<()>>,
}

impl std::fmt::Debug for ChromiumProfileStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChromiumProfileStore")
            .field("root", &self.root)
            .finish()
    }
}

impl ChromiumProfileStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            root: Arc::new(data_dir.as_ref().join("chromium-profiles")),
            mutation: Arc::new(Mutex::new(())),
        }
    }

    pub fn ensure_default(&self) -> Result<ChromiumProfileRecord, AppRuntimeError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut registry = self.read();
        if let Some(current) = registry
            .default_profile_id
            .as_ref()
            .and_then(|id| registry.profiles.iter().find(|profile| &profile.id == id))
            .cloned()
        {
            return Ok(current);
        }
        let id = mint_entity_id("brp");
        let timestamp = now_iso();
        let directory = self.ensure_directory(
            self.env_override_directory()
                .unwrap_or_else(|| self.root.join(&id)),
        )?;
        let profile = ChromiumProfileRecord {
            id: id.clone(),
            name: DEFAULT_PROFILE_NAME.to_string(),
            directory: directory.display().to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        registry.profiles.push(profile.clone());
        registry.default_profile_id = Some(id);
        self.write(&registry)?;
        Ok(profile)
    }

    pub fn default_profile_id(&self) -> Result<String, AppRuntimeError> {
        Ok(self.ensure_default()?.id)
    }

    pub fn list(&self) -> Result<Vec<ChromiumProfileRecord>, AppRuntimeError> {
        self.ensure_default()?;
        let mut profiles = self.read().profiles;
        profiles.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(profiles)
    }

    pub fn create(&self, name: &str) -> Result<ChromiumProfileRecord, AppRuntimeError> {
        let name = normalize_profile_name(name)?;
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut registry = self.read();
        if registry
            .profiles
            .iter()
            .any(|profile| profile.name.eq_ignore_ascii_case(&name))
        {
            return Err(AppRuntimeError::ProfileNameConflict(format!(
                "Browser profile name \"{name}\" already exists."
            )));
        }
        let mut id = mint_entity_id("brp");
        while registry.profiles.iter().any(|profile| profile.id == id)
            || self.root.join(&id).exists()
        {
            id = mint_entity_id("brp");
        }
        let timestamp = now_iso();
        let directory = self.ensure_directory(self.root.join(&id))?;
        let profile = ChromiumProfileRecord {
            id,
            name,
            directory: directory.display().to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        registry.profiles.push(profile.clone());
        self.write(&registry)?;
        Ok(profile)
    }

    pub fn rename(
        &self,
        profile_id: &str,
        name: &str,
    ) -> Result<ChromiumProfileRecord, AppRuntimeError> {
        let name = normalize_profile_name(name)?;
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut registry = self.read();
        if registry
            .profiles
            .iter()
            .any(|profile| profile.id != profile_id && profile.name.eq_ignore_ascii_case(&name))
        {
            return Err(AppRuntimeError::ProfileNameConflict(format!(
                "Browser profile name \"{name}\" already exists."
            )));
        }
        let Some(profile) = registry
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id)
        else {
            return Err(AppRuntimeError::ProfileNotFound(format!(
                "Browser profile {profile_id} was not found."
            )));
        };
        profile.name = name;
        profile.updated_at = now_iso();
        let profile = profile.clone();
        self.write(&registry)?;
        Ok(profile)
    }

    pub fn remove(&self, profile_id: &str) -> Result<(), AppRuntimeError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut registry = self.read();
        let Some(profile) = registry
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
        else {
            return Err(AppRuntimeError::ProfileNotFound(format!(
                "Browser profile {profile_id} was not found."
            )));
        };
        if registry.default_profile_id.as_deref() == Some(profile_id) {
            return Err(AppRuntimeError::ProfileDefaultProtected(
                "The default browser profile cannot be removed; change the default profile first."
                    .to_string(),
            ));
        }
        registry.profiles.retain(|profile| profile.id != profile_id);
        if registry
            .default_profile_id
            .as_ref()
            .is_some_and(|id| !registry.profiles.iter().any(|profile| &profile.id == id))
        {
            registry.default_profile_id = None;
        }
        self.write(&registry)?;
        let _ = std::fs::remove_dir_all(profile.directory);
        Ok(())
    }

    pub fn set_default(&self, profile_id: &str) -> Result<ChromiumProfileRecord, AppRuntimeError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut registry = self.read();
        let Some(profile) = registry
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
        else {
            return Err(AppRuntimeError::ProfileNotFound(format!(
                "Browser profile {profile_id} was not found."
            )));
        };
        registry.default_profile_id = Some(profile_id.to_string());
        self.write(&registry)?;
        Ok(profile)
    }

    pub fn resolve(&self, profile_id: &str) -> Result<ChromiumProfileRecord, AppRuntimeError> {
        let profile_id = profile_id.trim();
        if profile_id.is_empty()
            || profile_id.contains('/')
            || profile_id.contains('\\')
            || profile_id.contains('\0')
        {
            return Err(AppRuntimeError::ProfileNotFound(
                "Browser profile id is invalid.".to_string(),
            ));
        }
        let Some(profile) = self
            .read()
            .profiles
            .into_iter()
            .find(|profile| profile.id == profile_id)
        else {
            return Err(AppRuntimeError::ProfileNotFound(format!(
                "Browser profile {profile_id} was not found."
            )));
        };
        self.ensure_directory(PathBuf::from(&profile.directory))?;
        Ok(profile)
    }

    pub fn usage_bytes(&self, profile_id: &str) -> Result<u64, AppRuntimeError> {
        let profile = self.resolve(profile_id)?;
        Ok(directory_size(Path::new(&profile.directory)))
    }

    fn env_override_directory(&self) -> Option<PathBuf> {
        std::env::var_os("TASK_HANDOFF_CHROMIUM_USER_DATA_DIR")
            .and_then(|value| {
                let value = value.to_string_lossy().trim().to_string();
                (!value.is_empty()).then_some(value)
            })
            .map(|value| {
                let path = PathBuf::from(value);
                if path.is_absolute() {
                    path
                } else {
                    std::env::current_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                        .join(path)
                }
            })
    }

    fn read(&self) -> ChromiumProfileRegistry {
        let path = self.root.join("index.json");
        let Ok(raw) = read_json::<serde_json::Value>(&path) else {
            return ChromiumProfileRegistry {
                version: PROFILE_REGISTRY_VERSION,
                default_profile_id: None,
                profiles: Vec::new(),
            };
        };
        let mut registry =
            serde_json::from_value::<ChromiumProfileRegistry>(raw).unwrap_or_default();
        registry.version = PROFILE_REGISTRY_VERSION;
        registry.profiles.retain(|profile| {
            !profile.id.trim().is_empty()
                && !profile.name.trim().is_empty()
                && Path::new(&profile.directory).is_absolute()
                && !profile.created_at.is_empty()
                && !profile.updated_at.is_empty()
        });
        if registry
            .default_profile_id
            .as_ref()
            .is_some_and(|id| !registry.profiles.iter().any(|profile| &profile.id == id))
        {
            registry.default_profile_id = None;
        }
        registry
    }

    fn write(&self, registry: &ChromiumProfileRegistry) -> Result<(), AppRuntimeError> {
        std::fs::create_dir_all(&*self.root)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        write_json_atomic(&self.root.join("index.json"), registry, Some(0o600))
            .map_err(|error| AppRuntimeError::storage(error.to_string()))
    }

    fn ensure_directory(&self, path: PathBuf) -> Result<PathBuf, AppRuntimeError> {
        std::fs::create_dir_all(&path)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
        }
        Ok(path)
    }
}

pub fn profile_view(profile: ChromiumProfileRecord, default_profile_id: &str) -> AppProfile {
    let is_default = default_profile_id == profile.id;
    AppProfile {
        id: profile.id,
        name: profile.name,
        is_default,
        running_session_id: None,
        disk_usage_bytes: None,
        created_at: profile.created_at,
        updated_at: profile.updated_at,
    }
}

fn normalize_profile_name(name: &str) -> Result<String, AppRuntimeError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 60
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err(AppRuntimeError::ProfileNameInvalid(
            "Browser profile name must contain between 1 and 60 visible characters.".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let Ok(file_type) = entry.file_type() else {
                return 0;
            };
            if file_type.is_symlink() {
                return 0;
            }
            if file_type.is_dir() {
                return directory_size(&entry.path());
            }
            if file_type.is_file() {
                return entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            }
            0
        })
        .sum()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_profile_is_idempotent_and_the_previous_default_can_be_removed() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = ChromiumProfileStore::new(root.path());
        let first = store.ensure_default().expect("default");
        let second = store.ensure_default().expect("default again");
        assert_eq!(first.id, second.id);
        let extra = store.create("Work").expect("profile");
        store.set_default(&extra.id).expect("set default");
        store.remove(&first.id).expect("remove old default");
        let profiles = store.list().expect("list");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Work");
    }
}
