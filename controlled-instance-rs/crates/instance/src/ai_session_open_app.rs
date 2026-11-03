use controlled_instance_ai_session::ProviderError;
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AiSessionOpenAppOutcome {
    Success(Value),
    Error(ProviderError),
}

impl AiSessionOpenAppOutcome {
    pub(crate) fn success(data: Value) -> Self {
        Self::Success(data)
    }

    pub(crate) fn error(status_code: u16, code: &str, message: impl Into<String>) -> Self {
        Self::Error(ProviderError::new(code, message, status_code))
    }
}

#[derive(Clone)]
struct OpenAppFlight {
    id: u64,
    result: watch::Receiver<Option<AiSessionOpenAppOutcome>>,
}

pub(crate) struct AiSessionOpenAppCoordinator {
    flights: Mutex<HashMap<String, OpenAppFlight>>,
    next_id: AtomicU64,
}

impl Default for AiSessionOpenAppCoordinator {
    fn default() -> Self {
        Self {
            flights: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

impl AiSessionOpenAppCoordinator {
    pub(crate) async fn open<F, Fut>(
        self: &Arc<Self>,
        keys: Vec<String>,
        operation: F,
    ) -> AiSessionOpenAppOutcome
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = AiSessionOpenAppOutcome> + Send + 'static,
    {
        let (sender, receiver) = watch::channel(None);
        let flight_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let existing = {
            let mut flights = self
                .flights
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(existing) = keys.iter().find_map(|key| flights.get(key).cloned()) {
                Some(existing)
            } else {
                for key in &keys {
                    flights.insert(
                        key.clone(),
                        OpenAppFlight {
                            id: flight_id,
                            result: receiver.clone(),
                        },
                    );
                }
                None
            }
        };
        if let Some(existing) = existing {
            return wait_for_result(existing.result).await;
        }

        let coordinator = self.clone();
        let cleanup_keys = keys.clone();
        tokio::spawn(async move {
            let outcome = operation().await;
            sender.send_replace(Some(outcome.clone()));
            coordinator.remove(&cleanup_keys, flight_id);
        });
        wait_for_result(receiver).await
    }

    fn remove(&self, keys: &[String], flight_id: u64) {
        let mut flights = self
            .flights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for key in keys {
            if flights
                .get(key)
                .is_some_and(|flight| flight.id == flight_id)
            {
                flights.remove(key);
            }
        }
    }
}

async fn wait_for_result(
    mut receiver: watch::Receiver<Option<AiSessionOpenAppOutcome>>,
) -> AiSessionOpenAppOutcome {
    loop {
        if let Some(outcome) = receiver.borrow().clone() {
            return outcome;
        }
        if receiver.changed().await.is_err() {
            return AiSessionOpenAppOutcome::error(
                409,
                "AI_SESSION_OPEN_APP_FAILED",
                "App could not resume the AI session.",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::Barrier;

    #[tokio::test]
    async fn same_provider_key_shares_one_operation_and_result() {
        let coordinator = Arc::new(AiSessionOpenAppCoordinator::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let first = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .open(
                        vec![
                            "ai:ses_first".to_string(),
                            "provider:codex:provider_one".to_string(),
                        ],
                        move || async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                            AiSessionOpenAppOutcome::success(
                                serde_json::json!({"appSessionId": "app_one"}),
                            )
                        },
                    )
                    .await
            })
        };
        let second = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .open(
                        vec![
                            "ai:ses_second".to_string(),
                            "provider:codex:provider_one".to_string(),
                        ],
                        move || async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            AiSessionOpenAppOutcome::success(
                                serde_json::json!({"appSessionId": "app_second"}),
                            )
                        },
                    )
                    .await
            })
        };

        let first = first.await.expect("first request");
        let second = second.await.expect("second request");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
        assert_eq!(
            first,
            AiSessionOpenAppOutcome::success(serde_json::json!({"appSessionId": "app_one"}))
        );
    }

    #[tokio::test]
    async fn different_keys_run_in_parallel() {
        let coordinator = Arc::new(AiSessionOpenAppCoordinator::default());
        let barrier = Arc::new(Barrier::new(2));
        let first = {
            let coordinator = coordinator.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                coordinator
                    .open(vec!["ai:ses_first".to_string()], move || async move {
                        barrier.wait().await;
                        AiSessionOpenAppOutcome::success(serde_json::json!({"request": "first"}))
                    })
                    .await
            })
        };
        let second = {
            let coordinator = coordinator.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                coordinator
                    .open(vec!["ai:ses_second".to_string()], move || async move {
                        barrier.wait().await;
                        AiSessionOpenAppOutcome::success(serde_json::json!({"request": "second"}))
                    })
                    .await
            })
        };

        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            (
                first.await.expect("first request"),
                second.await.expect("second request"),
            )
        })
        .await
        .expect("different keys must not serialize");

        assert_eq!(
            first,
            AiSessionOpenAppOutcome::success(serde_json::json!({"request": "first"}))
        );
        assert_eq!(
            second,
            AiSessionOpenAppOutcome::success(serde_json::json!({"request": "second"}))
        );
    }

    #[tokio::test]
    async fn completed_flight_is_removed_for_the_next_request() {
        let coordinator = Arc::new(AiSessionOpenAppCoordinator::default());
        let calls = Arc::new(AtomicUsize::new(0));
        for request in 1..=2 {
            let calls = calls.clone();
            let outcome = coordinator
                .open(vec!["ai:ses_one".to_string()], move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    AiSessionOpenAppOutcome::success(serde_json::json!({"request": request}))
                })
                .await;
            assert_eq!(
                outcome,
                AiSessionOpenAppOutcome::success(serde_json::json!({"request": request}))
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
