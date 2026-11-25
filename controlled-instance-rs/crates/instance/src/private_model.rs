use chrono::{SecondsFormat, Utc};
use controlled_instance_ai_session::{
    AcpSessionHome, AiSessionModelSelection, AiSessionModelSelectionIntent,
    AiSessionModelSelectionResolver, AiSessionTitleGenerator, AiSessionTitleInput,
    OpenCodeModelSelectionProjector, ProviderError,
};
use controlled_instance_app_runtime::AppRuntime;
use controlled_instance_core::{
    atomic::{write_atomic, write_json_atomic},
    fs_permissions::restrict_path,
    managed_backup::{create_managed_backup, prune_managed_backups, DEFAULT_MANAGED_BACKUP_LIMIT},
    text::truncate_utf16,
};
use controlled_instance_protocol::{
    codex_model_provider_id, parse_codex_instance_settings, parse_instance_private_model_catalog,
    select_model_name_entry, sorted_model_name_entries, CodexInstanceSettings,
    InstancePrivateModelCatalog, ManagedModelEnvironment, PrivateModelCatalogSummary,
    PrivateModelNameEntry, PrivateModelProtocol,
};
use controlled_instance_workspace::ConfigSyncEnvironment;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

const MANAGED_PROVIDER_PREFIX: &str = controlled_instance_protocol::MANAGED_MODEL_PROVIDER_PREFIX;
const COMMAND_CODE_LOCAL_AUTH: &str = "task-handoff-local-only";
const MANAGED_ENV_KEYS: [&str; 9] = [
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "TASK_HANDOFF_CODEX_BASE_URL",
    "TASK_HANDOFF_CODEX_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "TASK_HANDOFF_CLAUDE_MODEL",
    "TASK_HANDOFF_OPENCODE_CONFIG_CONTENT",
];
const CLAUDE_SHADOWED_ENV: [&str; 6] = [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_MODEL",
    "TASK_HANDOFF_CLAUDE_MODEL",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedModelError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
}

impl ManagedModelError {
    fn new(code: impl Into<String>, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status_code,
        }
    }

    fn invalid(code: &str, error: impl fmt::Display) -> Self {
        Self::new(code, error.to_string(), 400)
    }

    fn failed(code: &str, error: impl fmt::Display) -> Self {
        Self::new(code, error.to_string(), 500)
    }
}

impl fmt::Display for ManagedModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ManagedModelError {}

impl From<io::Error> for ManagedModelError {
    fn from(error: io::Error) -> Self {
        Self::failed("MODEL_CONFIG_WRITE_FAILED", error)
    }
}

#[derive(Debug, Clone, Default)]
pub struct ManagedCodexConfigResult {
    pub applied: bool,
    pub provider_environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct ManagedClaudeConfigResult {
    pub applied: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ManagedModelEnvironmentApplyResult {
    pub codex_auth_configured: bool,
    pub claude_auth_configured: bool,
    pub config_updated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedModelConfigApplyResult {
    pub applied: bool,
    pub config_updated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedModelCatalogSnapshot {
    pub source: String,
    pub loaded_at: Option<String>,
    pub catalog: Option<PrivateModelCatalogSummary>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AcpPrivateLaunchConfig {
    pub env: BTreeMap<String, String>,
    pub args: Vec<String>,
    pub cleanup_dir: Option<PathBuf>,
    pub session_home: Option<AcpSessionHome>,
}

struct AcpModelEntity {
    id: String,
    protocol: PrivateModelProtocol,
    base_url: String,
    credential: String,
    model_names: Vec<PrivateModelNameEntry>,
}

#[derive(Debug)]
struct ModelConfigState {
    base_environment: BTreeMap<String, String>,
    managed_environment: BTreeMap<String, String>,
    catalog: Option<InstancePrivateModelCatalog>,
    source: String,
    loaded_at: Option<String>,
    codex_settings: Option<CodexInstanceSettings>,
}

/// Owns the private model files and managed process environment for one
/// controlled instance. The catalog, settings and managed environment live in
/// one lock so a live node-agent push is applied atomically from the runtime's
/// point of view.
#[derive(Debug)]
pub struct ControlledModelConfig {
    control_mode: crate::config::ControlMode,
    default_codex_home: PathBuf,
    default_claude_home: PathBuf,
    state: Mutex<ModelConfigState>,
}

impl ControlledModelConfig {
    pub fn load(
        _instance_id: &str,
        control_mode: crate::config::ControlMode,
        environment: &ConfigSyncEnvironment,
        process_environment: BTreeMap<String, String>,
        started_at: &str,
    ) -> Result<Self, ManagedModelError> {
        let (catalog, source) = read_catalog(&process_environment)?;
        let loaded_at = (source != "none").then(|| started_at.to_string());
        let codex_settings = read_codex_settings(&process_environment)?;
        let managed_environment = managed_environment_from_process(&process_environment);
        let config = Self {
            control_mode,
            default_codex_home: environment.codex_home.clone(),
            default_claude_home: environment.claude_home.clone(),
            state: Mutex::new(ModelConfigState {
                base_environment: process_environment,
                managed_environment,
                catalog,
                source,
                loaded_at,
                codex_settings,
            }),
        };
        {
            let mut state = config.lock();
            let codex = config.apply_codex(&mut state)?;
            state.managed_environment.extend(codex.provider_environment);
            config.apply_claude(&state)?;
        }
        Ok(config)
    }

    pub fn apply_environment(
        &self,
        next: ManagedModelEnvironment,
    ) -> Result<ManagedModelEnvironmentApplyResult, ManagedModelError> {
        next.validate().map_err(|error| {
            ManagedModelError::invalid("MANAGED_MODEL_ENVIRONMENT_INVALID", error)
        })?;
        let mut state = self.lock();
        for key in MANAGED_ENV_KEYS {
            if key != "CODEX_HOME" {
                state.managed_environment.remove(key);
            }
        }
        state.managed_environment.extend(
            next.entries()
                .into_iter()
                .map(|(key, value)| (key.to_string(), value)),
        );
        let codex = self.apply_codex(&mut state)?;
        let claude = self.apply_claude(&state)?;
        Ok(ManagedModelEnvironmentApplyResult {
            codex_auth_configured: next
                .openai_api_key
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            claude_auth_configured: next
                .anthropic_api_key
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            config_updated: codex.applied || claude.applied,
        })
    }

    pub fn apply_catalog(
        &self,
        value: Value,
    ) -> Result<ManagedModelConfigApplyResult, ManagedModelError> {
        let catalog = parse_catalog(value, None)?;
        let mut state = self.lock();
        state.catalog = Some(catalog);
        state.source = "live-sync".to_string();
        state.loaded_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        state
            .managed_environment
            .retain(|key, _| !key.starts_with("TASK_HANDOFF_CODEX_PROVIDER_"));
        let codex = self.apply_codex(&mut state)?;
        state
            .managed_environment
            .extend(codex.provider_environment.clone());
        Ok(ManagedModelConfigApplyResult {
            applied: true,
            config_updated: codex.applied,
        })
    }

    pub fn apply_codex_settings(
        &self,
        value: Value,
    ) -> Result<ManagedModelConfigApplyResult, ManagedModelError> {
        let settings = parse_codex_instance_settings(value)
            .map_err(|error| ManagedModelError::invalid("CODEX_SETTINGS_INVALID", error))?;
        let mut state = self.lock();
        state.codex_settings = Some(settings);
        let codex = self.apply_codex(&mut state)?;
        Ok(ManagedModelConfigApplyResult {
            applied: true,
            config_updated: codex.applied,
        })
    }

    pub fn reapply_after_config_import(
        &self,
        program_ids: &[String],
    ) -> Result<(), ManagedModelError> {
        let mut state = self.lock();
        if program_ids.iter().any(|id| id == "codex") {
            self.apply_codex(&mut state)?;
        }
        if program_ids.iter().any(|id| id == "claude") {
            self.apply_claude(&state)?;
        }
        Ok(())
    }

    pub fn catalog_snapshot(&self) -> ManagedModelCatalogSnapshot {
        let state = self.lock();
        ManagedModelCatalogSnapshot {
            source: state.source.clone(),
            loaded_at: state.loaded_at.clone(),
            catalog: state.catalog.as_ref().map(PrivateModelCatalogSummary::from),
        }
    }

    pub fn resolve_selection(
        &self,
        agent: &str,
        requested: Option<&AiSessionModelSelection>,
        intent: AiSessionModelSelectionIntent,
    ) -> Result<Option<AiSessionModelSelection>, ManagedModelError> {
        let protocols = private_model_protocols_for_agent(agent);
        if protocols.is_empty() {
            return Ok(None);
        }
        let state = self.lock();
        let Some(catalog) = state.catalog.as_ref() else {
            if requested.is_none() {
                return Ok(None);
            }
            return Err(ManagedModelError::new(
                "AI_SESSION_MODEL_CATALOG_UNAVAILABLE",
                "The model configuration is not loaded by this instance. Restart the instance to apply the latest model configuration.",
                409,
            ));
        };
        let mut entities = catalog.entities().into_iter().filter(|entity| {
            entity
                .protocols
                .iter()
                .any(|protocol| protocols.contains(protocol))
        });
        let entity = match requested {
            Some(selection) => entities.find(|entity| entity.id == selection.model_entity_id),
            None => entities.next(),
        };
        let Some(entity) = entity else {
            if requested.is_none() {
                return Ok(None);
            }
            return Err(stale_or_target_model_error(
                intent,
                "AI_SESSION_MODEL_ENTITY_UNAVAILABLE",
            ));
        };
        let names = sorted_model_name_entries(&entity.model_names);
        let entry = match requested {
            Some(selection) => selection
                .model_upstream_name
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .and_then(|model| names.iter().find(|entry| entry.identity() == model.trim()))
                .or_else(|| {
                    names
                        .iter()
                        .find(|entry| entry.identity() == selection.model_name.trim())
                })
                .or_else(|| {
                    names
                        .iter()
                        .find(|entry| entry.name == selection.model_name)
                }),
            None => names.first(),
        };
        let Some(entry) = entry else {
            return Err(stale_or_target_model_error(
                intent,
                "AI_SESSION_MODEL_NAME_UNAVAILABLE",
            ));
        };
        Ok(Some(AiSessionModelSelection {
            model_entity_id: entity.id,
            model_name: entry.name.clone(),
            model_upstream_name: Some(entry.identity().to_string()),
        }))
    }

    pub(crate) fn codex_title_model(
        &self,
        selection: Option<&AiSessionModelSelection>,
        observed_model: Option<&str>,
        observed_provider: Option<&str>,
    ) -> Option<(String, String)> {
        if let Some(selection) = selection {
            let selected = self
                .resolve_selection(
                    "codex",
                    Some(selection),
                    AiSessionModelSelectionIntent::Session,
                )
                .ok()??;
            return Some((
                selected.upstream_name().to_string(),
                codex_model_provider_id(&selected.model_entity_id),
            ));
        }
        Some((
            observed_model
                .map(str::trim)
                .filter(|model| !model.is_empty())?
                .to_string(),
            observed_provider
                .map(str::trim)
                .filter(|provider| !provider.is_empty())?
                .to_string(),
        ))
    }

    pub fn sync_app_environment(&self, runtime: &AppRuntime) {
        self.sync_app_environment_with_overrides(runtime, BTreeMap::new());
    }

    pub fn sync_app_environment_with_overrides(
        &self,
        runtime: &AppRuntime,
        overrides: BTreeMap<String, String>,
    ) {
        let environment = self.runtime_environment();
        let unset = CLAUDE_SHADOWED_ENV
            .into_iter()
            .map(ToString::to_string)
            .collect::<BTreeSet<_>>();
        let mut environment = environment;
        environment.extend(overrides);
        runtime.set_managed_environment_with_unset(environment, unset);
    }

    /// Environment entries that must be present in every managed agent/app
    /// process. This mirrors the Node runtime's managed-app environment and is
    /// also used by the direct Codex app-server connection.
    #[cfg(test)]
    pub(crate) fn acp_launch_config(
        &self,
        agent: &str,
        model_selection: Option<&AiSessionModelSelection>,
        data_dir: &Path,
    ) -> Result<AcpPrivateLaunchConfig, ManagedModelError> {
        self.acp_launch_config_for_session(agent, model_selection, data_dir, None, None)
    }

    pub(crate) fn acp_launch_config_for_session(
        &self,
        agent: &str,
        model_selection: Option<&AiSessionModelSelection>,
        data_dir: &Path,
        provider_session_id: Option<&str>,
        cwd: Option<&Path>,
    ) -> Result<AcpPrivateLaunchConfig, ManagedModelError> {
        let state = self.lock();
        let environment = self.current_environment(&state);
        let entities = state
            .catalog
            .as_ref()
            .map(|catalog| acp_model_entities(catalog, &environment, agent))
            .unwrap_or_default();
        if entities.is_empty() && agent != "gemini" {
            return Ok(AcpPrivateLaunchConfig::default());
        }
        fs::create_dir_all(data_dir)?;
        restrict_path(data_dir, 0o700)?;
        let root = data_dir.join(format!("acp-session-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        restrict_path(&root, 0o700)?;
        let session_home = if agent == "commandcode" {
            let home = AcpSessionHome {
                source: root.join(".commandcode"),
                durable_root: data_dir.join("acp-session-homes").join("commandcode"),
            };
            if let Some(provider_session_id) = provider_session_id {
                home.restore(provider_session_id).map_err(|error| {
                    ManagedModelError::failed("MODEL_CONFIG_WRITE_FAILED", error)
                })?;
            }
            Some(home)
        } else {
            None
        };
        let result = write_acp_model_config(agent, &entities, model_selection, &root, cwd);
        if result.is_err() {
            let _ = fs::remove_dir_all(&root);
        }
        result.map(|(env, args)| AcpPrivateLaunchConfig {
            env,
            args,
            cleanup_dir: Some(root),
            session_home,
        })
    }

    pub fn runtime_environment(&self) -> BTreeMap<String, String> {
        let state = self.lock();
        state
            .managed_environment
            .iter()
            .filter(|(key, _)| {
                MANAGED_ENV_KEYS.contains(&key.as_str())
                    || key.starts_with("TASK_HANDOFF_CODEX_PROVIDER_")
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    #[cfg(test)]
    fn managed_environment_value(&self, key: &str) -> Option<String> {
        self.lock().managed_environment.get(key).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ModelConfigState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn current_environment(&self, state: &ModelConfigState) -> BTreeMap<String, String> {
        let mut environment = state.base_environment.clone();
        environment.extend(state.managed_environment.clone());
        environment
    }

    fn apply_codex(
        &self,
        state: &mut ModelConfigState,
    ) -> Result<ManagedCodexConfigResult, ManagedModelError> {
        if self.control_mode != crate::config::ControlMode::Controlled {
            return Ok(ManagedCodexConfigResult::default());
        }
        let environment = self.current_environment(state);
        let entities = codex_entities(state.catalog.as_ref(), &environment);
        let default_entity = entities
            .iter()
            .find(|entity| entity.base_url.is_some())
            .cloned();
        let default_model = default_entity.as_ref().and_then(|entity| {
            sorted_model_name_entries(&entity.model_names)
                .first()
                .map(|entry| entry.identity().to_string())
        });
        let model = default_model
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| env_trimmed(&environment, "TASK_HANDOFF_CODEX_MODEL"));
        let base_url = env_trimmed(&environment, "TASK_HANDOFF_CODEX_BASE_URL");
        let api_key = env_trimmed(&environment, "OPENAI_API_KEY");
        let has_managed_model = if state.catalog.is_some() {
            default_entity.is_some() && model.is_some()
        } else {
            model.is_some() && base_url.is_some() && api_key.is_some()
        };
        if !has_managed_model && state.codex_settings.is_none() {
            return Ok(ManagedCodexConfigResult::default());
        }

        let home = env_trimmed(&environment, "CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_codex_home.clone());
        fs::create_dir_all(&home)?;
        restrict_path(&home, 0o700)?;
        let config_path = home.join("config.toml");
        let auth_path = home.join("auth.json");
        prune_managed_backups(&config_path, DEFAULT_MANAGED_BACKUP_LIMIT)?;

        let mut applied = false;
        if has_managed_model && state.catalog.is_none() {
            if let (Some(key), Some(base_url)) = (api_key.as_deref(), base_url.as_deref()) {
                let _ = base_url;
                let current_key = read_codex_auth_key(&auth_path);
                if current_key.as_deref() != Some(key) {
                    write_json_atomic(
                        &auth_path,
                        &serde_json::json!({ "auth_mode": "apikey", "OPENAI_API_KEY": key }),
                        Some(0o600),
                    )?;
                    applied = true;
                }
            }
        }

        let (current_contents, current) = read_codex_config_source(&config_path)?;
        let mut next = current.clone();
        let model_provider = default_entity
            .as_ref()
            .map(|entity| codex_provider_id(&entity.id))
            .unwrap_or_else(|| "openai".to_string());
        if has_managed_model {
            if let Some(model) = &model {
                next.insert("model".to_string(), toml::Value::String(model.clone()));
            }
            next.insert(
                "model_provider".to_string(),
                toml::Value::String(model_provider.clone()),
            );
            if state.catalog.is_some() {
                let mut providers = match next.remove("model_providers") {
                    Some(toml::Value::Table(providers)) => providers,
                    _ => toml::Table::new(),
                };
                providers.retain(|id, _| !id.starts_with(MANAGED_PROVIDER_PREFIX));
                for entity in entities.iter().filter(|entity| entity.base_url.is_some()) {
                    let provider_id = codex_provider_id(&entity.id);
                    let mut provider = toml::Table::new();
                    provider.insert(
                        "name".to_string(),
                        toml::Value::String(format!("TaskHandoff {}", entity.id)),
                    );
                    provider.insert(
                        "base_url".to_string(),
                        toml::Value::String(entity.base_url.clone().unwrap_or_default()),
                    );
                    provider.insert(
                        "env_key".to_string(),
                        toml::Value::String(codex_provider_api_key_env_name(&entity.id)),
                    );
                    provider.insert(
                        "wire_api".to_string(),
                        toml::Value::String("responses".to_string()),
                    );
                    providers.insert(provider_id, toml::Value::Table(provider));
                }
                next.insert("model_providers".to_string(), toml::Value::Table(providers));
            } else if let Some(base_url) = &base_url {
                next.insert(
                    "openai_base_url".to_string(),
                    toml::Value::String(base_url.clone()),
                );
            }
        }
        if let Some(settings) = &state.codex_settings {
            apply_codex_settings_to_toml(&mut next, settings, state.catalog.as_ref())?;
        }
        if next != current {
            if !current_contents.is_empty() {
                create_managed_backup(&config_path)?;
            }
            let contents = toml::to_string(&next)
                .map_err(|error| ManagedModelError::failed("CODEX_MODEL_CONFIG_INVALID", error))?;
            write_atomic(&config_path, contents.as_bytes(), Some(0o600))?;
            applied = true;
        }
        Ok(ManagedCodexConfigResult {
            applied,
            provider_environment: codex_provider_environment(&entities),
        })
    }

    fn apply_claude(
        &self,
        state: &ModelConfigState,
    ) -> Result<ManagedClaudeConfigResult, ManagedModelError> {
        if self.control_mode != crate::config::ControlMode::Controlled {
            return Ok(ManagedClaudeConfigResult::default());
        }
        let environment = self.current_environment(state);
        let Some(model) = env_trimmed(&environment, "TASK_HANDOFF_CLAUDE_MODEL") else {
            return Ok(ManagedClaudeConfigResult::default());
        };
        let Some(base_url) = env_trimmed(&environment, "ANTHROPIC_BASE_URL") else {
            return Ok(ManagedClaudeConfigResult::default());
        };
        let Some(api_key) = env_trimmed(&environment, "ANTHROPIC_API_KEY") else {
            return Ok(ManagedClaudeConfigResult::default());
        };
        let claude_home = env_trimmed(&environment, "CLAUDE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_claude_home.clone());
        fs::create_dir_all(&claude_home)?;
        restrict_path(&claude_home, 0o700)?;
        let settings_path = claude_home.join("settings.json");
        prune_managed_backups(&settings_path, DEFAULT_MANAGED_BACKUP_LIMIT)?;
        let (current_contents, mut settings) = read_claude_settings(&settings_path)?;
        let current_env = match settings.get("env") {
            Some(Value::Object(environment)) => environment.clone(),
            Some(_) => {
                return Err(ManagedModelError::failed(
                    "CLAUDE_MODEL_CONFIG_INVALID",
                    format!(
                        "Claude settings could not be read or parsed at {}: env must be a JSON object",
                        settings_path.display()
                    ),
                ));
            }
            None => serde_json::Map::new(),
        };
        let unchanged = current_env.get("ANTHROPIC_API_KEY").and_then(Value::as_str)
            == Some(api_key.as_str())
            && current_env
                .get("ANTHROPIC_BASE_URL")
                .and_then(Value::as_str)
                == Some(base_url.as_str())
            && current_env.get("ANTHROPIC_MODEL").and_then(Value::as_str) == Some(model.as_str())
            && !current_env.contains_key("ANTHROPIC_AUTH_TOKEN");
        if unchanged {
            return Ok(ManagedClaudeConfigResult { applied: false });
        }
        let mut next_env = current_env;
        next_env.insert("ANTHROPIC_API_KEY".to_string(), Value::String(api_key));
        next_env.insert("ANTHROPIC_BASE_URL".to_string(), Value::String(base_url));
        next_env.insert("ANTHROPIC_MODEL".to_string(), Value::String(model));
        // An older bearer token must never silently outrank the selected key.
        next_env.remove("ANTHROPIC_AUTH_TOKEN");
        settings.insert("env".to_string(), Value::Object(next_env));
        if !current_contents.is_empty() {
            create_managed_backup(&settings_path)?;
        }
        write_json_atomic(&settings_path, &Value::Object(settings), Some(0o600))?;
        Ok(ManagedClaudeConfigResult { applied: true })
    }
}

impl AiSessionModelSelectionResolver for ControlledModelConfig {
    fn resolve(
        &self,
        agent: &str,
        requested: Option<&AiSessionModelSelection>,
        intent: AiSessionModelSelectionIntent,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
        self.resolve_selection(agent, requested, intent)
            .map_err(|error| ProviderError::new(error.code, error.message, error.status_code))
    }

    fn supports_observed_model_projection(&self, agent: &str) -> bool {
        agent == "codex"
    }

    fn project_observed_model_selection(
        &self,
        agent: &str,
        model_provider: &str,
        model: &str,
    ) -> Option<AiSessionModelSelection> {
        if agent != "codex" {
            return None;
        }
        let state = self.lock();
        let catalog = state.catalog.as_ref()?;
        let entities = catalog
            .entities()
            .into_iter()
            .filter(|entity| {
                entity
                    .protocols
                    .contains(&PrivateModelProtocol::OpenAiResponses)
            })
            .collect::<Vec<_>>();
        // Codex persists the provider in its own namespace. Prefer the exact
        // managed provider mapping, then reconcile a legacy/generic provider by
        // a model name that is unique in this instance catalog.
        let entity = entities
            .iter()
            .find(|entity| codex_model_provider_id(&entity.id) == model_provider)
            .or_else(|| {
                let matches = entities
                    .iter()
                    .filter(|entity| {
                        entity
                            .model_names
                            .iter()
                            .any(|entry| entry.identity() == model || entry.name == model)
                    })
                    .collect::<Vec<_>>();
                (matches.len() == 1).then_some(matches[0])
            })?;
        let entry = select_model_name_entry(&entity.model_names, model)?;
        Some(AiSessionModelSelection {
            model_entity_id: entity.id.clone(),
            model_name: entry.name.clone(),
            model_upstream_name: Some(entry.identity().to_string()),
        })
    }
}

impl OpenCodeModelSelectionProjector for ControlledModelConfig {
    fn project_model_selection(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Option<AiSessionModelSelection> {
        let state = self.lock();
        let catalog = state.catalog.as_ref()?;
        let entity_id =
            provider_id.strip_prefix(controlled_instance_protocol::MANAGED_MODEL_PROVIDER_PREFIX);
        let entities = catalog.entities();
        let matches = entities
            .iter()
            .filter(|entity| {
                entity
                    .protocols
                    .contains(&PrivateModelProtocol::OpenAiChatCompletions)
                    && entity_id.is_none_or(|entity_id| entity.id == entity_id)
                    && select_model_name_entry(&entity.model_names, model_id).is_some()
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return None;
        }
        let entity = matches[0];
        let entry = select_model_name_entry(&entity.model_names, model_id)?;
        Some(AiSessionModelSelection {
            model_entity_id: entity.id.clone(),
            model_name: entry.name.clone(),
            model_upstream_name: Some(entry.identity().to_string()),
        })
    }
}

#[async_trait::async_trait]
impl AiSessionTitleGenerator for ControlledModelConfig {
    async fn generate_title(&self, input: AiSessionTitleInput) -> Result<String, ProviderError> {
        let (protocol, url, credential) = {
            let state = self.lock();
            let catalog = state.catalog.as_ref().ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_TITLE_MODEL_UNAVAILABLE",
                    "The selected title model is unavailable in this instance.",
                    409,
                )
            })?;
            let entity = catalog
                .entities()
                .into_iter()
                .find(|entity| entity.id == input.model_selection.model_entity_id)
                .ok_or_else(|| {
                    ProviderError::new(
                        "AI_SESSION_TITLE_MODEL_UNAVAILABLE",
                        "The selected title model is unavailable in this instance.",
                        409,
                    )
                })?;
            let protocol = [
                PrivateModelProtocol::OpenAiResponses,
                PrivateModelProtocol::OpenAiChatCompletions,
            ]
            .into_iter()
            .find(|protocol| {
                entity.protocols.contains(protocol)
                    && catalog.base_url(&entity.id, *protocol).is_some()
            })
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_TITLE_PROTOCOL_UNAVAILABLE",
                    "The selected title model has no OpenAI-compatible route.",
                    409,
                )
            })?;
            let base_url = catalog
                .base_url(&entity.id, protocol)
                .expect("selected title route");
            let credential = match catalog {
                InstancePrivateModelCatalog::Direct { entities, .. } => entities
                    .iter()
                    .find(|candidate| candidate.id == entity.id)
                    .map(|candidate| candidate.key.clone()),
                InstancePrivateModelCatalog::Relay { .. } => {
                    let environment = self.current_environment(&state);
                    env_trimmed(&environment, "TASK_HANDOFF_REGISTRATION_TOKEN")
                }
            }
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_TITLE_CREDENTIAL_UNAVAILABLE",
                    "The selected title model has no usable route credential.",
                    409,
                )
            })?;
            (protocol, title_route_url(base_url, protocol), credential)
        };
        let model = input
            .model_selection
            .model_upstream_name
            .as_deref()
            .unwrap_or(&input.model_selection.model_name);
        let body = title_request_body(
            protocol,
            model,
            &input.prompt,
            &input.output_schema,
            input.reasoning_effort.as_deref(),
        );
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_TITLE_MODEL_REQUEST_FAILED",
                    error.to_string(),
                    502,
                )
            })?
            .post(url)
            .bearer_auth(credential)
            .header("accept", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_TITLE_MODEL_REQUEST_FAILED",
                    format!("Title model request failed: {error}"),
                    502,
                )
            })?;
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ProviderError::new(
                "AI_SESSION_TITLE_MODEL_REQUEST_FAILED",
                format!(
                    "Title model returned HTTP {}: {}",
                    status.as_u16(),
                    bounded_text(&raw, 4000)
                ),
                502,
            ));
        }
        let parsed = serde_json::from_str::<Value>(&raw).map_err(|_| {
            ProviderError::new(
                "AI_SESSION_TITLE_MODEL_RESPONSE_INVALID",
                "Title model returned invalid JSON.",
                502,
            )
        })?;
        title_response_text(protocol, &parsed).ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_TITLE_MODEL_RESPONSE_INVALID",
                "Title model returned no text output.",
                502,
            )
        })
    }
}

fn title_route_url(base_url: &str, protocol: PrivateModelProtocol) -> String {
    format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        if protocol == PrivateModelProtocol::OpenAiResponses {
            "/responses"
        } else {
            "/chat/completions"
        }
    )
}

fn title_request_body(
    protocol: PrivateModelProtocol,
    model: &str,
    prompt: &str,
    output_schema: &Value,
    reasoning_effort: Option<&str>,
) -> Value {
    if protocol == PrivateModelProtocol::OpenAiResponses {
        let mut body = json!({
            "model": model,
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": prompt }] }],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "ai_session_title",
                    "strict": true,
                    "schema": output_schema,
                }
            }
        });
        if let Some(effort) = reasoning_effort {
            body["reasoning"] = json!({ "effort": effort });
        }
        return body;
    }
    let mut body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "ai_session_title",
                "strict": true,
                "schema": output_schema,
            }
        }
    });
    if let Some(effort) = reasoning_effort {
        body["reasoning_effort"] = json!(effort);
    }
    body
}

fn title_response_text(protocol: PrivateModelProtocol, value: &Value) -> Option<String> {
    if protocol == PrivateModelProtocol::OpenAiResponses {
        if let Some(text) = value
            .get("output_text")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Some(text.to_string());
        }
        for item in value.get("output").and_then(Value::as_array)? {
            if item.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            for content in item
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if content.get("type").and_then(Value::as_str) == Some("output_text") {
                    if let Some(text) = content
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                    {
                        return Some(text.to_string());
                    }
                }
            }
        }
        return None;
    }
    let choice = value.get("choices").and_then(Value::as_array)?.first()?;
    let message = choice.get("message").unwrap_or(&Value::Null);
    if let Some(text) = message
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Some(text.to_string());
    }
    for content in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if matches!(
            content.get("type").and_then(Value::as_str),
            Some("text" | "output_text")
        ) {
            if let Some(text) = content
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                return Some(text.to_string());
            }
        }
    }
    choice
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn bounded_text(value: &str, limit: usize) -> String {
    truncate_utf16(value, limit)
}

fn acp_model_entities(
    catalog: &InstancePrivateModelCatalog,
    environment: &BTreeMap<String, String>,
    agent: &str,
) -> Vec<AcpModelEntity> {
    let protocols = private_model_protocols_for_agent(agent);
    let relay_credential = env_trimmed(environment, "TASK_HANDOFF_REGISTRATION_TOKEN");
    catalog
        .entities()
        .into_iter()
        .flat_map(|entity| {
            let (protocol, base_url) = protocols.iter().find_map(|protocol| {
                entity.protocols.contains(protocol).then(|| {
                    catalog
                        .base_url(&entity.id, *protocol)
                        .map(|base_url| (*protocol, base_url.to_string()))
                })?
            })?;
            let credential = match catalog {
                InstancePrivateModelCatalog::Direct { entities, .. } => entities
                    .iter()
                    .find(|candidate| candidate.id == entity.id)
                    .map(|candidate| candidate.key.clone())
                    .unwrap_or_default(),
                InstancePrivateModelCatalog::Relay { .. } => {
                    relay_credential.clone().unwrap_or_default()
                }
            };
            Some(AcpModelEntity {
                id: entity.id,
                protocol,
                base_url,
                credential,
                model_names: entity.model_names,
            })
        })
        .collect()
}

fn acp_managed_provider_key(model_entity_id: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_invalid = false;
    for character in model_entity_id.to_lowercase().chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '-')
        {
            normalized.push(character);
            previous_was_invalid = false;
        } else if !previous_was_invalid {
            normalized.push('-');
            previous_was_invalid = true;
        }
    }
    let normalized = normalized.trim_matches('-');
    format!(
        "{}{}",
        controlled_instance_protocol::MANAGED_MODEL_PROVIDER_PREFIX,
        if normalized.is_empty() {
            "model"
        } else {
            normalized
        }
    )
}

fn acp_gemini_base_url(base_url: &str) -> String {
    base_url
        .strip_suffix("/v1beta/")
        .or_else(|| base_url.strip_suffix("/v1beta"))
        .unwrap_or(base_url)
        .trim_end_matches('/')
        .to_string()
}

fn write_acp_model_file(
    root: &Path,
    relative: &Path,
    contents: &str,
) -> Result<PathBuf, ManagedModelError> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        restrict_path(parent, 0o700)?;
    }
    write_atomic(&path, contents.as_bytes(), Some(0o600))?;
    Ok(path)
}

fn write_acp_model_config(
    agent: &str,
    entities: &[AcpModelEntity],
    selection: Option<&AiSessionModelSelection>,
    root: &Path,
    cwd: Option<&Path>,
) -> Result<(BTreeMap<String, String>, Vec<String>), ManagedModelError> {
    let mut env = BTreeMap::new();
    if agent == "gemini" {
        if let Some(cwd) = cwd {
            // Gemini 0.71.1 rejects autoEdit/yolo outside a trusted folder.
            // Trust only the session workspace instead of enabling a global
            // trust-everything switch.
            let trust = write_acp_model_file(
                root,
                Path::new("trustedFolders.json"),
                &serde_json::to_string_pretty(&json!({
                    cwd.to_string_lossy().as_ref(): "TRUST_FOLDER"
                }))
                .map_err(|error| ManagedModelError::failed("MODEL_CONFIG_WRITE_FAILED", error))?,
            )?;
            env.insert(
                "GEMINI_CLI_TRUSTED_FOLDERS_PATH".to_string(),
                trust.to_string_lossy().into_owned(),
            );
        }
        let target = selection
            .and_then(|selection| {
                entities
                    .iter()
                    .find(|entity| entity.id == selection.model_entity_id)
            })
            .or_else(|| entities.first());
        let Some(target) = target else {
            return Ok((env, Vec::new()));
        };
        let model = selection
            .map(AiSessionModelSelection::upstream_name)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                target
                    .model_names
                    .first()
                    .map(PrivateModelNameEntry::identity)
            })
            .unwrap_or_default();
        if target.base_url.trim().is_empty() {
            return Err(ManagedModelError::new(
                "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
                "The selected Gemini model has no configured relay route.",
                409,
            ));
        }
        env.insert(
            "GOOGLE_GEMINI_BASE_URL".to_string(),
            acp_gemini_base_url(&target.base_url),
        );
        env.insert("GEMINI_API_KEY".to_string(), target.credential.clone());
        env.insert("GOOGLE_API_KEY".to_string(), target.credential.clone());
        env.insert("GOOGLE_GENAI_USE_VERTEXAI".to_string(), "false".to_string());
        env.insert("GEMINI_MODEL".to_string(), model.to_string());
        return Ok((env, Vec::new()));
    }
    if agent == "commandcode" {
        let mut providers = serde_json::Map::new();
        for (index, entity) in entities.iter().enumerate() {
            let env_name = format!("TASK_HANDOFF_ACP_MODEL_KEY_{index}");
            env.insert(env_name.clone(), entity.credential.clone());
            let api = match entity.protocol {
                PrivateModelProtocol::OpenAiChatCompletions => "openai-completions",
                PrivateModelProtocol::OpenAiResponses => "openai-responses",
                PrivateModelProtocol::AnthropicMessages => "anthropic-messages",
                PrivateModelProtocol::GoogleGenerativeAi => "google-generative-ai",
            };
            let models = entity
                .model_names
                .iter()
                .map(|entry| {
                    (
                        entry.identity().to_string(),
                        json!({
                            "name": entry.name,
                            "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
                        }),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            providers.insert(
                acp_managed_provider_key(&entity.id),
                json!({
                    "name": entity.id,
                    "api": api,
                    "baseURL": entity.base_url,
                    "apiKey": format!("${env_name}"),
                    "models": models,
                }),
            );
        }
        let contents = serde_json::to_string_pretty(&json!({ "provider": providers }))
            .map_err(|error| ManagedModelError::failed("MODEL_CONFIG_WRITE_FAILED", error))?;
        write_acp_model_file(
            root,
            Path::new(".commandcode").join("providers.json").as_path(),
            &format!("{contents}\n"),
        )?;
        env.insert("HOME".to_string(), root.display().to_string());
        // Command Code rejects session/new without an auth token even when all
        // models are private BYOK providers. Local-only mode prevents Command
        // Code traffic, and this fixed value is not a usable cloud credential.
        env.insert(
            "COMMAND_CODE_API_KEY".to_string(),
            COMMAND_CODE_LOCAL_AUTH.to_string(),
        );
        env.insert("CMD_LOCAL_ONLY".to_string(), "1".to_string());
        return Ok((env, Vec::new()));
    }
    let mut lines = vec![
        "- id: llm-pi-ai".to_string(),
        "  config:".to_string(),
        "    providers:".to_string(),
    ];
    for (index, entity) in entities.iter().enumerate() {
        let provider_key = acp_managed_provider_key(&entity.id);
        let env_name = format!("TASK_HANDOFF_ACP_MODEL_KEY_{index}");
        env.insert(env_name.clone(), entity.credential.clone());
        let api = match entity.protocol {
            PrivateModelProtocol::OpenAiChatCompletions => "openai-completions",
            PrivateModelProtocol::OpenAiResponses => "openai-responses",
            PrivateModelProtocol::AnthropicMessages => "anthropic-messages",
            PrivateModelProtocol::GoogleGenerativeAi => "google-generative-ai",
        };
        let base_url = if entity.protocol == PrivateModelProtocol::GoogleGenerativeAi
            && !entity.base_url.trim_end_matches('/').ends_with("/v1beta")
        {
            // pi-ai treats a Google baseURL as already versioned. Relay routes
            // end at /v1, so add the operation prefix expected by the adapter.
            format!("{}/v1beta", entity.base_url.trim_end_matches('/'))
        } else {
            entity.base_url.clone()
        };
        lines.push(format!("      {}:", yaml_string(&provider_key)));
        lines.push(format!("        displayName: {}", yaml_string(&entity.id)));
        lines.push(format!("        apiKeyEnv: {}", yaml_string(&env_name)));
        lines.push(format!("        api: {}", yaml_string(api)));
        lines.push(format!("        baseURL: {}", yaml_string(&base_url)));
        lines.push("        models:".to_string());
        for entry in &entity.model_names {
            lines.push(format!("          - id: {}", yaml_string(entry.identity())));
            lines.push(format!("            name: {}", yaml_string(&entry.name)));
            lines.push("            reasoningEfforts:".to_string());
            lines.push("              \"off\":".to_string());
            lines.push("              minimal: \"minimal\"".to_string());
            lines.push("              low: \"low\"".to_string());
            lines.push("              medium: \"medium\"".to_string());
            lines.push("              high: \"high\"".to_string());
            if entity.protocol != PrivateModelProtocol::GoogleGenerativeAi {
                lines.push("              xhigh: \"xhigh\"".to_string());
                lines.push("              max: \"max\"".to_string());
            }
        }
    }
    let patch = write_acp_model_file(
        root,
        Path::new("acp-model.patch.yml"),
        &format!("{}\n", lines.join("\n")),
    )?;
    env.insert("DSH_HOME".to_string(), root.display().to_string());
    Ok((
        env,
        vec!["--patch".to_string(), patch.display().to_string()],
    ))
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

const CODEX_MODEL_PROTOCOLS: &[PrivateModelProtocol] = &[PrivateModelProtocol::OpenAiResponses];
const CLAUDE_MODEL_PROTOCOLS: &[PrivateModelProtocol] = &[PrivateModelProtocol::AnthropicMessages];
const OPENCODE_MODEL_PROTOCOLS: &[PrivateModelProtocol] =
    &[PrivateModelProtocol::OpenAiChatCompletions];
const GEMINI_MODEL_PROTOCOLS: &[PrivateModelProtocol] = &[PrivateModelProtocol::GoogleGenerativeAi];
const COMMANDCODE_MODEL_PROTOCOLS: &[PrivateModelProtocol] = &[
    PrivateModelProtocol::OpenAiChatCompletions,
    PrivateModelProtocol::OpenAiResponses,
    PrivateModelProtocol::AnthropicMessages,
];
const DSH_MODEL_PROTOCOLS: &[PrivateModelProtocol] = &[
    PrivateModelProtocol::OpenAiChatCompletions,
    PrivateModelProtocol::OpenAiResponses,
    PrivateModelProtocol::AnthropicMessages,
    PrivateModelProtocol::GoogleGenerativeAi,
];

fn private_model_protocols_for_agent(agent: &str) -> &'static [PrivateModelProtocol] {
    match agent {
        "codex" => CODEX_MODEL_PROTOCOLS,
        "claude" => CLAUDE_MODEL_PROTOCOLS,
        "opencode" => OPENCODE_MODEL_PROTOCOLS,
        "gemini" => GEMINI_MODEL_PROTOCOLS,
        "commandcode" => COMMANDCODE_MODEL_PROTOCOLS,
        "dsh" => DSH_MODEL_PROTOCOLS,
        _ => &[],
    }
}

fn stale_or_target_model_error(
    intent: AiSessionModelSelectionIntent,
    code: &str,
) -> ManagedModelError {
    if intent == AiSessionModelSelectionIntent::Target {
        ManagedModelError::new(
            "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
            "The selected model has not taken effect in this running instance. Try again in a moment, or restart the instance to apply the latest model configuration.",
            409,
        )
    } else {
        ManagedModelError::new(
            code,
            "The model previously selected for this session is no longer available. Select another model to continue.",
            409,
        )
    }
}

#[derive(Debug, Clone)]
struct CodexEntity {
    id: String,
    base_url: Option<String>,
    model_names: Vec<PrivateModelNameEntry>,
    api_key: Option<String>,
}

fn codex_entities(
    catalog: Option<&InstancePrivateModelCatalog>,
    environment: &BTreeMap<String, String>,
) -> Vec<CodexEntity> {
    let Some(catalog) = catalog else {
        return Vec::new();
    };
    let relay_credential = env_trimmed(environment, "TASK_HANDOFF_REGISTRATION_TOKEN");
    match catalog {
        InstancePrivateModelCatalog::Direct { entities, .. } => entities
            .iter()
            .filter(|entity| {
                entity
                    .protocols
                    .contains(&PrivateModelProtocol::OpenAiResponses)
            })
            .map(|entity| CodexEntity {
                id: entity.id.clone(),
                base_url: Some(entity.endpoint.clone()),
                model_names: entity.model_names.clone(),
                api_key: Some(entity.key.clone()),
            })
            .collect(),
        InstancePrivateModelCatalog::Relay { entities, .. } => entities
            .iter()
            .filter(|entity| {
                entity
                    .protocols
                    .contains(&PrivateModelProtocol::OpenAiResponses)
            })
            .map(|entity| CodexEntity {
                id: entity.id.clone(),
                base_url: catalog
                    .base_url(&entity.id, PrivateModelProtocol::OpenAiResponses)
                    .map(ToString::to_string),
                model_names: entity.model_names.clone(),
                api_key: relay_credential.clone(),
            })
            .collect(),
    }
}

fn codex_provider_environment(entities: &[CodexEntity]) -> BTreeMap<String, String> {
    entities
        .iter()
        .filter_map(|entity| {
            entity
                .api_key
                .as_ref()
                .filter(|key| !key.is_empty())
                .map(|key| (codex_provider_api_key_env_name(&entity.id), key.clone()))
        })
        .collect()
}

fn codex_provider_id(model_entity_id: &str) -> String {
    codex_model_provider_id(model_entity_id)
}

fn codex_provider_api_key_env_name(model_entity_id: &str) -> String {
    let provider = codex_provider_id(model_entity_id);
    let normalized = provider
        .to_uppercase()
        .chars()
        .map(|character| {
            if character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("TASK_HANDOFF_CODEX_PROVIDER_{normalized}_API_KEY")
}

fn apply_codex_settings_to_toml(
    config: &mut toml::Table,
    settings: &CodexInstanceSettings,
    catalog: Option<&InstancePrivateModelCatalog>,
) -> Result<(), ManagedModelError> {
    config.remove("model_verbosity");
    config.remove("personality");
    if let Some(value) = settings.model_verbosity {
        config.insert(
            "model_verbosity".to_string(),
            toml::Value::String(
                match value {
                    controlled_instance_protocol::CodexModelVerbosity::Low => "low",
                    controlled_instance_protocol::CodexModelVerbosity::Medium => "medium",
                    controlled_instance_protocol::CodexModelVerbosity::High => "high",
                }
                .to_string(),
            ),
        );
    }
    if let Some(value) = settings.personality {
        config.insert(
            "personality".to_string(),
            toml::Value::String(
                match value {
                    controlled_instance_protocol::CodexPersonality::None => "none",
                    controlled_instance_protocol::CodexPersonality::Friendly => "friendly",
                    controlled_instance_protocol::CodexPersonality::Pragmatic => "pragmatic",
                }
                .to_string(),
            ),
        );
    }
    let mut agents = match config.remove("agents") {
        Some(toml::Value::Table(agents)) => agents,
        _ => toml::Table::new(),
    };
    for key in [
        "enabled",
        "max_concurrent_threads_per_session",
        "default_subagent_model",
        "default_subagent_reasoning_effort",
    ] {
        agents.remove(key);
    }
    agents.insert(
        "enabled".to_string(),
        toml::Value::Boolean(settings.multi_agent.enabled),
    );
    if let Some(value) = settings.multi_agent.max_concurrent_threads {
        agents.insert(
            "max_concurrent_threads_per_session".to_string(),
            toml::Value::Integer(i64::from(value)),
        );
    }
    if let Some(default_model) = &settings.multi_agent.default_model {
        let entity = catalog.and_then(|catalog| match catalog {
            InstancePrivateModelCatalog::Direct { entities, .. } => entities
                .iter()
                .find(|entity| {
                    entity.id == default_model.model_entity_id
                        && entity
                            .protocols
                            .contains(&PrivateModelProtocol::OpenAiResponses)
                })
                .map(|entity| entity.model_names.as_slice()),
            InstancePrivateModelCatalog::Relay { entities, .. } => entities
                .iter()
                .find(|entity| {
                    entity.id == default_model.model_entity_id
                        && entity
                            .protocols
                            .contains(&PrivateModelProtocol::OpenAiResponses)
                })
                .map(|entity| entity.model_names.as_slice()),
        });
        let sorted = entity.map(sorted_model_name_entries).unwrap_or_default();
        let entry = default_model
            .model_upstream_name
            .as_deref()
            .and_then(|model| select_model_name_entry(&sorted, model))
            .or_else(|| select_model_name_entry(&sorted, &default_model.model_name));
        let Some(entry) = entry else {
            return Err(ManagedModelError::new(
                "CODEX_SUBAGENT_MODEL_UNAVAILABLE",
                "The configured Codex subagent model is not assigned to this instance.",
                400,
            ));
        };
        agents.insert(
            "default_subagent_model".to_string(),
            toml::Value::String(entry.identity().to_string()),
        );
    }
    if let Some(value) = &settings.multi_agent.default_reasoning_effort {
        agents.insert(
            "default_subagent_reasoning_effort".to_string(),
            toml::Value::String(value.clone()),
        );
    }
    config.insert("agents".to_string(), toml::Value::Table(agents));
    Ok(())
}

fn read_catalog(
    process_environment: &BTreeMap<String, String>,
) -> Result<(Option<InstancePrivateModelCatalog>, String), ManagedModelError> {
    if let Some(serialized) = process_environment.get("TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON") {
        let value = serde_json::from_str::<Value>(serialized)
            .map_err(|error| ManagedModelError::invalid("PRIVATE_MODEL_CATALOG_INVALID", error))?;
        let catalog = parse_catalog(value, expected_instance_id(process_environment).as_deref())?;
        return Ok((Some(catalog), "environment".to_string()));
    }
    if process_environment
        .get("TASK_HANDOFF_PRIVATE_CONFIG_LOADED")
        .is_some_and(|value| value == "1")
    {
        return Ok((None, "none".to_string()));
    }
    let Some(root) = read_private_config_root(process_environment)? else {
        return Ok((None, "none".to_string()));
    };
    let Some(value) = root.get("modelCatalog").cloned() else {
        return Ok((None, "none".to_string()));
    };
    let catalog = parse_catalog(value, expected_instance_id(process_environment).as_deref())?;
    Ok((Some(catalog), "private-config-file".to_string()))
}

fn parse_catalog(
    value: Value,
    expected_instance_id: Option<&str>,
) -> Result<InstancePrivateModelCatalog, ManagedModelError> {
    parse_instance_private_model_catalog(value, expected_instance_id).map_err(|error| match error {
        controlled_instance_protocol::PrivateModelCatalogParseError::InstanceIdentityMismatch => {
            ManagedModelError::new(
                "PRIVATE_MODEL_CATALOG_IDENTITY_MISMATCH",
                "Private model catalog instance identity does not match this runtime.",
                400,
            )
        }
        error => ManagedModelError::invalid("PRIVATE_MODEL_CATALOG_INVALID", error.to_string()),
    })
}

fn read_codex_settings(
    process_environment: &BTreeMap<String, String>,
) -> Result<Option<CodexInstanceSettings>, ManagedModelError> {
    if let Some(serialized) = process_environment.get("TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON") {
        let value = serde_json::from_str::<Value>(serialized)
            .map_err(|error| ManagedModelError::invalid("CODEX_SETTINGS_INVALID", error))?;
        return parse_codex_instance_settings(value)
            .map(Some)
            .map_err(|error| ManagedModelError::invalid("CODEX_SETTINGS_INVALID", error));
    }
    if process_environment
        .get("TASK_HANDOFF_PRIVATE_CONFIG_LOADED")
        .is_some_and(|value| value == "1")
    {
        return Ok(None);
    }
    let Some(root) = read_private_config_root(process_environment)? else {
        return Ok(None);
    };
    match root.get("codexSettings").cloned() {
        Some(value) => parse_codex_instance_settings(value)
            .map(Some)
            .map_err(|error| ManagedModelError::invalid("CODEX_SETTINGS_INVALID", error)),
        None => Ok(None),
    }
}

fn read_private_config_root(
    process_environment: &BTreeMap<String, String>,
) -> Result<Option<serde_json::Map<String, Value>>, ManagedModelError> {
    let path = process_environment
        .get("TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let Some(path) = path else {
        return Ok(None);
    };
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ManagedModelError::failed("PRIVATE_CONFIG_INVALID", error)),
    };
    match serde_json::from_str::<Value>(&contents) {
        Ok(Value::Object(root)) => Ok(Some(root)),
        Ok(_) => Ok(None),
        Err(error) => Err(ManagedModelError::invalid("PRIVATE_CONFIG_INVALID", error)),
    }
}

fn expected_instance_id(environment: &BTreeMap<String, String>) -> Option<String> {
    environment
        .get("TASK_HANDOFF_INSTANCE_ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn managed_environment_from_process(
    environment: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    environment
        .iter()
        .filter(|(key, _)| {
            MANAGED_ENV_KEYS.contains(&key.as_str())
                || key.starts_with("TASK_HANDOFF_CODEX_PROVIDER_")
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn env_trimmed(environment: &BTreeMap<String, String>, key: &str) -> Option<String> {
    environment
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
fn read_codex_config(path: &Path) -> Result<toml::Table, ManagedModelError> {
    read_codex_config_source(path).map(|(_, config)| config)
}

fn read_codex_config_source(path: &Path) -> Result<(String, toml::Table), ManagedModelError> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            if contents.trim().is_empty() {
                return Ok((contents, toml::Table::new()));
            }
            toml::from_str(&contents)
                .map(|config| (contents, config))
                .map_err(|error| {
                    ManagedModelError::failed(
                        "CODEX_MODEL_CONFIG_INVALID",
                        format!(
                            "Codex config could not be read or parsed at {}: {error}",
                            path.display()
                        ),
                    )
                })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok((String::new(), toml::Table::new()))
        }
        Err(error) => Err(ManagedModelError::failed(
            "CODEX_MODEL_CONFIG_INVALID",
            format!(
                "Codex config could not be read or parsed at {}: {error}",
                path.display()
            ),
        )),
    }
}

fn read_codex_auth_key(path: &Path) -> Option<String> {
    let value = serde_json::from_str::<Value>(&fs::read_to_string(path).ok()?).ok()?;
    (value.get("auth_mode").and_then(Value::as_str) == Some("apikey"))
        .then(|| {
            value
                .get("OPENAI_API_KEY")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .flatten()
}

fn read_claude_settings(
    path: &Path,
) -> Result<(String, serde_json::Map<String, Value>), ManagedModelError> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(ManagedModelError::failed(
                "CLAUDE_MODEL_CONFIG_INVALID",
                format!(
                    "Claude settings could not be read or parsed at {}: {error}",
                    path.display()
                ),
            ));
        }
    };
    if contents.trim().is_empty() {
        return Ok((contents, serde_json::Map::new()));
    }
    match serde_json::from_str::<Value>(&contents) {
        Ok(Value::Object(settings)) => Ok((contents, settings)),
        Ok(_) => Err(ManagedModelError::failed(
            "CLAUDE_MODEL_CONFIG_INVALID",
            format!(
                "Claude settings could not be read or parsed at {}: the root value must be a JSON object",
                path.display()
            ),
        )),
        Err(error) => Err(ManagedModelError::failed(
            "CLAUDE_MODEL_CONFIG_INVALID",
            format!(
                "Claude settings could not be read or parsed at {}: {error}",
                path.display()
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ControlMode;
    use axum::{
        body::to_bytes,
        extract::State as AxumState,
        http::{header::AUTHORIZATION, StatusCode},
        response::{IntoResponse, Response},
        routing::any,
        Json, Router,
    };
    use serde_json::json;
    use std::sync::Arc;

    #[derive(Debug, Clone)]
    struct CapturedTitleRequest {
        path: String,
        authorization: Option<String>,
        body: Value,
    }

    #[derive(Clone)]
    struct FakeTitleServer {
        status: StatusCode,
        response: Value,
        requests: Arc<Mutex<Vec<CapturedTitleRequest>>>,
    }

    async fn fake_title_server(
        AxumState(state): AxumState<FakeTitleServer>,
        request: axum::extract::Request,
    ) -> Response {
        let path = request.uri().path().to_string();
        let authorization = request
            .headers()
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let bytes = to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap_or_default();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        state
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(CapturedTitleRequest {
                path,
                authorization,
                body,
            });
        (state.status, Json(state.response)).into_response()
    }

    async fn start_title_server(
        status: StatusCode,
        response: Value,
    ) -> (String, Arc<Mutex<Vec<CapturedTitleRequest>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = FakeTitleServer {
            status,
            response,
            requests: requests.clone(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("title listener");
        let address = listener.local_addr().expect("title address");
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .fallback(any(fake_title_server))
                    .with_state(state),
            )
            .await
            .expect("title server");
        });
        (format!("http://{address}"), requests)
    }

    fn model_environment(root: &Path) -> ConfigSyncEnvironment {
        ConfigSyncEnvironment {
            home: root.join("home"),
            workspace: root.join("workspace"),
            codex_home: root.join("home/.codex"),
            claude_home: root.join("home/.claude"),
            data_dir: root.join("data"),
            log_dir: root.join("data/logs"),
            artifact_dir: root.join("data/artifacts"),
        }
    }

    fn process_environment(root: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("HOME".to_string(), root.join("home").display().to_string()),
            (
                "CODEX_HOME".to_string(),
                root.join("home/.codex").display().to_string(),
            ),
            (
                "CLAUDE_HOME".to_string(),
                root.join("home/.claude").display().to_string(),
            ),
            (
                "TASK_HANDOFF_REGISTRATION_TOKEN".to_string(),
                "relay-credential".to_string(),
            ),
        ])
    }

    fn direct_catalog() -> Value {
        json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-primary",
                "protocols": ["openai-responses", "anthropic-messages"],
                "modelNames": [{
                    "upstreamName": "upstream-primary",
                    "name": "Primary Label",
                    "order": 0
                }],
                "endpoint": "https://models.example/v1",
                "key": "direct-secret"
            }],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        })
    }

    fn title_catalog(endpoint: &str, protocols: &[&str]) -> Value {
        json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-title",
                "protocols": protocols,
                "modelNames": [{
                    "upstreamName": "upstream-title",
                    "name": "Title Label",
                    "order": 0
                }],
                "endpoint": endpoint,
                "key": "direct-secret"
            }],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        })
    }

    fn opencode_catalog() -> Value {
        json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [
                {
                    "id": "chat-one",
                    "protocols": ["openai-chat-completions"],
                    "modelNames": [{
                        "upstreamName": "chat-upstream",
                        "name": "Chat One",
                        "order": 0
                    }],
                    "endpoint": "https://chat.example/v1",
                    "key": "chat-secret"
                },
                {
                    "id": "shared-a",
                    "protocols": ["openai-chat-completions"],
                    "modelNames": [{
                        "upstreamName": "shared-upstream",
                        "name": "Shared A",
                        "order": 0
                    }],
                    "endpoint": "https://chat.example/v1",
                    "key": "chat-secret"
                },
                {
                    "id": "shared-b",
                    "protocols": ["openai-chat-completions"],
                    "modelNames": [{
                        "upstreamName": "shared-upstream",
                        "name": "Shared B",
                        "order": 0
                    }],
                    "endpoint": "https://chat.example/v1",
                    "key": "chat-secret"
                }
            ],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        })
    }

    fn config_with_catalog(root: &Path, catalog: Value) -> ControlledModelConfig {
        let environment = model_environment(root);
        let mut process = process_environment(root);
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            catalog.to_string(),
        );
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_0000000000000".to_string(),
        );
        ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config")
    }

    fn title_input() -> AiSessionTitleInput {
        AiSessionTitleInput {
            prompt: "Fix the migration rollout".to_string(),
            output_schema: controlled_instance_ai_session::ai_session_title_output_schema(),
            model_selection: AiSessionModelSelection {
                model_entity_id: "model-title".to_string(),
                model_name: "Title Label".to_string(),
                model_upstream_name: Some("upstream-title".to_string()),
            },
            reasoning_effort: Some("high".to_string()),
        }
    }

    fn selection_projection(
        config: &ControlledModelConfig,
        agent: &str,
        requested: Option<&AiSessionModelSelection>,
        intent: AiSessionModelSelectionIntent,
    ) -> Value {
        match config.resolve_selection(agent, requested, intent) {
            Ok(Some(selection)) => json!({
                "modelEntityId": selection.model_entity_id,
                "modelName": selection.model_name,
                "modelUpstreamName": selection.model_upstream_name,
            }),
            Ok(None) => Value::Null,
            Err(error) => json!({
                "code": error.code,
                "statusCode": error.status_code,
                "message": error.message,
            }),
        }
    }

    fn source_projection(config: &ControlledModelConfig) -> Value {
        let snapshot = config.catalog_snapshot();
        let catalog = {
            let state = config.lock();
            state.catalog.as_ref().map(|catalog| {
                let has_key = serde_json::to_string(catalog)
                    .expect("catalog json")
                    .contains("secret");
                json!({
                    "instanceId": catalog.instance_id(),
                    "entityIds": catalog.entities().into_iter().map(|entity| entity.id).collect::<Vec<_>>(),
                    "hasKey": has_key,
                })
            })
        };
        json!({ "source": snapshot.source, "catalog": catalog })
    }

    #[test]
    fn direct_catalog_configures_codex_and_exposes_no_key_in_summary() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            direct_catalog().to_string(),
        );
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_0000000000000".to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let parsed = read_codex_config(&root.path().join("home/.codex/config.toml")).expect("toml");
        assert_eq!(parsed["model"].as_str(), Some("upstream-primary"));
        assert_eq!(
            parsed["model_providers"]["task-handoff-model-primary"]["base_url"].as_str(),
            Some("https://models.example/v1")
        );
        assert_eq!(
            config.managed_environment_value(
                "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_PRIMARY_API_KEY"
            ),
            Some("direct-secret".to_string())
        );
        let summary = serde_json::to_value(config.catalog_snapshot()).expect("snapshot");
        assert!(summary.get("key").is_none());
        assert!(!summary.to_string().contains("direct-secret"));
    }

    #[test]
    fn relay_catalog_uses_registration_credential_and_route_url() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            json!({
                "protocolVersion": "2026-10-02",
                "instanceId": "ins_0000000000000",
                "entities": [{
                    "id": "relay-primary",
                    "protocols": ["openai-responses"],
                    "modelNames": [{"name": "Relay Model", "order": 0}],
                    "routes": [{
                        "protocol": "openai-responses",
                        "baseUrl": "https://relay.example/instances/ins_0000000000000"
                    }]
                }],
                "updatedAt": "2026-11-02T00:00:00.000Z"
            })
            .to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let parsed = read_codex_config(&root.path().join("home/.codex/config.toml")).expect("toml");
        assert_eq!(
            parsed["model_providers"]["task-handoff-relay-primary"]["base_url"].as_str(),
            Some("https://relay.example/instances/ins_0000000000000")
        );
        assert_eq!(
            config.managed_environment_value(
                "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_RELAY_PRIMARY_API_KEY"
            ),
            Some("relay-credential".to_string())
        );
        assert_eq!(
            config
                .runtime_environment()
                .get("TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_RELAY_PRIMARY_API_KEY"),
            Some(&"relay-credential".to_string())
        );
    }

    #[test]
    fn claude_settings_remove_the_stale_auth_token_and_keep_unknown_fields() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        fs::create_dir_all(root.path().join("home/.claude")).expect("claude home");
        fs::write(
            root.path().join("home/.claude/settings.json"),
            serde_json::to_vec_pretty(&json!({
                "theme": "dark",
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "old-token",
                    "KEEP": "value"
                }
            }))
            .expect("json"),
        )
        .expect("settings");
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process_environment(root.path()),
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        config
            .apply_environment(ManagedModelEnvironment {
                anthropic_api_key: Some("new-key".to_string()),
                anthropic_base_url: Some("https://claude.example".to_string()),
                claude_model: Some("claude-private".to_string()),
                ..ManagedModelEnvironment::default()
            })
            .expect("environment");
        let settings: Value = serde_json::from_slice(
            &fs::read(root.path().join("home/.claude/settings.json")).expect("settings"),
        )
        .expect("json");
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["env"]["KEEP"], "value");
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "new-key");
        assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "claude-private");
        assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
    }

    #[test]
    fn config_import_reapplies_the_managed_codex_configuration() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            direct_catalog().to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let path = root.path().join("home/.codex/config.toml");
        fs::write(&path, "model = \"imported-model\"\n").expect("imported config");
        config
            .reapply_after_config_import(&["codex".to_string()])
            .expect("reapply");
        let parsed = read_codex_config(&path).expect("toml");
        assert_eq!(parsed["model"].as_str(), Some("upstream-primary"));
    }

    #[test]
    fn live_catalog_materializes_for_restart_and_invalid_input_keeps_previous_state() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            direct_catalog().to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process.clone(),
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let config_path = root.path().join("home/.codex/config.toml");
        assert_eq!(
            read_codex_config(&config_path).expect("initial config")["model"].as_str(),
            Some("upstream-primary")
        );

        let next_catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-secondary",
                "protocols": ["openai-responses"],
                "modelNames": [{
                    "upstreamName": "upstream-secondary",
                    "name": "Secondary Label",
                    "order": 0
                }],
                "endpoint": "https://secondary.example/v1",
                "key": "secondary-secret"
            }],
            "updatedAt": "2026-11-02T00:00:02.000Z"
        });
        let applied = config
            .apply_catalog(next_catalog.clone())
            .expect("live catalog apply");
        assert!(applied.applied);
        assert!(applied.config_updated);
        let parsed = read_codex_config(&config_path).expect("live config");
        assert_eq!(parsed["model"].as_str(), Some("upstream-secondary"));
        assert_eq!(
            parsed["model_providers"]["task-handoff-model-secondary"]["base_url"].as_str(),
            Some("https://secondary.example/v1")
        );
        assert_eq!(
            config.managed_environment_value(
                "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_SECONDARY_API_KEY"
            ),
            Some("secondary-secret".to_string())
        );
        assert!(config
            .managed_environment_value(
                "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_PRIMARY_API_KEY"
            )
            .is_none());
        let snapshot = config.catalog_snapshot();
        assert_eq!(snapshot.source, "live-sync");
        assert_eq!(
            snapshot.catalog.as_ref().expect("catalog").entities[0].id,
            "model-secondary"
        );

        // A restarted instance receives the same catalog from the node-agent
        // private configuration and must materialize the same Codex config.
        let mut restarted_process = process_environment(root.path());
        restarted_process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            next_catalog.to_string(),
        );
        let restarted = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            restarted_process,
            "2026-11-02T00:00:03.000Z",
        )
        .expect("restarted model config");
        let parsed = read_codex_config(&config_path).expect("restarted config");
        assert_eq!(parsed["model"].as_str(), Some("upstream-secondary"));
        assert_eq!(
            restarted
                .resolve_selection("codex", None, AiSessionModelSelectionIntent::Session)
                .expect("selection")
                .expect("selected model")
                .model_entity_id,
            "model-secondary"
        );

        let before_invalid = fs::read_to_string(&config_path).expect("config bytes");
        let error = restarted
            .apply_catalog(json!({ "protocolVersion": "2026-08-27" }))
            .expect_err("invalid catalog must be rejected");
        assert_eq!(error.code, "PRIVATE_MODEL_CATALOG_INVALID");
        assert_eq!(error.status_code, 400);
        assert_eq!(
            restarted
                .catalog_snapshot()
                .catalog
                .as_ref()
                .expect("catalog")
                .entities[0]
                .id,
            "model-secondary"
        );
        assert_eq!(
            fs::read_to_string(&config_path).expect("config survives"),
            before_invalid
        );
    }

    #[test]
    fn live_catalog_write_failure_surfaces_and_can_be_retried() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            direct_catalog().to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let codex_home = root.path().join("home/.codex");
        fs::remove_dir_all(&codex_home).expect("remove codex home");
        fs::write(&codex_home, "not a directory").expect("blocking codex home");
        let next_catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-secondary",
                "protocols": ["openai-responses"],
                "modelNames": [{
                    "upstreamName": "upstream-secondary",
                    "name": "Secondary Label",
                    "order": 0
                }],
                "endpoint": "https://secondary.example/v1",
                "key": "secondary-secret"
            }],
            "updatedAt": "2026-11-02T00:00:02.000Z"
        });
        let error = config
            .apply_catalog(next_catalog.clone())
            .expect_err("blocked codex home must fail the write");
        assert_eq!(error.code, "MODEL_CONFIG_WRITE_FAILED");
        assert_eq!(error.status_code, 500);

        fs::remove_file(&codex_home).expect("remove blocking file");
        fs::create_dir_all(&codex_home).expect("restore codex home");
        config
            .apply_catalog(next_catalog)
            .expect("retry after restoring the directory");
        let parsed =
            read_codex_config(&root.path().join("home/.codex/config.toml")).expect("retry config");
        assert_eq!(parsed["model"].as_str(), Some("upstream-secondary"));
    }

    #[test]
    fn codex_settings_sanitize_unknown_fields_before_strict_parsing() {
        let settings = parse_codex_instance_settings(json!({
            "modelVerbosity": "high",
            "multiAgent": {
                "enabled": false,
                "futureField": "ignored",
                "defaultModel": {
                    "modelEntityId": "model-primary",
                    "modelName": "Primary",
                    "futureField": "ignored"
                }
            },
            "futureField": "ignored"
        }))
        .expect("settings");
        assert!(!settings.multi_agent.enabled);
        assert_eq!(
            settings.model_verbosity,
            Some(controlled_instance_protocol::CodexModelVerbosity::High)
        );
        assert!(
            parse_codex_instance_settings(json!({ "multiAgent": { "enabled": "yes" } })).is_err()
        );
    }

    #[test]
    fn codex_title_model_uses_the_catalog_selection_before_observed_thread_settings() {
        let root = tempfile::tempdir().unwrap();
        let config = config_with_catalog(root.path(), direct_catalog());
        let mut selection = AiSessionModelSelection {
            model_entity_id: "model-primary".into(),
            model_name: "Primary Label".into(),
            model_upstream_name: Some("upstream-primary".into()),
        };
        assert_eq!(
            config.codex_title_model(
                Some(&selection),
                Some("stale-model"),
                Some("stale-provider")
            ),
            Some((
                "upstream-primary".into(),
                codex_model_provider_id("model-primary")
            ))
        );
        selection.model_entity_id = "removed-model".into();
        assert!(config
            .codex_title_model(
                Some(&selection),
                Some("stale-model"),
                Some("stale-provider")
            )
            .is_none());
        assert_eq!(
            config.codex_title_model(None, Some("observed"), Some("openai")),
            Some(("observed".into(), "openai".into()))
        );
    }

    #[test]
    fn model_selection_resolves_to_stable_identity_after_display_rename() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            direct_catalog().to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let original = AiSessionModelSelection {
            model_entity_id: "model-primary".to_string(),
            model_name: "Primary Label".to_string(),
            model_upstream_name: Some("upstream-primary".to_string()),
        };
        let selected = config
            .resolve_selection(
                "codex",
                Some(&original),
                AiSessionModelSelectionIntent::Session,
            )
            .expect("selection")
            .expect("selected model");
        assert_eq!(selected.model_name, "Primary Label");
        assert_eq!(
            selected.model_upstream_name.as_deref(),
            Some("upstream-primary")
        );

        let mut renamed = direct_catalog();
        renamed["entities"][0]["modelNames"][0]["name"] = json!("Renamed Label");
        config
            .apply_catalog(renamed)
            .expect("apply renamed catalog");
        let selected = config
            .resolve_selection(
                "codex",
                Some(&original),
                AiSessionModelSelectionIntent::Session,
            )
            .expect("selection after rename")
            .expect("selected model after rename");
        assert_eq!(selected.model_entity_id, "model-primary");
        assert_eq!(selected.model_name, "Renamed Label");
        assert_eq!(
            selected.model_upstream_name.as_deref(),
            Some("upstream-primary")
        );

        let default = config
            .resolve_selection("codex", None, AiSessionModelSelectionIntent::Target)
            .expect("default selection")
            .expect("default model");
        assert_eq!(default.model_entity_id, "model-primary");
    }

    #[test]
    fn model_selection_projection_matches_node_fixture() {
        let fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/private-model-selection-parity.json"
            ))
            .expect("fixture"),
        )
        .expect("fixture json");
        let catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-primary",
                "endpoint": "https://models.example/v1",
                "key": "secret",
                "protocols": ["openai-responses"],
                "modelNames": [
                    {"name": "Primary Label", "upstreamName": "upstream-primary", "order": 0},
                    {"name": "Secondary Label", "upstreamName": "upstream-secondary", "order": 1}
                ]
            }],
            "updatedAt": "2026-11-20T00:00:00.000Z"
        });
        let mut renamed = catalog.clone();
        renamed["entities"][0]["modelNames"] = json!([
            {"name": "Renamed Primary", "upstreamName": "upstream-primary", "order": 0},
            {"name": "Secondary Label", "upstreamName": "upstream-secondary", "order": 1}
        ]);
        let mut colliding = catalog.clone();
        colliding["entities"][0]["modelNames"] = json!([
            {"name": "shared", "upstreamName": "upstream-a", "order": 0},
            {"name": "upstream-a", "upstreamName": "shared", "order": 1}
        ]);
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            catalog.to_string(),
        );
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_0000000000000".to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let default = selection_projection(
            &config,
            "codex",
            None,
            AiSessionModelSelectionIntent::Target,
        );
        let unsupported = selection_projection(
            &config,
            "unknown",
            None,
            AiSessionModelSelectionIntent::Target,
        );
        let stale_entity = AiSessionModelSelection {
            model_entity_id: "removed".to_string(),
            model_name: "Primary Label".to_string(),
            model_upstream_name: None,
        };
        let stale_entity_target = selection_projection(
            &config,
            "codex",
            Some(&stale_entity),
            AiSessionModelSelectionIntent::Target,
        );
        let stale_entity_session = selection_projection(
            &config,
            "codex",
            Some(&stale_entity),
            AiSessionModelSelectionIntent::Session,
        );
        let stale_name = AiSessionModelSelection {
            model_entity_id: "model-primary".to_string(),
            model_name: "removed-model".to_string(),
            model_upstream_name: None,
        };
        let stale_name_target = selection_projection(
            &config,
            "codex",
            Some(&stale_name),
            AiSessionModelSelectionIntent::Target,
        );
        let stale_name_session = selection_projection(
            &config,
            "codex",
            Some(&stale_name),
            AiSessionModelSelectionIntent::Session,
        );

        config.apply_catalog(renamed).expect("renamed catalog");
        let stored_label = AiSessionModelSelection {
            model_entity_id: "model-primary".to_string(),
            model_name: "Primary Label".to_string(),
            model_upstream_name: Some("upstream-primary".to_string()),
        };
        let renamed_session = selection_projection(
            &config,
            "codex",
            Some(&stored_label),
            AiSessionModelSelectionIntent::Session,
        );
        let upstream_client_name = AiSessionModelSelection {
            model_entity_id: "model-primary".to_string(),
            model_name: "upstream-primary".to_string(),
            model_upstream_name: None,
        };
        let upstream_client_name = selection_projection(
            &config,
            "codex",
            Some(&upstream_client_name),
            AiSessionModelSelectionIntent::Target,
        );

        config.apply_catalog(colliding).expect("colliding catalog");
        let colliding = AiSessionModelSelection {
            model_entity_id: "model-primary".to_string(),
            model_name: "shared".to_string(),
            model_upstream_name: None,
        };
        let colliding = selection_projection(
            &config,
            "codex",
            Some(&colliding),
            AiSessionModelSelectionIntent::Target,
        );
        config.apply_catalog(catalog).expect("base catalog");
        let summary = serde_json::to_value(
            config
                .catalog_snapshot()
                .catalog
                .expect("private model catalog summary"),
        )
        .expect("summary");
        let actual = json!({
            "scenarios": [
                {"name": "default", "result": default},
                {"name": "unsupported-agent", "result": unsupported},
                {"name": "renamed-session", "result": renamed_session},
                {"name": "upstream-client-name", "result": upstream_client_name},
                {"name": "colliding-identity-wins", "result": colliding},
                {"name": "stale-entity-target", "error": stale_entity_target},
                {"name": "stale-entity-session", "error": stale_entity_session},
                {"name": "stale-name-target", "error": stale_name_target},
                {"name": "stale-name-session", "error": stale_name_session}
            ],
            "summary": summary,
            "summaryLeaksKey": summary.to_string().contains("secret")
        });
        assert_eq!(actual, fixture);
    }

    #[test]
    fn private_model_catalog_source_and_identity_errors_match_node_fixture() {
        let fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/private-model-source-parity.json"
            ))
            .expect("fixture"),
        )
        .expect("fixture json");
        let catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-primary",
                "endpoint": "https://models.example/v1",
                "key": "secret",
                "protocols": ["openai-responses"],
                "modelNames": [{"name": "Primary Label", "upstreamName": "upstream-primary", "order": 0}]
            }],
            "updatedAt": "2026-11-20T00:00:00.000Z"
        });
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());

        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_0000000000000".to_string(),
        );
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            catalog.to_string(),
        );
        let environment_config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("environment catalog");
        let environment_source = source_projection(&environment_config);

        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_0000000000000".to_string(),
        );
        process.insert(
            "TASK_HANDOFF_PRIVATE_CONFIG_LOADED".to_string(),
            "1".to_string(),
        );
        let loaded_without_catalog = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("loaded without catalog");
        let loaded_without_catalog_source = source_projection(&loaded_without_catalog);

        let private_config_path = root.path().join("private-config.json");
        std::fs::write(
            &private_config_path,
            json!({ "modelCatalog": catalog }).to_string(),
        )
        .expect("private config");
        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_0000000000000".to_string(),
        );
        process.insert(
            "TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH".to_string(),
            private_config_path.display().to_string(),
        );
        let file_config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("private config catalog");
        let file_source = source_projection(&file_config);

        let mut process = process_environment(root.path());
        process.insert(
            "TASK_HANDOFF_INSTANCE_ID".to_string(),
            "ins_other".to_string(),
        );
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            catalog.to_string(),
        );
        let error = ControlledModelConfig::load(
            "ins_other",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect_err("identity mismatch must fail");
        let actual = json!({
            "sources": [environment_source, loaded_without_catalog_source, file_source],
            "identityMismatch": {
                "code": error.code,
                "message": error.message,
                "leaksKey": error.message.contains("secret")
            }
        });
        assert_eq!(actual, fixture);
    }

    #[test]
    fn missing_target_and_missing_catalog_use_distinct_error_codes() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process_environment(root.path()),
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let requested = AiSessionModelSelection {
            model_entity_id: "missing".to_string(),
            model_name: "Missing".to_string(),
            model_upstream_name: None,
        };
        let error = config
            .resolve_selection(
                "codex",
                Some(&requested),
                AiSessionModelSelectionIntent::Target,
            )
            .expect_err("missing catalog must fail");
        assert_eq!(error.code, "AI_SESSION_MODEL_CATALOG_UNAVAILABLE");
        assert_eq!(error.status_code, 409);

        config.apply_catalog(direct_catalog()).expect("catalog");
        let error = config
            .resolve_selection(
                "codex",
                Some(&requested),
                AiSessionModelSelectionIntent::Target,
            )
            .expect_err("missing target must fail");
        assert_eq!(error.code, "AI_SESSION_MODEL_TARGET_UNAVAILABLE");
        assert_eq!(error.status_code, 409);
    }

    #[test]
    fn codex_provider_identity_is_derived_from_the_stable_entity_id() {
        assert_eq!(
            codex_provider_id("Model.Primary/One"),
            "task-handoff-model-primary-one"
        );
    }

    #[test]
    fn opencode_model_projection_requires_a_unique_chat_match() {
        let root = tempfile::tempdir().expect("tempdir");
        let config = config_with_catalog(root.path(), opencode_catalog());
        let exact = config
            .project_model_selection("task-handoff-chat-one", "chat-upstream")
            .expect("exact provider match");
        assert_eq!(exact.model_entity_id, "chat-one");
        assert_eq!(exact.model_name, "Chat One");
        assert_eq!(exact.model_upstream_name.as_deref(), Some("chat-upstream"));

        let unique_by_model = config
            .project_model_selection("unmanaged-provider", "chat-upstream")
            .expect("unique model identity");
        assert_eq!(unique_by_model.model_entity_id, "chat-one");

        assert!(config
            .project_model_selection("unmanaged-provider", "shared-upstream")
            .is_none());
        assert!(config
            .project_model_selection("task-handoff-chat-one", "missing-model")
            .is_none());
    }

    #[test]
    fn title_request_shapes_and_routes_match_the_node_contract() {
        let schema = controlled_instance_ai_session::ai_session_title_output_schema();
        let responses = title_request_body(
            PrivateModelProtocol::OpenAiResponses,
            "upstream-title",
            "Prompt",
            &schema,
            Some("high"),
        );
        assert_eq!(responses["model"], "upstream-title");
        assert_eq!(responses["reasoning"]["effort"], "high");
        assert_eq!(
            responses["text"]["format"]["schema"]["properties"]["title"]["maxLength"],
            36
        );
        assert_eq!(
            title_route_url(
                "https://models.example/v1/",
                PrivateModelProtocol::OpenAiResponses
            ),
            "https://models.example/v1/responses"
        );

        let chat = title_request_body(
            PrivateModelProtocol::OpenAiChatCompletions,
            "upstream-title",
            "Prompt",
            &schema,
            Some("high"),
        );
        assert_eq!(chat["messages"][0]["content"], "Prompt");
        assert_eq!(chat["reasoning_effort"], "high");
        assert_eq!(chat["response_format"]["type"], "json_schema");
        assert_eq!(
            title_route_url(
                "https://models.example/v1",
                PrivateModelProtocol::OpenAiChatCompletions
            ),
            "https://models.example/v1/chat/completions"
        );
    }

    #[tokio::test]
    async fn title_generator_prefers_responses_with_the_direct_credential() {
        let (endpoint, requests) = start_title_server(
            StatusCode::OK,
            json!({
                "output": [{
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": "{\"title\":\"Fix migration\"}"
                    }]
                }]
            }),
        )
        .await;
        let root = tempfile::tempdir().expect("tempdir");
        let config = config_with_catalog(
            root.path(),
            title_catalog(
                &format!("{endpoint}/v1"),
                &["openai-chat-completions", "openai-responses"],
            ),
        );
        let response = config
            .generate_title(title_input())
            .await
            .expect("generated title response");
        assert_eq!(
            controlled_instance_ai_session::parse_ai_session_title(&response).as_deref(),
            Some("Fix migration")
        );
        let requests = requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/responses");
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("Bearer direct-secret")
        );
        assert_eq!(requests[0].body["model"], "upstream-title");
    }

    #[tokio::test]
    async fn title_generator_falls_back_to_chat_and_rejects_empty_output() {
        let (endpoint, requests) = start_title_server(
            StatusCode::OK,
            json!({ "choices": [{ "message": { "content": "" } }] }),
        )
        .await;
        let root = tempfile::tempdir().expect("tempdir");
        let config = config_with_catalog(
            root.path(),
            title_catalog(&format!("{endpoint}/v1"), &["openai-chat-completions"]),
        );
        let error = config
            .generate_title(title_input())
            .await
            .expect_err("empty output must fail");
        assert_eq!(error.code, "AI_SESSION_TITLE_MODEL_RESPONSE_INVALID");
        let requests = requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/chat/completions");
        assert_eq!(requests[0].body["model"], "upstream-title");
    }

    #[tokio::test]
    async fn relay_title_generation_requires_the_registration_credential() {
        let root = tempfile::tempdir().expect("tempdir");
        let environment = model_environment(root.path());
        let mut process = process_environment(root.path());
        process.remove("TASK_HANDOFF_REGISTRATION_TOKEN");
        process.insert(
            "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON".to_string(),
            json!({
                "protocolVersion": "2026-10-02",
                "instanceId": "ins_0000000000000",
                "entities": [{
                    "id": "model-title",
                    "protocols": ["openai-responses"],
                    "modelNames": [{
                        "upstreamName": "upstream-title",
                        "name": "Title Label",
                        "order": 0
                    }],
                    "routes": [{
                        "protocol": "openai-responses",
                        "baseUrl": "https://relay.example/instances/ins_0000000000000"
                    }]
                }],
                "updatedAt": "2026-11-02T00:00:00.000Z"
            })
            .to_string(),
        );
        let config = ControlledModelConfig::load(
            "ins_0000000000000",
            ControlMode::Controlled,
            &environment,
            process,
            "2026-11-02T00:00:01.000Z",
        )
        .expect("model config");
        let error = config
            .generate_title(title_input())
            .await
            .expect_err("relay credential is required");
        assert_eq!(error.code, "AI_SESSION_TITLE_CREDENTIAL_UNAVAILABLE");
    }

    #[test]
    fn codex_observation_projects_managed_provider_to_public_model_identity() {
        let root = tempfile::tempdir().expect("tempdir");
        let config = config_with_catalog(root.path(), direct_catalog());

        let projected = config
            .project_observed_model_selection(
                "codex",
                "task-handoff-model-primary",
                "upstream-primary",
            )
            .expect("projected model");
        assert_eq!(
            projected,
            AiSessionModelSelection {
                model_entity_id: "model-primary".to_string(),
                model_name: "Primary Label".to_string(),
                model_upstream_name: Some("upstream-primary".to_string()),
            }
        );
        assert_eq!(
            config
                .project_observed_model_selection("codex", "openai", "upstream-primary")
                .expect("legacy provider fallback")
                .model_name,
            "Primary Label"
        );
    }

    #[test]
    fn codex_observation_does_not_guess_between_ambiguous_model_names() {
        let root = tempfile::tempdir().expect("tempdir");
        let ambiguous = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [
                {
                    "id": "model-a",
                    "protocols": ["openai-responses"],
                    "modelNames": [{"name": "Shared", "order": 0}],
                    "endpoint": "https://a.example/v1",
                    "key": "a-secret"
                },
                {
                    "id": "model-b",
                    "protocols": ["openai-responses"],
                    "modelNames": [{"name": "Shared", "order": 0}],
                    "endpoint": "https://b.example/v1",
                    "key": "b-secret"
                }
            ],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        });
        let config = config_with_catalog(root.path(), ambiguous);

        assert!(config
            .project_observed_model_selection("codex", "openai", "Shared")
            .is_none());
        assert_eq!(
            config
                .project_observed_model_selection("codex", "task-handoff-model-b", "Shared",)
                .expect("exact provider wins")
                .model_entity_id,
            "model-b"
        );
    }

    #[test]
    fn acp_agents_resolve_catalog_models_and_write_private_launch_config() {
        let root = tempfile::tempdir().expect("tempdir");
        let catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "model-primary",
                "protocols": [
                    "openai-responses",
                    "openai-chat-completions",
                    "anthropic-messages",
                    "google-generative-ai"
                ],
                "modelNames": [{
                    "upstreamName": "upstream-primary",
                    "name": "Primary Label",
                    "order": 0
                }],
                "endpoint": "https://models.example/v1beta",
                "key": "secret"
            }],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        });
        let config = config_with_catalog(root.path(), catalog);
        let selection = AiSessionModelSelection {
            model_entity_id: "model-primary".into(),
            model_name: "Primary Label".into(),
            model_upstream_name: Some("upstream-primary".into()),
        };
        for agent in ["gemini", "commandcode", "dsh"] {
            let resolved = config
                .resolve_selection(
                    agent,
                    Some(&selection),
                    AiSessionModelSelectionIntent::Target,
                )
                .expect("resolve")
                .expect("selection");
            assert_eq!(resolved.model_entity_id, "model-primary");
        }

        let data_dir = root.path().join("acp-session-config");
        let gemini = config
            .acp_launch_config("gemini", Some(&selection), &data_dir)
            .expect("gemini config");
        assert_eq!(
            gemini.env.get("GOOGLE_GEMINI_BASE_URL").map(String::as_str),
            Some("https://models.example")
        );
        assert_eq!(
            gemini.env.get("GEMINI_MODEL").map(String::as_str),
            Some("upstream-primary")
        );
        assert_eq!(
            gemini.env.get("GEMINI_API_KEY").map(String::as_str),
            Some("secret")
        );
        assert!(gemini
            .cleanup_dir
            .as_ref()
            .is_some_and(|path| path.exists()));
        let gemini_trusted = config
            .acp_launch_config_for_session(
                "gemini",
                Some(&selection),
                &data_dir,
                None,
                Some(Path::new("/workspace/demo")),
            )
            .expect("gemini trusted config");
        let trust_path = gemini_trusted
            .env
            .get("GEMINI_CLI_TRUSTED_FOLDERS_PATH")
            .expect("gemini trust file");
        let trust: Value = serde_json::from_str(
            &std::fs::read_to_string(trust_path).expect("gemini trust file contents"),
        )
        .expect("gemini trust JSON");
        assert_eq!(trust["/workspace/demo"], "TRUST_FOLDER");

        let relay_config = config_with_catalog(
            root.path(),
            json!({
                "protocolVersion": "2026-10-02",
                "instanceId": "ins_0000000000000",
                "entities": [{
                    "id": "model-primary",
                    "protocols": ["google-generative-ai"],
                    "modelNames": [{
                        "upstreamName": "upstream-primary",
                        "name": "Primary Label",
                        "order": 0
                    }],
                    "routes": [{
                        "protocol": "google-generative-ai",
                        "baseUrl": "https://node.example/api/node-agent/model-relay/instances/ins_0000000000000/routes/rly_demo/v1"
                    }]
                }],
                "updatedAt": "2026-11-02T00:00:00.000Z"
            }),
        );
        let relay_gemini = relay_config
            .acp_launch_config("gemini", Some(&selection), &data_dir)
            .expect("relay gemini config");
        assert_eq!(
            relay_gemini
                .env
                .get("GOOGLE_GEMINI_BASE_URL")
                .map(String::as_str),
            Some("https://node.example/api/node-agent/model-relay/instances/ins_0000000000000/routes/rly_demo/v1")
        );
        let relay_dsh = relay_config
            .acp_launch_config("dsh", Some(&selection), &data_dir)
            .expect("relay dsh config");
        let relay_patch = std::fs::read_to_string(relay_dsh.args.get(1).expect("relay dsh patch"))
            .expect("relay dsh patch contents");
        assert!(relay_patch.contains(
            "baseURL: \"https://node.example/api/node-agent/model-relay/instances/ins_0000000000000/routes/rly_demo/v1/v1beta\""
        ));

        let commandcode = config
            .acp_launch_config("commandcode", Some(&selection), &data_dir)
            .expect("commandcode config");
        let home = commandcode.env.get("HOME").expect("commandcode home");
        assert_eq!(
            commandcode
                .env
                .get("COMMAND_CODE_API_KEY")
                .map(String::as_str),
            Some("task-handoff-local-only")
        );
        assert_eq!(
            commandcode.env.get("CMD_LOCAL_ONLY").map(String::as_str),
            Some("1")
        );
        let providers =
            std::fs::read_to_string(Path::new(home).join(".commandcode").join("providers.json"))
                .expect("providers config");
        assert!(providers.contains("task-handoff-model-primary"));
        assert!(providers.contains("$TASK_HANDOFF_ACP_MODEL_KEY_0"));
        let session_file = Path::new(home)
            .join(".commandcode")
            .join("sessions")
            .join("session-1.jsonl");
        std::fs::create_dir_all(session_file.parent().unwrap()).unwrap();
        std::fs::write(&session_file, "{\"message\":\"kept\"}\n").unwrap();
        commandcode
            .session_home
            .as_ref()
            .expect("commandcode session home")
            .persist("session-1")
            .expect("persist commandcode home");
        let resumed = config
            .acp_launch_config_for_session(
                "commandcode",
                Some(&selection),
                &data_dir,
                Some("session-1"),
                None,
            )
            .expect("resumed commandcode config");
        let resumed_home = resumed.env.get("HOME").expect("resumed commandcode home");
        assert_eq!(
            std::fs::read_to_string(
                Path::new(resumed_home)
                    .join(".commandcode")
                    .join("sessions")
                    .join("session-1.jsonl")
            )
            .expect("restored commandcode session"),
            "{\"message\":\"kept\"}\n"
        );

        let dsh = config
            .acp_launch_config("dsh", Some(&selection), &data_dir)
            .expect("dsh config");
        let dsh_home = dsh.env.get("DSH_HOME").expect("dsh home");
        let patch = std::fs::read_to_string(Path::new(dsh_home).join("acp-model.patch.yml"))
            .expect("dsh patch");
        assert!(patch.contains("task-handoff-model-primary"));
        assert_eq!(dsh.args.first().map(String::as_str), Some("--patch"));
    }
}
