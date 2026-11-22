//! The public instance capability boundary, with no attach credentials or private
//! component/session records. Extensible diagnostics are strings, not enums.
use serde::{Deserialize, Serialize};
pub const REMOTE_DESKTOP_PROTOCOL_VERSION: &str = "2026-11-17";
pub const REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION: &str = "2026-11-09";
pub const REMOTE_DESKTOP_WINDOW_MIN_SIZE: u32 = 160;
pub const REMOTE_DESKTOP_WINDOW_MAX_SIZE: u32 = 16_384;
pub const REMOTE_DESKTOP_WINDOW_RESIZE_MAX_PRESETS: usize = 32;
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
    pub source_providers: Vec<RemoteDesktopSourceProvider>,
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
pub struct RemoteDesktopSourceProvider {
    pub kind: String,
    pub available: bool,
    #[serde(deserialize_with = "required_reason")]
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopCapture {
    pub backends: Vec<String>,
    pub cursor: bool,
    /// Additive capability domain. Components that predate capture precision
    /// omit it; readers treat that as no selectable precision modes.
    #[serde(default)]
    pub precision_modes: Vec<String>,
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
    /// Additive capability domain. Old components omit it and readers keep
    /// window-mode resize disabled without invalidating the other features.
    #[serde(default, deserialize_with = "deserialize_window_resize")]
    pub window_resize: RemoteDesktopWindowResize,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopWindowSize {
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopWindowResize {
    #[serde(default)]
    pub available: bool,
    #[serde(default, deserialize_with = "deserialize_window_sizes")]
    pub presets: Vec<RemoteDesktopWindowSize>,
    #[serde(default)]
    pub fit_to_viewport: bool,
}
impl RemoteDesktopWindowResize {
    pub fn sanitize(&mut self) {
        if !self.available {
            self.presets.clear();
            self.fit_to_viewport = false;
            return;
        }
        let mut sanitized = Vec::new();
        for size in &self.presets {
            if size.width < REMOTE_DESKTOP_WINDOW_MIN_SIZE
                || size.width > REMOTE_DESKTOP_WINDOW_MAX_SIZE
                || size.height < REMOTE_DESKTOP_WINDOW_MIN_SIZE
                || size.height > REMOTE_DESKTOP_WINDOW_MAX_SIZE
                || sanitized.iter().any(|current| current == size)
            {
                continue;
            }
            sanitized.push(*size);
            if sanitized.len() >= REMOTE_DESKTOP_WINDOW_RESIZE_MAX_PRESETS {
                break;
            }
        }
        self.presets = sanitized;
        self.available = !self.presets.is_empty() || self.fit_to_viewport;
    }
}

fn deserialize_window_resize<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<RemoteDesktopWindowResize, D::Error> {
    // An unknown or malformed additive submodel closes only this feature. It
    // must not make the surrounding remote-desktop capability unreadable.
    Ok(RemoteDesktopWindowResize::deserialize(deserializer).unwrap_or_default())
}

fn deserialize_window_sizes<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<RemoteDesktopWindowSize>, D::Error> {
    let values = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(values
        .into_iter()
        .filter_map(|value| {
            let value = value.as_object()?;
            let width = u32::try_from(value.get("width")?.as_u64()?).ok()?;
            let height = u32::try_from(value.get("height")?.as_u64()?).ok()?;
            Some(RemoteDesktopWindowSize { width, height })
        })
        .collect())
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
            max_frame_rate: 60,
            max_bitrate: 8_000_000,
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
            source_providers: vec![],
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
        .map(|mut capability| {
            capability.features.window_resize.sanitize();
            capability
        })
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
                && c.source_providers
                    .iter()
                    .all(|provider| !provider.kind.is_empty())
                && [
                    &c.capture.backends,
                    &c.capture.precision_modes,
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

pub const INSTANCE_CAPABILITIES_CHANGED_EVENT_TYPE: &str = "instance.capabilities.changed";

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
            v.as_object_mut().unwrap().remove("sourceProviders");
            v
        }] {
            let read = serde_json::from_value::<Reader>(json!({"desktop":value})).unwrap();
            assert_eq!(read.desktop.unwrap(), RemoteDesktopCapabilities::default());
        }
        let mut future = fixture;
        future["available"] = json!(true);
        future["protocolVersion"] = json!("2030-01-01");
        future["platform"] = json!("future-os");
        future["sourceProviders"] =
            json!([{"kind":"future-source","available":true,"reason":null}]);
        future["future"] = json!(true);
        let read = serde_json::from_value::<Reader>(json!({"desktop":future}))
            .unwrap()
            .desktop
            .unwrap();
        assert!(read.available);
        assert_eq!(read.protocol_version, "2030-01-01");
        assert_eq!(read.source_providers[0].kind, "future-source");
    }

    #[test]
    fn missing_window_resize_disables_only_that_feature() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/remote-desktop-capability-fixture.json"
        ))
        .unwrap();
        let mut legacy = fixture;
        legacy["available"] = json!(true);
        legacy["features"]
            .as_object_mut()
            .unwrap()
            .remove("windowResize");
        let read = serde_json::from_value::<Reader>(json!({"desktop": legacy}))
            .unwrap()
            .desktop
            .unwrap();
        assert!(read.available);
        assert_eq!(
            read.features.window_resize,
            RemoteDesktopWindowResize::default()
        );
    }

    #[test]
    fn window_resize_presets_are_sanitized_without_disabling_the_capability() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/remote-desktop-capability-fixture.json"
        ))
        .unwrap();
        let mut current = fixture;
        current["available"] = json!(true);
        current["features"]["windowResize"] = json!({
            "available": true,
            "presets": [
                {"width": 1280, "height": 720},
                {"width": 1280, "height": 720},
                {"width": 159, "height": 900},
                {"width": 1920, "height": 1080}
            ],
            "fitToViewport": true,
            "future": true
        });
        let read = serde_json::from_value::<Reader>(json!({"desktop": current}))
            .unwrap()
            .desktop
            .unwrap();
        assert!(read.available);
        assert_eq!(
            read.features.window_resize.presets,
            vec![
                RemoteDesktopWindowSize {
                    width: 1280,
                    height: 720
                },
                RemoteDesktopWindowSize {
                    width: 1920,
                    height: 1080
                }
            ]
        );
        assert!(read.features.window_resize.fit_to_viewport);
    }

    #[test]
    fn malformed_window_resize_entries_disable_only_invalid_presets() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/remote-desktop-capability-fixture.json"
        ))
        .unwrap();
        let mut current = fixture;
        current["available"] = json!(true);
        current["features"]["windowResize"] = json!({
            "available": true,
            "presets": [
                {"width": 1280, "height": 720},
                {"width": -1, "height": 900},
                {"width": 1600.5, "height": 900},
                {"width": "1920", "height": 1080},
                {"width": 1920, "height": 1080}
            ],
            "fitToViewport": true
        });
        let read = serde_json::from_value::<Reader>(json!({"desktop": current}))
            .unwrap()
            .desktop
            .unwrap();
        assert!(read.available);
        assert_eq!(
            read.features.window_resize.presets,
            vec![
                RemoteDesktopWindowSize {
                    width: 1280,
                    height: 720
                },
                RemoteDesktopWindowSize {
                    width: 1920,
                    height: 1080
                }
            ]
        );
        assert!(read.features.window_resize.fit_to_viewport);
    }

    #[test]
    fn malformed_window_resize_submodel_leaves_other_features_readable() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/remote-desktop-capability-fixture.json"
        ))
        .unwrap();
        let mut current = fixture;
        current["available"] = json!(true);
        current["features"]["clipboard"] = json!(true);
        current["features"]["windowResize"] = json!("future-shape");
        let read = serde_json::from_value::<Reader>(json!({"desktop": current}))
            .unwrap()
            .desktop
            .unwrap();
        assert!(read.available);
        assert!(read.features.clipboard);
        assert_eq!(
            read.features.window_resize,
            RemoteDesktopWindowResize::default()
        );
    }
}
