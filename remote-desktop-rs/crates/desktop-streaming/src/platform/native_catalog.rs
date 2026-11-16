//! On-demand WGC window references. Native identities stay inside this adapter;
//! selection, retained-handle validation and input leases share the same
//! HWND/PID identity without exposing it to IPC or the product UI.
use crate::{
    catalog::{CaptureSource, Catalog, NativeSource, MAX_SOURCES},
    error::BackendError,
    session::Owner,
    traits::Geometry,
};
use crabgrab::prelude::*;
use std::time::Instant;

struct Selection {
    window: CapturableWindow,
    pid: u32,
}
pub struct WindowCatalog {
    references: Catalog<Selection>,
}

impl Default for WindowCatalog {
    fn default() -> Self {
        Self::new(crate::session::secret())
    }
}

pub fn identity(window: &CapturableWindow) -> anyhow::Result<super::windows_window::Identity> {
    use crabgrab::platform::windows::WindowsCapturableWindowExt;
    let pid = u32::try_from(window.application().pid())
        .ok()
        .filter(|pid| *pid != 0)
        .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    Ok(super::windows_window::Identity {
        window: window.get_window_handle().0,
        pid,
    })
}

fn selectable(window: &CapturableWindow) -> bool {
    if !window.is_visible() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let Ok(identity) = identity(window) else {
            return false;
        };
        let hwnd = identity.window as *mut std::ffi::c_void;
        if !super::windows_window::selectable(hwnd, identity.pid) {
            return false;
        }
    }
    let r = window.rect();
    Geometry::from_actuator_rect(r.origin.x, r.origin.y, r.size.width, r.size.height).is_ok()
}
async fn enumerate() -> anyhow::Result<CapturableContent> {
    #[cfg(target_os = "windows")]
    {
        super::windows_access::prepare_dpi()?;
        super::windows_access::check()?;
    }
    anyhow::ensure!(
        CaptureStream::test_access(false).is_some(),
        BackendError::ScreenPermissionRequired
    );
    CapturableContent::new(CapturableContentFilter::NORMAL_WINDOWS)
        .await
        .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))
}
impl WindowCatalog {
    pub fn new(source_salt: String) -> Self {
        Self {
            references: Catalog::with_salt(source_salt),
        }
    }

    pub async fn enumerate(&mut self, owner: Owner) -> anyhow::Result<Vec<CaptureSource>> {
        self.references.invalidate();
        let content = enumerate().await?;
        let mut windows = Vec::new();
        for window in content.windows().filter(selectable) {
            let Ok(native_identity) = identity(&window) else {
                continue;
            };
            // WGC frames are configured from the DWM visible frame. Publish the
            // same rectangle here so catalog dimensions cannot disagree with the
            // capture and input authority selected moments later.
            let Ok(geometry) = super::windows_window::geometry(native_identity) else {
                continue;
            };
            let application = window.application();
            let (title, subtitle) =
                crate::catalog::source_labels(window.title(), application.name());
            windows.push(NativeSource {
                identity: format!("wgc:{}:{}", native_identity.window, native_identity.pid),
                unavailable_reason: None,
                handle: Selection {
                    window: window.clone(),
                    pid: native_identity.pid,
                },
                kind: "window".into(),
                title,
                subtitle,
                width: geometry.width,
                height: geometry.height,
            });
            if windows.len() >= MAX_SOURCES {
                break;
            }
        }
        self.references
            .publish(owner, windows, Instant::now())
            .map_err(Into::into)
    }
    /// Consume once and reject vanished/hidden targets or a changed owning PID.
    /// Input leases separately revalidate the retained HWND before every event.
    pub async fn consume(
        &mut self,
        reference: &str,
        owner: &Owner,
    ) -> anyhow::Result<CapturableWindow> {
        let selected = match self.references.consume(reference, owner, Instant::now()) {
            Ok(selected) => selected,
            Err(crate::catalog::CatalogError::InvalidReference) => {
                self.enumerate(owner.clone()).await?;
                self.references.consume(reference, owner, Instant::now())?
            }
            Err(error) => return Err(error.into()),
        };
        let content = enumerate().await?;
        content
            .windows()
            .find(|w| {
                w == &selected.window
                    && w.application().pid() as u32 == selected.pid
                    && selectable(w)
            })
            .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))
    }
}
