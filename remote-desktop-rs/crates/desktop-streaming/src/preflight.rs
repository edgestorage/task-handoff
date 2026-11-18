//! Permission-free, one-shot initialization checks. Never creates a surface,
//! enumerates window titles, starts a capture stream, or posts an input event.
use crate::{capture::Mode, error::BackendError};
use controlled_instance_protocol::RemoteDesktopCapabilities;

pub fn probe(mode: Mode, show_cursor: bool) -> RemoteDesktopCapabilities {
    let mut capability =
        RemoteDesktopCapabilities::unavailable("REMOTE_DESKTOP_PLATFORM_UNSUPPORTED");
    capability.platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
    .into();
    capability.runtime_kind = if mode == Mode::Virtual {
        "docker"
    } else {
        "local"
    }
    .into();
    capability.desktop_source = if mode == Mode::Virtual {
        "instance-virtual-display"
    } else {
        "host-desktop"
    }
    .into();
    match check(mode) {
        Ok(desktop_source) => {
            if let Some(desktop_source) = desktop_source {
                capability.desktop_source = desktop_source.into();
            }
        }
        Err(error) => {
            let reason = BackendError::from_error(&error).to_string();
            capability.reason = Some(reason.clone());
            return capability;
        }
    }
    capability.available = true;
    capability.status = "ready".into();
    capability.reason = None;
    capability.source_providers = vec![controlled_instance_protocol::RemoteDesktopSourceProvider {
        kind: "display".into(),
        available: true,
        reason: None,
    }];
    #[cfg(target_os = "macos")]
    {
        capability.source_providers.push(
            controlled_instance_protocol::RemoteDesktopSourceProvider {
                kind: "window".into(),
                available: true,
                reason: None,
            },
        );
    }
    #[cfg(target_os = "linux")]
    {
        capability.source_providers.push(
            controlled_instance_protocol::RemoteDesktopSourceProvider {
                kind: "window".into(),
                available: true,
                reason: None,
            },
        );
    }
    #[cfg(target_os = "windows")]
    {
        capability.source_providers.push(
            controlled_instance_protocol::RemoteDesktopSourceProvider {
                kind: "window".into(),
                available: true,
                reason: None,
            },
        );
    }
    capability.capture.backends = vec![if cfg!(target_os = "macos") {
        "screencapturekit"
    } else if cfg!(target_os = "windows") {
        "wgc"
    } else {
        "x11-xshm-xdamage"
    }
    .into()];
    capability.capture.cursor = show_cursor;
    capability.capture.precision_modes = vec!["auto".into(), "performance".into()];
    let codecs = crate::codec::local_video_codecs();
    capability.encoders = if codecs.contains(&crate::codec::VideoCodec::H265) {
        vec!["videotoolbox".into(), "openh264".into()]
    } else {
        vec!["openh264".into()]
    };
    capability.input.backends = vec![if cfg!(target_os = "macos") {
        "cgevent"
    } else if cfg!(target_os = "windows") {
        "sendinput"
    } else {
        "xtest"
    }
    .into()];
    capability.input.text_commit = true;
    capability.input.keyboard_layout = false;
    capability.transport = vec!["webrtc".into()];
    capability.video.codecs = codecs.iter().map(|codec| codec.as_str().into()).collect();
    capability.video.max_width = 3840;
    capability.video.max_height = 2160;
    capability.video.max_frame_rate = 30;
    capability.features.keyboard = true;
    capability.features.mouse = true;
    capability.features.clipboard = true;
    capability.viewer_limit = crate::session::MAX_VIEWERS as u64;
    capability.fallback = controlled_instance_protocol::RemoteDesktopFallbackCapabilities::ready();
    capability
}
fn check(mode: Mode) -> anyhow::Result<Option<&'static str>> {
    anyhow::ensure!(
        matches!(mode, Mode::Local | Mode::Virtual),
        BackendError::PlatformUnsupported
    );
    anyhow::ensure!(
        cfg!(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "windows"
        )),
        BackendError::PlatformUnsupported
    );
    #[cfg(target_os = "macos")]
    {
        anyhow::ensure!(mode == Mode::Local, BackendError::VirtualUnsupported);
        crate::platform::macos::preflight()?;
        // Enigo's maintained permission check explicitly keeps OS prompts off.
        let _input = enigo::Enigo::new(&enigo::Settings {
            open_prompt_to_get_permissions: false,
            ..Default::default()
        })
        .map_err(|_| anyhow::anyhow!(BackendError::InputPermissionRequired))?;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = mode;
        let plan = crate::linux_desktop::resolve()?;
        if plan.ownership == crate::linux_desktop::DisplayOwnership::Attached {
            let _input = enigo::Enigo::new(&enigo::Settings {
                x11_display: Some(plan.config.display.clone()),
                open_prompt_to_get_permissions: false,
                ..Default::default()
            })
            .map_err(|_| anyhow::anyhow!(BackendError::InputPermissionRequired))?;
        }
        let _encoder = crate::encoder::Encoder::new(
            2_000_000,
            crate::codec::Limits::default(),
            20,
            crate::encoder::Policy::Software,
            crate::codec::VideoCodec::H264,
        )?;
        Ok(Some(plan.desktop_source()))
    }
    #[cfg(target_os = "windows")]
    {
        anyhow::ensure!(mode == Mode::Local, BackendError::VirtualUnsupported);
        crate::platform::apple_windows::preflight()?;
        let _input = enigo::Enigo::new(&enigo::Settings {
            open_prompt_to_get_permissions: false,
            ..Default::default()
        })
        .map_err(|_| anyhow::anyhow!(BackendError::InputPermissionRequired))?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Codec initialization does not require a desktop or any screen permissions.
        let _encoder = crate::encoder::Encoder::new(
            2_000_000,
            crate::codec::Limits::default(),
            20,
            crate::encoder::Policy::Software,
            crate::codec::VideoCodec::H264,
        )?;
        Ok(None)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_mode_never_probes_or_advertises_native_access() {
        let capability = probe(Mode::Control, true);
        assert!(!capability.available);
        assert!(!capability.capture.cursor);
        assert!(capability.source_providers.is_empty());
    }
}
