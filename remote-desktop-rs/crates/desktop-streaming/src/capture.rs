//! Component-local platform choice. It is not a public capability document.
use crate::{
    traits::{CapturePrecision, Geometry, PointerMapping},
    video::{Budget, Frame},
};

/// Both SCK and WGC accept bounded BGRA surfaces. Larger native modes are fit
/// proportionally instead of fabricating a per-platform hard-coded ceiling.
pub const MAX_CAPTURE_DIMENSION: u32 = 8192;

pub fn resolve_capture_size(
    native_width: u32,
    native_height: u32,
    precision: CapturePrecision,
    native_scale_x: f64,
    native_scale_y: f64,
) -> anyhow::Result<(u32, u32)> {
    anyhow::ensure!(
        native_width > 0
            && native_height > 0
            && native_scale_x.is_finite()
            && native_scale_y.is_finite()
            && native_scale_x > 0.0
            && native_scale_y > 0.0,
        crate::error::BackendError::InvalidGeometry
    );
    let (width, height) = match precision {
        CapturePrecision::Auto => (native_width as f64, native_height as f64),
        CapturePrecision::Performance => (
            native_width as f64 / native_scale_x,
            native_height as f64 / native_scale_y,
        ),
    };
    anyhow::ensure!(
        width <= u32::MAX as f64 && height <= u32::MAX as f64,
        crate::error::BackendError::InvalidGeometry
    );
    let fit = (MAX_CAPTURE_DIMENSION as f64 / width)
        .min(MAX_CAPTURE_DIMENSION as f64 / height)
        .min(1.0);
    Ok((
        ((width * fit).round() as u32).max(1),
        ((height * fit).round() as u32).max(1),
    ))
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Control,
    Synthetic,
    Local,
    Virtual,
}
pub enum Source {
    Synthetic,
    #[cfg(target_os = "linux")]
    X11(Box<crate::platform::linux::Capture>),
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Native(Box<crate::platform::native_capture::Capture>),
}
impl Source {
    pub async fn local(show_cursor: bool) -> anyhow::Result<Self> {
        #[cfg(target_os = "linux")]
        {
            anyhow::ensure!(
                std::env::var("XDG_SESSION_TYPE").as_deref() != Ok("wayland"),
                crate::error::BackendError::WaylandUnsupported
            );
            let display = std::env::var("DISPLAY")
                .map_err(|_| anyhow::anyhow!(crate::error::BackendError::NoInteractiveSession))?;
            Ok(Self::X11(Box::new(crate::platform::linux::Capture::open(
                &crate::platform::linux::Config {
                    display,
                    cookie: None,
                    authority: None,
                    include_cursor: show_cursor,
                },
            )?)))
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            Ok(Self::Native(Box::new(
                crate::platform::native_capture::Capture::primary_display_with_cursor(show_cursor)
                    .await?,
            )))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            anyhow::bail!(crate::error::BackendError::PlatformUnsupported)
        }
    }
    pub fn refresh_geometry(&mut self) -> anyhow::Result<Geometry> {
        #[cfg(target_os = "linux")]
        if let Self::X11(c) = self {
            return c.refresh_geometry();
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Self::Native(c) = self {
            return c.refresh_geometry();
        }
        Ok(self.geometry())
    }
    pub fn set_capture_precision(&mut self, precision: CapturePrecision) -> anyhow::Result<bool> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Self::Native(c) = self {
            return c.set_capture_precision(precision);
        }
        let _ = precision;
        Ok(false)
    }
    /// Expected native buffer dimensions before conversion to the encoded
    /// budget. Input geometry remains the actuator rectangle returned above.
    pub fn capture_dimensions(&self) -> (u32, u32) {
        match self {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Self::Native(c) => c.capture_dimensions(),
            #[cfg(target_os = "linux")]
            Self::X11(c) => {
                let geometry = c.geometry();
                (geometry.width, geometry.height)
            }
            Self::Synthetic => {
                let geometry = self.geometry();
                (geometry.width, geometry.height)
            }
        }
    }
    pub fn geometry(&self) -> Geometry {
        match self {
            Self::Synthetic => Geometry {
                x: 0,
                y: 0,
                width: 640,
                height: 360,
                scale: 1.0,
            },
            #[cfg(target_os = "linux")]
            Self::X11(c) => c.geometry(),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Self::Native(c) => c.geometry(),
        }
    }
    /// Viewport mapping for the latest native frame. Menu popovers can extend
    /// the capture beyond the selected window and the encoded surface can
    /// contain letterbox bars, so pointer input cannot use one `Geometry`.
    #[cfg(target_os = "macos")]
    pub fn pointer_mapping(&self) -> Option<PointerMapping> {
        match self {
            Self::Native(c) => Some(c.pointer_mapping()),
            _ => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    pub fn pointer_mapping(&self) -> Option<PointerMapping> {
        None
    }
    pub fn frame(
        &mut self,
        index: u64,
        input: &crate::synthetic::SyntheticInput,
        _force: bool,
        budget: Budget,
    ) -> anyhow::Result<Option<Frame>> {
        match self {
            Self::Synthetic => Ok(Some(Frame::I420(crate::video::scale_yuv(
                crate::synthetic::pattern(index, input),
                budget,
            )?))),
            #[cfg(target_os = "linux")]
            // XDamage controls native readback, while cached frames maintain
            // video cadence. A completely silent static track makes browser
            // jitter buffers wait for another frame and repeatedly request PLI.
            Self::X11(c) => c
                .frame(true)?
                .map(|raw| crate::video::from_bgra(raw, budget).map(Frame::I420))
                .transpose(),
            #[cfg(target_os = "macos")]
            Self::Native(c) => c.frame(_force),
            #[cfg(target_os = "windows")]
            Self::Native(c) => c
                .frame(_force)?
                .map(|raw| crate::video::from_bgra(raw, budget).map(Frame::I420))
                .transpose(),
        }
    }
    pub fn pause(&mut self) -> anyhow::Result<()> {
        match self {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Self::Native(c) => c.pause(),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_keeps_native_pixels_and_performance_uses_logical_pixels() {
        assert_eq!(
            resolve_capture_size(5120, 2160, CapturePrecision::Auto, 2.0, 2.0).unwrap(),
            (5120, 2160)
        );
        assert_eq!(
            resolve_capture_size(5120, 2160, CapturePrecision::Performance, 2.0, 2.0).unwrap(),
            (2560, 1080)
        );
        assert_eq!(
            resolve_capture_size(3839, 1619, CapturePrecision::Performance, 1.5, 1.5).unwrap(),
            (2559, 1079)
        );
        assert_eq!(
            resolve_capture_size(3840, 2160, CapturePrecision::Performance, 1.5, 1.5).unwrap(),
            (2560, 1440)
        );
    }

    #[test]
    fn oversized_native_capture_is_fit_without_changing_aspect_ratio() {
        let (width, height) =
            resolve_capture_size(10240, 5760, CapturePrecision::Auto, 2.0, 2.0).unwrap();
        assert_eq!((width, height), (8192, 4608));
        assert!((width as i64 * 2880 - height as i64 * 5120).abs() <= 2 * (5120 + 2880));
    }
}
