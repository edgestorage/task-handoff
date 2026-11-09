//! Host/component boundary only. Never re-export from the public protocol crate.
use crate::model::{CaptureTarget, Owner, Snapshot};
use serde::{Deserialize, Serialize};

pub const IPC_VERSION: &str = "2026-11-07";
pub const CHANNEL_VERSION: &str = "2026-11-05";
pub const MAX_IPC_FRAME: usize = 1024 * 1024;

// Deliberately no Debug: nonce, attach credentials, SDP and input must not enter logs.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol_version: String,
    pub nonce: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub protocol_version: String,
    pub boot_id: String,
    pub capability: ComponentCapability,
    /// Loopback-only fallback WebSocket base URL and process-scoped bearer.
    /// Private host IPC only; never projected to the public capability model.
    pub fallback_url: String,
    pub fallback_token: String,
}

// The component supplies the boundary-owned capability model. Private IPC adds
// no second schema or local compatibility table and carries no media here.
pub type ComponentCapability = controlled_instance_protocol::RemoteDesktopCapabilities;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub boot_id: String,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Probe,
    Takeover {
        owner: Owner,
        viewer_session_id: String,
        capture_target: CaptureTarget,
    },
    // Only the dedicated trusted management transport may issue this command.
    ForceStop {
        viewer_session_id: String,
    },
    ListWindows {
        owner: Owner,
    },
    Metrics {
        owner: Owner,
        viewer_session_id: String,
    },
    Reserve {
        owner: Owner,
        capture_target: CaptureTarget,
    },
    Attach {
        owner: Owner,
        viewer_session_id: String,
        capture_target: CaptureTarget,
        attach_token: String,
    },
    Snapshot {
        owner: Owner,
        viewer_session_id: String,
    },
    Stop {
        owner: Owner,
        viewer_session_id: String,
    },
    Offer {
        owner: Owner,
        viewer_session_id: String,
        sdp: String,
    },
    ConfigureIce {
        owner: Owner,
        viewer_session_id: String,
        ice_servers: Vec<IceServer>,
        ice_credentials_expires_at: Option<u64>,
    },
    Candidate {
        owner: Owner,
        viewer_session_id: String,
        candidate: IceCandidate,
    },
    SignalAlive {
        owner: Owner,
        viewer_session_id: String,
    },
    SignalClosed {
        owner: Owner,
        viewer_session_id: String,
    },
    Shutdown,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub request_id: String,
    pub boot_id: String,
    #[serde(flatten)]
    pub result: Reply,
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Capability {
        capability: Box<ComponentCapability>,
    },
    Windows {
        windows: Vec<crate::model::WindowEntry>,
    },
    Metrics {
        metrics: MediaMetrics,
    },
    Reserved {
        snapshot: Snapshot,
        attach_token: String,
        attach_expires_at: u64,
    },
    Snapshot {
        snapshot: Snapshot,
    },
    Answer {
        sdp: String,
    },
    Acknowledged,
    Stopped,
    Error {
        code: String,
    },
}

/// Read-only authoritative event; host never reconstructs session transitions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub boot_id: String,
    pub snapshot: Snapshot,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum Packet {
    Response(Response),
    Event(SessionEvent),
}

/// Test/diagnostic IPC only, never a session field or public capability. These
/// measured counters cannot be derived from IDs/configuration; the owning media
/// worker/pacer is their sole writer. Lifetime is one in-memory peer.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetrics {
    // Component-owned ephemeral diagnostic, set by the active encoder after
    // encode. Device/runtime fallback cannot be inferred from platform/config.
    // Private host IPC only; no public capability or persistence projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
    pub estimated_bitrate: u64,
    pub paced_bitrate: u64,
    pub queued_bytes: u64,
    pub max_queued_bytes: u64,
    pub queue_resets: u64,
    pub frame_budget_drops: u64,
    pub frames_sent: u64,
    pub keyframes_sent: u64,
}

/// Ephemeral ICE configuration, owned by the signaling transport. Never logged,
/// persisted, or included in a public session snapshot.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u16>,
}
