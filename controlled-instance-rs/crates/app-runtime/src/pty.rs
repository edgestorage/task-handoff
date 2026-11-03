use std::time::Duration;

use tokio::process::Child;

pub const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(5);
pub const PROCESS_KILL_TIMEOUT: Duration = Duration::from_secs(1);

pub struct PtySpawn {
    pub child: Child,
    pub reader: std::fs::File,
    pub handle: PtyHandle,
    pub pid: u32,
}

#[cfg(unix)]
mod unix {
    use std::{collections::BTreeMap, path::Path, process::Stdio, sync::Arc};

    use tokio::process::Command;

    use super::{PtySpawn, PROCESS_KILL_TIMEOUT, PROCESS_STOP_TIMEOUT};
    use crate::AppRuntimeError;

    #[derive(Clone)]
    pub struct PtyHandle {
        master: Arc<std::fs::File>,
        writer: Arc<std::fs::File>,
        pid: u32,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }

    impl PtyHandle {
        fn new(master: std::fs::File, writer: std::fs::File, pid: u32) -> Self {
            Self {
                master: Arc::new(master),
                writer: Arc::new(writer),
                pid,
                closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }

        pub fn write(&self, data: &[u8]) -> Result<(), AppRuntimeError> {
            use std::io::Write;
            let mut writer = &*self.writer;
            writer
                .write_all(data)
                .map_err(|error| AppRuntimeError::spawn(error.to_string()))
        }

        pub fn resize(&self, cols: u16, rows: u16) -> Result<(), AppRuntimeError> {
            resize_pty(&self.master, cols, rows)
        }

        pub fn stop(&self) {
            if self.closed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            request_stop_process_group(self.pid);
        }

        pub fn is_closed(&self) -> bool {
            self.closed.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    pub fn spawn_pty(
        command: &str,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> Result<PtySpawn, AppRuntimeError> {
        use std::{
            fs::File,
            os::fd::{AsRawFd, FromRawFd},
        };

        let mut master_fd = -1;
        let mut slave_fd = -1;
        let mut winsize = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut winsize,
            )
        };
        if result != 0 {
            return Err(AppRuntimeError::spawn(format!(
                "openpty failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let master = unsafe { File::from_raw_fd(master_fd) };
        let slave = unsafe { File::from_raw_fd(slave_fd) };
        let stdin = slave
            .try_clone()
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
        let stdout = slave
            .try_clone()
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
        let stderr = slave
            .try_clone()
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
        let slave_fd_for_child = slave.as_raw_fd();

        let mut process = Command::new(command);
        process
            .args(args)
            .current_dir(cwd)
            .envs(env)
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .kill_on_drop(true);
        unsafe {
            process.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(slave_fd_for_child, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = process.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppRuntimeError::missing_command(command.to_string())
            } else {
                AppRuntimeError::spawn(error.to_string())
            }
        })?;
        drop(slave);
        let pid = child
            .id()
            .ok_or_else(|| AppRuntimeError::spawn("PTY child has no pid"))?;
        let reader = master
            .try_clone()
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
        let writer = master
            .try_clone()
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
        let handle = PtyHandle::new(master, writer, pid);
        Ok(PtySpawn {
            child,
            reader,
            handle,
            pid,
        })
    }

    pub fn resize_pty(master: &std::fs::File, cols: u16, rows: u16) -> Result<(), AppRuntimeError> {
        use std::os::fd::AsRawFd;
        let winsize = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &winsize) };
        if result == 0 {
            Ok(())
        } else {
            Err(AppRuntimeError::spawn(format!(
                "PTY resize failed: {}",
                std::io::Error::last_os_error()
            )))
        }
    }

    pub fn terminate_process_group(pid: u32) -> Vec<u32> {
        terminate_process_groups(&[pid])
    }

    pub fn process_group_exists(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let result = unsafe { libc::kill(-(pid as libc::pid_t), 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    pub fn terminate_process_groups(pids: &[u32]) -> Vec<u32> {
        terminate_process_groups_with_timeouts(pids, PROCESS_STOP_TIMEOUT, PROCESS_KILL_TIMEOUT)
    }

    pub fn request_stop_process_group(pid: u32) {
        if pid == 0 {
            return;
        }
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
        }
    }

    pub fn request_stop_process_groups(pids: &[u32]) {
        for pid in pids {
            request_stop_process_group(*pid);
        }
    }

    pub fn wait_process_groups(pids: &[u32], timeout: std::time::Duration) -> Vec<u32> {
        wait_for_process_groups(pids, timeout)
    }

    pub fn kill_process_groups(pids: &[u32]) {
        for pid in pids {
            if *pid == 0 {
                continue;
            }
            unsafe {
                libc::kill(-(*pid as libc::pid_t), libc::SIGKILL);
            }
        }
    }

    fn terminate_process_groups_with_timeouts(
        pids: &[u32],
        stop_timeout: std::time::Duration,
        kill_timeout: std::time::Duration,
    ) -> Vec<u32> {
        let pids = pids
            .iter()
            .copied()
            .filter(|pid| *pid > 0)
            .collect::<Vec<_>>();
        if pids.is_empty() {
            return Vec::new();
        }
        for pid in &pids {
            unsafe {
                libc::kill(-(*pid as libc::pid_t), libc::SIGTERM);
            }
        }
        let mut remaining = wait_for_process_groups(&pids, stop_timeout);
        if remaining.is_empty() {
            return remaining;
        }
        for pid in &remaining {
            unsafe {
                libc::kill(-(*pid as libc::pid_t), libc::SIGKILL);
            }
        }
        remaining = wait_for_process_groups(&remaining, kill_timeout);
        remaining
    }

    fn wait_for_process_groups(pids: &[u32], timeout: std::time::Duration) -> Vec<u32> {
        let deadline = std::time::Instant::now() + timeout;
        let mut remaining = pids
            .iter()
            .copied()
            .filter(|pid| process_group_exists(*pid))
            .collect::<Vec<_>>();
        while !remaining.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
            remaining.retain(|pid| process_group_exists(*pid));
        }
        remaining
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            os::unix::process::CommandExt,
            process::Stdio,
            time::{Duration, Instant},
        };

        #[test]
        fn production_process_timeouts_match_the_node_contract() {
            assert_eq!(PROCESS_STOP_TIMEOUT, Duration::from_secs(5));
            assert_eq!(PROCESS_KILL_TIMEOUT, Duration::from_secs(1));
        }

        #[test]
        fn termination_escalates_after_the_grace_period() {
            let root = tempfile::tempdir().expect("tempdir");
            let ready = root.path().join("ready");
            let mut command = std::process::Command::new("sh");
            command
                .args([
                    "-c",
                    "trap '' TERM; : > \"$PTY_READY\"; while :; do sleep 1; done",
                ])
                .env("PTY_READY", &ready)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            let mut child = command.spawn().expect("spawn signal-ignoring child");
            let pid = child.id();
            let waiter = std::thread::spawn(move || child.wait());

            let start_deadline = Instant::now() + Duration::from_secs(1);
            while !process_group_exists(pid) && Instant::now() < start_deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                process_group_exists(pid),
                "child process group did not start"
            );
            while !ready.exists() && Instant::now() < start_deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(ready.exists(), "child did not install its signal handler");

            let started = Instant::now();
            let remaining = terminate_process_groups_with_timeouts(
                &[pid],
                Duration::from_millis(80),
                Duration::from_secs(1),
            );
            let elapsed = started.elapsed();
            waiter.join().expect("wait thread").expect("child status");

            assert!(
                remaining.is_empty(),
                "remaining process groups: {remaining:?}"
            );
            assert!(elapsed >= Duration::from_millis(60), "elapsed: {elapsed:?}");
            assert!(elapsed < Duration::from_secs(3), "elapsed: {elapsed:?}");
            assert!(!process_group_exists(pid));
        }
    }
}

#[cfg(windows)]
#[path = "pty_windows.rs"]
mod windows;

#[cfg(unix)]
pub use unix::{
    kill_process_groups, process_group_exists, request_stop_process_groups, resize_pty, spawn_pty,
    terminate_process_group, terminate_process_groups, wait_process_groups, PtyHandle,
};

#[cfg(windows)]
pub use windows::{
    kill_process_groups, process_group_exists, request_stop_process_groups, resize_pty, spawn_pty,
    terminate_process_group, terminate_process_groups, wait_process_groups, PtyHandle,
};
