use rand::Rng;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const MAX_SEQUENCE: u64 = (1 << 22) - 1;

struct SnowflakeState {
    last_millis: u64,
    sequence: u64,
}

fn state() -> &'static Mutex<SnowflakeState> {
    static STATE: OnceLock<Mutex<SnowflakeState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(SnowflakeState {
            last_millis: 0,
            sequence: rand::rng().random_range(0..=MAX_SEQUENCE),
        })
    })
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn encode_crockford(mut value: u64) -> String {
    let mut buffer = [b'0'; 13];
    for index in (0..13).rev() {
        buffer[index] = CROCKFORD[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(buffer.to_vec()).expect("Crockford alphabet is ASCII")
}

/// Mints the repository-wide time-ordered entity ID shape: `<prefix>_<13 base32>`.
pub fn mint_entity_id(prefix: &str) -> String {
    let mut state = state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = unix_millis();
    if now == state.last_millis {
        state.sequence = (state.sequence + 1) & MAX_SEQUENCE;
        if state.sequence == 0 {
            state.last_millis = now.saturating_add(1);
        }
    } else {
        state.last_millis = now.max(state.last_millis);
        state.sequence = rand::rng().random_range(0..=MAX_SEQUENCE);
    }
    let value = (state.last_millis << 22) | state.sequence;
    format!("{prefix}_{}", encode_crockford(value))
}

pub fn event_id() -> String {
    let millis = unix_millis();
    let random = rand::rng().random::<u64>();
    format!("evt_{millis:x}_{random:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_ids_have_stable_wire_shape() {
        let id = mint_entity_id("ins");
        assert_eq!(id.len(), 17);
        assert!(id.starts_with("ins_"));
        assert!(id[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase()));
    }

    #[test]
    fn entity_ids_are_monotonic_within_a_process() {
        let first = mint_entity_id("ses");
        let second = mint_entity_id("ses");
        assert_ne!(first, second);
        assert!(second > first);
    }
}
