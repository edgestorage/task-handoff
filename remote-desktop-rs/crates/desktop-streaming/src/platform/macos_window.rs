//! Public AX/CG window identity, confined to a dedicated worker thread. Retain
//! the AX object across selection/lifetime checks; never identify by title or
//! use private AXWindowNumber APIs. Ambiguous AX/CG associations fail closed.
use crate::{error::BackendError, traits::Geometry};
use core_foundation::{
    array::CFArray,
    base::{CFType, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
};
use core_graphics::{geometry::CGRect, window::*};
use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray as AxArray, CFBoolean, CFRetained, CFString, CFType as AxType, CGPoint, CGSize,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    ptr::NonNull,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const FOCUS_ACTIVATION_TIMEOUT: Duration = Duration::from_millis(600);
const FOCUS_ACTIVATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const WINDOW_BIND_TIMEOUT: Duration = Duration::from_millis(600);
const WINDOW_BIND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const FOCUSED_WINDOW_ANCESTOR_LIMIT: usize = 4;
const COVERING_WINDOW_SCAN_LIMIT: usize = 256;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub window: u32,
    pub pid: i32,
}

/// The selected window and the screen-space union SCK actually captures for
/// it. Native menus and popovers are separate higher-layer windows, so capture
/// layout must not be derived from the target window geometry alone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureLayout {
    pub geometry: Geometry,
    pub capture_bounds: Geometry,
}
#[derive(Clone)]
pub struct Lease {
    tx: mpsc::SyncSender<Request>,
}
enum Operation {
    Geometry,
    Focus,
    Validate(Geometry, Option<(i32, i32)>),
}
impl Operation {
    fn timeout(&self) -> Duration {
        match self {
            // focus() deliberately waits up to FOCUS_ACTIVATION_TIMEOUT for
            // AX/WindowServer to publish the activation. The lease budget must
            // outlive that wait, otherwise a slow but successful activation is
            // reported as a dead window.
            Self::Focus => FOCUS_ACTIVATION_TIMEOUT + Duration::from_millis(400),
            Self::Geometry | Self::Validate(..) => Duration::from_millis(300),
        }
    }
    fn timeout_error(&self) -> BackendError {
        match self {
            Self::Focus => BackendError::WindowFocusRequired,
            Self::Geometry | Self::Validate(..) => BackendError::GeometryChanged,
        }
    }
}
struct Request {
    operation: Operation,
    reply: mpsc::SyncSender<Result<Geometry, BackendError>>,
}
impl Lease {
    pub fn bind(identity: Identity, geometry: Geometry) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::sync_channel::<Request>(4);
        let (ready, wait) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let deadline = Instant::now() + WINDOW_BIND_TIMEOUT;
            let mut native = Native::bind(identity, geometry);
            while let Err(error) = &native {
                let retryable = matches!(
                    error.downcast_ref::<BackendError>(),
                    Some(BackendError::WindowUnavailable | BackendError::GeometryChanged)
                );
                if !retryable || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(WINDOW_BIND_POLL_INTERVAL);
                native = Native::bind(identity, geometry);
            }
            let _ = ready.send(
                native
                    .as_ref()
                    .map(|_| ())
                    .map_err(BackendError::from_error),
            );
            let Ok(native) = native else {
                return;
            };
            for request in rx {
                let is_geometry = matches!(&request.operation, Operation::Geometry);
                let started = Instant::now();
                if is_geometry {
                    eprintln!("REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.worker.start");
                }
                let result = match request.operation {
                    Operation::Geometry => native.geometry(),
                    Operation::Focus => native.focus(),
                    Operation::Validate(expected, point) => native.validate(expected, point),
                }
                .map_err(|e| BackendError::from_error(&e));
                if is_geometry {
                    match &result {
                        Ok(geometry) => eprintln!(
                            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.worker.end elapsedMs={} result=ok geometry={geometry:?}",
                            started.elapsed().as_millis()
                        ),
                        Err(error) => eprintln!(
                            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.worker.end elapsedMs={} result=error error={error}",
                            started.elapsed().as_millis()
                        ),
                    }
                }
                let _ = request.reply.send(result);
            }
        });
        wait.recv_timeout(Duration::from_secs(2))??;
        Ok(Self { tx })
    }
    fn call(&self, operation: Operation) -> anyhow::Result<Geometry> {
        let is_geometry = matches!(&operation, Operation::Geometry);
        let timeout = operation.timeout();
        let timeout_error = operation.timeout_error();
        let started = Instant::now();
        if is_geometry {
            eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.lease.start timeoutMs={}",
                timeout.as_millis()
            );
        }
        let (reply, rx) = mpsc::sync_channel(1);
        if let Err(error) = self.tx.try_send(Request { operation, reply }) {
            if is_geometry {
                eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.lease.send_error elapsedMs={} error={error}",
                    started.elapsed().as_millis()
                );
            }
            return Err(anyhow::anyhow!(timeout_error));
        }
        let received = rx.recv_timeout(timeout);
        if is_geometry {
            match &received {
                Ok(Ok(geometry)) => eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.lease.end elapsedMs={} result=ok geometry={geometry:?}",
                    started.elapsed().as_millis()
                ),
                Ok(Err(error)) => eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.lease.end elapsedMs={} result=error error={error}",
                    started.elapsed().as_millis()
                ),
                Err(error) => eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.lease.end elapsedMs={} result=timeout error={error}",
                    started.elapsed().as_millis()
                ),
            }
        }
        Ok(received.map_err(|_| anyhow::anyhow!(timeout_error))??)
    }
    pub fn geometry(&self) -> anyhow::Result<Geometry> {
        self.call(Operation::Geometry)
    }
    pub fn focus(&self) -> anyhow::Result<Geometry> {
        self.call(Operation::Focus)
    }
    pub fn validate(&self, geometry: Geometry, point: Option<(i32, i32)>) -> anyhow::Result<()> {
        self.call(Operation::Validate(geometry, point)).map(|_| ())
    }
}

/// WindowServer geometry is sufficient for capture layout. Accessibility can
/// briefly omit a live window while its application updates its AX tree; that
/// must not make the capture source unavailable. Input binding still validates
/// AX and CG together in the dedicated input worker.
pub fn geometry(identity: Identity) -> anyhow::Result<Geometry> {
    Ok(capture_layout(identity)?.geometry)
}

/// Screen-space union represented by a desktop-independent window capture.
/// SCK includes same-process transient windows such as menus and popovers even
/// though they are separate higher-layer CG windows.
pub fn capture_bounds(identity: Identity) -> anyhow::Result<Geometry> {
    Ok(capture_layout(identity)?.capture_bounds)
}

pub fn capture_layout(identity: Identity) -> anyhow::Result<CaptureLayout> {
    capture_layout_from_windows(&visible_windows()?, identity)
}

fn capture_layout_from_windows(
    windows: &[Visible],
    identity: Identity,
) -> anyhow::Result<CaptureLayout> {
    anyhow::ensure!(identity.pid > 0, BackendError::WindowUnavailable);
    let mut geometry = None;
    let mut left = i64::MAX;
    let mut top = i64::MAX;
    let mut right = i64::MIN;
    let mut bottom = i64::MIN;
    for window in windows.iter().filter(|window| {
        window.pid == identity.pid && (window.id == identity.window || window.layer > 0)
    }) {
        if window.id == identity.window {
            geometry = Some(window.geometry);
        }
        let x = i64::from(window.geometry.x);
        let y = i64::from(window.geometry.y);
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + i64::from(window.geometry.width));
        bottom = bottom.max(y + i64::from(window.geometry.height));
    }
    let geometry = geometry.ok_or_else(|| {
        eprintln!(
            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.visible_geometry.not_found window={} pid={}",
            identity.window, identity.pid
        );
        anyhow::anyhow!(BackendError::WindowUnavailable)
    })?;
    let capture_bounds = Geometry::from_actuator_rect(
        left as f64,
        top as f64,
        right.saturating_sub(left) as f64,
        bottom.saturating_sub(top) as f64,
    )?;
    Ok(CaptureLayout {
        geometry,
        capture_bounds,
    })
}

#[cfg(test)]
fn capture_union(windows: &[Visible], identity: Identity) -> anyhow::Result<Geometry> {
    Ok(capture_layout_from_windows(windows, identity)?.capture_bounds)
}
fn transient_geometry_ax_error(error: AXError) -> bool {
    matches!(error, AXError::CannotComplete | AXError::InvalidUIElement)
}
fn attribute(
    element: &AXUIElement,
    key: &str,
    transient_as_geometry: bool,
) -> anyhow::Result<CFRetained<AxType>> {
    let mut value: *const AxType = std::ptr::null();
    // Copy API returns a +1 CF value; the maintained retained wrapper owns it.
    let error = unsafe {
        element.copy_attribute_value(&CFString::from_str(key), NonNull::from(&mut value))
    };
    if error != AXError::Success {
        eprintln!(
            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.attribute.error key={key} axError={error:?}"
        );
    }
    if error != AXError::Success {
        return Err(
            if transient_as_geometry && transient_geometry_ax_error(error) {
                BackendError::GeometryChanged.into()
            } else {
                BackendError::WindowUnavailable.into()
            },
        );
    }
    let value = NonNull::new(value.cast_mut()).ok_or_else(|| {
        eprintln!("REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.attribute.null key={key}");
        anyhow::anyhow!(BackendError::WindowUnavailable)
    })?;
    Ok(unsafe { CFRetained::from_raw(value) })
}
fn optional_element_attribute(element: &AXUIElement, key: &str) -> Option<CFRetained<AXUIElement>> {
    let mut value: *const AxType = std::ptr::null();
    let error = unsafe {
        element.copy_attribute_value(&CFString::from_str(key), NonNull::from(&mut value))
    };
    if error != AXError::Success {
        return None;
    }
    let value = NonNull::new(value.cast_mut())?;
    let value = unsafe { CFRetained::from_raw(value) };
    value.downcast::<AXUIElement>().ok()
}
fn focused_window_matches<T, Pid, Parent>(
    target: &T,
    focused: &T,
    expected_pid: i32,
    pid: Pid,
    parent: Parent,
) -> bool
where
    T: Clone + PartialEq,
    Pid: Fn(&T) -> Option<i32>,
    Parent: Fn(&T) -> Option<T>,
{
    if focused == target {
        return true;
    }
    let mut current = focused.clone();
    for _ in 0..FOCUSED_WINDOW_ANCESTOR_LIMIT {
        if pid(&current) != Some(expected_pid) {
            return false;
        }
        let Some(next) = parent(&current) else {
            return false;
        };
        if next == current {
            return false;
        }
        if &next == target {
            return true;
        }
        current = next;
    }
    false
}
fn geometry_contains(outer: Geometry, inner: Geometry) -> bool {
    let outer_right = i64::from(outer.x) + i64::from(outer.width);
    let outer_bottom = i64::from(outer.y) + i64::from(outer.height);
    let inner_right = i64::from(inner.x) + i64::from(inner.width);
    let inner_bottom = i64::from(inner.y) + i64::from(inner.height);
    i64::from(inner.x) >= i64::from(outer.x)
        && i64::from(inner.y) >= i64::from(outer.y)
        && inner_right <= outer_right
        && inner_bottom <= outer_bottom
}
fn owned_layer_zero_window_matches(
    target_pid: i32,
    hit: &Visible,
    candidate_pid: i32,
    candidate_role: &str,
    candidate_subrole: &str,
    candidate_geometry: Geometry,
    target_geometry: Geometry,
) -> bool {
    candidate_pid == target_pid
        && candidate_pid == hit.pid
        && candidate_role == "AXWindow"
        && matches!(
            candidate_subrole,
            "AXUnknown" | "AXDialog" | "AXFloatingWindow"
        )
        && candidate_geometry == hit.geometry
        && geometry_contains(target_geometry, hit.geometry)
}
fn ax_geometry(element: &AXUIElement) -> anyhow::Result<Geometry> {
    let position = attribute(element, "AXPosition", true)?
        .downcast::<AXValue>()
        .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    let size = attribute(element, "AXSize", true)?
        .downcast::<AXValue>()
        .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    let mut point = CGPoint::ZERO;
    let mut extent = CGSize::ZERO;
    anyhow::ensure!(
        unsafe {
            position.value(AXValueType::CGPoint, NonNull::from(&mut point).cast())
                && size.value(AXValueType::CGSize, NonNull::from(&mut extent).cast())
        },
        BackendError::WindowUnavailable
    );
    Geometry::from_actuator_rect(point.x, point.y, extent.width, extent.height)
}
struct Native {
    identity: Identity,
    app: CFRetained<AXUIElement>,
    window: CFRetained<AXUIElement>,
    /// AX-verified, same-process layer-0 child windows such as sheets. CG
    /// reports these separately from the selected window at layer 0, so the
    /// layer-only transient rule cannot identify them.
    owned_transients: RefCell<HashMap<u32, Geometry>>,
}
impl Native {
    fn bind(identity: Identity, geometry: Geometry) -> anyhow::Result<Self> {
        anyhow::ensure!(identity.pid > 0, BackendError::WindowUnavailable);
        let app = unsafe { AXUIElement::new_application(identity.pid) };
        unsafe {
            app.set_messaging_timeout(0.05);
        }
        let list = attribute(&app, "AXWindows", true)?
            .downcast::<AxArray>()
            .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
        // AXWindows is documented as a CFArray of CF objects; preserve runtime
        // downcasts for each value rather than assuming every element is AX.
        let list = unsafe { CFRetained::cast_unchecked::<AxArray<AxType>>(list) };
        anyhow::ensure!(
            list.len() <= crate::catalog::MAX_SOURCES,
            BackendError::WindowUnavailable
        );
        let mut matched = None;
        for item in list.iter() {
            let Ok(window) = item.downcast::<AXUIElement>() else {
                continue;
            };
            unsafe {
                window.set_messaging_timeout(0.05);
            }
            if ax_geometry(&window).is_ok_and(|g| g == geometry) {
                anyhow::ensure!(matched.is_none(), BackendError::WindowIdentityAmbiguous);
                matched = Some(window);
            }
        }
        let native = Self {
            identity,
            app,
            window: matched.ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?,
            owned_transients: RefCell::new(HashMap::new()),
        };
        anyhow::ensure!(
            native.geometry()? == geometry,
            BackendError::GeometryChanged
        );
        Ok(native)
    }
    fn geometry(&self) -> anyhow::Result<Geometry> {
        (|| -> anyhow::Result<Geometry> {
            let mut pid = 0;
            let pid_result = unsafe { self.window.pid(NonNull::from(&mut pid)) };
            if pid_result != AXError::Success {
                return Err(if transient_geometry_ax_error(pid_result) {
                    BackendError::GeometryChanged.into()
                } else {
                    BackendError::WindowUnavailable.into()
                });
            }
            anyhow::ensure!(pid == self.identity.pid, BackendError::WindowUnavailable);
            let minimized = attribute(&self.window, "AXMinimized", true)?
                .downcast::<CFBoolean>()
                .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
            anyhow::ensure!(!minimized.value(), BackendError::WindowUnavailable);
            let geometry = ax_geometry(&self.window)?;
            let windows = visible_windows()?;
            let current = windows
                .iter()
                .find(|w| w.id == self.identity.window && w.pid == pid)
                .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
            // AX and WindowServer update independently during native moves/resizes.
            // Preserve identity, suspend input and wait for coherent geometry instead
            // of treating a transient coordinate mismatch as a closed window.
            anyhow::ensure!(current.geometry == geometry, BackendError::GeometryChanged);
            Ok(geometry)
        })()
    }
    fn frontmost(&self) -> anyhow::Result<()> {
        let app = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication();
        let frontmost = app.is_some_and(|a| a.processIdentifier() == self.identity.pid);
        anyhow::ensure!(frontmost, BackendError::WindowFocusRequired);
        Ok(())
    }
    fn focused_element(&self) -> anyhow::Result<CFRetained<AXUIElement>> {
        let focused = attribute(&self.app, "AXFocusedWindow", false)
            .map_err(|_| anyhow::anyhow!(BackendError::WindowFocusRequired))?
            .downcast::<AXUIElement>()
            .map_err(|_| anyhow::anyhow!(BackendError::WindowFocusRequired))?;
        unsafe {
            focused.set_messaging_timeout(0.05);
        }
        Ok(focused)
    }
    fn focused_matches(&self, focused: &CFRetained<AXUIElement>) -> bool {
        focused_window_matches(
            &self.window,
            focused,
            self.identity.pid,
            |element: &CFRetained<AXUIElement>| {
                let mut pid = 0;
                (unsafe { element.pid(NonNull::from(&mut pid)) } == AXError::Success).then_some(pid)
            },
            |element: &CFRetained<AXUIElement>| {
                optional_element_attribute(element.as_ref(), "AXParent")
                    .or_else(|| optional_element_attribute(element.as_ref(), "AXWindow"))
            },
        )
    }
    fn focused(&self) -> anyhow::Result<()> {
        self.frontmost()?;
        // AXFocusedWindow is a focus observation, not a geometry query. A
        // transient AX error (for example kAXErrorCannotComplete while a sheet
        // is being installed) must suspend input and be retried, never be
        // reported as WindowUnavailable and kill the input guard.
        let focused = self.focused_element()?;
        if focused == self.window {
            // Closing a sheet restores the target as AXFocusedWindow. Drop the
            // verified child cache so WindowServer ID reuse cannot grant input
            // to a later unrelated layer-0 window.
            self.owned_transients.borrow_mut().clear();
        }
        // A native sheet becomes AXFocusedWindow while its parent remains the
        // selected AXWindow. Accept only focus elements whose bounded AXParent/
        // AXWindow chain reaches the selected window; unrelated app windows
        // still fail closed.
        let matches = self.focused_matches(&focused);
        anyhow::ensure!(matches, BackendError::WindowFocusRequired);
        Ok(())
    }
    fn owned_layer_zero_transient(&self, hit: &Visible) -> bool {
        if hit.pid != self.identity.pid || hit.id == self.identity.window || hit.layer != 0 {
            return false;
        }
        if let Some(geometry) = self.owned_transients.borrow().get(&hit.id) {
            return *geometry == hit.geometry;
        }
        if let Ok(focused) = self.focused_element() {
            if focused == self.window {
                // Closing a sheet restores the target as AXFocusedWindow. Drop
                // the verified child cache so WindowServer ID reuse cannot
                // grant input to a later unrelated layer-0 window.
                self.owned_transients.borrow_mut().clear();
            } else if self.focused_matches(&focused)
                && ax_geometry(&focused).is_ok_and(|geometry| geometry == hit.geometry)
            {
                self.remember_owned_transient(hit);
                return true;
            }
        }
        // Some browsers expose a toolbar/popover as a separate layer-0 AXWindow
        // whose AXParent is the application. Its stable public signals are the
        // nonstandard window subrole and geometry fully covered by the selected
        // window, so require both instead of accepting every same-process
        // layer-0 window.
        self.owned_layer_zero_ax_window(hit)
    }
    fn owned_layer_zero_ax_window(&self, hit: &Visible) -> bool {
        let Ok(target_geometry) = ax_geometry(&self.window) else {
            return false;
        };
        let Ok(windows) = attribute(&self.app, "AXWindows", false).and_then(|value| {
            value
                .downcast::<AxArray>()
                .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))
        }) else {
            eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.pointer.covering_scan window={} hitWindow={} result=windows_unavailable",
                self.identity.window, hit.id
            );
            return false;
        };
        let windows = unsafe { CFRetained::cast_unchecked::<AxArray<AxType>>(windows) };
        let count = windows.len();
        let mut inspected = 0usize;
        for item in windows.iter().take(COVERING_WINDOW_SCAN_LIMIT) {
            let Ok(window) = item.downcast::<AXUIElement>() else {
                continue;
            };
            inspected += 1;
            unsafe {
                window.set_messaging_timeout(0.05);
            }
            let mut pid = 0;
            if unsafe { window.pid(NonNull::from(&mut pid)) } != AXError::Success {
                continue;
            }
            let Ok(role) = attribute(&window, "AXRole", true).and_then(|value| {
                value
                    .downcast::<CFString>()
                    .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))
            }) else {
                continue;
            };
            let subrole = attribute(&window, "AXSubrole", true)
                .and_then(|value| {
                    value
                        .downcast::<CFString>()
                        .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))
                })
                .map_or_else(|_| String::new(), |value| value.to_string());
            let Ok(geometry) = ax_geometry(&window) else {
                continue;
            };
            if inspected <= 8 {
                eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.pointer.covering_candidate window={} hitWindow={} candidatePid={} role={} subrole={} geometry={geometry:?}",
                    self.identity.window, hit.id, pid, role, subrole
                );
            }
            if owned_layer_zero_window_matches(
                self.identity.pid,
                hit,
                pid,
                &role.to_string(),
                &subrole,
                geometry,
                target_geometry,
            ) {
                self.remember_owned_transient(hit);
                return true;
            }
        }
        eprintln!(
            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.pointer.covering_scan window={} hitWindow={} result=no_match windows={count} inspected={inspected}",
            self.identity.window, hit.id
        );
        false
    }
    fn remember_owned_transient(&self, hit: &Visible) {
        self.owned_transients
            .borrow_mut()
            .insert(hit.id, hit.geometry);
        eprintln!(
            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.pointer.owned_transient window={} pid={} hitWindow={} geometry={geometry:?}",
            self.identity.window,
            self.identity.pid,
            hit.id,
            geometry = hit.geometry
        );
    }
    fn pointer_allowed(&self, hit: &Visible) -> bool {
        pointer_hit_allowed(self.identity, hit) || self.owned_layer_zero_transient(hit)
    }
    fn focus(&self) -> anyhow::Result<Geometry> {
        let geometry = self.geometry()?;
        let yes = CFBoolean::new(true);
        // Device Hub's simulator windows reject AXRaise with
        // kAXErrorAttributeUnsupported even though AXMain and AXFocused are
        // settable. Request activation through both supported paths and let the
        // observed frontmost/focused state below decide whether focus succeeded.
        if unsafe { self.window.perform_action(&CFString::from_str("AXRaise")) } != AXError::Success
        {
            let _ = unsafe {
                self.window
                    .set_attribute_value(&CFString::from_str("AXMain"), yes.as_ref())
            };
            let _ = unsafe {
                self.window
                    .set_attribute_value(&CFString::from_str("AXFocused"), yes.as_ref())
            };
        }
        let _ = unsafe {
            self.app
                .set_attribute_value(&CFString::from_str("AXFrontmost"), yes.as_ref())
        };
        // AXRaise/AXFrontmost return before WindowServer and NSWorkspace publish
        // the new foreground application. Wait for the observed transition
        // instead of failing immediately and leaving the viewer in a retry
        // loop even though activation is already in flight.
        let deadline = Instant::now() + FOCUS_ACTIVATION_TIMEOUT;
        loop {
            match self.focused() {
                Ok(()) => return Ok(geometry),
                Err(_) if Instant::now() < deadline => {
                    thread::sleep(FOCUS_ACTIVATION_POLL_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
    }
    fn validate(&self, expected: Geometry, point: Option<(i32, i32)>) -> anyhow::Result<Geometry> {
        let geometry = self.geometry()?;
        anyhow::ensure!(geometry == expected, BackendError::GeometryChanged);
        // CGEvent is global, so the target application must remain frontmost.
        // Its exact AX focused window may legitimately move to an app-owned
        // menu, popover or dialog while the user interacts with that window;
        // requiring the original window here would suspend control mid-action.
        self.frontmost().inspect_err(|_| {
            eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.validate.frontmost_rejected window={} pid={}",
                self.identity.window, self.identity.pid
            );
        })?;
        if let Some((x, y)) = point {
            let hit = visible_windows()?.into_iter().find(|w| {
                x as i64 >= w.geometry.x as i64
                    && y as i64 >= w.geometry.y as i64
                    && (x as i64) < w.geometry.x as i64 + w.geometry.width as i64
                    && (y as i64) < w.geometry.y as i64 + w.geometry.height as i64
            });
            let matches = hit.as_ref().is_some_and(|w| self.pointer_allowed(w));
            if !matches {
                match &hit {
                    Some(hit) => eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.validate.hit_rejected window={} pid={} point=({x},{y}) hitWindow={} hitPid={} hitLayer={} hitGeometry={:?}",
                        self.identity.window,
                        self.identity.pid,
                        hit.id,
                        hit.pid,
                        hit.layer,
                        hit.geometry
                    ),
                    None => eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=macos_window.validate.hit_rejected window={} pid={} point=({x},{y}) hitWindow=none",
                        self.identity.window, self.identity.pid
                    ),
                }
            }
            anyhow::ensure!(matches, BackendError::WindowFocusRequired);
        }
        Ok(geometry)
    }
}
struct Visible {
    id: u32,
    pid: i32,
    layer: i64,
    geometry: Geometry,
}
fn pointer_hit_allowed(target: Identity, hit: &Visible) -> bool {
    hit.pid == target.pid
        && (hit.id == target.window
            // Native menus, popovers and similar transient surfaces publish as
            // higher-layer windows owned by the same process. They are part of
            // the selected window's interaction and must not suspend input.
            || hit.layer > 0)
}
fn dictionary_value(
    dictionary: &CFDictionary,
    key: core_foundation::string::CFStringRef,
) -> Option<CFType> {
    let value = dictionary.find(key.cast::<std::ffi::c_void>())?;
    // CG window-list dictionary values are CF objects; validate each concrete
    // type with downcast before reading data. No native title/owner name read.
    Some(unsafe { CFType::wrap_under_get_rule(*value) })
}
fn visible_windows() -> anyhow::Result<Vec<Visible>> {
    let array: CFArray = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        0,
    )
    .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    let mut result = Vec::new();
    for raw in array.iter() {
        let item = unsafe { CFType::wrap_under_get_rule(*raw) };
        let Some(dictionary) = item.downcast::<CFDictionary>() else {
            continue;
        };
        let number = |key| {
            dictionary_value(&dictionary, key)?
                .downcast::<CFNumber>()?
                .to_i64()
        };
        let (Some(id), Some(pid), Some(alpha)) = (
            number(unsafe { kCGWindowNumber }),
            number(unsafe { kCGWindowOwnerPID }),
            dictionary_value(&dictionary, unsafe { kCGWindowAlpha })
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_f64()),
        ) else {
            continue;
        };
        if alpha <= 0.0 {
            continue;
        }
        // CG publishes its non-interactive cursor as a window at the cursor
        // level (observed23x22 at the injected point). It cannot occlude input.
        // Query the OS-defined level; all other overlays still participate.
        let cursor_level = objc2_core_graphics::CGWindowLevelForKey(
            objc2_core_graphics::CGWindowLevelKey::CursorWindowLevelKey,
        );
        let Some(layer) = number(unsafe { kCGWindowLayer }) else {
            continue;
        };
        if layer == i64::from(cursor_level) {
            continue;
        }
        let Some(bounds) = dictionary_value(&dictionary, unsafe { kCGWindowBounds })
            .and_then(|v| v.downcast::<CFDictionary>())
        else {
            continue;
        };
        let Some(rect) = CGRect::from_dict_representation(&bounds) else {
            continue;
        };
        let Ok(geometry) = Geometry::from_actuator_rect(
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        ) else {
            continue;
        };
        result.push(Visible {
            id: id as u32,
            pid: pid as i32,
            layer,
            geometry,
        });
        anyhow::ensure!(result.len() <= 4096, BackendError::WindowUnavailable);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        capture_layout_from_windows, capture_union, focused_window_matches, geometry_contains,
        owned_layer_zero_window_matches, pointer_hit_allowed, transient_geometry_ax_error,
        Identity, Visible,
    };
    use crate::traits::Geometry;
    use objc2_application_services::AXError;

    fn visible(id: u32, pid: i32, layer: i64) -> Visible {
        Visible {
            id,
            pid,
            layer,
            geometry: Geometry {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                scale: 1.0,
            },
        }
    }

    fn positioned(
        id: u32,
        pid: i32,
        layer: i64,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Visible {
        Visible {
            id,
            pid,
            layer,
            geometry: Geometry {
                x,
                y,
                width,
                height,
                scale: 1.0,
            },
        }
    }

    #[test]
    fn capture_union_includes_same_process_popovers_beyond_the_window() {
        let identity = Identity {
            window: 10,
            pid: 42,
        };
        let windows = vec![
            positioned(10, 42, 0, -149, 30, 1386, 1050),
            positioned(11, 42, 101, 827, 106, 327, 656),
            positioned(12, 42, 101, 1444, 442, 201, 192),
            positioned(13, 7, 101, 0, 0, 4000, 4000),
        ];
        assert_eq!(
            capture_union(&windows, identity).unwrap(),
            Geometry {
                x: -149,
                y: 30,
                width: 1794,
                height: 1050,
                scale: 1.0,
            }
        );
    }

    #[test]
    fn capture_union_ignores_unrelated_same_process_normal_windows() {
        let identity = Identity {
            window: 10,
            pid: 42,
        };
        let windows = vec![
            positioned(10, 42, 0, 100, 80, 800, 600),
            positioned(11, 42, 0, 1200, 800, 400, 300),
        ];
        assert_eq!(
            capture_union(&windows, identity).unwrap(),
            Geometry {
                x: 100,
                y: 80,
                width: 800,
                height: 600,
                scale: 1.0,
            }
        );
    }

    #[test]
    fn capture_layout_tracks_popover_open_and_close_without_changing_window_geometry() {
        let identity = Identity {
            window: 10,
            pid: 42,
        };
        let window = Geometry {
            x: -149,
            y: 30,
            width: 1386,
            height: 1050,
            scale: 1.0,
        };
        let open = vec![
            positioned(10, 42, 0, -149, 30, 1386, 1050),
            positioned(11, 42, 101, 827, 106, 327, 656),
            positioned(12, 42, 101, 1444, 442, 201, 192),
        ];
        let opened = capture_layout_from_windows(&open, identity).unwrap();
        assert_eq!(opened.geometry, window);
        assert_eq!(
            opened.capture_bounds,
            Geometry {
                x: -149,
                y: 30,
                width: 1794,
                height: 1050,
                scale: 1.0,
            }
        );

        let closed = vec![positioned(10, 42, 0, -149, 30, 1386, 1050)];
        let reopened = capture_layout_from_windows(&closed, identity).unwrap();
        assert_eq!(reopened.geometry, window);
        assert_eq!(reopened.capture_bounds, window);
    }

    #[test]
    fn transient_geometry_ax_errors_do_not_mean_window_closed() {
        assert!(transient_geometry_ax_error(AXError::CannotComplete));
        assert!(transient_geometry_ax_error(AXError::InvalidUIElement));
        assert!(!transient_geometry_ax_error(AXError::AttributeUnsupported));
        assert!(!transient_geometry_ax_error(AXError::Success));
    }

    #[derive(Clone, PartialEq)]
    struct FocusNode {
        id: u32,
        pid: i32,
        parent: Option<u32>,
    }

    fn focus_node(id: u32, pid: i32, parent: Option<u32>) -> FocusNode {
        FocusNode { id, pid, parent }
    }

    #[test]
    fn focused_window_accepts_owned_sheet_and_rejects_unrelated_window() {
        let target = focus_node(10, 42, None);
        let sheet = focus_node(11, 42, Some(10));
        let unrelated = focus_node(12, 42, None);
        let pid = |node: &FocusNode| Some(node.pid);
        let parent = |node: &FocusNode| node.parent.map(|id| focus_node(id, node.pid, None));
        assert!(focused_window_matches(&target, &target, 42, pid, parent));
        assert!(focused_window_matches(&target, &sheet, 42, pid, parent));
        assert!(!focused_window_matches(
            &target, &unrelated, 42, pid, parent
        ));
        let same_id_other_process = focus_node(11, 7, Some(10));
        assert!(!focused_window_matches(
            &target,
            &same_id_other_process,
            42,
            pid,
            parent
        ));
    }

    #[test]
    fn focused_window_bounds_parent_traversal_and_cycles() {
        let target = focus_node(10, 42, None);
        let cycle = focus_node(11, 42, Some(11));
        let too_deep = focus_node(15, 42, Some(14));
        let pid = |node: &FocusNode| Some(node.pid);
        assert!(!focused_window_matches(&target, &cycle, 42, pid, |node| {
            node.parent.map(|id| focus_node(id, node.pid, Some(id)))
        }));
        assert!(!focused_window_matches(
            &target,
            &too_deep,
            42,
            pid,
            |node| match node.id {
                15 => Some(focus_node(14, node.pid, Some(13))),
                14 => Some(focus_node(13, node.pid, Some(12))),
                13 => Some(focus_node(12, node.pid, None)),
                _ => None,
            }
        ));
    }

    #[test]
    fn pointer_accepts_target_window() {
        assert!(pointer_hit_allowed(
            Identity {
                window: 10,
                pid: 42
            },
            &visible(10, 42, 0)
        ));
    }

    #[test]
    fn pointer_accepts_same_process_transient_overlay() {
        assert!(pointer_hit_allowed(
            Identity {
                window: 10,
                pid: 42
            },
            &visible(11, 42, 101)
        ));
    }

    #[test]
    fn pointer_rejects_other_process_overlay() {
        assert!(!pointer_hit_allowed(
            Identity {
                window: 10,
                pid: 42
            },
            &visible(11, 7, 101)
        ));
    }

    #[test]
    fn pointer_rejects_unrelated_same_process_window() {
        assert!(!pointer_hit_allowed(
            Identity {
                window: 10,
                pid: 42
            },
            &visible(11, 42, 0)
        ));
    }

    #[test]
    fn owned_layer_zero_window_accepts_only_covered_nonstandard_ax_window() {
        let target = Identity {
            window: 10,
            pid: 42,
        };
        let hit = positioned(11, 42, 0, -85, 70, 1102, 239);
        let target_geometry = positioned(10, 42, 0, -149, 30, 1386, 1050).geometry;
        assert!(owned_layer_zero_window_matches(
            42,
            &hit,
            42,
            "AXWindow",
            "AXUnknown",
            hit.geometry,
            target_geometry,
        ));
        assert!(owned_layer_zero_window_matches(
            42,
            &hit,
            42,
            "AXWindow",
            "AXDialog",
            hit.geometry,
            target_geometry,
        ));
        assert!(!owned_layer_zero_window_matches(
            42,
            &hit,
            7,
            "AXWindow",
            "AXUnknown",
            hit.geometry,
            target_geometry,
        ));
        assert!(!owned_layer_zero_window_matches(
            42,
            &hit,
            42,
            "AXGroup",
            "AXUnknown",
            hit.geometry,
            target_geometry,
        ));
        assert!(!owned_layer_zero_window_matches(
            42,
            &hit,
            42,
            "AXWindow",
            "AXStandardWindow",
            hit.geometry,
            target_geometry,
        ));
        let outside = positioned(11, 42, 0, 1300, 70, 1102, 239);
        assert!(!owned_layer_zero_window_matches(
            42,
            &outside,
            42,
            "AXWindow",
            "AXUnknown",
            outside.geometry,
            target_geometry,
        ));
        assert!(!owned_layer_zero_window_matches(
            42,
            &hit,
            42,
            "AXWindow",
            "AXUnknown",
            Geometry {
                x: -84,
                y: 70,
                width: 100,
                height: 100,
                scale: 1.0,
            },
            target_geometry,
        ));
        assert!(geometry_contains(target_geometry, hit.geometry));
        assert!(!geometry_contains(target_geometry, outside.geometry));
        assert!(!pointer_hit_allowed(target, &hit));
    }
}
