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
    ptr::NonNull,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const FOCUS_ACTIVATION_TIMEOUT: Duration = Duration::from_millis(600);
const FOCUS_ACTIVATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const WINDOW_BIND_TIMEOUT: Duration = Duration::from_millis(600);
const WINDOW_BIND_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub window: u32,
    pub pid: i32,
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
                let result = match request.operation {
                    Operation::Geometry => native.geometry(),
                    Operation::Focus => native.focus(),
                    Operation::Validate(expected, point) => native.validate(expected, point),
                }
                .map_err(|e| BackendError::from_error(&e));
                let _ = request.reply.send(result);
            }
        });
        wait.recv_timeout(Duration::from_secs(2))??;
        Ok(Self { tx })
    }
    fn call(&self, operation: Operation) -> anyhow::Result<Geometry> {
        let (reply, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Request { operation, reply })
            .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
        Ok(rx
            .recv_timeout(Duration::from_millis(300))
            .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))??)
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
    anyhow::ensure!(identity.pid > 0, BackendError::WindowUnavailable);
    let current = visible_windows()?
        .into_iter()
        .find(|window| window.id == identity.window && window.pid == identity.pid)
        .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    Ok(current.geometry)
}
fn attribute(element: &AXUIElement, key: &str) -> anyhow::Result<CFRetained<AxType>> {
    let mut value: *const AxType = std::ptr::null();
    // Copy API returns a +1 CF value; the maintained retained wrapper owns it.
    let error = unsafe {
        element.copy_attribute_value(&CFString::from_str(key), NonNull::from(&mut value))
    };
    anyhow::ensure!(error == AXError::Success, BackendError::WindowUnavailable);
    let value = NonNull::new(value.cast_mut())
        .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    Ok(unsafe { CFRetained::from_raw(value) })
}
fn ax_geometry(element: &AXUIElement) -> anyhow::Result<Geometry> {
    let position = attribute(element, "AXPosition")?
        .downcast::<AXValue>()
        .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
    let size = attribute(element, "AXSize")?
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
}
impl Native {
    fn bind(identity: Identity, geometry: Geometry) -> anyhow::Result<Self> {
        anyhow::ensure!(identity.pid > 0, BackendError::WindowUnavailable);
        let app = unsafe { AXUIElement::new_application(identity.pid) };
        unsafe {
            app.set_messaging_timeout(0.05);
        }
        let list = attribute(&app, "AXWindows")?
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
        };
        anyhow::ensure!(
            native.geometry()? == geometry,
            BackendError::GeometryChanged
        );
        Ok(native)
    }
    fn geometry(&self) -> anyhow::Result<Geometry> {
        let mut pid = 0;
        anyhow::ensure!(
            unsafe { self.window.pid(NonNull::from(&mut pid)) } == AXError::Success
                && pid == self.identity.pid,
            BackendError::WindowUnavailable
        );
        let minimized = attribute(&self.window, "AXMinimized")?
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
    }
    fn focused(&self) -> anyhow::Result<()> {
        let app = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication();
        let frontmost = app.is_some_and(|a| a.processIdentifier() == self.identity.pid);
        anyhow::ensure!(frontmost, BackendError::WindowFocusRequired);
        let focused = attribute(&self.app, "AXFocusedWindow")?
            .downcast::<AXUIElement>()
            .map_err(|_| anyhow::anyhow!(BackendError::WindowFocusRequired))?;
        anyhow::ensure!(focused == self.window, BackendError::WindowFocusRequired);
        Ok(())
    }
    fn focus(&self) -> anyhow::Result<Geometry> {
        let geometry = self.geometry()?;
        anyhow::ensure!(
            unsafe { self.window.perform_action(&CFString::from_str("AXRaise")) }
                == AXError::Success,
            BackendError::WindowFocusRequired
        );
        let yes = CFBoolean::new(true);
        anyhow::ensure!(
            unsafe {
                self.app
                    .set_attribute_value(&CFString::from_str("AXFrontmost"), yes.as_ref())
            } == AXError::Success,
            BackendError::WindowFocusRequired
        );
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
        self.focused()?;
        if let Some((x, y)) = point {
            let hit = visible_windows()?.into_iter().find(|w| {
                x as i64 >= w.geometry.x as i64
                    && y as i64 >= w.geometry.y as i64
                    && (x as i64) < w.geometry.x as i64 + w.geometry.width as i64
                    && (y as i64) < w.geometry.y as i64 + w.geometry.height as i64
            });
            let matches =
                hit.is_some_and(|w| w.id == self.identity.window && w.pid == self.identity.pid);
            anyhow::ensure!(matches, BackendError::WindowFocusRequired);
        }
        Ok(geometry)
    }
}
struct Visible {
    id: u32,
    pid: i32,
    geometry: Geometry,
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
        if number(unsafe { kCGWindowLayer }) == Some(i64::from(cursor_level)) {
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
            geometry,
        });
        anyhow::ensure!(result.len() <= 4096, BackendError::WindowUnavailable);
    }
    Ok(result)
}
