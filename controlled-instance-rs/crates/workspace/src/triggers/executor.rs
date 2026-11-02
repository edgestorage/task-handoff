use super::store::{TriggerStore, TriggerStoreError};
use controlled_instance_ai_session::{
    AiSessionController, AiSessionMessageInput, ProviderError, ProviderMessageInput,
};
use controlled_instance_protocol::{
    TriggerConfig, TriggerDeployment, TriggerEventType, TriggerExecutionResult,
};
use serde_json::{json, Value};
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
        let text = input.prompt_override.clone().unwrap_or_else(|| {
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
    json!({
        "session": result.session,
        "provider": result.provider,
        "action": result.action.action,
        "turnId": result.action.turn_id,
        "providerTurnId": result.action.provider_turn_id,
        "queueId": result.action.queue_id,
    })
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
}
