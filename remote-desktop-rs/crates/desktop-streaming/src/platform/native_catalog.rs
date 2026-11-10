//! On-demand WGC window references. Native identities stay inside this
//! adapter; the service must not expose window capture until focus/hit testing
//! and geometry transitions are integrated and validated on each platform.
use crate::{
    catalog::{Catalog, NativeWindow, WindowEntry, MAX_WINDOWS},
    error::BackendError,
    session::Owner,
    traits::Geometry,
};
use crabgrab::prelude::*;
use std::time::Instant;

struct Selection {
    window: CapturableWindow,
    pid: i32,
}
#[derive(Default)]
pub struct WindowCatalog {
    references: Catalog<Selection>,
}

fn selectable(window: &CapturableWindow) -> bool {
    if !window.is_visible() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        use crabgrab::platform::windows::WindowsCapturableWindowExt;
        use windows_sys::Win32::{Graphics::Dwm::*, UI::WindowsAndMessaging::*};
        let hwnd = window.get_window_handle().0 as *mut std::ffi::c_void;
        unsafe {
            if IsWindow(hwnd) == 0
                || IsIconic(hwnd) != 0
                || hwnd == GetShellWindow()
                || hwnd == GetDesktopWindow()
                || GetAncestor(hwnd, GA_ROOT) != hwnd
                || (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW) != 0
            {
                return false;
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                (&mut cloaked as *mut u32).cast(),
                4,
            ) < 0
                || cloaked != 0
            {
                return false;
            }
            let mut affinity = 0;
            // The OS may deny this query for another process. Successful
            // protection metadata excludes the target; WGC remains final owner
            // of capture authorization when the query is inaccessible.
            if GetWindowDisplayAffinity(hwnd, &mut affinity) != 0 && affinity != WDA_NONE {
                return false;
            }
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
    pub async fn enumerate(&mut self, owner: Owner) -> anyhow::Result<Vec<WindowEntry>> {
        self.references.invalidate();
        let content = enumerate().await?;
        let mut windows = Vec::new();
        for window in content.windows().filter(selectable) {
            let rect = window.rect();
            let geometry = Geometry::from_actuator_rect(
                rect.origin.x,
                rect.origin.y,
                rect.size.width,
                rect.size.height,
            )?;
            let application = window.application();
            windows.push(NativeWindow {
                identity: format!("wgc:{}:{}", window.get_window_handle().0, application.pid()),
                unavailable_reason: None,
                handle: Selection {
                    window: window.clone(),
                    pid: application.pid(),
                },
                title: window.title(),
                application_name: application.name(),
                width: geometry.width,
                height: geometry.height,
            });
            if windows.len() > MAX_WINDOWS {
                break;
            }
        }
        self.references
            .publish(owner, windows, Instant::now())
            .map_err(Into::into)
    }
    /// Consume once and reject vanished/hidden targets or a changed owning PID.
    /// Same-process HWND reuse and focus protection still require a retained
    /// native capture-item identity before this is wired into the service.
    pub async fn consume(
        &mut self,
        reference: &str,
        owner: &Owner,
    ) -> anyhow::Result<CapturableWindow> {
        let selected = self.references.consume(reference, owner, Instant::now())?;
        let content = enumerate().await?;
        content
            .windows()
            .find(|w| {
                w == &selected.window && w.application().pid() == selected.pid && selectable(w)
            })
            .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))
    }
}
