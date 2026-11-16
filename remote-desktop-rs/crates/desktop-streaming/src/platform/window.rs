//! Platform window-capture catalog and retained target boundary. Public window
//! references never expose native handles.
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub enum WindowCatalog {
    #[cfg(target_os = "macos")]
    Macos(crate::platform::macos::WindowCatalog),
    #[cfg(target_os = "linux")]
    Linux(crate::platform::linux::WindowCatalog),
    #[cfg(target_os = "windows")]
    Windows(crate::platform::native_catalog::WindowCatalog),
}
#[cfg(target_os = "macos")]
impl Default for WindowCatalog {
    fn default() -> Self {
        Self::Macos(Default::default())
    }
}
#[cfg(target_os = "windows")]
impl Default for WindowCatalog {
    fn default() -> Self {
        Self::windows_with_source_salt(crate::session::secret())
    }
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
impl WindowCatalog {
    #[cfg(target_os = "macos")]
    pub fn with_source_salt(source_salt: String) -> Self {
        Self::Macos(crate::platform::macos::WindowCatalog::new(source_salt))
    }
    #[cfg(target_os = "windows")]
    fn windows_with_source_salt(source_salt: String) -> Self {
        Self::Windows(crate::platform::native_catalog::WindowCatalog::new(
            source_salt,
        ))
    }
    #[cfg(target_os = "windows")]
    pub fn with_source_salt(source_salt: String) -> Self {
        Self::windows_with_source_salt(source_salt)
    }
    pub async fn enumerate(
        &mut self,
        owner: crate::session::Owner,
    ) -> anyhow::Result<Vec<crate::catalog::CaptureSource>> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Macos(catalog) => catalog.enumerate(owner).await,
            #[cfg(target_os = "linux")]
            Self::Linux(catalog) => catalog.enumerate(owner).await,
            #[cfg(target_os = "windows")]
            Self::Windows(catalog) => catalog.enumerate(owner).await,
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
            #[cfg(target_os = "windows")]
            Self::Windows(catalog) => catalog
                .consume(reference, owner)
                .await
                .map(WindowTarget::Windows),
        }
    }
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
#[derive(Clone)]
pub enum WindowTarget {
    #[cfg(target_os = "macos")]
    Macos(crate::platform::macos::Target),
    #[cfg(target_os = "linux")]
    Linux(crate::platform::linux::WindowTarget),
    #[cfg(target_os = "windows")]
    Windows(crabgrab::prelude::CapturableWindow),
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
impl WindowTarget {
    pub fn source(&self, show_cursor: bool) -> anyhow::Result<crate::capture::Source> {
        match self {
            #[cfg(target_os = "macos")]
            Self::Macos(target) => {
                crate::platform::macos::Capture::new_with_cursor(target.clone(), show_cursor)
                    .map(|capture| crate::capture::Source::Native(Box::new(capture)))
            }
            #[cfg(target_os = "linux")]
            Self::Linux(target) => target
                .open(show_cursor)
                .map(Box::new)
                .map(crate::capture::Source::X11),
            #[cfg(target_os = "windows")]
            Self::Windows(target) => crate::platform::apple_windows::Capture::new_with_cursor(
                crate::platform::apple_windows::Target::Window(target.clone()),
                show_cursor,
            )
            .map(|capture| crate::capture::Source::Native(Box::new(capture))),
        }
    }
}
