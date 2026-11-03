use super::store::{TriggerStore, TriggerStoreError};
use controlled_instance_ai_session::{
    AiSessionController, AiSessionMessageInput, ProviderError, ProviderMessageInput,
};
use controlled_instance_protocol::{
    TriggerConfig, TriggerDeployment, TriggerEventType, TriggerExecutionResult,
};
use serde_json::{Map, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct TriggerExecuteInput {
    pub config: TriggerConfig,
    pub deployment: TriggerDeployment,
    pub event_type: TriggerEventType,
    pub event_summary: Option<String>,
    pub prompt_override: Option<String>,
}

#[derive(Debug, Error)]
pub enum TriggerExecutionError {
    #[error(
        "Triggers are unavailable while the controlled instance is draining for a runtime update."
    )]
    Draining,
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] TriggerStoreError),
}

impl TriggerExecutionError {
    pub fn code(&self) -> &str {
        match self {
            Self::Draining => "TRIGGER_RUNTIME_DRAINING",
            Self::Provider(error) => &error.code,
            Self::Store(TriggerStoreError::Invalid(_)) => "TRIGGER_INVALID",
            Self::Store(_) => "TRIGGER_PERSISTENCE_FAILED",
        }
    }

    pub fn status_code(&self) -> u16 {
        match self {
            Self::Draining => 400,
            Self::Provider(error) => error.status_code,
            Self::Store(TriggerStoreError::Invalid(_)) => 400,
            Self::Store(_) => 500,
        }
    }
}

pub struct TriggerExecutor {
    store: Arc<TriggerStore>,
    ai_sessions: Arc<AiSessionController>,
    draining: AtomicBool,
}

impl TriggerExecutor {
    pub fn new(store: Arc<TriggerStore>, ai_sessions: Arc<AiSessionController>) -> Self {
        Self {
            store,
            ai_sessions,
            draining: AtomicBool::new(false),
        }
    }

    pub fn begin_drain(&self) {
        self.draining.store(true, Ordering::SeqCst);
    }

    pub fn end_drain(&self) {
        self.draining.store(false, Ordering::SeqCst);
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub async fn execute(
        &self,
        input: TriggerExecuteInput,
    ) -> Result<TriggerExecutionResult, TriggerExecutionError> {
        if self.is_draining() {
            return Err(TriggerExecutionError::Draining);
        }
        let run = self.store.start_run(
            &input.config,
            &input.deployment,
            input.event_type,
            input.event_summary.clone(),
        )?;
        let text = input
            .prompt_override
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                render_prompt(
                    &input.config.action.prompt_template,
                    &input.config,
                    input.event_type,
                    input.event_summary.as_deref().unwrap_or_default(),
                )
            });
        let message = AiSessionMessageInput {
            message: text,
            ..AiSessionMessageInput::default()
        };
        let result = match self
            .ai_sessions
            .send_message(
                &input.deployment.target.ai_session_id,
                ProviderMessageInput::from_wire(&message),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                if error.code == "AI_SESSION_NOT_FOUND" {
                    if let Err(store_error) = self
                        .store
                        .delete_deployment(&input.deployment.config_hash, input.deployment.key())
                    {
                        tracing::warn!(%store_error, "failed to delete a missing AI session trigger deployment");
                    }
                }
                let _ = self.store.complete_run(&run, Some(&error.message));
                return Err(TriggerExecutionError::Provider(error));
            }
        };
        let completed = self
            .store
            .complete_run(&run, None)?
            .ok_or_else(|| TriggerStoreError::Invalid("Trigger run disappeared.".to_string()))?;
        Ok(TriggerExecutionResult {
            run: completed,
            result: trigger_action_result(&result),
        })
    }
}

pub fn render_prompt(
    template: &str,
    config: &TriggerConfig,
    event_type: TriggerEventType,
    event_summary: &str,
) -> String {
    template
        .replace("{{trigger.configHash}}", &config.config_hash)
        .replace("{{trigger.name}}", &config.name)
        .replace("{{event.type}}", trigger_event_type_name(event_type))
        .replace("{{event.summary}}", event_summary)
}

fn trigger_action_result(result: &controlled_instance_ai_session::AiSessionActionResult) -> Value {
    let mut object = Map::new();
    object.insert(
        "session".to_string(),
        serde_json::to_value(&result.session).unwrap_or(Value::Null),
    );
    object.insert(
        "provider".to_string(),
        Value::String(result.provider.clone()),
    );
    object.insert(
        "action".to_string(),
        Value::String(result.action.action.clone()),
    );
    for (key, value) in [
        ("decision", result.action.decision.as_ref()),
        ("turnId", result.action.turn_id.as_ref()),
        ("providerTurnId", result.action.provider_turn_id.as_ref()),
        ("queueId", result.action.queue_id.as_ref()),
    ] {
        if let Some(value) = value {
            object.insert(key.to_string(), Value::String(value.clone()));
        }
    }
    Value::Object(object)
}

pub fn trigger_event_type_name(value: TriggerEventType) -> &'static str {
    match value {
        TriggerEventType::Manual => "manual",
        TriggerEventType::Schedule => "schedule",
        TriggerEventType::FileChange => "file-change",
        TriggerEventType::AiSession => "ai-session",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_ai_session::{AiSession, AiSessionActionResult, ProviderAction};
    use serde_json::json;

    #[test]
    fn prompt_rendering_replaces_placeholders_in_node_order() {
        let config: TriggerConfig = serde_json::from_value(json!({
            "configHash": "trg_12345678",
            "name": "{{event.type}} watcher",
            "source": { "type": "schedule", "scheduleKind": "interval", "intervalMs": 1000 },
            "action": { "promptTemplate": "ignored" },
            "policy": { "maxConcurrentRuns": 1, "whenBusy": "skip" },
            "createdAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        }))
        .expect("config");
        assert_eq!(
            render_prompt(
                "{{trigger.configHash}} {{trigger.name}} {{event.type}} {{event.summary}}",
                &config,
                TriggerEventType::Manual,
                "summary"
            ),
            "trg_12345678 manual watcher manual summary"
        );
    }

    #[test]
    fn action_result_matches_the_node_shape_and_omits_absent_optional_fields() {
        let session: AiSession = serde_json::from_value(json!({
            "id": "session-trigger",
            "agent": "codex",
            "creationSource": "ai-session",
            "status": "idle",
            "phase": "unknown",
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        }))
        .expect("session");
        let complete = trigger_action_result(&AiSessionActionResult {
            session: session.clone(),
            provider: "codex".to_string(),
            action: ProviderAction {
                action: "approval".to_string(),
                turn_id: Some("turn-1".to_string()),
                provider_turn_id: Some("provider-turn-1".to_string()),
                decision: Some("allow".to_string()),
                queue_id: Some("queue-1".to_string()),
            },
        });
        assert_eq!(complete["decision"], "allow");
        assert_eq!(complete["turnId"], "turn-1");
        assert_eq!(complete["providerTurnId"], "provider-turn-1");
        assert_eq!(complete["queueId"], "queue-1");

        let minimal = trigger_action_result(&AiSessionActionResult {
            session,
            provider: "codex".to_string(),
            action: ProviderAction::simple("interrupt"),
        });
        let keys = minimal
            .as_object()
            .expect("object")
            .keys()
            .collect::<Vec<_>>();
        assert_eq!(keys.len(), 3);
        assert!(keys.contains(&&"action".to_string()));
        assert!(keys.contains(&&"provider".to_string()));
        assert!(keys.contains(&&"session".to_string()));
    }
}
