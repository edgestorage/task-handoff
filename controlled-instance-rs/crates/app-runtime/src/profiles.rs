use controlled_instance_core::atomic::{read_json, write_json_atomic};
use controlled_instance_protocol::{mint_entity_id, AppProfile};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::AppRuntimeError;

const PROFILE_REGISTRY_VERSION: u32 = 1;
const DEFAULT_PROFILE_NAME: &str = "Default";
const PROFILE_USAGE_CACHE_TTL: Duration = Duration::from_secs(60);

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

fn sanitize_registry(value: serde_json::Value) -> ChromiumProfileRegistry {
    let Some(record) = value.as_object() else {
        return ChromiumProfileRegistry {
            version: PROFILE_REGISTRY_VERSION,
            default_profile_id: None,
            profiles: Vec::new(),
        };
    };
    let profiles = record
        .get("profiles")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(sanitize_profile)
        .collect::<Vec<_>>();
    let default_profile_id = record
        .get("defaultProfileId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| profiles.iter().any(|profile| profile.id == *value))
        .map(ToString::to_string);
    ChromiumProfileRegistry {
        version: record
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .and_then(|version| u32::try_from(version).ok())
            .unwrap_or(PROFILE_REGISTRY_VERSION),
        default_profile_id,
        profiles,
    }
}

fn sanitize_profile(value: &serde_json::Value) -> Option<ChromiumProfileRecord> {
    let item = value.as_object()?;
    let text = |key: &str| item.get(key).and_then(serde_json::Value::as_str);
    let id = text("id")?.trim();
    let name = text("name")?.trim();
    let directory = text("directory")?.trim();
    let created_at = text("createdAt")?;
    let updated_at = text("updatedAt")?;
    if id.is_empty()
        || name.is_empty()
        || created_at.is_empty()
        || updated_at.is_empty()
        || !Path::new(directory).is_absolute()
    {
        return None;
    }
    Some(ChromiumProfileRecord {
        id: id.to_string(),
        name: name.to_string(),
        directory: directory.to_string(),
        created_at: created_at.to_string(),
        updated_at: updated_at.to_string(),
    })
}

#[derive(Clone)]
pub struct ChromiumProfileStore {
    root: Arc<PathBuf>,
    mutation: Arc<Mutex<()>>,
    usage_cache: Arc<Mutex<HashMap<String, (u64, Instant)>>>,
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
            usage_cache: Arc::new(Mutex::new(HashMap::new())),
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
            .any(|profile| profile.name.to_lowercase() == name.to_lowercase())
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
        if registry.profiles.iter().any(|profile| {
            profile.id != profile_id && profile.name.to_lowercase() == name.to_lowercase()
        }) {
            return Err(AppRuntimeError::ProfileNameConflict(format!(
                "Browser profile name \"{name}\" already exists."
            )));
        }
        let Some(profile) = registry
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id)
        else {
            return Err(AppRuntimeError::ProfileNotFound {
                message: format!("Browser profile {profile_id} was not found."),
                profile_id: None,
            });
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
            return Err(AppRuntimeError::ProfileNotFound {
                message: format!("Browser profile {profile_id} was not found."),
                profile_id: None,
            });
        };
        if registry.default_profile_id.as_deref() == Some(profile_id) {
            return Err(AppRuntimeError::ProfileDefaultProtected {
                message: "The default browser profile cannot be removed; change the default profile first."
                    .to_string(),
                profile_id: profile_id.to_string(),
            });
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
        match std::fs::remove_dir_all(&profile.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppRuntimeError::storage(error.to_string())),
        }
        self.usage_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(profile_id);
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
            return Err(AppRuntimeError::ProfileNotFound {
                message: format!("Browser profile {profile_id} was not found."),
                profile_id: None,
            });
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
            return Err(AppRuntimeError::ProfileNotFound {
                message: "Browser profile id is invalid.".to_string(),
                profile_id: Some(profile_id.to_string()),
            });
        }
        let Some(profile) = self
            .read()
            .profiles
            .into_iter()
            .find(|profile| profile.id == profile_id)
        else {
            return Err(AppRuntimeError::ProfileNotFound {
                message: format!("Browser profile {profile_id} was not found."),
                profile_id: Some(profile_id.to_string()),
            });
        };
        self.ensure_directory(PathBuf::from(&profile.directory))?;
        Ok(profile)
    }

    pub fn usage_bytes(&self, profile_id: &str) -> Result<u64, AppRuntimeError> {
        if let Some((bytes, measured_at)) = self
            .usage_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(profile_id)
            .copied()
        {
            if measured_at.elapsed() < PROFILE_USAGE_CACHE_TTL {
                return Ok(bytes);
            }
        }
        let profile = self.resolve(profile_id)?;
        let bytes = directory_size(Path::new(&profile.directory))?;
        self.usage_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(profile_id.to_string(), (bytes, Instant::now()));
        Ok(bytes)
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
        sanitize_registry(raw)
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
        || controlled_instance_core::text::utf16_len(trimmed) > 60
        || trimmed
            .chars()
            .any(|character| matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'))
    {
        return Err(AppRuntimeError::ProfileNameInvalid(
            "Browser profile name must contain between 1 and 60 visible characters.".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn directory_size(path: &Path) -> Result<u64, AppRuntimeError> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(AppRuntimeError::storage(error.to_string())),
    };
    let mut total = 0;
    for entry in entries {
        // Profile usage is best-effort: concurrent Chromium writes can remove
        // an entry between readdir and stat.
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total += directory_size(&entry.path()).unwrap_or(0);
            continue;
        }
        if file_type.is_file() {
            if let Ok(metadata) = entry.metadata() {
                total += metadata.len();
            }
        }
    }
    Ok(total)
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

    #[test]
    fn profile_names_conflict_with_unicode_case_folding() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = ChromiumProfileStore::new(root.path());
        store.create("Ärger").expect("profile");
        let error = store
            .create("ärger")
            .expect_err("case-insensitive conflict");
        assert_eq!(error.code(), "BROWSER_PROFILE_NAME_CONFLICT");
    }

    #[test]
    fn profile_names_reject_ascii_controls_but_allow_c1_characters() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = ChromiumProfileStore::new(root.path());
        let accepted = store.create("C1 \u{0085} name").expect("C1 profile name");
        assert_eq!(accepted.name, "C1 \u{0085} name");
        for rejected in ["\u{0000}", "\u{001f}", "\u{007f}"] {
            let error = store
                .create(rejected)
                .expect_err("ASCII control character must be rejected");
            assert_eq!(error.code(), "BROWSER_PROFILE_NAME_INVALID");
        }
    }

    #[test]
    fn directory_size_only_treats_missing_directories_as_empty() {
        let root = tempfile::tempdir().expect("tempdir");
        let missing = root.path().join("missing");
        assert_eq!(directory_size(&missing).expect("missing directory"), 0);

        let file = root.path().join("not-a-directory");
        std::fs::write(&file, b"content").expect("file");
        let error = directory_size(&file).expect_err("non-directory must fail");
        assert_eq!(error.code(), "APP_PERSISTENCE_FAILED");
    }
}
