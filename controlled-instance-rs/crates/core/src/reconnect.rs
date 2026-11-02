use rand::Rng;
use std::time::Duration;

pub const STANDARD_RECONNECT_BASE_DELAY_MS: u64 = 250;
pub const STANDARD_RECONNECT_MAX_DELAY_MS: u64 = 60_000;

pub fn standard_reconnect_delay_ms(retry_number: u32, random: f64) -> u64 {
    let normalized_retry = retry_number.max(1);
    if normalized_retry == 1 {
        return 0;
    }
    if normalized_retry == 2 {
        return STANDARD_RECONNECT_BASE_DELAY_MS;
    }
    let shift = (normalized_retry - 2).min(31);
    let base_delay = STANDARD_RECONNECT_BASE_DELAY_MS
        .saturating_mul(1_u64 << shift)
        .min(STANDARD_RECONNECT_MAX_DELAY_MS);
    let jittered = (base_delay as f64 * (0.75 + random.clamp(0.0, 1.0) * 0.5)).round() as u64;
    jittered.min(STANDARD_RECONNECT_MAX_DELAY_MS)
}

#[derive(Debug, Default)]
pub struct StandardReconnectBackoff {
    attempts: u32,
}

impl StandardReconnectBackoff {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn next_delay(&mut self) -> Duration {
        self.attempts = self.attempts.saturating_add(1);
        Duration::from_millis(standard_reconnect_delay_ms(
            self.attempts,
            rand::rng().random::<f64>(),
        ))
    }

    pub fn reset(&mut self) {
        self.attempts = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_retry_is_immediate_and_later_retries_are_capped() {
        assert_eq!(standard_reconnect_delay_ms(1, 0.5), 0);
        assert_eq!(standard_reconnect_delay_ms(2, 0.5), 250);
        assert_eq!(standard_reconnect_delay_ms(100, 0.5), 60_000);
    }

    #[test]
    fn backoff_resets_after_a_successful_cycle() {
        let mut backoff = StandardReconnectBackoff::new();
        assert_eq!(backoff.next_delay(), Duration::ZERO);
        let _ = backoff.next_delay();
        assert_eq!(backoff.attempts(), 2);
        backoff.reset();
        assert_eq!(backoff.attempts(), 0);
    }
}
