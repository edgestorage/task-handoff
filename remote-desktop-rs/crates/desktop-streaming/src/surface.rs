//! Lifetime-owned virtual desktop keeper. Viewer teardown never owns this
//! surface; component EOF tears down only the keeper's own process group.
#[cfg(target_os = "linux")]
mod linux {
    use serde::{Deserialize, Serialize};
    use std::{
        io::{BufRead, Read, Write},
        os::unix::{fs::OpenOptionsExt, process::CommandExt},
        path::PathBuf,
        process::{Command, Stdio},
        time::Duration,
    };
    #[derive(Serialize, Deserialize)]
    pub struct Ready {
        pub nonce: String,
        pub display: String,
        pub authority: PathBuf,
        pub cookie: Vec<u8>,
    }
    pub struct Client {
        pub child: tokio::process::Child,
        _lifetime: Option<tokio::process::ChildStdin>,
        pub ready: Ready,
    }
    impl Client {
        pub async fn spawn(binary: &std::path::Path) -> anyhow::Result<Self> {
            let mut child = tokio::process::Command::new(binary)
                .arg("--surface-owner")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?;
            let mut input = child.stdin.take().unwrap();
            let mut output = child.stdout.take().unwrap();
            let nonce = crate::session::secret();
            crate::framing::write(&mut input, &nonce).await?;
            let ready = tokio::time::timeout(
                Duration::from_secs(10),
                crate::framing::read::<Ready>(&mut output),
            )
            .await??
            .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_SURFACE_UNAVAILABLE"))?;
            anyhow::ensure!(
                ready.nonce == nonce,
                "REMOTE_DESKTOP_SURFACE_HANDSHAKE_FAILED"
            );
            Ok(Self {
                child,
                _lifetime: Some(input),
                ready,
            })
        }
        pub fn config(&self) -> crate::platform::linux::Config {
            crate::platform::linux::Config {
                display: self.ready.display.clone(),
                cookie: Some(self.ready.cookie.clone()),
                authority: Some(self.ready.authority.clone()),
                include_cursor: true,
            }
        }
        pub async fn close(mut self) -> anyhow::Result<()> {
            self._lifetime.take();
            tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await??;
            Ok(())
        }
    }
    /// After the owned WM/panel dies, subreaper adoption keeps even setsid()
    /// launcher descendants inside this keeper's ownership boundary. No host
    /// process scan or external process adoption is used.
    fn reap_descendants() {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        let own = std::process::id();
        let end = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            unsafe { while libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) > 0 {} }
            let children = std::fs::read_to_string(format!("/proc/{own}/task/{own}/children"))
                .unwrap_or_default();
            if children.trim().is_empty() {
                break;
            }
            for pid in children
                .split_whitespace()
                .filter_map(|s| s.parse::<i32>().ok())
            {
                // Pin identity before checking parenthood: PID reuse cannot
                // redirect the signal to a process outside this owned tree.
                let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
                if raw < 0 {
                    continue;
                }
                let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
                let owned =
                    std::fs::read_to_string(format!("/proc/{pid}/status")).is_ok_and(|status| {
                        status.lines().any(|line| {
                            line.strip_prefix("PPid:")
                                .is_some_and(|parent| parent.trim() == own.to_string())
                        })
                    });
                if owned {
                    unsafe {
                        libc::syscall(
                            libc::SYS_pidfd_send_signal,
                            fd.as_raw_fd(),
                            libc::SIGKILL,
                            std::ptr::null::<libc::siginfo_t>(),
                            0,
                        );
                    }
                }
            }
            if std::time::Instant::now() >= end {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    struct Group(u32);
    impl Drop for Group {
        fn drop(&mut self) {
            // This pgid is minted by our owned Xvfb child, never discovered/adopted.
            unsafe {
                libc::kill(-(self.0 as i32), libc::SIGTERM);
            }
            std::thread::sleep(Duration::from_millis(250));
            unsafe {
                libc::kill(-(self.0 as i32), libc::SIGKILL);
            }
            reap_descendants();
        }
    }
    fn spawn(command: &mut Command, group: i32) -> std::io::Result<std::process::Child> {
        let owner = std::process::id();
        command.process_group(group);
        // Only async-signal-safe libc calls run between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != owner as i32 {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
        command.spawn()
    }
    #[cfg(test)]
    #[test]
    fn subreaper_collects_detached_launcher_descendants() {
        if let Some(record) = std::env::var_os("TH_G1_REAPER_CHILD") {
            assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) }, 0);
            let mut shell = Command::new("sh");
            shell
                .args([
                    "-c",
                    "setsid sh -c 'sleep 600 & echo $! > \"$1\"; wait' sh \"$1\" & wait",
                    "sh",
                ])
                .arg(&record)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = spawn(&mut shell, 0).unwrap();
            let group = Group(child.id());
            let end = std::time::Instant::now() + Duration::from_secs(2);
            while !std::path::Path::new(&record).exists() {
                assert!(std::time::Instant::now() < end);
                std::thread::sleep(Duration::from_millis(10));
            }
            drop(group);
            let _ = child.wait();
            assert!(std::fs::read_to_string(format!(
                "/proc/{}/task/{}/children",
                std::process::id(),
                std::process::id()
            ))
            .unwrap()
            .trim()
            .is_empty());
        } else {
            // A fresh executable isolates subreaper scope from Cargo's parallel
            // test runner. It can only adopt descendants it launched itself.
            let directory = tempfile::tempdir().unwrap();
            let record = directory.path().join("child");
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "surface::linux::subreaper_collects_detached_launcher_descendants",
                    "--nocapture",
                ])
                .env("TH_G1_REAPER_CHILD", &record)
                .status()
                .unwrap();
            assert!(status.success());
            let pid = std::fs::read_to_string(record).unwrap();
            assert!(!std::path::Path::new(&format!("/proc/{}", pid.trim())).exists());
        }
    }
    pub fn run() -> anyhow::Result<()> {
        let nonce: String = crate::input_guard::read(&mut std::io::stdin().lock())?;
        anyhow::ensure!(nonce.len() == 64, "REMOTE_DESKTOP_SURFACE_HANDSHAKE_FAILED");
        // Linux>=5.3 pidfds are required by this backend's cleanup contract.
        // Fail before spawning a surface when the kernel lacks the mechanism.
        use std::os::fd::{FromRawFd, OwnedFd};
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, std::process::id(), 0) };
        anyhow::ensure!(descriptor >= 0, "REMOTE_DESKTOP_SUPERVISION_UNSUPPORTED");
        drop(unsafe { OwnedFd::from_raw_fd(descriptor as i32) });
        anyhow::ensure!(
            unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) } == 0,
            "REMOTE_DESKTOP_SUPERVISION_UNAVAILABLE"
        );
        let directory = tempfile::Builder::new()
            .prefix("th-desktop-surface-")
            .tempdir()?;
        let authority = directory.path().join("Xauthority");
        let cookie = rand::random::<[u8; 16]>().to_vec();
        let mut auth = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&authority)?;
        // Xauthority has no maintained public writer in x11rb. A single
        // FamilyWild, empty-display MIT-MAGIC-COOKIE-1 record covers this private
        // Unix-only server; the file stays0700/0600 and never enters argv/logs.
        auth.write_all(&u16::MAX.to_be_bytes())?;
        for field in [
            b"".as_slice(),
            b"".as_slice(),
            b"MIT-MAGIC-COOKIE-1".as_slice(),
            cookie.as_slice(),
        ] {
            auth.write_all(&(field.len() as u16).to_be_bytes())?;
            auth.write_all(field)?;
        }
        drop(auth);
        let mut command = Command::new("Xvfb");
        command
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                "1280x720x24",
                "-nolisten",
                "tcp",
                "-noreset",
                "-auth",
            ])
            .arg(&authority)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut xvfb = spawn(&mut command, 0)?;
        let group = Group(xvfb.id());
        let stdout = xvfb.stdout.take().unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line);
            let _ = ready_tx.send(result);
        });
        let line = ready_rx.recv_timeout(Duration::from_secs(3))??;
        let number = line.trim().parse::<u16>()?;
        let display = format!(":{number}");
        let (dead, death) = std::sync::mpsc::channel();
        let monitor = dead.clone();
        std::thread::spawn(move || {
            let _ = xvfb.wait();
            let _ = monitor.send(());
        });
        // Tint2 delegates .desktop parsing/launch to its maintained launcher;
        // jgmenu owns XDG discovery/categories, avoiding a second app registry.
        // All files and launcher processes belong to this surface lifetime.
        let icon = directory.path().join("applications.svg");
        std::fs::write(
            &icon,
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M4 6h16M4 12h16M4 18h16" stroke="#eeeeee" stroke-width="2"/></svg>"##,
        )?;
        let launcher = directory.path().join("applications.desktop");
        std::fs::write(&launcher, format!("[Desktop Entry]\nType=Application\nName=Applications\nExec=jgmenu --simple --at-pointer --csv-cmd=\"jgmenu_run apps\"\nIcon={}\nTerminal=false\n", icon.display()))?;
        let panel = directory.path().join("tint2rc");
        std::fs::write(&panel, format!("panel_items = LTC\npanel_size = 100% 36\npanel_position = bottom center horizontal\npanel_layer = top\npanel_background_id = 0\nlauncher_padding = 6 4 4\nlauncher_icon_size = 24\nlauncher_item_app = {}\ntaskbar_mode = single_desktop\ntask_icon = 1\ntask_text = 1\ntask_font = Sans 12\ntask_font_color = #eeeeee 100\ntime1_format = %H:%M\ntime1_font = Sans 12\nclock_font_color = #eeeeee 100\nclock_padding = 8 4\n", launcher.display()))?;
        // A missing menu dependency fails explicit surface creation; never
        // publish a blank/partially installed desktop as a working backend.
        anyhow::ensure!(
            Command::new("jgmenu")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?
                .success(),
            "REMOTE_DESKTOP_SURFACE_DEPENDENCY_MISSING"
        );
        for app in ["openbox", "tint2"] {
            let mut command = Command::new(app);
            if app == "tint2" {
                command.arg("-c").arg(&panel);
            }
            command
                .env("DISPLAY", &display)
                .env("XAUTHORITY", &authority)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = spawn(&mut command, group.0 as i32)?;
            let monitor = dead.clone();
            std::thread::spawn(move || {
                let _ = child.wait();
                let _ = monitor.send(());
            });
        }
        // Ensure dependencies actually form a working desktop, not a blank frame.
        let capture = crate::platform::linux::Capture::open(&crate::platform::linux::Config {
            display: display.clone(),
            cookie: Some(cookie.clone()),
            authority: Some(authority.clone()),
            include_cursor: true,
        })?;
        drop(capture);
        crate::input_guard::write(
            &mut std::io::stdout().lock(),
            &Ready {
                nonce,
                display,
                authority,
                cookie,
            },
        )?;
        std::thread::spawn(move || {
            let _ = std::io::stdin().read(&mut [0]);
            let _ = dead.send(());
        });
        let _ = death.recv();
        drop(group);
        Ok(())
    }
}
#[cfg(target_os = "linux")]
pub use linux::*;
