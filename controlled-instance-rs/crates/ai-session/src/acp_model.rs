use crate::{AiSessionModelSelection, AiSessionPermissionMode};
use controlled_instance_protocol::MANAGED_MODEL_PROVIDER_PREFIX;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcpSelectOption {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcpSelectConfiguration {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub current_value: String,
    pub options: Vec<AcpSelectOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcpLegacyModels {
    pub current_model_id: String,
    pub available_models: Vec<AcpSelectOption>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AcpSessionConfiguration {
    pub options: Vec<AcpSelectConfiguration>,
    pub legacy_models: Option<AcpLegacyModels>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcpSessionMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcpSessionModes {
    pub current_mode_id: String,
    pub available_modes: Vec<AcpSessionMode>,
}

pub(crate) fn acp_permission_modes(agent: &str) -> Vec<String> {
    if matches!(agent, "gemini" | "commandcode") {
        vec!["ask".into(), "auto-review".into(), "full-access".into()]
    } else {
        Vec::new()
    }
}

pub(crate) fn acp_permission_mode_id(
    agent: &str,
    mode: AiSessionPermissionMode,
) -> Option<&'static str> {
    match (agent, mode) {
        ("gemini", AiSessionPermissionMode::Ask) => Some("default"),
        ("gemini", AiSessionPermissionMode::AutoReview) => Some("autoEdit"),
        ("gemini", AiSessionPermissionMode::FullAccess) => Some("yolo"),
        ("commandcode", AiSessionPermissionMode::Ask) => Some("default"),
        ("commandcode", AiSessionPermissionMode::AutoReview) => Some("auto-accept"),
        ("commandcode", AiSessionPermissionMode::FullAccess) => Some("bypass"),
        _ => None,
    }
}

pub(crate) fn acp_permission_mode_for_id(agent: &str, id: &str) -> Option<AiSessionPermissionMode> {
    match (agent, id) {
        ("gemini", "default") | ("commandcode", "default") => Some(AiSessionPermissionMode::Ask),
        ("gemini", "autoEdit") | ("commandcode", "auto-accept") => {
            Some(AiSessionPermissionMode::AutoReview)
        }
        ("gemini", "yolo") | ("commandcode", "bypass") => Some(AiSessionPermissionMode::FullAccess),
        _ => None,
    }
}

pub(crate) fn normalize_acp_session_modes(value: Option<&Value>) -> Option<AcpSessionModes> {
    let source = value?.as_object()?;
    let available_modes = source
        .get("availableModes")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|entry| {
            let item = entry.as_object()?;
            Some(AcpSessionMode {
                id: text(item.get("id"))?,
                name: text(item.get("name"))?,
                description: text(item.get("description")),
            })
        })
        .collect::<Vec<_>>();
    if available_modes.is_empty() {
        return None;
    }
    Some(AcpSessionModes {
        current_mode_id: text(source.get("currentModeId"))
            .unwrap_or_else(|| available_modes[0].id.clone()),
        available_modes,
    })
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn flatten_select_options(value: Option<&Value>) -> Vec<AcpSelectOption> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut options = Vec::new();
    for entry in entries {
        let Some(item) = entry.as_object() else {
            continue;
        };
        if item.get("options").is_some_and(Value::is_array) {
            options.extend(flatten_select_options(item.get("options")));
            continue;
        }
        let value = text(item.get("value")).or_else(|| text(item.get("modelId")));
        let name = text(item.get("name"));
        let (Some(value), Some(name)) = (value, name) else {
            continue;
        };
        options.push(AcpSelectOption {
            value,
            name,
            description: text(item.get("description")),
        });
    }
    options
}

/// ACP Agents currently expose two shapes: stable `configOptions` and Gemini
/// CLI's legacy `models` object. Unknown entries are ignored so a newer Agent
/// field cannot make an otherwise usable session fail.
pub(crate) fn normalize_acp_session_configuration(value: &Value) -> AcpSessionConfiguration {
    let options = value
        .get("configOptions")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let item = entry.as_object()?;
                    if item.get("type").and_then(Value::as_str) == Some("boolean") {
                        return None;
                    }
                    let id = text(item.get("id"))?;
                    let name = text(item.get("name"))?;
                    // ACP select values are opaque strings. dsh uses the empty
                    // string for its provider-default reasoning level.
                    let current_value = item
                        .get("currentValue")
                        .and_then(Value::as_str)?
                        .to_string();
                    let options = flatten_select_options(item.get("options"));
                    if options.is_empty() {
                        return None;
                    }
                    Some(AcpSelectConfiguration {
                        id,
                        name,
                        category: text(item.get("category")),
                        current_value,
                        options,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let legacy_models = value.get("models").and_then(|legacy| {
        let current_model_id = text(legacy.get("currentModelId"))?;
        let available_models = flatten_select_options(legacy.get("availableModels"));
        (!available_models.is_empty()).then_some(AcpLegacyModels {
            current_model_id,
            available_models,
        })
    });
    AcpSessionConfiguration {
        options,
        legacy_models,
    }
}

impl AcpSessionConfiguration {
    pub(crate) fn model_option(&self) -> Option<&AcpSelectConfiguration> {
        self.options
            .iter()
            .find(|option| option.category.as_deref() == Some("model") || option.id == "model")
    }

    pub(crate) fn reasoning_option(&self) -> Option<&AcpSelectConfiguration> {
        self.options.iter().find(|option| {
            option.category.as_deref() == Some("thought_level")
                || option.id == "reasoning_effort"
                || option.id == "effort"
        })
    }

    pub(crate) fn available_model_values(&self) -> Vec<String> {
        self.model_option()
            .map(|option| {
                option
                    .options
                    .iter()
                    .map(|candidate| candidate.value.clone())
                    .collect()
            })
            .or_else(|| {
                self.legacy_models.as_ref().map(|legacy| {
                    legacy
                        .available_models
                        .iter()
                        .map(|candidate| candidate.value.clone())
                        .collect()
                })
            })
            .unwrap_or_default()
    }

    /// Gemini CLI accepts configured model IDs through `session/set_model`
    /// without listing them in legacy `availableModels`.
    pub(crate) fn model_value_selectable(&self, value: &str) -> bool {
        if self.legacy_models.is_some() {
            return true;
        }
        let available = self.available_model_values();
        available.is_empty() || available.iter().any(|candidate| candidate == value)
    }

    pub(crate) fn reasoning_effort_value(&self, effort: &str) -> Option<String> {
        let option = self.reasoning_option()?;
        let mut aliases = vec![effort.to_string()];
        if effort == "none" {
            aliases.extend(["off".to_string(), "disabled".to_string()]);
        }
        if effort == "minimal" {
            aliases.push("low".to_string());
        }
        if matches!(effort, "xhigh" | "max" | "ultra") {
            aliases.extend(["xhigh".to_string(), "max".to_string(), "ultra".to_string()]);
        }
        aliases.sort();
        aliases.dedup();
        let matches = option.options.iter().filter(|candidate| {
            aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(&candidate.value))
                || aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(&candidate.name))
        });
        let matches = matches.collect::<Vec<_>>();
        matches
            .iter()
            .find(|candidate| {
                aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(&candidate.value))
            })
            .or_else(|| matches.first())
            .map(|candidate| candidate.value.clone())
    }
}

pub(crate) fn acp_managed_provider_key(model_entity_id: &str) -> String {
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
        "{MANAGED_MODEL_PROVIDER_PREFIX}{}",
        if normalized.is_empty() {
            "model"
        } else {
            normalized
        }
    )
}

pub(crate) fn acp_model_value(agent: &str, selection: &AiSessionModelSelection) -> String {
    let model = selection.upstream_name();
    if agent == "commandcode" {
        return format!(
            "{}/{}",
            acp_managed_provider_key(&selection.model_entity_id),
            model
        );
    }
    if agent == "dsh" {
        return serde_json::to_string(&vec![
            acp_managed_provider_key(&selection.model_entity_id),
            model.to_string(),
        ])
        .unwrap_or_else(|_| "[]".to_string());
    }
    model.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_stable_and_legacy_acp_model_surfaces() {
        let stable = normalize_acp_session_configuration(&json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "model-b",
                "options": [
                    { "value": "model-a", "name": "A" },
                    { "value": "model-b", "name": "B" }
                ]
            }]
        }));
        assert_eq!(stable.available_model_values(), ["model-a", "model-b"]);
        assert_eq!(stable.model_option().unwrap().current_value, "model-b");

        let legacy = normalize_acp_session_configuration(&json!({
            "models": {
                "currentModelId": "model-b",
                "availableModels": [
                    { "modelId": "model-a", "name": "A" },
                    { "modelId": "model-b", "name": "B" }
                ]
            }
        }));
        assert_eq!(legacy.available_model_values(), ["model-a", "model-b"]);
        assert_eq!(legacy.legacy_models.unwrap().current_model_id, "model-b");
    }

    #[test]
    fn model_values_preserve_agent_namespaces() {
        let selection = AiSessionModelSelection {
            model_entity_id: "demo".into(),
            model_name: "Model B".into(),
            model_upstream_name: Some("model-b".into()),
        };
        assert_eq!(acp_model_value("gemini", &selection), "model-b");
        assert_eq!(
            acp_model_value("commandcode", &selection),
            "task-handoff-demo/model-b"
        );
        assert_eq!(
            acp_model_value("dsh", &selection),
            "[\"task-handoff-demo\",\"model-b\"]"
        );
    }

    #[test]
    fn configured_gemini_models_are_selectable_outside_available_models() {
        let legacy = normalize_acp_session_configuration(&json!({
            "models": {
                "currentModelId": "configured-model-b",
                "availableModels": [
                    { "modelId": "auto", "name": "Auto" },
                    { "modelId": "gemini-2.5-pro", "name": "gemini-2.5-pro" }
                ]
            }
        }));
        assert!(legacy.model_value_selectable("configured-model-a"));

        let stable = normalize_acp_session_configuration(&json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "model-a",
                "options": [{ "value": "model-a", "name": "A" }]
            }]
        }));
        assert!(stable.model_value_selectable("model-a"));
        assert!(!stable.model_value_selectable("model-b"));
    }

    #[test]
    fn permission_modes_map_to_pinned_agent_ids() {
        assert_eq!(
            acp_permission_modes("gemini"),
            ["ask", "auto-review", "full-access"]
        );
        assert_eq!(
            acp_permission_mode_id("gemini", AiSessionPermissionMode::AutoReview),
            Some("autoEdit")
        );
        assert_eq!(
            acp_permission_mode_id("commandcode", AiSessionPermissionMode::FullAccess),
            Some("bypass")
        );
        assert_eq!(
            acp_permission_mode_for_id("commandcode", "auto-accept"),
            Some(AiSessionPermissionMode::AutoReview)
        );
        assert!(acp_permission_modes("dsh").is_empty());
        assert_eq!(
            acp_permission_mode_id("dsh", AiSessionPermissionMode::Ask),
            None
        );
    }

    #[test]
    fn normalizes_negotiated_session_modes() {
        let modes = normalize_acp_session_modes(Some(&json!({
            "currentModeId": "autoEdit",
            "availableModes": [
                { "id": "default", "name": "Default" },
                { "id": "autoEdit", "name": "Auto Edit", "description": "Auto-approves edits" },
                { "id": "", "name": "Invalid" }
            ]
        })))
        .unwrap();
        assert_eq!(modes.current_mode_id, "autoEdit");
        assert_eq!(modes.available_modes.len(), 2);
        assert_eq!(
            modes.available_modes[1].description.as_deref(),
            Some("Auto-approves edits")
        );
        assert!(normalize_acp_session_modes(Some(&json!({ "availableModes": [] }))).is_none());
    }
}
