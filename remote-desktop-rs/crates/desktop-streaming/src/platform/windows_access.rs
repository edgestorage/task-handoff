//! Native session/desktop authority checks. Never switch desktops, launch into
//! another user's session or infer input access from successful WGC capture.
use crate::error::BackendError;
use std::{ffi::c_void, ptr};
use windows_sys::Win32::{
    System::{RemoteDesktop::*, StationsAndDesktops::*, Threading::GetCurrentThreadId},
    UI::HiDpi::*,
};

/// Called before native enumeration/injection, in each independent process.
/// Process-wide awareness keeps WGC rectangles and SendInput in physical pixels;
/// an embedding host with a conflicting manifest must fail explicitly.
pub fn prepare_dpi() -> anyhow::Result<()> {
    unsafe {
        let expected = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2;
        if AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), expected) == 0 {
            anyhow::ensure!(
                SetProcessDpiAwarenessContext(expected) != 0,
                BackendError::DpiUnavailable
            );
        }
    }
    Ok(())
}

struct Desktop(HDESK);
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                CloseDesktop(self.0);
            }
        }
    }
}
struct WtsBuffer(*mut u16);
impl Drop for WtsBuffer {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                WTSFreeMemory(self.0.cast());
            }
        }
    }
}
fn name(handle: HDESK) -> anyhow::Result<Vec<u16>> {
    // Desktop names are OS identifiers, never returned or logged. Bounded UTF-16
    // storage avoids treating a truncated/failed query as matching authority.
    let mut buffer = [0u16; 256];
    let mut bytes = 0;
    let ok = unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            buffer.as_mut_ptr().cast::<c_void>(),
            std::mem::size_of_val(&buffer) as u32,
            &mut bytes,
        )
    };
    anyhow::ensure!(
        ok != 0 && bytes >= 2 && bytes as usize <= std::mem::size_of_val(&buffer) && bytes % 2 == 0,
        BackendError::DesktopUnavailable
    );
    let count = bytes as usize / 2;
    anyhow::ensure!(buffer[count - 1] == 0, BackendError::DesktopUnavailable);
    Ok(buffer[..count - 1].to_vec())
}
/// Recheck at each native frame/input boundary. These are OS adapter permission
/// checks, not UI/business polling. Never cache success across lock/RDP changes.
pub fn check() -> anyhow::Result<()> {
    unsafe {
        let mut session = 0;
        anyhow::ensure!(
            ProcessIdToSessionId(std::process::id(), &mut session) != 0 && session != 0,
            BackendError::NoInteractiveSession
        );
        let mut buffer = ptr::null_mut();
        let mut bytes = 0;
        let ok = WTSQuerySessionInformationW(
            ptr::null_mut(),
            session,
            WTSConnectState,
            &mut buffer,
            &mut bytes,
        );
        let buffer = WtsBuffer(buffer);
        anyhow::ensure!(
            ok != 0
                && !buffer.0.is_null()
                && bytes as usize >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>(),
            BackendError::NoInteractiveSession
        );
        let state = ptr::read_unaligned(buffer.0.cast::<WTS_CONNECTSTATE_CLASS>());
        anyhow::ensure!(state == WTSActive, BackendError::NoInteractiveSession);
        let input = Desktop(OpenInputDesktop(0, 0, DESKTOP_READOBJECTS));
        anyhow::ensure!(!input.0.is_null(), BackendError::DesktopUnavailable);
        let current = GetThreadDesktop(GetCurrentThreadId());
        anyhow::ensure!(
            !current.is_null() && name(current)? == name(input.0)?,
            BackendError::DesktopUnavailable
        );
    }
    Ok(())
}
