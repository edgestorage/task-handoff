//! Instance-owned durable intent, independent of package installation and general
//! config writes from N-1 clients. No session or credential is persisted.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
#[derive(Clone)]
pub struct DesktopSettings {
    file: PathBuf,
}
impl DesktopSettings {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join("remote-desktop.json"),
        }
    }
    /// Sanitize before consuming: unknown/missing fields and invalid historical
    /// values disable only this feature. Do not erase the source during reads.
    pub fn enabled(&self) -> bool {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("enabled").and_then(Value::as_bool))
            .unwrap_or(false)
    }
    pub fn set(&self, enabled: bool) -> std::io::Result<()> {
        controlled_instance_core::atomic::write_json_atomic(
            &self.file,
            &json!({"enabled":enabled}),
            Some(0o600),
        )
    }
    pub fn clear(&self) -> std::io::Result<()> {
        match std::fs::remove_file(&self.file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_reads_are_feature_local_and_uninstall_clears_intent() {
        let dir = tempfile::tempdir().unwrap();
        let store = DesktopSettings::new(dir.path());
        for (raw, expected) in [
            ("{}", false),
            ("{\"enabled\":true,\"future\":1}", true),
            ("{\"enabled\":\"true\"}", false),
            ("not json", false),
        ] {
            std::fs::write(dir.path().join("remote-desktop.json"), raw).unwrap();
            assert_eq!(store.enabled(), expected);
        }
        store.set(true).unwrap();
        assert!(store.enabled());
        assert!(DesktopSettings::new(dir.path()).enabled());
        store.clear().unwrap();
        assert!(!store.enabled());
        store.clear().unwrap();
    }
}
