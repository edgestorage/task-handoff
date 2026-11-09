//! Component-local platform choice. It is not a public capability document.
use crate::{traits::Geometry, video::Budget};
use openh264::formats::YUVBuffer;
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
    Native(crate::platform::native_capture::Capture),
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
            Ok(Self::Native(
                crate::platform::native_capture::Capture::primary_display_with_cursor(show_cursor)
                    .await?,
            ))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            anyhow::bail!(crate::error::BackendError::PlatformUnsupported)
        }
    }
    pub fn refresh_geometry(&mut self) -> anyhow::Result<Geometry> {
        #[cfg(target_os = "macos")]
        if let Self::Native(c) = self {
            return c.refresh_geometry();
        }
        Ok(self.geometry())
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
    pub fn frame(
        &mut self,
        index: u64,
        input: &crate::synthetic::SyntheticInput,
        _force: bool,
        budget: Budget,
    ) -> anyhow::Result<Option<YUVBuffer>> {
        match self {
            Self::Synthetic => Ok(Some(crate::video::scale_yuv(
                crate::synthetic::pattern(index, input),
                budget,
            )?)),
            #[cfg(target_os = "linux")]
            // XDamage controls native readback, while cached frames maintain
            // video cadence. A completely silent static track makes browser
            // jitter buffers wait for another frame and repeatedly request PLI.
            Self::X11(c) => c
                .frame(true)?
                .map(|raw| crate::video::from_bgra(raw, budget))
                .transpose(),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Self::Native(c) => c
                .frame(_force)?
                .map(|raw| crate::video::from_bgra(raw, budget))
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
