//! Process ownership for the standalone host and disposable native workers.
//! Job handles are unnamed and non-inheritable. Assign children BEFORE sending
//! their bootstrap: an unassigned child cannot start capture or native input.
//! The input guard explicitly breaks away so job teardown cannot kill it before
//! it releases pressed keys on pipe EOF. Never weaken assignment failures.
use crate::error::BackendError;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::System::JobObjects::*;

pub struct Job(OwnedHandle);
impl Job {
    pub fn new(allow_guard_breakaway: bool) -> anyhow::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        anyhow::ensure!(!handle.is_null(), BackendError::ProcessOwnershipUnavailable);
        // CreateJobObjectW with no SECURITY_ATTRIBUTES creates a non-inherited
        // handle. OwnedHandle is its sole owner, including initialization errors.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | if allow_guard_breakaway {
                JOB_OBJECT_LIMIT_BREAKAWAY_OK
            } else {
                0
            };
        anyhow::ensure!(
            unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } != 0,
            BackendError::ProcessOwnershipUnavailable
        );
        Ok(job)
    }

    pub async fn assign(&self, child: &mut tokio::process::Child) -> anyhow::Result<()> {
        let assigned = child.raw_handle().is_some_and(|handle| unsafe {
            AssignProcessToJobObject(self.0.as_raw_handle(), handle) != 0
        });
        if !assigned {
            // No bootstrap has been sent, so this process owns no native input.
            // Reap it now rather than relying on async Child drop or host EOF.
            let _ = child.kill().await;
            anyhow::bail!(BackendError::ProcessOwnershipUnavailable);
        }
        Ok(())
    }
}
