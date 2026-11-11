//! Platform window-capture catalog and retained target boundary. Public window
//! references never expose native handles.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub enum WindowCatalog {
    #[cfg(target_os = "macos")]
    Macos(crate::platform::macos::WindowCatalog),
    #[cfg(target_os = "linux")]
    Linux(crate::platform::linux::WindowCatalog),
}
#[cfg(target_os = "macos")]
impl Default for WindowCatalog {
    fn default() -> Self {
        Self::Macos(Default::default())
    }
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl WindowCatalog {
    pub async fn enumerate(
        &mut self,
        owner: crate::session::Owner,
    ) -> anyhow::Result<Vec<crate::catalog::CaptureSource>> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Macos(catalog) => catalog.enumerate(owner).await,
            #[cfg(target_os = "linux")]
            Self::Linux(catalog) => catalog.enumerate(owner).await,
        }
    }
    pub async fn consume(
        &mut self,
        reference: &str,
        owner: &crate::session::Owner,
    ) -> anyhow::Result<WindowTarget> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Macos(catalog) => catalog
                .consume(reference, owner)
                .await
                .map(|capture| WindowTarget::Macos(capture.retained_target())),
            #[cfg(target_os = "linux")]
            Self::Linux(catalog) => catalog
                .consume(reference, owner)
                .await
                .map(WindowTarget::Linux),
        }
    }
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone)]
pub enum WindowTarget {
    #[cfg(target_os = "macos")]
    Macos(crate::platform::macos::Target),
    #[cfg(target_os = "linux")]
    Linux(crate::platform::linux::WindowTarget),
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl WindowTarget {
    pub fn source(&self, show_cursor: bool) -> anyhow::Result<crate::capture::Source> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Macos(target) => {
                crate::platform::macos::Capture::new_with_cursor(target.clone(), show_cursor)
                    .map(crate::capture::Source::Native)
            }
            #[cfg(target_os = "linux")]
            Self::Linux(target) => target
                .open(show_cursor)
                .map(Box::new)
                .map(crate::capture::Source::X11),
        }
    }
}
