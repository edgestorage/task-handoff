use chrono::{DateTime, SecondsFormat, Utc};
use controlled_instance_ai_session::ProviderError;
use controlled_instance_core::atomic::write_json_atomic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BINDINGS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunMemberBinding {
    pub run_id: String,
    pub member_id: String,
    pub ai_session_id: String,
    pub provider_session_id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentRunMemberBindingInput {
    pub run_id: String,
    pub member_id: String,
    pub ai_session_id: String,
    pub provider_session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingState<'a> {
    version: u8,
    bindings: &'a [AgentRunMemberBinding],
}

pub struct AgentRunMemberBindingStore {
    path: PathBuf,
    state: Mutex<Vec<AgentRunMemberBinding>>,
}

impl AgentRunMemberBindingStore {
    pub fn load(runtime_dir: &Path) -> Result<Self, ProviderError> {
        let path = runtime_dir.join("agent-run-member-bindings.json");
        let bindings = match std::fs::read(&path) {
            Ok(bytes) => parse_bindings(&bytes).map_err(|error| {
                ProviderError::new(
                    "AGENT_RUN_MEMBER_BINDING_STORE_INVALID",
                    format!("Agent Run member binding store is invalid: {error}"),
                    500,
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(ProviderError::new(
                    "AGENT_RUN_MEMBER_BINDING_STORE_FAILED",
                    error.to_string(),
                    500,
                ))
            }
        };
        Ok(Self {
            path,
            state: Mutex::new(bindings),
        })
    }

    pub fn list(&self) -> Vec<AgentRunMemberBinding> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn get(&self, run_id: &str, member_id: &str) -> Option<AgentRunMemberBinding> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|binding| binding.run_id == run_id && binding.member_id == member_id)
            .cloned()
    }

    pub fn get_by_session(&self, ai_session_id: &str) -> Option<AgentRunMemberBinding> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|binding| binding.ai_session_id == ai_session_id)
            .cloned()
    }

    pub fn bind(
        &self,
        input: AgentRunMemberBindingInput,
    ) -> Result<AgentRunMemberBinding, ProviderError> {
        self.bind_at(input, now_iso())
    }

    fn bind_at(
        &self,
        input: AgentRunMemberBindingInput,
        timestamp: String,
    ) -> Result<AgentRunMemberBinding, ProviderError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let existing = state
            .iter()
            .find(|binding| {
                binding.run_id == input.run_id && binding.member_id == input.member_id
                    || binding.ai_session_id == input.ai_session_id
            })
            .cloned();
        if let Some(existing) = existing {
            if existing.run_id == input.run_id
                && existing.member_id == input.member_id
                && existing.ai_session_id == input.ai_session_id
                && existing.provider_session_id == input.provider_session_id
            {
                return Ok(existing);
            }
            return Err(ProviderError::conflict(
                "AGENT_RUN_MEMBER_SESSION_CONFLICT",
                "The AI Session is already bound to another Agent Run member.",
            ));
        }
        if state.len() >= MAX_BINDINGS {
            return Err(ProviderError::new(
                "AGENT_RUN_MEMBER_BINDING_LIMIT",
                "The Agent Run member binding store is full.",
                409,
            ));
        }
        let binding = AgentRunMemberBinding {
            run_id: input.run_id,
            member_id: input.member_id,
            ai_session_id: input.ai_session_id,
            provider_session_id: input.provider_session_id,
            created_at: timestamp,
            closed_at: None,
        };
        let mut next = state.clone();
        next.push(binding.clone());
        persist(&self.path, &next)?;
        *state = next;
        Ok(binding)
    }

    pub fn close(
        &self,
        run_id: &str,
        member_id: &str,
    ) -> Result<Option<AgentRunMemberBinding>, ProviderError> {
        self.close_at(run_id, member_id, now_iso())
    }

    fn close_at(
        &self,
        run_id: &str,
        member_id: &str,
        timestamp: String,
    ) -> Result<Option<AgentRunMemberBinding>, ProviderError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(index) = state
            .iter()
            .position(|binding| binding.run_id == run_id && binding.member_id == member_id)
        else {
            return Ok(None);
        };
        if state[index].closed_at.is_some() {
            return Ok(Some(state[index].clone()));
        }
        let mut next = state.clone();
        next[index].closed_at = Some(timestamp);
        persist(&self.path, &next)?;
        *state = next;
        Ok(Some(state[index].clone()))
    }
}

fn parse_bindings(bytes: &[u8]) -> Result<Vec<AgentRunMemberBinding>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "store must be a JSON object".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("store.version must be 1".to_string());
    }
    let bindings = object
        .get("bindings")
        .and_then(Value::as_array)
        .ok_or_else(|| "store.bindings must be an array".to_string())?;
    if bindings.len() > MAX_BINDINGS {
        return Err(format!("store.bindings exceeds {MAX_BINDINGS} entries"));
    }
    bindings
        .iter()
        .enumerate()
        .map(|(index, value)| {
            parse_binding(value).map_err(|error| format!("bindings[{index}]: {error}"))
        })
        .collect()
}

fn parse_binding(value: &Value) -> Result<AgentRunMemberBinding, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "binding must be an object".to_string())?;
    let required = |key: &str, max: usize| -> Result<String, String> {
        let value = object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= max)
            .ok_or_else(|| format!("{key} is invalid"))?;
        Ok(value.to_string())
    };
    let timestamp = |key: &str, required: bool| -> Result<Option<String>, String> {
        match object.get(key).and_then(Value::as_str) {
            Some(value) if DateTime::parse_from_rfc3339(value).is_ok() => {
                Ok(Some(value.to_string()))
            }
            None if !required => Ok(None),
            _ => Err(format!("{key} is invalid")),
        }
    };
    Ok(AgentRunMemberBinding {
        run_id: required("runId", 120)?,
        member_id: required("memberId", 120)?,
        ai_session_id: required("aiSessionId", 120)?,
        provider_session_id: required("providerSessionId", 240)?,
        created_at: timestamp("createdAt", true)?.expect("required timestamp"),
        closed_at: timestamp("closedAt", false)?,
    })
}

fn persist(path: &Path, bindings: &[AgentRunMemberBinding]) -> Result<(), ProviderError> {
    write_json_atomic(
        path,
        &BindingState {
            version: 1,
            bindings,
        },
        Some(0o600),
    )
    .map_err(|error| {
        ProviderError::new(
            "AGENT_RUN_MEMBER_BINDING_STORE_FAILED",
            error.to_string(),
            500,
        )
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(session: &str) -> AgentRunMemberBindingInput {
        AgentRunMemberBindingInput {
            run_id: "run_1".to_string(),
            member_id: "member_1".to_string(),
            ai_session_id: session.to_string(),
            provider_session_id: format!("thread-{session}"),
        }
    }

    #[test]
    fn bindings_round_trip_the_node_json_shape_and_are_idempotent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = AgentRunMemberBindingStore::load(directory.path()).expect("store");
        let binding = store
            .bind_at(input("ses_1"), "2026-11-02T00:00:00.000Z".to_string())
            .expect("bind");
        assert_eq!(binding.created_at, "2026-11-02T00:00:00.000Z");
        assert_eq!(
            store
                .bind_at(input("ses_1"), "2026-11-02T00:01:00.000Z".to_string())
                .expect("idempotent"),
            binding
        );
        let raw: Value = serde_json::from_slice(
            &std::fs::read(directory.path().join("agent-run-member-bindings.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["bindings"][0]["runId"], "run_1");
        assert!(raw["bindings"][0].get("closedAt").is_none());
    }

    #[test]
    fn a_session_cannot_be_bound_to_two_members_or_a_different_member_identity() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = AgentRunMemberBindingStore::load(directory.path()).expect("store");
        store
            .bind_at(input("ses_1"), "2026-11-02T00:00:00.000Z".to_string())
            .expect("bind");
        let mut other = input("ses_1");
        other.member_id = "member_2".to_string();
        let error = store
            .bind_at(other, "2026-11-02T00:01:00.000Z".to_string())
            .expect_err("conflict");
        assert_eq!(error.code, "AGENT_RUN_MEMBER_SESSION_CONFLICT");
        assert_eq!(error.status_code, 409);
    }

    #[test]
    fn close_is_idempotent_and_survives_reload() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = AgentRunMemberBindingStore::load(directory.path()).expect("store");
        store
            .bind_at(input("ses_1"), "2026-11-02T00:00:00.000Z".to_string())
            .expect("bind");
        let closed = store
            .close_at("run_1", "member_1", "2026-11-02T00:02:00.000Z".to_string())
            .expect("close")
            .expect("binding");
        assert_eq!(
            closed.closed_at.as_deref(),
            Some("2026-11-02T00:02:00.000Z")
        );
        let again = store
            .close_at("run_1", "member_1", "2026-11-02T00:03:00.000Z".to_string())
            .expect("close")
            .expect("binding");
        assert_eq!(again.closed_at, closed.closed_at);
        let reloaded = AgentRunMemberBindingStore::load(directory.path()).expect("reload");
        assert_eq!(reloaded.get("run_1", "member_1").expect("binding"), closed);
    }

    #[test]
    fn unknown_fields_are_ignored_but_invalid_known_fields_fail_loading() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("agent-run-member-bindings.json");
        std::fs::write(
            &path,
            br#"{
              "version": 1,
              "future": true,
              "bindings": [{
                "runId": "run_1",
                "memberId": "member_1",
                "aiSessionId": "ses_1",
                "providerSessionId": "thread-1",
                "createdAt": "2026-11-02T00:00:00.000Z",
                "futureBindingField": "ignored"
              }]
            }"#,
        )
        .expect("write");
        assert!(AgentRunMemberBindingStore::load(directory.path()).is_ok());
        std::fs::write(&path, br#"{"version":1,"bindings":[{"runId":"run_1"}]}"#).expect("write");
        assert!(AgentRunMemberBindingStore::load(directory.path()).is_err());
    }
}
