use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION: &str = "2026-08-27";
pub const INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION: &str = "2026-10-02";
pub const MANAGED_MODEL_PROVIDER_PREFIX: &str = "task-handoff-";

/// Codex persists the provider id with each thread. Derive it from the stable
/// model entity identity so display-name changes never alter the provider.
pub fn codex_model_provider_id(model_entity_id: &str) -> String {
    let normalized = model_entity_id
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
            {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("{MANAGED_MODEL_PROVIDER_PREFIX}{normalized}")
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum PrivateModelProtocol {
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "openai-chat-completions")]
    OpenAiChatCompletions,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivateModelNameEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_name: Option<String>,
    pub name: String,
    pub order: u32,
}

impl PrivateModelNameEntry {
    pub fn identity(&self) -> &str {
        self.upstream_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.name.trim())
    }
}

/// Resolve one client-reported model name. Stable identities win over mutable
/// display labels; duplicate identities intentionally resolve to the first
/// order-sorted entry, while duplicate labels stay ambiguous.
pub fn select_model_name_entry<'a>(
    entries: &'a [PrivateModelNameEntry],
    model: &str,
) -> Option<&'a PrivateModelNameEntry> {
    if let Some(entry) = entries.iter().find(|entry| entry.identity() == model) {
        return Some(entry);
    }
    let mut matches = entries.iter().filter(|entry| entry.name == model);
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

pub fn sorted_model_name_entries(entries: &[PrivateModelNameEntry]) -> Vec<PrivateModelNameEntry> {
    let mut entries = entries.to_vec();
    entries.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then(left.name.cmp(&right.name))
    });
    entries
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectPrivateModelEntity {
    pub id: String,
    pub protocols: Vec<PrivateModelProtocol>,
    pub model_names: Vec<PrivateModelNameEntry>,
    pub endpoint: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivateModelRoute {
    pub protocol: PrivateModelProtocol,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayPrivateModelEntity {
    pub id: String,
    pub protocols: Vec<PrivateModelProtocol>,
    pub model_names: Vec<PrivateModelNameEntry>,
    pub routes: Vec<PrivateModelRoute>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "protocolVersion", rename_all_fields = "camelCase")]
pub enum InstancePrivateModelCatalog {
    #[serde(rename = "2026-08-27")]
    Direct {
        instance_id: String,
        entities: Vec<DirectPrivateModelEntity>,
        updated_at: String,
    },
    #[serde(rename = "2026-10-02")]
    Relay {
        instance_id: String,
        entities: Vec<RelayPrivateModelEntity>,
        updated_at: String,
    },
}

impl InstancePrivateModelCatalog {
    pub fn instance_id(&self) -> &str {
        match self {
            Self::Direct { instance_id, .. } | Self::Relay { instance_id, .. } => instance_id,
        }
    }

    pub fn updated_at(&self) -> &str {
        match self {
            Self::Direct { updated_at, .. } | Self::Relay { updated_at, .. } => updated_at,
        }
    }

    pub fn protocol_version(&self) -> &'static str {
        match self {
            Self::Direct { .. } => INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION,
            Self::Relay { .. } => INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
        }
    }

    pub fn entities(&self) -> Vec<PrivateModelEntitySummary> {
        match self {
            Self::Direct { entities, .. } => entities
                .iter()
                .map(|entity| PrivateModelEntitySummary {
                    id: entity.id.clone(),
                    protocols: entity.protocols.clone(),
                    model_names: entity.model_names.clone(),
                })
                .collect(),
            Self::Relay { entities, .. } => entities
                .iter()
                .map(|entity| PrivateModelEntitySummary {
                    id: entity.id.clone(),
                    protocols: entity.protocols.clone(),
                    model_names: entity.model_names.clone(),
                })
                .collect(),
        }
    }

    pub fn base_url(&self, entity_id: &str, protocol: PrivateModelProtocol) -> Option<&str> {
        match self {
            Self::Direct { entities, .. } => entities
                .iter()
                .find(|entity| entity.id == entity_id && entity.protocols.contains(&protocol))
                .map(|entity| entity.endpoint.as_str()),
            Self::Relay { entities, .. } => entities
                .iter()
                .find(|entity| entity.id == entity_id && entity.protocols.contains(&protocol))
                .and_then(|entity| {
                    entity
                        .routes
                        .iter()
                        .find(|route| route.protocol == protocol)
                        .map(|route| route.base_url.as_str())
                }),
        }
    }

    pub fn is_relay(&self) -> bool {
        matches!(self, Self::Relay { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivateModelEntitySummary {
    pub id: String,
    pub protocols: Vec<PrivateModelProtocol>,
    pub model_names: Vec<PrivateModelNameEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivateModelCatalogSummary {
    pub protocol_version: String,
    pub instance_id: String,
    pub updated_at: String,
    pub entities: Vec<PrivateModelEntitySummary>,
}

impl From<&InstancePrivateModelCatalog> for PrivateModelCatalogSummary {
    fn from(catalog: &InstancePrivateModelCatalog) -> Self {
        Self {
            protocol_version: catalog.protocol_version().to_string(),
            instance_id: catalog.instance_id().to_string(),
            updated_at: catalog.updated_at().to_string(),
            entities: catalog.entities(),
        }
    }
}

pub fn parse_instance_private_model_catalog(
    value: Value,
    expected_instance_id: Option<&str>,
) -> Result<InstancePrivateModelCatalog, String> {
    let mut catalog = serde_json::from_value::<InstancePrivateModelCatalog>(value)
        .map_err(|error| format!("Private model catalog is invalid: {error}"))?;
    normalize_catalog(&mut catalog)?;
    if expected_instance_id.is_some_and(|expected| catalog.instance_id() != expected) {
        return Err(
            "Private model catalog instance identity does not match this runtime.".to_string(),
        );
    }
    Ok(catalog)
}

fn normalize_catalog(catalog: &mut InstancePrivateModelCatalog) -> Result<(), String> {
    match catalog {
        InstancePrivateModelCatalog::Direct {
            instance_id,
            entities,
            updated_at,
        } => {
            normalize_common(instance_id, updated_at, entities.len())?;
            for entity in entities {
                normalize_entity(
                    &mut entity.id,
                    &mut entity.protocols,
                    &mut entity.model_names,
                )?;
                trim_bounded(&mut entity.endpoint, 2048, "Private model endpoint")?;
                trim_bounded(&mut entity.key, 4096, "Private model key")?;
            }
        }
        InstancePrivateModelCatalog::Relay {
            instance_id,
            entities,
            updated_at,
        } => {
            normalize_common(instance_id, updated_at, entities.len())?;
            for entity in entities {
                normalize_entity(
                    &mut entity.id,
                    &mut entity.protocols,
                    &mut entity.model_names,
                )?;
                if entity.routes.is_empty() || entity.routes.len() > 3 {
                    return Err(
                        "Private relay entity routes must contain 1 to 3 entries.".to_string()
                    );
                }
                let mut protocols = std::collections::BTreeSet::new();
                for route in &mut entity.routes {
                    if !protocols.insert(route.protocol) {
                        return Err(
                            "Private relay entity contains duplicate protocols.".to_string()
                        );
                    }
                    trim_bounded(&mut route.base_url, 2048, "Private relay route URL")?;
                }
            }
        }
    }
    Ok(())
}

fn normalize_common(
    instance_id: &mut String,
    updated_at: &mut String,
    entity_count: usize,
) -> Result<(), String> {
    trim_bounded(instance_id, 120, "Private model catalog instanceId")?;
    trim_bounded(updated_at, 120, "Private model catalog updatedAt")?;
    if chrono::DateTime::parse_from_rfc3339(updated_at).is_err() {
        return Err("Private model catalog updatedAt must be an RFC3339 datetime.".to_string());
    }
    if entity_count > 64 {
        return Err("Private model catalog cannot contain more than 64 entities.".to_string());
    }
    Ok(())
}

fn normalize_entity(
    id: &mut String,
    protocols: &mut [PrivateModelProtocol],
    model_names: &mut Vec<PrivateModelNameEntry>,
) -> Result<(), String> {
    trim_bounded(id, 120, "Private model entity id")?;
    if protocols.is_empty() || protocols.len() > 3 {
        return Err("Private model entity protocols must contain 1 to 3 entries.".to_string());
    }
    if model_names.is_empty() || model_names.len() > 256 {
        return Err("Private model entity names must contain 1 to 256 entries.".to_string());
    }
    for entry in model_names {
        if let Some(upstream_name) = &mut entry.upstream_name {
            trim_bounded(upstream_name, 240, "Private model upstreamName")?;
        }
        trim_bounded(&mut entry.name, 240, "Private model name")?;
        if entry.order > 1_000_000 {
            return Err("Private model order is out of range.".to_string());
        }
    }
    Ok(())
}

fn trim_bounded(value: &mut String, max: usize, field: &str) -> Result<(), String> {
    *value = value.trim().to_string();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{field} is invalid."));
    }
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedModelEnvironment {
    #[serde(
        rename = "CODEX_HOME",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_home: Option<String>,
    #[serde(
        rename = "OPENAI_API_KEY",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub openai_api_key: Option<String>,
    #[serde(
        rename = "OPENAI_BASE_URL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub openai_base_url: Option<String>,
    #[serde(
        rename = "TASK_HANDOFF_CODEX_BASE_URL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_base_url: Option<String>,
    #[serde(
        rename = "TASK_HANDOFF_CODEX_MODEL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_model: Option<String>,
    #[serde(
        rename = "ANTHROPIC_API_KEY",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub anthropic_api_key: Option<String>,
    #[serde(
        rename = "ANTHROPIC_BASE_URL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub anthropic_base_url: Option<String>,
    #[serde(
        rename = "TASK_HANDOFF_CLAUDE_MODEL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub claude_model: Option<String>,
    #[serde(
        rename = "TASK_HANDOFF_OPENCODE_CONFIG_CONTENT",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub opencode_config_content: Option<String>,
}

impl ManagedModelEnvironment {
    pub fn validate(&self) -> Result<(), String> {
        for (field, value, max) in [
            ("CODEX_HOME", self.codex_home.as_deref(), 4096),
            ("OPENAI_API_KEY", self.openai_api_key.as_deref(), 4096),
            ("OPENAI_BASE_URL", self.openai_base_url.as_deref(), 4096),
            (
                "TASK_HANDOFF_CODEX_BASE_URL",
                self.codex_base_url.as_deref(),
                4096,
            ),
            (
                "TASK_HANDOFF_CODEX_MODEL",
                self.codex_model.as_deref(),
                4096,
            ),
            ("ANTHROPIC_API_KEY", self.anthropic_api_key.as_deref(), 4096),
            (
                "ANTHROPIC_BASE_URL",
                self.anthropic_base_url.as_deref(),
                4096,
            ),
            (
                "TASK_HANDOFF_CLAUDE_MODEL",
                self.claude_model.as_deref(),
                4096,
            ),
            (
                "TASK_HANDOFF_OPENCODE_CONFIG_CONTENT",
                self.opencode_config_content.as_deref(),
                1_048_576,
            ),
        ] {
            if value.is_some_and(|value| value.len() > max) {
                return Err(format!("{field} is too long."));
            }
        }
        Ok(())
    }

    pub fn entries(&self) -> Vec<(&'static str, String)> {
        [
            ("CODEX_HOME", self.codex_home.clone()),
            ("OPENAI_API_KEY", self.openai_api_key.clone()),
            ("OPENAI_BASE_URL", self.openai_base_url.clone()),
            ("TASK_HANDOFF_CODEX_BASE_URL", self.codex_base_url.clone()),
            ("TASK_HANDOFF_CODEX_MODEL", self.codex_model.clone()),
            ("ANTHROPIC_API_KEY", self.anthropic_api_key.clone()),
            ("ANTHROPIC_BASE_URL", self.anthropic_base_url.clone()),
            ("TASK_HANDOFF_CLAUDE_MODEL", self.claude_model.clone()),
            (
                "TASK_HANDOFF_OPENCODE_CONFIG_CONTENT",
                self.opencode_config_content.clone(),
            ),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexModelVerbosity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexPersonality {
    None,
    Friendly,
    Pragmatic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexSubagentModel {
    pub model_entity_id: String,
    pub model_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_upstream_name: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexMultiAgentSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_threads: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<CodexSubagentModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
}

impl Default for CodexMultiAgentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_concurrent_threads: None,
            default_model: None,
            default_reasoning_effort: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexInstanceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_verbosity: Option<CodexModelVerbosity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality: Option<CodexPersonality>,
    #[serde(default)]
    pub multi_agent: CodexMultiAgentSettings,
}

/// Readers accept settings produced by newer producers by dropping fields this
/// runtime does not understand. The request body itself stays strict after the
/// sanitizer runs, so malformed known fields cannot be silently tolerated.
pub fn sanitize_codex_instance_settings(value: Value) -> Value {
    let Value::Object(mut source) = value else {
        return value;
    };
    let multi_agent = source.remove("multiAgent");
    let sanitized_multi_agent = match multi_agent {
        Some(Value::Object(mut value)) => {
            let default_model = value.remove("defaultModel");
            let sanitized_default_model = match default_model {
                Some(Value::Object(mut model)) => {
                    let mut output = serde_json::Map::new();
                    if let Some(value) = model.remove("modelEntityId") {
                        output.insert("modelEntityId".to_string(), value);
                    }
                    if let Some(value) = model.remove("modelName") {
                        output.insert("modelName".to_string(), value);
                    }
                    if let Some(value) = model.remove("modelUpstreamName") {
                        if value.is_string() {
                            output.insert("modelUpstreamName".to_string(), value);
                        }
                    }
                    Some(Value::Object(output))
                }
                Some(other) => Some(other),
                None => None,
            };
            let mut output = serde_json::Map::new();
            for key in ["enabled", "maxConcurrentThreads", "defaultReasoningEffort"] {
                if let Some(value) = value.remove(key) {
                    output.insert(key.to_string(), value);
                }
            }
            if let Some(value) = sanitized_default_model {
                output.insert("defaultModel".to_string(), value);
            }
            Some(Value::Object(output))
        }
        Some(other) => Some(other),
        None => None,
    };
    let mut output = serde_json::Map::new();
    for key in ["modelVerbosity", "personality"] {
        if let Some(value) = source.remove(key) {
            output.insert(key.to_string(), value);
        }
    }
    if let Some(value) = sanitized_multi_agent {
        output.insert("multiAgent".to_string(), value);
    }
    Value::Object(output)
}

pub fn parse_codex_instance_settings(value: Value) -> Result<CodexInstanceSettings, String> {
    let settings =
        serde_json::from_value::<CodexInstanceSettings>(sanitize_codex_instance_settings(value))
            .map_err(|error| format!("Codex instance settings are invalid: {error}"))?;
    if settings
        .multi_agent
        .max_concurrent_threads
        .is_some_and(|value| !(1..=64).contains(&value))
    {
        return Err("Codex maxConcurrentThreads must be between 1 and 64.".to_string());
    }
    if let Some(effort) = &settings.multi_agent.default_reasoning_effort {
        if !matches!(
            effort.as_str(),
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ) {
            return Err("Codex defaultReasoningEffort is invalid.".to_string());
        }
    }
    if let Some(model) = &settings.multi_agent.default_model {
        if model.model_entity_id.trim().is_empty() || model.model_name.trim().is_empty() {
            return Err("Codex default subagent model is invalid.".to_string());
        }
    }
    Ok(settings)
}
