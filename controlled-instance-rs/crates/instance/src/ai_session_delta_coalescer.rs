use crate::events::EventBus;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::time::sleep;

pub const DEFAULT_WINDOW_MS: f64 = 32.0;
pub const MIN_WINDOW_MS: f64 = 20.0;
pub const MAX_WINDOW_MS: f64 = 50.0;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AiSessionDeltaKey {
    pub instance_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
}

impl AiSessionDeltaKey {
    pub fn new(
        instance_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_id: Option<String>,
        item_id: Option<String>,
    ) -> Self {
        Self {
            instance_id: instance_id.into(),
            session_id: session_id.into(),
            turn_id,
            item_id,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum FlushReason {
    Window,
    Manual,
    Completed,
    Failed,
    Waiting,
    Interrupted,
    AuthoritativeEvent,
    EventSourceClose,
    ServiceClose,
}

impl FlushReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Manual => "manual",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Waiting => "waiting",
            Self::Interrupted => "interrupted",
            Self::AuthoritativeEvent => "authoritative-event",
            Self::EventSourceClose => "event-source-close",
            Self::ServiceClose => "service-close",
        }
    }
}

#[derive(Clone, Debug, Default)]
struct CoalescerDiagnostics {
    raw_delta_count: u64,
    emitted_event_count: u64,
    total_batch_size: u64,
    max_batch_size: u64,
    flush_reasons: HashMap<String, u64>,
    total_first_batch_wait_ms: f64,
    max_first_batch_wait_ms: f64,
}

struct PendingDeltaBatch {
    chunks: Vec<String>,
    first_received_at: Instant,
    last_payload: Value,
    generation: u64,
}

#[derive(Default)]
struct CoalescerState {
    pending: HashMap<AiSessionDeltaKey, PendingDeltaBatch>,
    order: Vec<AiSessionDeltaKey>,
    diagnostics: CoalescerDiagnostics,
    next_generation: u64,
    closed: bool,
}

#[derive(Clone)]
pub struct AiSessionDeltaCoalescer {
    window_ms: f64,
    event_type: &'static str,
    events: EventBus,
    state: Arc<Mutex<CoalescerState>>,
}

impl AiSessionDeltaCoalescer {
    pub fn new(
        events: EventBus,
        event_type: &'static str,
        window_ms: Option<f64>,
    ) -> Result<Self, String> {
        let window_ms = window_ms.unwrap_or(DEFAULT_WINDOW_MS);
        if !window_ms.is_finite() || !(MIN_WINDOW_MS..=MAX_WINDOW_MS).contains(&window_ms) {
            return Err(format!(
                "AI session delta coalescing window must be between {MIN_WINDOW_MS}ms and {MAX_WINDOW_MS}ms"
            ));
        }
        Ok(Self {
            window_ms,
            event_type,
            events,
            state: Arc::new(Mutex::new(CoalescerState::default())),
        })
    }

    pub fn push(
        &self,
        key: AiSessionDeltaKey,
        payload: Value,
        delta: String,
    ) -> Result<(), String> {
        let (generation, should_schedule) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.closed {
                return Err("AI session delta coalescer is closed".to_string());
            }
            state.diagnostics.raw_delta_count += 1;
            if let Some(batch) = state.pending.get_mut(&key) {
                batch.chunks.push(delta);
                batch.last_payload = payload;
                (batch.generation, false)
            } else {
                state.next_generation = state.next_generation.wrapping_add(1);
                let generation = state.next_generation;
                state.pending.insert(
                    key.clone(),
                    PendingDeltaBatch {
                        chunks: vec![delta],
                        first_received_at: Instant::now(),
                        last_payload: payload,
                        generation,
                    },
                );
                state.order.push(key.clone());
                (generation, true)
            }
        };
        if should_schedule {
            let coalescer = self.clone();
            tokio::spawn(async move {
                sleep(Duration::from_secs_f64(coalescer.window_ms / 1_000.0)).await;
                coalescer.flush_window(&key, generation);
            });
        }
        Ok(())
    }

    pub fn flush(&self, key: &AiSessionDeltaKey, reason: FlushReason) -> bool {
        self.flush_key(key, None, reason)
    }

    pub fn flush_all(&self, reason: FlushReason) -> usize {
        let keys = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.order.clone()
        };
        keys.into_iter()
            .filter(|key| self.flush_key(key, None, reason))
            .count()
    }

    pub fn close(&self, reason: FlushReason) -> usize {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.closed {
                return 0;
            }
            state.closed = true;
        }
        self.flush_all(reason)
    }

    pub fn window_ms(&self) -> f64 {
        self.window_ms
    }

    pub fn pending_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .len()
    }

    pub fn diagnostic_value(&self) -> Value {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let diagnostics = &state.diagnostics;
        json!({
            "windowMs": self.window_ms,
            "pendingMessageCount": state.pending.len(),
            "rawDeltaCount": diagnostics.raw_delta_count,
            "emittedEventCount": diagnostics.emitted_event_count,
            "totalBatchSize": diagnostics.total_batch_size,
            "maxBatchSize": diagnostics.max_batch_size,
            "flushReasons": diagnostics.flush_reasons,
            "totalFirstBatchWaitMs": diagnostics.total_first_batch_wait_ms,
            "maxFirstBatchWaitMs": diagnostics.max_first_batch_wait_ms,
        })
    }

    fn flush_window(&self, key: &AiSessionDeltaKey, generation: u64) {
        self.flush_key(key, Some(generation), FlushReason::Window);
    }

    fn flush_key(
        &self,
        key: &AiSessionDeltaKey,
        generation: Option<u64>,
        reason: FlushReason,
    ) -> bool {
        let batch = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(current) = state.pending.get(key) else {
                return false;
            };
            if generation.is_some_and(|expected| expected != current.generation) {
                return false;
            }
            let batch = state.pending.remove(key).expect("pending batch");
            state.order.retain(|candidate| candidate != key);
            let batch_size = batch.chunks.len() as u64;
            let wait_ms = batch.first_received_at.elapsed().as_secs_f64() * 1_000.0;
            let diagnostics = &mut state.diagnostics;
            diagnostics.emitted_event_count += 1;
            diagnostics.total_batch_size += batch_size;
            diagnostics.max_batch_size = diagnostics.max_batch_size.max(batch_size);
            *diagnostics
                .flush_reasons
                .entry(reason.as_str().to_string())
                .or_default() += 1;
            diagnostics.total_first_batch_wait_ms += wait_ms;
            diagnostics.max_first_batch_wait_ms = diagnostics.max_first_batch_wait_ms.max(wait_ms);
            batch
        };
        let mut payload = batch.last_payload;
        payload["delta"] = Value::String(batch.chunks.concat());
        self.events.publish(self.event_type, payload);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(session: &str, delta: &str, generated_at: &str) -> Value {
        json!({
            "instanceId": "inst_test",
            "sessionId": session,
            "turnId": "turn-1",
            "itemId": "item-1",
            "delta": delta,
            "generatedAt": generated_at,
        })
    }

    fn key(session: &str) -> AiSessionDeltaKey {
        AiSessionDeltaKey::new(
            "inst_test",
            session,
            Some("turn-1".into()),
            Some("item-1".into()),
        )
    }

    #[tokio::test]
    async fn coalesces_one_message_in_order_and_uses_the_last_metadata() {
        let events = EventBus::default();
        let mut receiver = events.subscribe();
        let coalescer =
            AiSessionDeltaCoalescer::new(events, "ai-session.message-delta", Some(20.0)).unwrap();
        coalescer
            .push(
                key("session-1"),
                payload("session-1", "hel", "2026-07-18T00:00:00.001Z"),
                "hel".into(),
            )
            .unwrap();
        coalescer
            .push(
                key("session-1"),
                payload("session-1", "lo", "2026-07-18T00:00:00.020Z"),
                "lo".into(),
            )
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("coalesced event")
            .expect("event");
        assert_eq!(event.r#type, "ai-session.message-delta");
        assert_eq!(event.payload["delta"], "hello");
        assert_eq!(event.payload["generatedAt"], "2026-07-18T00:00:00.020Z");
        let diagnostics = coalescer.diagnostic_value();
        assert_eq!(diagnostics["rawDeltaCount"], 2);
        assert_eq!(diagnostics["emittedEventCount"], 1);
        assert_eq!(diagnostics["totalBatchSize"], 2);
        assert_eq!(diagnostics["maxBatchSize"], 2);
        assert_eq!(diagnostics["flushReasons"]["window"], 1);
        assert_eq!(coalescer.pending_count(), 0);
    }

    #[tokio::test]
    async fn independent_keys_flush_without_mixing_and_all_keep_insertion_order() {
        let events = EventBus::default();
        let mut receiver = events.subscribe();
        let coalescer =
            AiSessionDeltaCoalescer::new(events, "ai-session.message-delta", Some(50.0)).unwrap();
        coalescer
            .push(key("session-1"), payload("session-1", "a", "1"), "a".into())
            .unwrap();
        coalescer
            .push(key("session-2"), payload("session-2", "b", "2"), "b".into())
            .unwrap();
        coalescer
            .push(key("session-1"), payload("session-1", "c", "3"), "c".into())
            .unwrap();
        assert!(coalescer.flush(&key("session-1"), FlushReason::Manual));
        assert_eq!(coalescer.pending_count(), 1);
        assert_eq!(
            receiver.try_recv().expect("first event").payload["delta"],
            "ac"
        );
        coalescer
            .push(key("session-1"), payload("session-1", "d", "4"), "d".into())
            .unwrap();
        assert_eq!(coalescer.flush_all(FlushReason::Manual), 2);
        assert_eq!(
            receiver.try_recv().expect("second event").payload["delta"],
            "b"
        );
        assert_eq!(
            receiver.try_recv().expect("third event").payload["delta"],
            "d"
        );
    }

    #[tokio::test]
    async fn closure_flushes_and_rejects_later_deltas() {
        let events = EventBus::default();
        let coalescer =
            AiSessionDeltaCoalescer::new(events, "ai-session.message-delta", Some(50.0)).unwrap();
        coalescer
            .push(
                key("session-1"),
                payload("session-1", "first", "1"),
                "first".into(),
            )
            .unwrap();
        assert_eq!(coalescer.close(FlushReason::ServiceClose), 1);
        assert_eq!(coalescer.close(FlushReason::ServiceClose), 0);
        assert!(coalescer
            .push(
                key("session-1"),
                payload("session-1", "late", "2"),
                "late".into()
            )
            .is_err());
    }

    #[test]
    fn validates_the_node_window_bounds() {
        let events = EventBus::default();
        for window_ms in [19.9, 50.1, f64::NAN, f64::INFINITY] {
            assert!(AiSessionDeltaCoalescer::new(
                events.clone(),
                "ai-session.message-delta",
                Some(window_ms)
            )
            .is_err());
        }
        for window_ms in [MIN_WINDOW_MS, DEFAULT_WINDOW_MS, MAX_WINDOW_MS] {
            assert!(AiSessionDeltaCoalescer::new(
                events.clone(),
                "ai-session.message-delta",
                Some(window_ms)
            )
            .is_ok());
        }
    }
}
