use std::path::{Path, PathBuf};

const CONTROLLED_INSTANCE_PACKAGE_NAME: &str = "@task-handoff/controlled-instance";
const DEFAULT_INSTANCE_RUNTIME_ROOT: &str = "/opt/task-handoff/instance-runtime";

/// Resolve the version reported to the node agent.
///
/// Local runtimes inject the desired version through the environment. Docker
/// runtimes install an independently versioned artifact, so the active runtime
/// manifest is authoritative after installation and across container restarts.
pub fn resolve_controlled_instance_package_version() -> String {
    env_optional("TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION")
        .or_else(runtime_manifest_version)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn runtime_manifest_version() -> Option<String> {
    let runtime_root = env_optional("TASK_HANDOFF_INSTANCE_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_INSTANCE_RUNTIME_ROOT));
    package_version_from_runtime_manifest(&runtime_root.join("current/runtime-manifest.json"))
}

pub fn package_version_from_runtime_manifest(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if manifest.get("packageName")?.as_str()? != CONTROLLED_INSTANCE_PACKAGE_NAME {
        return None;
    }
    manifest
        .get("version")?
        .as_str()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(ToString::to_string)
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}
