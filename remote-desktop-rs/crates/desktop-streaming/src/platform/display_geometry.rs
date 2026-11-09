//! Display input authority is derived from the capture rectangle, never added
//! to the IPC model. Keep the selected OS identity in this process and reject
//! topology changes before injecting at stale coordinates. Window targets need
//! their own focus/hit-test authority and must not use this display-only lease.
use crate::{error::BackendError, traits::Geometry};

pub struct DisplayGeometry {
    geometry: Geometry,
    #[cfg(target_os = "macos")]
    display: core_graphics::display::CGDisplay,
    #[cfg(target_os = "windows")]
    monitor: usize,
}

impl DisplayGeometry {
    pub fn bind(geometry: Geometry) -> anyhow::Result<Self> {
        #[cfg(target_os = "macos")]
        {
            use core_graphics::display::CGDisplay;
            let displays = CGDisplay::active_displays()
                .map_err(|_| anyhow::anyhow!(BackendError::DesktopUnavailable))?;
            let mut matches = displays.into_iter().map(CGDisplay::new).filter(|display| {
                apple_geometry(*display).is_ok_and(|current| current == geometry)
            });
            let display = matches
                .next()
                .ok_or_else(|| anyhow::anyhow!(BackendError::GeometryChanged))?;
            // Mirrored/overlapping displays cannot be inferred unambiguously.
            anyhow::ensure!(matches.next().is_none(), BackendError::GeometryChanged);
            Ok(Self { geometry, display })
        }
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::{Foundation::RECT, Graphics::Gdi::*};
            // RECT uses an exclusive right/bottom edge. Geometry permits the
            // last pixel at i32::MAX; Win32 cannot represent its exclusive edge.
            let right = i32::try_from(geometry.x as i64 + geometry.width as i64)
                .map_err(|_| anyhow::anyhow!(BackendError::InvalidGeometry))?;
            let bottom = i32::try_from(geometry.y as i64 + geometry.height as i64)
                .map_err(|_| anyhow::anyhow!(BackendError::InvalidGeometry))?;
            let rect = RECT {
                left: geometry.x,
                top: geometry.y,
                right,
                bottom,
            };
            let monitor = unsafe { MonitorFromRect(&rect, MONITOR_DEFAULTTONULL) };
            anyhow::ensure!(!monitor.is_null(), BackendError::DesktopUnavailable);
            let lease = Self {
                geometry,
                monitor: monitor as usize,
            };
            lease.validate()?;
            Ok(lease)
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        #[cfg(target_os = "macos")]
        let current = apple_geometry(self.display)?;
        #[cfg(target_os = "windows")]
        let current = {
            use windows_sys::Win32::Graphics::Gdi::*;
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            anyhow::ensure!(
                unsafe { GetMonitorInfoW(self.monitor as HMONITOR, &mut info) } != 0,
                BackendError::DesktopUnavailable
            );
            let r = info.rcMonitor;
            Geometry::from_actuator_rect(
                r.left as f64,
                r.top as f64,
                r.right as f64 - r.left as f64,
                r.bottom as f64 - r.top as f64,
            )?
        };
        anyhow::ensure!(current == self.geometry, BackendError::GeometryChanged);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn apple_geometry(display: core_graphics::display::CGDisplay) -> anyhow::Result<Geometry> {
    anyhow::ensure!(display.is_active(), BackendError::DesktopUnavailable);
    let r = display.bounds();
    Geometry::from_actuator_rect(r.origin.x, r.origin.y, r.size.width, r.size.height)
}
