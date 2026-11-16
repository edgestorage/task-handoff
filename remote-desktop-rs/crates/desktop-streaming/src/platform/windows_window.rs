//! Retained WGC window identity with Win32 focus and hit validation. The
//! target must remain visible, foreground-compatible and under the pointer for
//! native input; handles never cross the private IPC boundary.
use crate::{error::BackendError, traits::Geometry};
use std::{
    ffi::c_void,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::WindowsAndMessaging::{
        BringWindowToTop, GetAncestor, GetForegroundWindow, GetWindow, GetWindowDisplayAffinity,
        GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
        IsWindowVisible, SetForegroundWindow, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GWL_STYLE,
        GW_OWNER, WDA_NONE, WS_EX_TOOLWINDOW, WS_POPUP,
    },
};

const FOCUS_ACTIVATION_TIMEOUT: Duration = Duration::from_millis(600);
const FOCUS_ACTIVATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const WINDOW_BIND_TIMEOUT: Duration = Duration::from_millis(600);
const WINDOW_BIND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const OWNER_CHAIN_LIMIT: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub window: isize,
    pub pid: u32,
}

impl Identity {
    fn hwnd(self) -> HWND {
        self.window as HWND
    }
}

fn root(hwnd: HWND) -> HWND {
    if hwnd.is_null() {
        return hwnd;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_null() {
        hwnd
    } else {
        root
    }
}

fn window_pid(hwnd: HWND) -> Option<u32> {
    if hwnd.is_null() {
        return None;
    }
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    (thread != 0 && pid != 0).then_some(pid)
}

fn style(hwnd: HWND, index: i32) -> isize {
    unsafe { GetWindowLongPtrW(hwnd, index) }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let status = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast::<c_void>(),
            std::mem::size_of_val(&cloaked) as u32,
        )
    };
    status < 0 || cloaked != 0
}

fn is_protected(hwnd: HWND) -> bool {
    let mut affinity = 0u32;
    // A failed affinity query must not turn a protected window into a selectable
    // target. WGC-created/protected surfaces are rejected unless NONE is proven.
    unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) == 0 || affinity != WDA_NONE }
}

pub(crate) fn selectable(hwnd: HWND, pid: u32) -> bool {
    !hwnd.is_null()
        && pid != 0
        && window_pid(hwnd) == Some(pid)
        && super::windows_access::process_in_current_interactive_session(pid)
        && unsafe { IsWindow(hwnd) != 0 && IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 }
        && root(hwnd) == hwnd
        && (style(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW) == 0
        && !is_cloaked(hwnd)
        && !is_protected(hwnd)
}

fn geometry_from_rect(rect: RECT) -> anyhow::Result<Geometry> {
    Geometry::from_actuator_rect(
        rect.left as f64,
        rect.top as f64,
        (rect.right - rect.left) as f64,
        (rect.bottom - rect.top) as f64,
    )
}

fn native_geometry(identity: Identity) -> anyhow::Result<Geometry> {
    let hwnd = identity.hwnd();
    anyhow::ensure!(
        selectable(hwnd, identity.pid),
        BackendError::WindowUnavailable
    );
    let mut rect = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut rect as *mut RECT).cast::<c_void>(),
            std::mem::size_of_val(&rect) as u32,
        )
    };
    if (dwm < 0 || rect.right <= rect.left || rect.bottom <= rect.top)
        && unsafe { GetWindowRect(hwnd, &mut rect) } == 0
    {
        anyhow::bail!(BackendError::WindowUnavailable);
    }
    anyhow::ensure!(
        rect.right > rect.left && rect.bottom > rect.top,
        BackendError::WindowUnavailable
    );
    geometry_from_rect(rect)
}

pub fn geometry(identity: Identity) -> anyhow::Result<Geometry> {
    native_geometry(identity)
}

fn owner_matches(hwnd: HWND, target: HWND) -> bool {
    let mut current = root(hwnd);
    for _ in 0..OWNER_CHAIN_LIMIT {
        let owner = unsafe { GetWindow(current, GW_OWNER) };
        if owner.is_null() {
            return false;
        }
        if root(owner) == target {
            return true;
        }
        current = root(owner);
    }
    false
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Relation {
    root_matches: bool,
    same_process: bool,
    popup: bool,
    owner_matches: bool,
}

fn relation_allowed(relation: Relation) -> bool {
    relation.root_matches || (relation.same_process && (relation.popup || relation.owner_matches))
}

fn window_relation(candidate: HWND, identity: Identity) -> Relation {
    let target = identity.hwnd();
    let candidate_root = root(candidate);
    Relation {
        root_matches: candidate_root == target,
        same_process: window_pid(candidate_root) == Some(identity.pid),
        popup: (style(candidate_root, GWL_STYLE) as u32 & WS_POPUP) != 0,
        owner_matches: owner_matches(candidate_root, target),
    }
}

fn foreground_allowed(identity: Identity) -> bool {
    let foreground = unsafe { GetForegroundWindow() };
    !foreground.is_null()
        && (root(foreground) == identity.hwnd()
            || relation_allowed(window_relation(foreground, identity)))
}

fn pointer_allowed(identity: Identity, point: (i32, i32)) -> bool {
    let hit = unsafe {
        WindowFromPoint(POINT {
            x: point.0,
            y: point.1,
        })
    };
    !hit.is_null()
        && (root(hit) == identity.hwnd() || relation_allowed(window_relation(hit, identity)))
}

/// A background host is denied SetForegroundWindow by the Windows foreground
/// lock. Attaching to the current foreground input queue for the duration of
/// the activation grants the target window the same right a user click would.
fn activate_foreground(hwnd: HWND) {
    let foreground = unsafe { GetForegroundWindow() };
    let foreground_thread = if foreground.is_null() {
        0
    } else {
        unsafe { GetWindowThreadProcessId(foreground, std::ptr::null_mut()) }
    };
    let current_thread = unsafe { GetCurrentThreadId() };
    let attached = foreground_thread != 0
        && foreground_thread != current_thread
        && unsafe { AttachThreadInput(current_thread, foreground_thread, 1) } != 0;
    unsafe {
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(current_thread, foreground_thread, 0);
        }
    }
}

struct Native {
    identity: Identity,
    geometry: Geometry,
}

impl Native {
    fn bind(identity: Identity, expected: Geometry) -> anyhow::Result<Self> {
        crate::platform::windows_access::prepare_dpi()?;
        crate::platform::windows_access::check()?;
        anyhow::ensure!(
            native_geometry(identity)? == expected,
            BackendError::GeometryChanged
        );
        Ok(Self {
            identity,
            geometry: expected,
        })
    }

    fn geometry(&self) -> anyhow::Result<Geometry> {
        let geometry = native_geometry(self.identity)?;
        anyhow::ensure!(geometry == self.geometry, BackendError::GeometryChanged);
        Ok(geometry)
    }

    fn focus(&self) -> anyhow::Result<Geometry> {
        crate::platform::windows_access::check()?;
        let hwnd = self.identity.hwnd();
        if !foreground_allowed(self.identity) {
            activate_foreground(hwnd);
            let deadline = Instant::now() + FOCUS_ACTIVATION_TIMEOUT;
            while !foreground_allowed(self.identity) {
                anyhow::ensure!(Instant::now() < deadline, BackendError::WindowFocusRequired);
                thread::sleep(FOCUS_ACTIVATION_POLL_INTERVAL);
            }
        }
        let geometry = self.geometry()?;
        self.validate(geometry, None)
    }

    fn validate(&self, expected: Geometry, point: Option<(i32, i32)>) -> anyhow::Result<Geometry> {
        crate::platform::windows_access::check()?;
        let geometry = self.geometry()?;
        anyhow::ensure!(geometry == expected, BackendError::GeometryChanged);
        anyhow::ensure!(
            foreground_allowed(self.identity),
            BackendError::WindowFocusRequired
        );
        if let Some(point) = point {
            anyhow::ensure!(
                pointer_allowed(self.identity, point),
                BackendError::WindowFocusRequired
            );
        }
        Ok(geometry)
    }
}

pub struct Lease {
    native: Native,
}

impl Lease {
    pub fn bind(identity: Identity, geometry: Geometry) -> anyhow::Result<Self> {
        let deadline = Instant::now() + WINDOW_BIND_TIMEOUT;
        loop {
            match Native::bind(identity, geometry) {
                Ok(native) => return Ok(Self { native }),
                Err(error)
                    if Instant::now() < deadline
                        && matches!(
                            error.downcast_ref::<BackendError>(),
                            Some(BackendError::WindowUnavailable | BackendError::GeometryChanged)
                        ) =>
                {
                    thread::sleep(WINDOW_BIND_POLL_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn geometry(&self) -> anyhow::Result<Geometry> {
        self.native.geometry()
    }

    pub fn reconfigure(&mut self, geometry: Geometry) -> anyhow::Result<()> {
        anyhow::ensure!(
            native_geometry(self.native.identity)? == geometry,
            BackendError::GeometryChanged
        );
        self.native.geometry = geometry;
        Ok(())
    }

    pub fn focus(&self) -> anyhow::Result<Geometry> {
        self.native.focus()
    }

    pub fn validate(&self, geometry: Geometry, point: Option<(i32, i32)>) -> anyhow::Result<()> {
        self.native.validate(geometry, point).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn negative_origin_window_geometry_is_preserved() {
        let geometry = geometry_from_rect(rect(-1920, -200, -640, 480)).unwrap();
        assert_eq!(
            geometry,
            Geometry {
                x: -1920,
                y: -200,
                width: 1280,
                height: 680,
                scale: 1.0,
            }
        );
    }

    #[test]
    fn empty_window_geometry_is_rejected() {
        assert!(geometry_from_rect(rect(10, 10, 10, 20)).is_err());
        assert!(geometry_from_rect(rect(10, 10, 20, 10)).is_err());
    }

    #[test]
    fn same_process_popup_and_owned_dialog_are_transient() {
        assert!(relation_allowed(Relation {
            root_matches: true,
            same_process: true,
            popup: false,
            owner_matches: false,
        }));
        assert!(relation_allowed(Relation {
            root_matches: false,
            same_process: true,
            popup: true,
            owner_matches: false,
        }));
        assert!(relation_allowed(Relation {
            root_matches: false,
            same_process: true,
            popup: false,
            owner_matches: true,
        }));
    }

    #[test]
    fn other_process_and_unrelated_normal_windows_are_rejected() {
        assert!(!relation_allowed(Relation {
            root_matches: false,
            same_process: false,
            popup: true,
            owner_matches: true,
        }));
        assert!(!relation_allowed(Relation {
            root_matches: false,
            same_process: true,
            popup: false,
            owner_matches: false,
        }));
    }
}
