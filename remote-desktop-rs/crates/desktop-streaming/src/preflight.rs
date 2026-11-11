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
    let result = check(mode);
    if let Err(error) = result {
        let reason = BackendError::from_error(&error).to_string();
        capability.reason = Some(reason.clone());
        return capability;
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
    capability.capture.backends = vec![if cfg!(target_os = "macos") {
        "screencapturekit"
    } else {
        "x11-xshm-xdamage"
    }
    .into()];
    capability.capture.cursor = show_cursor;
    // Only the initialized encoder is advertised. Hardware is selected and
    // verified when stream geometry is known, with the existing software fallback.
    capability.encoders = vec!["openh264".into()];
    capability.input.backends = vec![if cfg!(target_os = "macos") {
        "cgevent"
    } else {
        "xtest"
    }
    .into()];
    capability.input.text_commit = true;
    capability.input.keyboard_layout = false;
    capability.transport = vec!["webrtc".into()];
    capability.video.codecs = vec!["h264".into()];
    capability.video.max_width = 1920;
    capability.video.max_height = 1080;
    capability.video.max_frame_rate = 30;
    capability.features.keyboard = true;
    capability.features.mouse = true;
    capability.features.clipboard = true;
    capability.viewer_limit = crate::session::MAX_VIEWERS as u64;
    capability.fallback = controlled_instance_protocol::RemoteDesktopFallbackCapabilities::ready();
    capability
}
fn check(mode: Mode) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(mode, Mode::Local | Mode::Virtual),
        BackendError::PlatformUnsupported
    );
    anyhow::ensure!(
        cfg!(any(target_os = "macos", target_os = "linux")),
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
    if mode == Mode::Virtual {
        use std::os::unix::fs::PermissionsExt;
        let paths = std::env::var_os("PATH").unwrap_or_default();
        for name in ["Xvfb", "openbox", "tint2"] {
            anyhow::ensure!(
                std::env::split_paths(&paths).any(|dir| std::fs::metadata(dir.join(name))
                    .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)),
                BackendError::DesktopUnavailable
            );
        }
    } else {
        anyhow::ensure!(
            std::env::var("XDG_SESSION_TYPE").as_deref() != Ok("wayland"),
            BackendError::WaylandUnsupported
        );
        let display = std::env::var("DISPLAY")
            .map_err(|_| anyhow::anyhow!(BackendError::NoInteractiveSession))?;
        // Opens and immediately drops a connection; no readback/capture loop.
        let _capture = crate::platform::linux::Capture::open(&crate::platform::linux::Config {
            display: display.clone(),
            cookie: None,
            authority: None,
            include_cursor: true,
        })?;
        let _input = enigo::Enigo::new(&enigo::Settings {
            x11_display: Some(display),
            open_prompt_to_get_permissions: false,
            ..Default::default()
        })
        .map_err(|_| anyhow::anyhow!(BackendError::InputPermissionRequired))?;
    }
    // Codec initialization does not require a desktop or any screen permissions.
    let _encoder = crate::encoder::Encoder::new(
        2_000_000,
        crate::codec::Limits::default(),
        20,
        crate::encoder::Policy::Software,
    )?;
    Ok(())
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
