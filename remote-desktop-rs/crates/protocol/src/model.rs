//! Projections owned by the component, not a second session registry.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub actor_id: String,
    pub device_session_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CaptureTarget {
    Display,
    Window { window_ref: String },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Starting,
    Negotiating,
    Active,
    Draining,
    Stopped,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub viewer_session_id: String,
    pub session_revision: u64,
    /// Component-owned control lease revision. It advances whenever the input
    /// holder changes, including an explicit transfer or holder disconnect.
    #[serde(default)]
    pub control_revision: u64,
    /// Whether this viewer currently owns the transferable input lease. Other
    /// viewers never receive another viewer's internal session identifier.
    #[serde(default)]
    pub is_controller: bool,
    /// Whether any active viewer currently owns the input lease. This is
    /// distinct from `is_controller`: after a controller disconnects the lease
    /// is intentionally unclaimed until another viewer requests it.
    #[serde(default = "default_true")]
    pub has_controller: bool,
    /// Number of non-terminal viewers currently attached to this desktop.
    #[serde(default = "default_viewer_count")]
    pub viewer_count: u64,
    /// Monotonic component-owned proof that a restarted ICE generation reached
    /// its connected/completed state. It is projected to the trusted CP/instance
    /// transport only; the browser signal boundary does not carry it.
    #[serde(default)]
    pub transport_generation: u64,
    /// Component-owned transport state. Fallback is sticky for the lifetime of
    /// a viewer session; terminal failures are projected as `failed`.
    #[serde(default = "default_transport")]
    pub transport: String,
    pub phase: Phase,
    pub capture_target: CaptureTarget,
    pub session_expires_at: u64,
    pub idle_expires_at: Option<u64>,
    pub input_epoch: Option<u64>,
    /// Private process-memory projection owned by capture. Target references and
    /// downscaled video cannot determine the actuator dimensions. No OS identity
    /// or desktop coordinates cross this boundary; revision also invalidates input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_geometry: Option<CaptureGeometry>,
    pub media_paused: bool,
    pub reason: Option<String>,
}

fn default_viewer_count() -> u64 {
    1
}
fn default_true() -> bool {
    true
}
fn default_transport() -> String {
    "webrtc".into()
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureGeometry {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub window_ref: String,
    pub title: String,
    pub application_name: String,
    pub width: u32,
    pub height: u32,
    pub capturable: bool,
    pub reason: Option<String>,
}
