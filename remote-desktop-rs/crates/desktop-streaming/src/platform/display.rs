//! Display provider catalog. Display identities remain inside the component;
//! callers receive only opaque source references.
use crate::{
    catalog::{CaptureSource, Catalog, CatalogError, NativeSource},
    error::BackendError,
    session::Owner,
};
use std::time::Instant;

#[cfg(target_os = "macos")]
pub type DisplayTarget = crate::platform::macos::DisplayTarget;
#[cfg(target_os = "linux")]
pub type DisplayTarget = crate::platform::linux::DisplayTarget;

pub struct DisplayCatalog {
    catalog: Catalog<DisplayTarget>,
    #[cfg(target_os = "linux")]
    config: crate::platform::linux::Config,
}

#[cfg(target_os = "macos")]
impl Default for DisplayCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl DisplayCatalog {
    #[cfg(target_os = "macos")]
    pub fn new() -> Self {
        Self {
            catalog: Catalog::default(),
        }
    }
    #[cfg(target_os = "linux")]
    pub fn new(config: crate::platform::linux::Config) -> Self {
        Self {
            catalog: Catalog::default(),
            config,
        }
    }
    pub async fn enumerate(&mut self, owner: Owner) -> anyhow::Result<Vec<CaptureSource>> {
        self.catalog.invalidate();
        #[cfg(target_os = "macos")]
        let displays =
            tokio::task::spawn_blocking(crate::platform::macos::enumerate_displays).await??;
        #[cfg(target_os = "linux")]
        let displays = {
            let config = self.config.clone();
            tokio::task::spawn_blocking(move || crate::platform::linux::enumerate_displays(&config))
                .await??
        };
        self.catalog
            .publish(owner, displays, Instant::now())
            .map_err(Into::into)
    }
    pub async fn consume(
        &mut self,
        source_ref: &str,
        owner: &Owner,
    ) -> anyhow::Result<DisplayTarget> {
        match self.catalog.consume(source_ref, owner, Instant::now()) {
            Ok(target) => Ok(target),
            Err(CatalogError::InvalidReference) => {
                self.enumerate(owner.clone()).await?;
                self.catalog
                    .consume(source_ref, owner, Instant::now())
                    .map_err(Into::into)
            }
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Clone)]
pub enum SourceTarget {
    Display(DisplayTarget),
    Window(super::window::WindowTarget),
}

impl SourceTarget {
    pub fn source(&self, show_cursor: bool) -> anyhow::Result<crate::capture::Source> {
        match self {
            Self::Display(target) => target.source(show_cursor),
            Self::Window(target) => target.source(show_cursor),
        }
    }
}

pub fn invalid_reference() -> anyhow::Error {
    CatalogError::InvalidReference.into()
}

pub fn backend_error(error: &anyhow::Error) -> BackendError {
    BackendError::from_error(error)
}

pub type NativeDisplay = NativeSource<DisplayTarget>;
