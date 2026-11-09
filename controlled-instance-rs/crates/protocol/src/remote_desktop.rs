//! The public instance capability boundary, with no attach credentials or private
//! component/session records. Extensible diagnostics are strings, not enums.
use serde::{Deserialize, Serialize};
pub const REMOTE_DESKTOP_PROTOCOL_VERSION: &str = "2026-11-05";
pub const REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION: &str = "2026-11-09";
pub const REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL: &str =
    "taskhandoff.remote-desktop.fallback.media.v1";
pub const REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL: &str =
    "taskhandoff.remote-desktop.fallback.control.v1";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopCapabilities {
    pub available: bool,
    pub status: String,
    #[serde(deserialize_with = "required_reason")]
    pub reason: Option<String>,
    pub protocol_version: String,
    pub runtime_kind: String,
    pub platform: String,
    pub desktop_source: String,
    pub capture_targets: Vec<String>,
    pub window_capture: RemoteDesktopWindowCapture,
    pub capture: RemoteDesktopCapture,
    pub encoders: Vec<String>,
    pub input: RemoteDesktopInput,
    pub transport: Vec<String>,
    pub video: RemoteDesktopVideo,
    pub features: RemoteDesktopFeatures,
    pub viewer_limit: u64,
    /// Additive compatibility domain. Older components omit it; absence only
    /// closes WebSocket fallback and leaves the WebRTC path unchanged.
    #[serde(default)]
    pub fallback: RemoteDesktopFallbackCapabilities,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopWindowCapture {
    pub available: bool,
    #[serde(deserialize_with = "required_reason")]
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopCapture {
    pub backends: Vec<String>,
    pub cursor: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopInput {
    pub backends: Vec<String>,
    pub text_commit: bool,
    pub keyboard_layout: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopVideo {
    pub codecs: Vec<String>,
    pub max_width: u64,
    pub max_height: u64,
    pub max_frame_rate: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopFeatures {
    pub clipboard: bool,
    pub keyboard: bool,
    pub mouse: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopFallbackCapabilities {
    pub available: bool,
    #[serde(deserialize_with = "required_reason")]
    pub reason: Option<String>,
    pub protocol_version: String,
    pub media_subprotocol: String,
    pub control_subprotocol: String,
    pub max_width: u64,
    pub max_height: u64,
    pub max_frame_rate: u64,
    pub max_bitrate: u64,
}
impl Default for RemoteDesktopFallbackCapabilities {
    fn default() -> Self {
        Self::unavailable("REMOTE_DESKTOP_FALLBACK_UNSUPPORTED")
    }
}
impl RemoteDesktopFallbackCapabilities {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            protocol_version: REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION.into(),
            media_subprotocol: REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL.into(),
            control_subprotocol: REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL.into(),
            max_width: 0,
            max_height: 0,
            max_frame_rate: 0,
            max_bitrate: 0,
        }
    }
    pub fn ready() -> Self {
        Self {
            available: true,
            reason: None,
            protocol_version: REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION.into(),
            media_subprotocol: REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL.into(),
            control_subprotocol: REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL.into(),
            max_width: 1920,
            max_height: 1080,
            max_frame_rate: 30,
            max_bitrate: 4_000_000,
        }
    }
}
impl Default for RemoteDesktopCapabilities {
    fn default() -> Self {
        Self::unavailable("REMOTE_DESKTOP_UNSUPPORTED")
    }
}
impl RemoteDesktopCapabilities {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            status: "unavailable".into(),
            reason: Some(reason.into()),
            protocol_version: REMOTE_DESKTOP_PROTOCOL_VERSION.into(),
            runtime_kind: "unknown".into(),
            platform: "unknown".into(),
            desktop_source: "none".into(),
            capture_targets: vec![],
            window_capture: RemoteDesktopWindowCapture {
                available: false,
                reason: Some(reason.into()),
            },
            capture: RemoteDesktopCapture::default(),
            encoders: vec![],
            input: RemoteDesktopInput::default(),
            transport: vec![],
            video: RemoteDesktopVideo::default(),
            features: RemoteDesktopFeatures::default(),
            viewer_limit: 0,
            fallback: RemoteDesktopFallbackCapabilities::unavailable(reason),
        }
    }
}
fn required_reason<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
/// Compatibility for v0.0.50: absent additive data is unsupported; malformed
/// desktop data must never invalidate the surrounding instance document.
pub fn deserialize_remote_desktop<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RemoteDesktopCapabilities>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    let parsed = serde_json::from_value::<RemoteDesktopCapabilities>(value)
        .ok()
        .filter(|c| {
            [
                &c.status,
                &c.protocol_version,
                &c.runtime_kind,
                &c.platform,
                &c.desktop_source,
            ]
            .iter()
            .all(|s| !s.is_empty())
                && [
                    &c.capture_targets,
                    &c.capture.backends,
                    &c.encoders,
                    &c.input.backends,
                    &c.transport,
                    &c.video.codecs,
                ]
                .iter()
                .all(|names| names.iter().all(|s| !s.is_empty()))
        });
    Ok(Some(parsed.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[derive(Deserialize)]
    struct Reader {
        #[serde(default, deserialize_with = "deserialize_remote_desktop")]
        desktop: Option<RemoteDesktopCapabilities>,
    }
    #[test]
    fn shared_fixture_and_feature_local_sanitize_match_node() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/remote-desktop-capability-fixture.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(RemoteDesktopCapabilities::default()).unwrap(),
            fixture
        );
        assert!(serde_json::from_value::<Reader>(json!({}))
            .unwrap()
            .desktop
            .is_none());
        for value in [json!({}), json!({"available":"yes"}), {
            let mut v = fixture.clone();
            v.as_object_mut().unwrap().remove("captureTargets");
            v
        }] {
            let read = serde_json::from_value::<Reader>(json!({"desktop":value})).unwrap();
            assert_eq!(read.desktop.unwrap(), RemoteDesktopCapabilities::default());
        }
        let mut future = fixture;
        future["available"] = json!(true);
        future["protocolVersion"] = json!("2030-01-01");
        future["platform"] = json!("future-os");
        future["captureTargets"] = json!(["future-target"]);
        future["future"] = json!(true);
        let read = serde_json::from_value::<Reader>(json!({"desktop":future}))
            .unwrap()
            .desktop
            .unwrap();
        assert!(read.available);
        assert_eq!(read.protocol_version, "2030-01-01");
        assert_eq!(read.capture_targets, ["future-target"]);
    }
}

pub const INSTANCE_CAPABILITIES_CHANGED_EVENT_TYPE: &str = "instance.capabilities.changed";
