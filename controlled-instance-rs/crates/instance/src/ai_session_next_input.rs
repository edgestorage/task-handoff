use crate::AppState;
use chrono::{SecondsFormat, Utc};
use controlled_instance_ai_session::{
    ai_session_next_input_output_schema, ai_session_next_input_prompt,
    parse_ai_session_next_input_suggestion, AiSession, AiSessionModelSelection,
    AiSessionNextInputSuggestionReasoningEffort, AiSessionStructuredModelGenerator,
    AiSessionStructuredModelInput, ProviderError, ProviderEvent,
};
use controlled_instance_protocol::AiSessionNextInputSuggestion;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{watch, Mutex, RwLock};

const NEXT_INPUT_DEBOUNCE: Duration = Duration::from_secs(1);
const NEXT_INPUT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct PendingRequest {
    key: String,
    turn_id: String,
}

struct ActiveRequest {
    key: String,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct SessionState {
    generation: u64,
    active: Option<ActiveRequest>,
    queued: Option<PendingRequest>,
    last_status: Option<String>,
    success_pending: bool,
    pending_success_turn_id: Option<String>,
    suppressed_turns: HashSet<String>,
}

#[cfg(test)]
type TestSuggestionGenerator = Arc<
    dyn Fn(
            String,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Option<String>, ProviderError>> + Send>,
        > + Send
        + Sync,
>;

pub struct AiSessionNextInputSuggestionCoordinator {
    enabled: AtomicBool,
    reasoning_effort: RwLock<AiSessionNextInputSuggestionReasoningEffort>,
    debounce: Duration,
    states: Mutex<HashMap<String, SessionState>>,
    seen: Mutex<HashSet<String>>,
    #[cfg(test)]
    test_generator: Mutex<Option<TestSuggestionGenerator>>,
}

impl Default for AiSessionNextInputSuggestionCoordinator {
    fn default() -> Self {
        Self::new(false)
    }
}

impl AiSessionNextInputSuggestionCoordinator {
    pub fn new(enabled: bool) -> Self {
        Self::with_reasoning_effort(
            enabled,
            AiSessionNextInputSuggestionReasoningEffort::default(),
        )
    }

    pub fn with_reasoning_effort(
        enabled: bool,
        reasoning_effort: AiSessionNextInputSuggestionReasoningEffort,
    ) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            reasoning_effort: RwLock::new(reasoning_effort),
            debounce: NEXT_INPUT_DEBOUNCE,
            states: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashSet::new()),
            #[cfg(test)]
            test_generator: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub async fn set_test_generator(&self, generator: TestSuggestionGenerator) {
        *self.test_generator.lock().await = Some(generator);
    }

    #[cfg(test)]
    pub fn with_debounce(enabled: bool, debounce: Duration) -> Self {
        Self {
            debounce,
            ..Self::new(enabled)
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub async fn reasoning_effort(&self) -> AiSessionNextInputSuggestionReasoningEffort {
        *self.reasoning_effort.read().await
    }

    pub async fn initialize(self: &Arc<Self>, state: &AppState) {
        if self.is_enabled() {
            for session in state.ai_sessions.list() {
                self.observe_baseline(&session).await;
            }
            return;
        }
        if state.ai_sessions.clear_next_input_suggestions() > 0 {
            state.publish_ai_session_snapshot("next-input-suggestion");
        }
    }

    pub async fn set_enabled(self: &Arc<Self>, state: &AppState, enabled: bool) {
        if self.enabled.swap(enabled, Ordering::SeqCst) == enabled {
            return;
        }
        if enabled {
            for session in state.ai_sessions.list() {
                self.observe_baseline(&session).await;
            }
            return;
        }
        self.invalidate_all().await;
        if state.ai_sessions.clear_next_input_suggestions() > 0 {
            state.publish_ai_session_snapshot("next-input-suggestion");
        }
    }

    pub async fn set_reasoning_effort(
        self: &Arc<Self>,
        state: &AppState,
        reasoning_effort: AiSessionNextInputSuggestionReasoningEffort,
    ) {
        let mut current = self.reasoning_effort.write().await;
        if *current == reasoning_effort {
            return;
        }
        self.invalidate_all().await;
        *current = reasoning_effort;
        drop(current);
        if state.ai_sessions.clear_next_input_suggestions() > 0 {
            state.publish_ai_session_snapshot("next-input-suggestion");
        }
        if self.is_enabled() {
            for session in state.ai_sessions.list() {
                self.observe_baseline(&session).await;
            }
        }
    }

    pub async fn handle_provider_event(self: &Arc<Self>, state: &AppState, event: &ProviderEvent) {
        if matches!(event, ProviderEvent::ConnectionChanged { connected: false }) {
            self.invalidate_all().await;
            return;
        }
        let Some(provider_session_id) = event_provider_session_id(event) else {
            return;
        };
        let Some(session) =
            state.ai_sessions.list().into_iter().find(|session| {
                session.provider_session_id.as_deref() == Some(provider_session_id)
            })
        else {
            return;
        };
        let previous_status = {
            let mut states = self.states.lock().await;
            let entry = states.entry(session.id.clone()).or_default();
            entry.last_status.clone()
        };
        {
            let mut states = self.states.lock().await;
            let entry = states.entry(session.id.clone()).or_default();
            if matches!(
                event,
                ProviderEvent::TurnStarted { .. } | ProviderEvent::UserMessage { .. }
            ) {
                entry.suppressed_turns.clear();
            }
            if let Some(turn_id) = suppressed_turn_id(event, &session) {
                entry.suppressed_turns.insert(turn_id);
                if entry.suppressed_turns.len() > 64 {
                    let stale = entry
                        .suppressed_turns
                        .iter()
                        .take(entry.suppressed_turns.len() - 32)
                        .cloned()
                        .collect::<Vec<_>>();
                    for turn_id in stale {
                        entry.suppressed_turns.remove(&turn_id);
                    }
                }
            }
        }
        // A final assistant message can arrive just after the turn settles. The
        // Node coordinator does not invalidate on agent messages: a new turn is
        // already covered by TurnStarted/UserMessage, and clearing the pending
        // success here would race the idle state change and drop the suggestion.
        let invalidating = event_invalidates_suggestion(event);
        let explicit_success = matches!(
            event,
            ProviderEvent::TurnCompleted { status, error: None, .. }
                if status.as_deref().is_none_or(|status| status == "completed")
        );
        let successful_turn_id = match event {
            ProviderEvent::TurnCompleted { turn_id, .. } if explicit_success => turn_id.clone(),
            _ => None,
        };
        let running_to_idle =
            matches!(
                event,
                ProviderEvent::AdapterSnapshot { snapshot, .. } if snapshot.status == "idle"
            ) || matches!(
                event,
                ProviderEvent::ThreadSnapshot { status, .. } if status == "idle"
            ) && matches!(previous_status.as_deref(), Some("running" | "waiting"));

        if invalidating {
            self.invalidate(&session.id).await;
            let cleared = state
                .ai_sessions
                .set_next_input_suggestion(&session.id, None)
                .unwrap_or(false);
            if cleared {
                state.publish_ai_session_snapshot("next-input-suggestion");
            }
        }

        if explicit_success || running_to_idle {
            let mut states = self.states.lock().await;
            let entry = states.entry(session.id.clone()).or_default();
            entry.success_pending = true;
            if let Some(turn_id) = successful_turn_id.clone() {
                entry.pending_success_turn_id = Some(turn_id);
            }
            drop(states);
            self.observe_successful_turn(state.clone(), &session.id, successful_turn_id.as_deref())
                .await;
        }
    }

    pub async fn handle_state_change(self: &Arc<Self>, state: &AppState) {
        if !self.is_enabled() {
            return;
        }
        let mut schedule = Vec::new();
        let mut baseline = Vec::new();
        let mut clear = Vec::new();
        let mut active = HashSet::new();
        for session in state.ai_sessions.list() {
            active.insert(session.id.clone());
            let idle = session.status == "idle";
            let (previous_status, success_pending, pending_turn_id) = {
                let mut states = self.states.lock().await;
                let entry = states.entry(session.id.clone()).or_default();
                let previous_status = entry.last_status.replace(session.status.clone());
                if idle {
                    let success_pending = std::mem::take(&mut entry.success_pending);
                    let pending_turn_id = entry.pending_success_turn_id.take();
                    (previous_status, success_pending, pending_turn_id)
                } else {
                    (previous_status, false, None)
                }
            };
            if session.next_input_suggestion.is_some() && !suggestion_is_valid(&session) {
                clear.push(session.id.clone());
            }
            if idle {
                let settled = success_pending
                    || matches!(previous_status.as_deref(), Some("running" | "waiting"));
                if settled && eligible(&session) {
                    let matches_pending = pending_turn_id.as_deref().is_none_or(|turn_id| {
                        latest_completed_turn(&session)
                            .is_some_and(|turn| turn_matches_provider_turn(turn, Some(turn_id)))
                    });
                    if matches_pending {
                        schedule.push((session.id.clone(), pending_turn_id));
                    }
                } else if previous_status.is_none() {
                    baseline.push(session.clone());
                }
            } else {
                self.invalidate(&session.id).await;
            }
        }
        for session in baseline {
            self.observe_baseline(&session).await;
        }
        for session_id in clear {
            let _ = state
                .ai_sessions
                .set_next_input_suggestion(&session_id, None);
        }
        for (session_id, provider_turn_id) in schedule {
            self.observe_successful_turn(state.clone(), &session_id, provider_turn_id.as_deref())
                .await;
        }
        self.retain_sessions(&active).await;
    }

    async fn retain_sessions(&self, active: &HashSet<String>) {
        let mut states = self.states.lock().await;
        states.retain(|session_id, _| active.contains(session_id));
    }

    pub async fn observe_baseline(&self, session: &AiSession) {
        if let Some(turn) = latest_completed_turn(session) {
            self.remember_key(request_key(session, turn)).await;
        }
    }

    pub async fn observe_successful_turn(
        self: &Arc<Self>,
        state: AppState,
        session_id: &str,
        provider_turn_id: Option<&str>,
    ) {
        if !self.is_enabled() {
            return;
        }
        let Some(session) = state.ai_sessions.get(session_id) else {
            return;
        };
        if !eligible(&session) {
            return;
        }
        let Some(turn) = latest_completed_turn(&session) else {
            return;
        };
        if !turn_matches_provider_turn(turn, provider_turn_id) {
            return;
        }
        if {
            let states = self.states.lock().await;
            states.get(session_id).is_some_and(|entry| {
                entry
                    .suppressed_turns
                    .contains(turn.get("id").and_then(Value::as_str).unwrap_or_default())
            })
        } {
            return;
        }
        let key = request_key(&session, turn);
        if !self.remember_key(key.clone()).await {
            return;
        }
        let pending = PendingRequest {
            key,
            turn_id: turn
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        let start = {
            let mut states = self.states.lock().await;
            let entry = states.entry(session_id.to_string()).or_default();
            if entry.active.is_some() {
                if let Some(active) = entry.active.as_ref() {
                    let _ = active.cancel.send(true);
                }
                entry.generation += 1;
                entry.queued = Some(pending);
                None
            } else {
                start_request(entry, pending)
            }
        };
        if let Some((pending, generation, cancel)) = start {
            self.spawn_run(state, session_id.to_string(), pending, generation, cancel);
        }
    }

    async fn invalidate_all(&self) {
        let mut states = self.states.lock().await;
        for entry in states.values_mut() {
            entry.generation += 1;
            entry.queued = None;
            if let Some(active) = entry.active.as_ref() {
                let _ = active.cancel.send(true);
            }
        }
    }

    async fn invalidate(&self, session_id: &str) {
        let mut states = self.states.lock().await;
        let Some(entry) = states.get_mut(session_id) else {
            return;
        };
        entry.generation += 1;
        entry.queued = None;
        entry.success_pending = false;
        entry.pending_success_turn_id = None;
        if let Some(active) = entry.active.as_ref() {
            let _ = active.cancel.send(true);
        }
    }

    async fn remember_key(&self, key: String) -> bool {
        let mut seen = self.seen.lock().await;
        if !seen.insert(key) {
            return false;
        }
        if seen.len() > 5_000 {
            let excess = seen.len() - 4_000;
            let stale = seen.iter().take(excess).cloned().collect::<Vec<_>>();
            for key in stale {
                seen.remove(&key);
            }
        }
        true
    }

    fn spawn_run(
        self: &Arc<Self>,
        state: AppState,
        session_id: String,
        pending: PendingRequest,
        generation: u64,
        cancel: watch::Receiver<bool>,
    ) {
        let coordinator = self.clone();
        let debounce = self.debounce;
        tokio::spawn(async move {
            tokio::time::sleep(debounce).await;
            coordinator
                .run(state.clone(), &session_id, &pending, generation, cancel)
                .await;
            coordinator.finish(state, &session_id, &pending.key).await;
        });
    }

    #[allow(unused_variables)]
    async fn generate(
        &self,
        state: &AppState,
        session: &AiSession,
        prompt: String,
        reasoning_effort: AiSessionNextInputSuggestionReasoningEffort,
        cancel: watch::Receiver<bool>,
    ) -> Result<Option<String>, ProviderError> {
        #[cfg(test)]
        if let Some(generator) = self.test_generator.lock().await.clone() {
            return generator(prompt).await;
        }
        state
            .generate_ai_session_next_input(session, prompt, reasoning_effort, cancel)
            .await
    }

    async fn run(
        self: &Arc<Self>,
        state: AppState,
        session_id: &str,
        pending: &PendingRequest,
        generation: u64,
        cancel: watch::Receiver<bool>,
    ) {
        {
            let states = self.states.lock().await;
            if !self.is_enabled()
                || states
                    .get(session_id)
                    .is_none_or(|entry| entry.generation != generation)
            {
                return;
            }
        }
        let Some(session) = state.ai_sessions.get(session_id) else {
            return;
        };
        if !eligible(&session)
            || latest_completed_turn(&session)
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                != Some(pending.turn_id.as_str())
        {
            return;
        }
        if self.is_suppressed(session_id, &pending.turn_id).await {
            return;
        }
        let prompt = ai_session_next_input_prompt(&session);
        let reasoning_effort = *self.reasoning_effort.read().await;
        let raw = match self
            .generate(&state, &session, prompt, reasoning_effort, cancel)
            .await
        {
            Ok(Some(raw)) => raw,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    code = %error.code,
                    ai_session_id = %session.id,
                    "AI Session next-input suggestion generation failed"
                );
                return;
            }
        };
        let Some(text) = parse_ai_session_next_input_suggestion(&raw) else {
            tracing::warn!(
                ai_session_id = %session.id,
                response_bytes = raw.len(),
                "AI Session next-input suggestion response could not be parsed"
            );
            return;
        };
        {
            let states = self.states.lock().await;
            if !self.is_enabled()
                || states
                    .get(session_id)
                    .is_none_or(|entry| entry.generation != generation)
            {
                return;
            }
        }
        let Some(current) = state.ai_sessions.get(session_id) else {
            return;
        };
        let Some(current_turn) = latest_completed_turn(&current) else {
            return;
        };
        if !eligible(&current)
            || request_key(&current, current_turn) != pending.key
            || current_turn.get("id").and_then(Value::as_str) != Some(pending.turn_id.as_str())
            || self.is_suppressed(session_id, &pending.turn_id).await
        {
            return;
        }
        let suggestion = AiSessionNextInputSuggestion {
            text,
            turn_id: pending.turn_id.clone(),
            generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if state
            .ai_sessions
            .set_next_input_suggestion(session_id, Some(suggestion))
            .unwrap_or(false)
        {
            state.publish_ai_session_snapshot("next-input-suggestion");
        }
    }

    async fn finish(self: &Arc<Self>, state: AppState, session_id: &str, key: &str) {
        let next = {
            let mut states = self.states.lock().await;
            let Some(entry) = states.get_mut(session_id) else {
                return;
            };
            if entry.active.as_ref().is_none_or(|active| active.key != key) {
                return;
            }
            entry.active = None;
            entry
                .queued
                .take()
                .and_then(|pending| start_request(entry, pending))
        };
        if let Some((pending, generation, cancel)) = next {
            self.spawn_run(state, session_id.to_string(), pending, generation, cancel);
        }
    }

    async fn is_suppressed(&self, session_id: &str, turn_id: &str) -> bool {
        let states = self.states.lock().await;
        states
            .get(session_id)
            .is_some_and(|entry| entry.suppressed_turns.contains(turn_id))
    }
}

fn start_request(
    entry: &mut SessionState,
    pending: PendingRequest,
) -> Option<(PendingRequest, u64, watch::Receiver<bool>)> {
    entry.generation += 1;
    let (cancel, receiver) = watch::channel(false);
    entry.active = Some(ActiveRequest {
        key: pending.key.clone(),
        cancel,
    });
    Some((pending, entry.generation, receiver))
}

fn event_provider_session_id(event: &ProviderEvent) -> Option<&str> {
    match event {
        ProviderEvent::ThreadDiscovered {
            provider_session_id,
            ..
        }
        | ProviderEvent::ThreadSnapshot {
            provider_session_id,
            ..
        }
        | ProviderEvent::AdapterSnapshot {
            provider_session_id,
            ..
        }
        | ProviderEvent::TurnStarted {
            provider_session_id,
            ..
        }
        | ProviderEvent::TurnCompleted {
            provider_session_id,
            ..
        }
        | ProviderEvent::SessionError {
            provider_session_id,
            ..
        }
        | ProviderEvent::ContextCompaction {
            provider_session_id,
            ..
        }
        | ProviderEvent::ThreadClosed {
            provider_session_id,
        }
        | ProviderEvent::ProviderSessionLifecycle {
            provider_session_id,
            ..
        }
        | ProviderEvent::UserMessage {
            provider_session_id,
            ..
        }
        | ProviderEvent::AgentMessageDelta {
            provider_session_id,
            ..
        }
        | ProviderEvent::AgentMessageCompleted {
            provider_session_id,
            ..
        }
        | ProviderEvent::GoalUpdated {
            provider_session_id,
            ..
        }
        | ProviderEvent::ApprovalRequested {
            provider_session_id,
            ..
        }
        | ProviderEvent::ApprovalResolved {
            provider_session_id,
            ..
        }
        | ProviderEvent::ToolActivity {
            provider_session_id,
            ..
        }
        | ProviderEvent::SubAgentActivity {
            provider_session_id,
            ..
        } => Some(provider_session_id),
        _ => None,
    }
}

fn event_invalidates_suggestion(event: &ProviderEvent) -> bool {
    match event {
        ProviderEvent::TurnStarted { .. }
        | ProviderEvent::UserMessage { .. }
        | ProviderEvent::ApprovalRequested { .. }
        | ProviderEvent::SessionError { .. }
        | ProviderEvent::ThreadClosed { .. } => true,
        ProviderEvent::AdapterSnapshot { snapshot, .. } => snapshot.status != "idle",
        ProviderEvent::TurnCompleted {
            status: Some(status),
            ..
        } => status != "completed",
        _ => false,
    }
}

fn suppressed_turn_id(event: &ProviderEvent, session: &AiSession) -> Option<String> {
    match event {
        ProviderEvent::TurnCompleted {
            turn_id: Some(turn_id),
            status: Some(status),
            ..
        } if status != "completed" => Some(turn_id.clone()),
        ProviderEvent::SessionError { .. } => session.active_turn_id.clone(),
        _ => None,
    }
}

fn turn_matches_provider_turn(turn: &Value, provider_turn_id: Option<&str>) -> bool {
    let Some(provider_turn_id) = provider_turn_id else {
        return true;
    };
    turn.get("id").and_then(Value::as_str) == Some(provider_turn_id)
        || turn.get("providerTurnId").and_then(Value::as_str) == Some(provider_turn_id)
}

fn latest_completed_turn(session: &AiSession) -> Option<&Value> {
    session
        .turns
        .as_deref()
        .unwrap_or_default()
        .last()
        .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("completed"))
}

fn eligible(session: &AiSession) -> bool {
    session.status == "idle"
        && session.queue.pending_count == 0
        && session
            .lineage
            .as_ref()
            .and_then(|lineage| lineage.get("kind"))
            .and_then(Value::as_str)
            != Some("subagent")
        && latest_completed_turn(session).is_some()
}

fn suggestion_is_valid(session: &AiSession) -> bool {
    let Some(suggestion) = session.next_input_suggestion.as_ref() else {
        return false;
    };
    eligible(session)
        && latest_completed_turn(session)
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            == Some(suggestion.turn_id.as_str())
}

fn request_key(session: &AiSession, turn: &Value) -> String {
    format!(
        "{}\0{}\0{}",
        session
            .provider_session_id
            .as_deref()
            .unwrap_or(session.id.as_str()),
        turn.get("id").and_then(Value::as_str).unwrap_or_default(),
        turn.get("completedAt")
            .or_else(|| turn.get("updatedAt"))
            .and_then(Value::as_str)
            .unwrap_or_default()
    )
}

impl AppState {
    async fn generate_ai_session_next_input(
        &self,
        session: &AiSession,
        prompt: String,
        reasoning_effort: AiSessionNextInputSuggestionReasoningEffort,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Option<String>, ProviderError> {
        let output_schema = ai_session_next_input_output_schema();
        let resolved_reasoning_effort =
            reasoning_effort.resolve(session.reasoning_effort.as_deref());
        match session.agent.as_str() {
            "codex" => {
                let provider_session_id =
                    session.provider_session_id.as_deref().ok_or_else(|| {
                        ProviderError::new(
                            "AI_SESSION_NEXT_INPUT_SUGGESTION_IDENTITY_MISSING",
                            "Codex session identity is missing.",
                            409,
                        )
                    })?;
                self.ai_session_codex.client().ensure_ready().await?;
                let snapshot = self
                    .ai_session_codex
                    .client()
                    .read_thread(provider_session_id)
                    .await?;
                let selection = session.model_selection.clone().and_then(|value| {
                    serde_json::from_value::<AiSessionModelSelection>(value).ok()
                });
                let Some((model, model_provider)) = self.controlled_models.codex_title_model(
                    selection.as_ref(),
                    snapshot.model.as_deref(),
                    snapshot.model_provider.as_deref(),
                ) else {
                    tracing::warn!(
                        ai_session_id = %session.id,
                        model_selection = ?session.model_selection,
                        "AI Session next-input suggestion Codex model route is unresolved"
                    );
                    return Ok(None);
                };
                let cwd = session
                    .cwd
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(snapshot.cwd.as_str());
                if cwd.is_empty() {
                    tracing::warn!(
                        ai_session_id = %session.id,
                        "AI Session next-input suggestion Codex cwd is unresolved"
                    );
                    return Ok(None);
                }
                let request = self
                    .ai_session_codex
                    .client()
                    .run_ephemeral_structured_turn(
                        cwd,
                        &model,
                        &model_provider,
                        &prompt,
                        output_schema,
                        resolved_reasoning_effort.as_deref(),
                    );
                tokio::select! {
                    biased;
                    _ = cancel.changed() => Ok(None),
                    result = tokio::time::timeout(NEXT_INPUT_TIMEOUT, request) => match result {
                        Ok(result) => result.map(Some),
                        Err(_) => {
                            tracing::warn!(
                                ai_session_id = %session.id,
                                "AI Session next-input suggestion timed out"
                            );
                            Ok(None)
                        }
                    },
                }
            }
            "opencode" => {
                let Some(model_selection) = session.model_selection.clone().and_then(|value| {
                    serde_json::from_value::<AiSessionModelSelection>(value).ok()
                }) else {
                    tracing::warn!(
                        ai_session_id = %session.id,
                        "AI Session next-input suggestion OpenCode model selection is unresolved"
                    );
                    return Ok(None);
                };
                self.controlled_models
                    .generate_structured_model(
                        AiSessionStructuredModelInput {
                            schema_name: "ai_session_next_input_suggestion".to_string(),
                            prompt,
                            output_schema,
                            model_selection,
                            reasoning_effort: resolved_reasoning_effort,
                            error_code_prefix: "AI_SESSION_NEXT_INPUT_SUGGESTION".to_string(),
                        },
                        Some(cancel),
                    )
                    .await
                    .map(Some)
            }
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::WebAuthState;
    use crate::config::InstanceConfig;
    use crate::private_model::{
        read_ai_session_next_input_suggestion_enabled,
        read_ai_session_next_input_suggestion_reasoning_effort,
    };
    use controlled_instance_ai_session::{
        ai_session_next_input_context, parse_ai_session_next_input_suggestion,
    };
    use controlled_instance_core::paths::StoragePaths;
    use controlled_instance_protocol::{
        project_ai_sessions_snapshot_for_consumer, AiSessionConsumerProjection, AiSessionsSnapshot,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    const FIXTURE: &str =
        include_str!("../../../../test/fixtures/ai-session-next-input-parity.json");

    fn normalize_session(mut value: Value) -> Value {
        let Some(object) = value.as_object_mut() else {
            panic!("session fixture must be an object")
        };
        object
            .entry("creationSource")
            .or_insert_with(|| json!("ai-session"));
        object.entry("phase").or_insert_with(|| json!("unknown"));
        let queue = object
            .entry("queue")
            .or_insert_with(|| json!({ "revision": 0, "pendingCount": 0, "items": [] }));
        if let Some(queue) = queue.as_object_mut() {
            queue.entry("revision").or_insert_with(|| json!(0));
            queue.entry("pendingCount").or_insert_with(|| json!(0));
            queue.entry("items").or_insert_with(|| json!([]));
        }
        object
            .entry("startedAt")
            .or_insert_with(|| json!("2026-11-25T00:00:00.000Z"));
        object
            .entry("updatedAt")
            .or_insert_with(|| json!("2026-11-25T00:01:00.000Z"));
        value
    }

    fn session(value: Value) -> AiSession {
        serde_json::from_value(normalize_session(value)).expect("session fixture")
    }

    fn session_with_turns(status: &str, turns: Value) -> AiSession {
        session(json!({
            "id": "ses_0000000000001",
            "agent": "codex",
            "providerSessionId": "thread-1",
            "status": status,
            "turns": turns
        }))
    }

    fn completed_turn(id: &str) -> Value {
        json!({
            "id": id,
            "status": "completed",
            "userPrompt": "修复测试",
            "summary": "测试已修复",
            "completedAt": "2026-11-25T00:00:30.000Z",
            "updatedAt": "2026-11-25T00:00:30.000Z"
        })
    }

    fn success_event(turn_id: &str) -> ProviderEvent {
        ProviderEvent::TurnCompleted {
            provider_session_id: "thread-1".to_string(),
            turn_id: Some(turn_id.to_string()),
            status: Some("completed".to_string()),
            error: None,
            completed_at: Some("2026-11-25T00:00:30.000Z".to_string()),
        }
    }

    fn test_state() -> (AppState, tempfile::TempDir) {
        let root = tempfile::tempdir().expect("tempdir");
        let ui = root.path().join("ui");
        std::fs::create_dir_all(&ui).expect("ui dir");
        std::fs::write(ui.join("index.html"), "<html>frozen ui</html>").expect("index");
        let data = root.path().join("data");
        let paths = StoragePaths {
            config_path: data.join("config.json"),
            data_dir: data.clone(),
            app_catalog_dir: data.join("app-catalog"),
            app_sessions_dir: data.join("app-sessions"),
            triggers_dir: data.join("triggers"),
            runtime_dir: data.join("runtime"),
            events_dir: data.join("events"),
            artifact_dir: data.join("artifacts"),
            log_dir: data.join("logs"),
            web_token_path: data.join("web-token"),
        };
        let config = InstanceConfig::for_test(ui, paths);
        (AppState::new(config, WebAuthState::disabled(None)), root)
    }

    fn generator(calls: Arc<AtomicUsize>, output: &'static str) -> TestSuggestionGenerator {
        Arc::new(move |_prompt| {
            let calls = calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(output.to_string()))
            })
        })
    }

    #[tokio::test]
    async fn shared_fixture_covers_parser_context_eligibility_projection_and_config() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture");
        for entry in fixture["parser"].as_array().expect("parser cases") {
            let raw = entry["raw"].as_str().expect("raw");
            let expected = entry["expected"].as_str();
            assert_eq!(
                parse_ai_session_next_input_suggestion(raw).as_deref(),
                expected,
                "{raw}"
            );
        }
        for entry in fixture["context"].as_array().expect("context cases") {
            let session = session(entry["session"].clone());
            let max_bytes = entry["maxBytes"].as_u64().expect("maxBytes") as usize;
            let users = ai_session_next_input_context(&session, max_bytes)
                .into_iter()
                .filter_map(|turn| turn.get("user").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>();
            let expected = entry["expectedUsers"]
                .as_array()
                .expect("expected users")
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            assert_eq!(users, expected, "{}", entry["name"]);
        }
        for entry in fixture["eligibility"]
            .as_array()
            .expect("eligibility cases")
        {
            let session = session(entry["session"].clone());
            assert_eq!(
                eligible(&session),
                entry["expected"].as_bool().expect("expected"),
                "{}",
                entry["name"]
            );
        }
        for entry in fixture["reasoningEffort"]
            .as_array()
            .expect("reasoning effort cases")
        {
            let mode = AiSessionNextInputSuggestionReasoningEffort::parse(
                entry["mode"].as_str().expect("mode"),
            )
            .expect("known mode");
            let session_effort = entry["sessionEffort"].as_str();
            let expected = entry["expected"].as_str().map(str::to_string);
            assert_eq!(mode.resolve(session_effort), expected, "{}", entry);
        }
        let consumer_session = session(json!({
            "id": "ses_0000000000003",
            "agent": "codex",
            "status": "idle",
            "lineage": { "kind": "subagent", "parentProviderSessionId": "thread-root" },
            "nextInputSuggestion": {
                "text": "继续。",
                "turnId": "turn_1",
                "generatedAt": "2026-11-25T00:00:30.000Z"
            }
        }));
        for entry in fixture["consumer"].as_array().expect("consumer cases") {
            let projected = project_ai_sessions_snapshot_for_consumer(
                AiSessionsSnapshot {
                    running_count: 0,
                    waiting_count: 0,
                    stale_count: 0,
                    sessions: vec![consumer_session.summary()],
                    updated_at: "2026-11-25T00:01:00.000Z".to_string(),
                },
                AiSessionConsumerProjection {
                    subagents: entry["subagents"].as_bool().expect("subagents"),
                    next_input_suggestion: entry["nextInputSuggestion"]
                        .as_bool()
                        .expect("nextInputSuggestion"),
                },
            );
            let projected = &projected.sessions[0];
            assert_eq!(
                projected.next_input_suggestion.is_some(),
                entry["expectedSuggestion"]
                    .as_bool()
                    .expect("expected suggestion"),
                "{}",
                entry
            );
            assert_eq!(
                projected.lineage.is_some(),
                entry["expectedLineage"]
                    .as_bool()
                    .expect("expected lineage"),
                "{}",
                entry
            );
        }
        for entry in fixture["config"].as_array().expect("config cases") {
            let environment = entry["env"]
                .as_object()
                .expect("env")
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().expect("env value").to_string()))
                .collect::<BTreeMap<_, _>>();
            assert_eq!(
                read_ai_session_next_input_suggestion_enabled(&environment),
                entry["expected"].as_bool().expect("expected"),
                "{}",
                entry
            );
        }
        for entry in fixture["reasoningEffortConfig"]
            .as_array()
            .expect("reasoning effort config cases")
        {
            let environment = entry["env"]
                .as_object()
                .expect("env")
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().expect("env value").to_string()))
                .collect::<BTreeMap<_, _>>();
            assert_eq!(
                read_ai_session_next_input_suggestion_reasoning_effort(&environment).as_str(),
                entry["expected"].as_str().expect("expected"),
                "{}",
                entry
            );
        }
    }

    #[tokio::test]
    async fn coordinator_generates_once_for_a_settled_turn() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(10),
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        coordinator
            .set_test_generator(generator(
                calls.clone(),
                r#"{"suggestion":"继续修复测试。"}"#,
            ))
            .await;
        state
            .ai_sessions
            .save(session_with_turns(
                "idle",
                json!([completed_turn("turn_1")]),
            ))
            .expect("session");

        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        tokio::time::sleep(Duration::from_millis(60)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let suggestion = state
            .ai_sessions
            .get("ses_0000000000001")
            .and_then(|session| session.next_input_suggestion)
            .expect("suggestion");
        assert_eq!(suggestion.text, "继续修复测试。");
        assert_eq!(suggestion.turn_id, "turn_1");
    }

    #[tokio::test]
    async fn a_late_success_for_an_older_turn_does_not_suggest_for_the_latest_turn() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(10),
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        coordinator
            .set_test_generator(generator(calls.clone(), r#"{"suggestion":"不应出现"}"#))
            .await;
        state
            .ai_sessions
            .save(session_with_turns(
                "idle",
                json!([completed_turn("turn_1"), completed_turn("turn_2")]),
            ))
            .expect("session");

        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        coordinator.handle_state_change(&state).await;
        tokio::time::sleep(Duration::from_millis(60)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(state
            .ai_sessions
            .get("ses_0000000000001")
            .expect("session")
            .next_input_suggestion
            .is_none());
    }

    #[tokio::test]
    async fn user_activity_cancels_a_pending_generation() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(40),
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        coordinator
            .set_test_generator(generator(calls.clone(), r#"{"suggestion":"不应出现"}"#))
            .await;
        state
            .ai_sessions
            .save(session_with_turns(
                "idle",
                json!([completed_turn("turn_1")]),
            ))
            .expect("session");

        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        coordinator
            .handle_provider_event(
                &state,
                &ProviderEvent::UserMessage {
                    provider_session_id: "thread-1".to_string(),
                    turn_id: "turn_2".to_string(),
                    item_id: "item-1".to_string(),
                    text: "next".to_string(),
                    observed_at: None,
                    completed: true,
                },
            )
            .await;
        tokio::time::sleep(Duration::from_millis(120)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_late_agent_message_does_not_drop_a_pending_successful_turn() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(10),
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        coordinator
            .set_test_generator(generator(
                calls.clone(),
                r#"{"suggestion":"继续修复测试。"}"#,
            ))
            .await;
        state
            .ai_sessions
            .save(session_with_turns(
                "running",
                json!([completed_turn("turn_1")]),
            ))
            .expect("session");

        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        // The adapter can emit the final agent message after turn/completed but
        // before the runtime exposes idle; this must not erase the pending success.
        coordinator
            .handle_provider_event(
                &state,
                &ProviderEvent::AgentMessageCompleted {
                    provider_session_id: "thread-1".to_string(),
                    turn_id: "turn_1".to_string(),
                    item_id: "item-1".to_string(),
                    text: "测试已修复".to_string(),
                    observed_at: Some("2026-11-25T00:00:31.000Z".to_string()),
                },
            )
            .await;
        state
            .ai_sessions
            .update("ses_0000000000001", |session| {
                session.status = "idle".to_string();
                Ok(true)
            })
            .expect("session update");
        coordinator.handle_state_change(&state).await;
        tokio::time::sleep(Duration::from_millis(60)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let suggestion = state
            .ai_sessions
            .get("ses_0000000000001")
            .and_then(|session| session.next_input_suggestion)
            .expect("suggestion");
        assert_eq!(suggestion.turn_id, "turn_1");
    }

    #[tokio::test]
    async fn closing_a_session_drops_its_coordinator_state_and_pending_request() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(40),
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        coordinator
            .set_test_generator(generator(calls.clone(), r#"{"suggestion":"不应出现"}"#))
            .await;
        state
            .ai_sessions
            .save(session_with_turns(
                "idle",
                json!([completed_turn("turn_1")]),
            ))
            .expect("session");
        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        state
            .ai_sessions
            .remove("ses_0000000000001")
            .expect("remove session");
        coordinator.handle_state_change(&state).await;
        tokio::time::sleep(Duration::from_millis(120)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn disabling_clears_persisted_suggestions_and_stops_requests() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(10),
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        coordinator
            .set_test_generator(generator(calls.clone(), r#"{"suggestion":"不应出现"}"#))
            .await;
        let mut session = session_with_turns("idle", json!([completed_turn("turn_1")]));
        session.next_input_suggestion = Some(AiSessionNextInputSuggestion {
            text: "旧建议".to_string(),
            turn_id: "turn_1".to_string(),
            generated_at: "2026-11-25T00:00:31.000Z".to_string(),
        });
        state.ai_sessions.save(session).expect("session");

        coordinator.set_enabled(&state, false).await;
        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        tokio::time::sleep(Duration::from_millis(60)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(state
            .ai_sessions
            .get("ses_0000000000001")
            .expect("session")
            .next_input_suggestion
            .is_none());
    }

    #[tokio::test]
    async fn changing_reasoning_mode_clears_suggestions_and_drops_in_flight_work() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(10),
        ));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let generator_started = started.clone();
        let generator_release = release.clone();
        let generator_calls = calls.clone();
        coordinator
            .set_test_generator(Arc::new(move |_prompt| {
                let started = generator_started.clone();
                let release = generator_release.clone();
                let calls = generator_calls.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    started.notify_one();
                    release.notified().await;
                    Ok(Some(r#"{"suggestion":"迟到建议"}"#.to_string()))
                })
            }))
            .await;
        let mut session = session_with_turns("idle", json!([completed_turn("turn_1")]));
        session.next_input_suggestion = Some(AiSessionNextInputSuggestion {
            text: "旧建议".to_string(),
            turn_id: "turn_1".to_string(),
            generated_at: "2026-11-25T00:00:31.000Z".to_string(),
        });
        state.ai_sessions.save(session).expect("session");

        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("generation should start");
        coordinator
            .set_reasoning_effort(&state, AiSessionNextInputSuggestionReasoningEffort::High)
            .await;
        assert_eq!(
            coordinator.reasoning_effort().await,
            AiSessionNextInputSuggestionReasoningEffort::High
        );
        assert!(state
            .ai_sessions
            .get("ses_0000000000001")
            .expect("session")
            .next_input_suggestion
            .is_none());

        release.notify_one();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(state
            .ai_sessions
            .get("ses_0000000000001")
            .expect("session")
            .next_input_suggestion
            .is_none());
    }

    #[tokio::test]
    async fn a_result_is_dropped_when_the_session_left_idle_before_persistence() {
        let (state, _root) = test_state();
        let coordinator = Arc::new(AiSessionNextInputSuggestionCoordinator::with_debounce(
            true,
            Duration::from_millis(10),
        ));
        let state_for_generator = state.clone();
        coordinator
            .set_test_generator(Arc::new(move |_prompt| {
                let state = state_for_generator.clone();
                Box::pin(async move {
                    state
                        .ai_sessions
                        .update("ses_0000000000001", |session| {
                            session.status = "running".to_string();
                            Ok(true)
                        })
                        .expect("session update");
                    Ok(Some(r#"{"suggestion":"不应写入"}"#.to_string()))
                })
            }))
            .await;
        state
            .ai_sessions
            .save(session_with_turns(
                "idle",
                json!([completed_turn("turn_1")]),
            ))
            .expect("session");

        coordinator
            .handle_provider_event(&state, &success_event("turn_1"))
            .await;
        tokio::time::sleep(Duration::from_millis(80)).await;

        assert!(state
            .ai_sessions
            .get("ses_0000000000001")
            .expect("session")
            .next_input_suggestion
            .is_none());
    }

    #[test]
    fn failed_completions_and_session_errors_suppress_their_turns() {
        let session = session_with_turns("idle", json!([completed_turn("turn_1")]));
        let failed = ProviderEvent::TurnCompleted {
            provider_session_id: "thread-1".to_string(),
            turn_id: Some("turn_1".to_string()),
            status: Some("interrupted".to_string()),
            error: None,
            completed_at: None,
        };
        assert!(event_invalidates_suggestion(&failed));
        assert_eq!(
            suppressed_turn_id(&failed, &session).as_deref(),
            Some("turn_1")
        );
        let completed = success_event("turn_1");
        assert!(!event_invalidates_suggestion(&completed));
        assert_eq!(suppressed_turn_id(&completed, &session), None);

        let mut active = session.clone();
        active.active_turn_id = Some("turn_active".to_string());
        let error = ProviderEvent::SessionError {
            provider_session_id: "thread-1".to_string(),
            error: "failed".to_string(),
        };
        assert!(event_invalidates_suggestion(&error));
        assert_eq!(
            suppressed_turn_id(&error, &active).as_deref(),
            Some("turn_active")
        );
    }

    #[test]
    fn latest_turn_must_be_completed_and_match_the_provider_turn() {
        let mut session = session_with_turns("idle", json!([completed_turn("turn_1")]));
        let latest = latest_completed_turn(&session).expect("latest");
        assert!(turn_matches_provider_turn(latest, Some("turn_1")));
        assert!(!turn_matches_provider_turn(latest, Some("turn_0")));
        session.status = "running".to_string();
        assert!(!eligible(&session));
        session.status = "idle".to_string();
        session.queue.pending_count = 1;
        assert!(!eligible(&session));
        session.queue.pending_count = 0;
        session.lineage = Some(json!({ "kind": "subagent", "parentProviderSessionId": "root" }));
        assert!(!eligible(&session));
    }
}
