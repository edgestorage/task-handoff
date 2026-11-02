use controlled_instance_protocol::{TriggerPolicy, TriggerWhenBusy};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_QUEUED_PER_TRIGGER: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerSkipReason {
    Cooldown,
    Busy,
    QueueFull,
    SchedulerStopped,
    JobDisabled,
}

impl SchedulerSkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cooldown => "cooldown",
            Self::Busy => "busy",
            Self::QueueFull => "queue-full",
            Self::SchedulerStopped => "scheduler-stopped",
            Self::JobDisabled => "job-disabled",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Cooldown => "Skipped by cooldown policy.",
            Self::Busy => "Skipped because trigger reached its concurrency limit.",
            Self::QueueFull => "Skipped because the trigger queue is full.",
            Self::SchedulerStopped => "Skipped because the trigger scheduler stopped.",
            Self::JobDisabled => "Skipped because the trigger was disabled.",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitDecision {
    Started,
    Queued,
    Skipped(SchedulerSkipReason),
}

#[derive(Clone)]
pub struct QueuedExecution<T> {
    pub key: String,
    pub event: T,
    pub policy: TriggerPolicy,
}

struct SchedulerState<T> {
    accepting: AtomicBool,
    running: Mutex<HashMap<String, usize>>,
    queued: Mutex<HashMap<String, VecDeque<QueuedExecution<T>>>>,
    last_started_at: Mutex<HashMap<String, i64>>,
}

pub struct Scheduler<T> {
    state: Arc<SchedulerState<T>>,
}

impl<T> Clone for Scheduler<T> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
        }
    }
}

impl<T> Scheduler<T> {
    pub fn new() -> Self {
        Self {
            state: Arc::new(SchedulerState {
                accepting: AtomicBool::new(true),
                running: Mutex::new(HashMap::new()),
                queued: Mutex::new(HashMap::new()),
                last_started_at: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn start(&self) {
        self.state.accepting.store(true, Ordering::SeqCst);
    }

    pub fn submit(&self, key: String, event: T, policy: TriggerPolicy) -> SubmitDecision
    where
        T: Clone,
    {
        if !self.state.accepting.load(Ordering::SeqCst) {
            return SubmitDecision::Skipped(SchedulerSkipReason::SchedulerStopped);
        }
        let now = unix_millis();
        if policy.cooldown_ms.is_some_and(|cooldown| {
            self.state
                .last_started_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&key)
                .is_some_and(|last| now.saturating_sub(*last) < cooldown as i64)
        }) {
            return SubmitDecision::Skipped(SchedulerSkipReason::Cooldown);
        }
        let running = self.running(&key);
        if running >= usize::from(policy.max_concurrent_runs) {
            if policy.when_busy == TriggerWhenBusy::Skip {
                return SubmitDecision::Skipped(SchedulerSkipReason::Busy);
            }
            let mut queued = self
                .state
                .queued
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let queue = queued.entry(key.clone()).or_default();
            if queue.len() >= MAX_QUEUED_PER_TRIGGER {
                return SubmitDecision::Skipped(SchedulerSkipReason::QueueFull);
            }
            queue.push_back(QueuedExecution { key, event, policy });
            return SubmitDecision::Queued;
        }
        self.begin(&key);
        SubmitDecision::Started
    }

    pub fn finish(&self, key: &str) -> Option<QueuedExecution<T>>
    where
        T: Clone,
    {
        {
            let mut running = self
                .state
                .running
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let remaining = running.get(key).copied().unwrap_or(1).saturating_sub(1);
            if remaining == 0 {
                running.remove(key);
            } else {
                running.insert(key.to_string(), remaining);
            }
        }
        if !self.state.accepting.load(Ordering::SeqCst) {
            return None;
        }
        let mut queued = self
            .state
            .queued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = queued.get(key)?.front().cloned()?;
        if self.running(key) >= usize::from(next.policy.max_concurrent_runs) {
            return None;
        }
        let queue = queued.get_mut(key).expect("queue exists");
        queue.pop_front();
        if queue.is_empty() {
            queued.remove(key);
        }
        self.begin(key);
        Some(next)
    }

    pub fn stop(&self) -> Vec<QueuedExecution<T>> {
        self.state.accepting.store(false, Ordering::SeqCst);
        let mut queued = self
            .state
            .queued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut skipped = Vec::new();
        for (_, queue) in queued.drain() {
            skipped.extend(queue);
        }
        skipped
    }

    pub fn current_running_count(&self, key: &str) -> usize {
        self.running(key)
    }

    fn running(&self, key: &str) -> usize {
        self.state
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .copied()
            .unwrap_or_default()
    }

    fn begin(&self, key: &str) {
        *self
            .state
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(key.to_string())
            .or_default() += 1;
        self.state
            .last_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key.to_string(), unix_millis());
    }
}

impl<T> Default for Scheduler<T> {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(concurrency: u8, busy: TriggerWhenBusy, cooldown: Option<u64>) -> TriggerPolicy {
        TriggerPolicy {
            cooldown_ms: cooldown,
            max_concurrent_runs: concurrency,
            when_busy: busy,
        }
    }

    #[test]
    fn scheduler_applies_cooldown_busy_queue_and_stop_semantics() {
        let scheduler = Scheduler::new();
        assert_eq!(
            scheduler.submit(
                "one".to_string(),
                "first",
                policy(1, TriggerWhenBusy::Queue, Some(60_000))
            ),
            SubmitDecision::Started
        );
        assert_eq!(
            scheduler.submit(
                "one".to_string(),
                "cooldown",
                policy(1, TriggerWhenBusy::Queue, Some(60_000))
            ),
            SubmitDecision::Skipped(SchedulerSkipReason::Cooldown)
        );
        assert_eq!(
            scheduler.submit(
                "one".to_string(),
                "busy",
                policy(1, TriggerWhenBusy::Skip, None)
            ),
            SubmitDecision::Skipped(SchedulerSkipReason::Busy)
        );

        let scheduler = Scheduler::new();
        assert_eq!(
            scheduler.submit(
                "two".to_string(),
                "first",
                policy(1, TriggerWhenBusy::Queue, None)
            ),
            SubmitDecision::Started
        );
        assert_eq!(
            scheduler.submit(
                "two".to_string(),
                "queued",
                policy(1, TriggerWhenBusy::Queue, None)
            ),
            SubmitDecision::Queued
        );
        let next = scheduler.finish("two").expect("queued execution");
        assert_eq!(next.event, "queued");
        assert_eq!(scheduler.current_running_count("two"), 1);
        scheduler.finish("two");

        let stopped = scheduler.stop();
        assert!(stopped.is_empty());
        assert_eq!(
            scheduler.submit(
                "three".to_string(),
                "stopped",
                policy(1, TriggerWhenBusy::Skip, None)
            ),
            SubmitDecision::Skipped(SchedulerSkipReason::SchedulerStopped)
        );
    }
}
