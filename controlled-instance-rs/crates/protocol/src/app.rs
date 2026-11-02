use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

pub const APP_SESSION_TOPIC: &str = "app.sessions";
pub const APP_SESSION_TOMBSTONE_RETENTION_MS: i64 = 60 * 60 * 1000;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Tty,
    Gui,
    Web,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppDisplayOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppDisplayMode {
    Isolated,
    Shared,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppDisplayTarget {
    pub mode: AppDisplayMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_create: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppAutomationCatalog {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_arg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppWebCatalog {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_arg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppCatalogItem {
    pub id: String,
    pub name: String,
    pub kind: AppKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<AppDisplayOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_display_target: Option<AppDisplayTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation: Option<AppAutomationCatalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web: Option<AppWebCatalog>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomAppCatalog {
    #[serde(default = "default_catalog_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub items: Vec<AppCatalogItem>,
}

fn default_catalog_version() -> u32 {
    1
}

impl Default for CustomAppCatalog {
    fn default() -> Self {
        Self {
            schema_version: default_catalog_version(),
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppAiSessionResume {
    pub ai_session_id: String,
    pub provider_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppLaunchOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<AppDisplayOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_target: Option<AppDisplayTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_session_resume: Option<AppAiSessionResume>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppLaunchRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(flatten)]
    pub options: AppLaunchOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionWorkspace {
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionTty {
    pub web_path: String,
    pub shell: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionDisplay {
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_session_id: Option<String>,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wm_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compositor_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xauthority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionVnc {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websockify_port: Option<u16>,
    pub web_path: String,
    pub no_vnc_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionWeb {
    pub host: String,
    pub port: u16,
    pub web_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionAutomation {
    #[serde(rename = "type")]
    pub kind: String,
    pub endpoint: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionProcess {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionPaths {
    pub session_dir: String,
    pub log_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionBinding {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub id: String,
    pub app_id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub workspace: AppSessionWorkspace,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch: Option<AppLaunchOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tty: Option<AppSessionTty>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<AppSessionDisplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vnc: Option<AppSessionVnc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web: Option<AppSessionWeb>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation: Option<AppSessionAutomation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<AppSessionProcess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<Value>,
    pub paths: AppSessionPaths,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bindings: Vec<AppSessionBinding>,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionsSnapshot {
    pub running_count: u64,
    pub problem_count: u64,
    pub sessions: Vec<AppSession>,
    pub updated_at: String,
}

impl AppSessionsSnapshot {
    pub fn active(sessions: Vec<AppSession>) -> Self {
        let visible = sessions
            .into_iter()
            .map(normalize_app_session)
            .filter(|session| is_visible_app_session_status(&session.status))
            .collect::<Vec<_>>();
        Self {
            running_count: visible
                .iter()
                .filter(|session| session.status == "running")
                .count() as u64,
            problem_count: visible
                .iter()
                .filter(|session| session.status == "failed")
                .count() as u64,
            sessions: visible,
            updated_at: now_iso(),
        }
    }

    pub fn all(sessions: Vec<AppSession>) -> Self {
        let sessions = sessions
            .into_iter()
            .map(normalize_app_session)
            .collect::<Vec<_>>();
        Self {
            running_count: sessions
                .iter()
                .filter(|session| session.status == "running")
                .count() as u64,
            problem_count: sessions
                .iter()
                .filter(|session| session.status == "failed")
                .count() as u64,
            sessions,
            updated_at: now_iso(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionsState {
    pub stream_id: String,
    pub revision: u64,
    pub last_event_at: String,
    pub snapshot: AppSessionsSnapshot,
}

impl Default for AppSessionsState {
    fn default() -> Self {
        Self {
            stream_id: String::new(),
            revision: 0,
            last_event_at: now_iso(),
            snapshot: AppSessionsSnapshot::active(Vec::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppProfile {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_usage_bytes: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppProfileList {
    pub app_id: String,
    pub default_profile_id: String,
    pub profiles: Vec<AppProfile>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppProfileNameInput {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSessionRenameInput {
    pub title: String,
}

pub fn normalize_app_session_status(status: &str) -> String {
    let value = status.trim().to_ascii_lowercase();
    match value.as_str() {
        "ended" => "closed".to_string(),
        "terminating" => "stopping".to_string(),
        "created" | "starting" | "running" | "stopping" | "stopped" | "exited" | "failed"
        | "closed" | "terminated" => value,
        _ => "unknown".to_string(),
    }
}

pub fn normalize_app_session(mut session: AppSession) -> AppSession {
    session.status = normalize_app_session_status(&session.status);
    let bindings = app_session_bindings(&session);
    let mut indexes = HashMap::<String, usize>::new();
    let mut merged = Vec::<AppSessionBinding>::new();
    for binding in bindings {
        let key = app_session_binding_key(&binding);
        if let Some(index) = indexes.get(&key).copied() {
            merged[index] = binding;
        } else {
            indexes.insert(key, merged.len());
            merged.push(binding);
        }
    }
    session.bindings = merged;
    session
}

fn app_session_binding_key(binding: &AppSessionBinding) -> String {
    match binding.kind.as_str() {
        "app-session" => format!("app:{}", binding.id),
        "provider-session" => format!(
            "provider:{}:{}",
            binding.agent.as_deref().unwrap_or_default(),
            binding.id
        ),
        _ => format!(
            "adapter:{}:{}",
            binding.adapter.as_deref().unwrap_or_default(),
            binding.key.as_deref().unwrap_or(&binding.id)
        ),
    }
}

fn legacy_app_session_bindings(session: &AppSession) -> Vec<AppSessionBinding> {
    let Some(ai) = session.ai.as_ref().and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut bindings = Vec::new();
    for agent in ["claude", "codex", "opencode"] {
        let Some(value) = ai
            .get(agent)
            .and_then(Value::as_object)
            .and_then(|value| value.get("providerSessionId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        bindings.push(AppSessionBinding {
            kind: "provider-session".to_string(),
            id: value.to_string(),
            agent: Some(agent.to_string()),
            adapter: None,
            key: None,
        });
    }
    bindings
}

fn app_session_bindings(session: &AppSession) -> Vec<AppSessionBinding> {
    session
        .bindings
        .iter()
        .cloned()
        .chain(std::iter::once(AppSessionBinding {
            kind: "app-session".to_string(),
            id: session.id.clone(),
            agent: None,
            adapter: None,
            key: None,
        }))
        .chain(legacy_app_session_bindings(session))
        .collect()
}

pub fn is_visible_app_session_status(status: &str) -> bool {
    !matches!(
        normalize_app_session_status(status).as_str(),
        "stopped" | "failed" | "exited" | "closed" | "terminated"
    )
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, status: &str) -> AppSession {
        AppSession {
            id: id.to_string(),
            app_id: "terminal-tty".to_string(),
            title: "Terminal".to_string(),
            kind: "tty".to_string(),
            status: status.to_string(),
            created_at: "2026-11-02T00:00:00.000Z".to_string(),
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
            workspace: AppSessionWorkspace {
                cwd: "/workspace".to_string(),
            },
            launch: None,
            tty: None,
            display: None,
            vnc: None,
            web: None,
            automation: None,
            process: None,
            ai: None,
            paths: AppSessionPaths {
                session_dir: "/tmp/s".to_string(),
                log_dir: "/tmp/l".to_string(),
            },
            bindings: Vec::new(),
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn active_snapshot_hides_terminal_states_and_normalizes_legacy_statuses() {
        let snapshot = AppSessionsSnapshot::active(vec![
            session("running", "running"),
            session("ended", "ended"),
            session("stopped", "stopped"),
        ]);
        assert_eq!(snapshot.running_count, 1);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].id, "running");
        assert_eq!(normalize_app_session_status("terminating"), "stopping");
    }

    #[test]
    fn normalization_merges_existing_and_legacy_bindings_without_duplicates() {
        let mut value = session("session-id", "running");
        value.bindings = vec![AppSessionBinding {
            kind: "provider-session".to_string(),
            id: "provider-id".to_string(),
            agent: Some("codex".to_string()),
            adapter: None,
            key: None,
        }];
        value.ai = Some(serde_json::json!({
            "codex": { "providerSessionId": "provider-id" },
            "claude": { "providerSessionId": "claude-id" }
        }));

        let normalized = normalize_app_session(value);
        assert_eq!(normalized.bindings.len(), 3);
        assert_eq!(normalized.bindings[0].kind, "provider-session");
        assert_eq!(normalized.bindings[0].agent.as_deref(), Some("codex"));
        assert_eq!(normalized.bindings[1].kind, "app-session");
        assert_eq!(normalized.bindings[2].agent.as_deref(), Some("claude"));
    }
}
