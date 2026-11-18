//! Lifetime-owned virtual desktop keeper. Viewer teardown never owns this
//! surface; component EOF tears down only the keeper's own process group.
#[cfg(target_os = "linux")]
mod linux {
    use crate::linux_desktop::{self, DesktopAction, DisplayOwnership, SessionLaunch};
    use serde::{Deserialize, Serialize};
    use std::{
        io::{BufRead, Read, Write},
        os::unix::{fs::OpenOptionsExt, process::CommandExt},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    #[derive(Serialize, Deserialize)]
    pub struct Ready {
        pub nonce: String,
        pub display: String,
        #[serde(default)]
        pub authority: Option<PathBuf>,
        #[serde(default)]
        pub cookie: Option<Vec<u8>>,
    }
    pub struct Client {
        pub child: tokio::process::Child,
        _lifetime: Option<tokio::process::ChildStdin>,
        pub ready: Ready,
    }
    impl Client {
        pub async fn spawn(binary: &std::path::Path) -> anyhow::Result<Self> {
            Self::spawn_with(binary, |_| {}).await
        }
        pub async fn spawn_private(binary: &std::path::Path) -> anyhow::Result<Self> {
            Self::spawn_with(binary, |command| {
                command
                    .env_remove("DISPLAY")
                    .env_remove("XAUTHORITY")
                    .env_remove("XDG_SESSION_TYPE");
            })
            .await
        }
        pub async fn spawn_attached(
            binary: &std::path::Path,
            display: &std::ffi::OsStr,
        ) -> anyhow::Result<Self> {
            Self::spawn_with(binary, |command| {
                command
                    .env("DISPLAY", display)
                    .env_remove("XAUTHORITY")
                    .env_remove("XDG_SESSION_TYPE");
            })
            .await
        }
        async fn spawn_with(
            binary: &std::path::Path,
            configure: impl FnOnce(&mut tokio::process::Command),
        ) -> anyhow::Result<Self> {
            let mut command = tokio::process::Command::new(binary);
            command
                .arg("--surface-owner")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            configure(&mut command);
            let mut child = command.spawn()?;
            let mut input = child.stdin.take().unwrap();
            let mut output = child.stdout.take().unwrap();
            let nonce = crate::session::secret();
            crate::framing::write(&mut input, &nonce).await?;
            let ready = tokio::time::timeout(
                Duration::from_secs(40),
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
                cookie: self.ready.cookie.clone(),
                authority: self.ready.authority.clone(),
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
            // This pgid is minted by a process created here, never discovered or
            // adopted from an attached display.
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
    fn spawn_desktop(command: &mut Command, group: i32) -> anyhow::Result<std::process::Child> {
        spawn(command, group)
            .map_err(|_| anyhow::anyhow!(crate::error::BackendError::DesktopUnavailable))
    }
    fn monitor_primary(mut child: std::process::Child, dead: std::sync::mpsc::Sender<()>) {
        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = dead.send(());
        });
    }
    fn reap_auxiliary(mut child: std::process::Child) {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    fn owned_authority(directory: &Path) -> anyhow::Result<(PathBuf, Vec<u8>)> {
        let authority = directory.join("Xauthority");
        let cookie = rand::random::<[u8; 16]>().to_vec();
        let mut auth = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&authority)?;
        // Xauthority has no maintained public writer in x11rb. A single
        // FamilyWild, empty-display MIT-MAGIC-COOKIE-1 record covers this private
        // Unix-only server; the file stays 0700/0600 and never enters argv/logs.
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
        Ok((authority, cookie))
    }
    fn spawn_xvfb(
        directory: &Path,
        dead: &std::sync::mpsc::Sender<()>,
    ) -> anyhow::Result<(crate::platform::linux::Config, Group)> {
        let (authority, cookie) = owned_authority(directory)?;
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
        monitor_primary(xvfb, dead.clone());
        Ok((
            crate::platform::linux::Config {
                display: format!(":{number}"),
                cookie: Some(cookie),
                authority: Some(authority),
                include_cursor: true,
            },
            group,
        ))
    }
    fn configure_session(
        command: &mut Command,
        config: &crate::platform::linux::Config,
        id: &str,
        current_desktop: &str,
    ) {
        command
            .env("DISPLAY", &config.display)
            .env("XDG_SESSION_TYPE", "x11")
            .env("XDG_SESSION_DESKTOP", id)
            .env("DESKTOP_SESSION", id)
            .env("XDG_CURRENT_DESKTOP", current_desktop);
        if let Some(authority) = &config.authority {
            command.env("XAUTHORITY", authority);
        }
    }
    struct StartedDesktop {
        owned_group: Option<Group>,
    }
    fn start_desktop(
        directory: &Path,
        config: &crate::platform::linux::Config,
        launch: &SessionLaunch,
        group: i32,
        dead: &std::sync::mpsc::Sender<()>,
    ) -> anyhow::Result<StartedDesktop> {
        match launch {
            SessionLaunch::Standard {
                id,
                name,
                desktop_names,
                command,
            } => {
                let current_desktop = if desktop_names.is_empty() {
                    name.clone()
                } else {
                    desktop_names.join(":")
                };
                let mut session = Command::new("dbus-run-session");
                session
                    .arg("--")
                    .arg(&command[0])
                    .args(&command[1..])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                configure_session(&mut session, config, id, &current_desktop);
                let child = spawn_desktop(&mut session, group)?;
                let pgid = if group == 0 { child.id() } else { group as u32 };
                let owned_group = (group == 0).then(|| Group(pgid));
                monitor_primary(child, dead.clone());
                Ok(StartedDesktop { owned_group })
            }
            SessionLaunch::Fallback => {
                let icon = directory.join("applications.svg");
                std::fs::write(
                    &icon,
                    r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M4 6h16M4 12h16M4 18h16" stroke="#eeeeee" stroke-width="2"/></svg>"##,
                )?;
                let launcher = directory.join("applications.desktop");
                std::fs::write(&launcher, format!("[Desktop Entry]\nType=Application\nName=Applications\nExec=jgmenu --simple --at-pointer --csv-cmd=\"jgmenu_run apps\"\nIcon={}\nTerminal=false\n", icon.display()))?;
                let panel = directory.join("tint2rc");
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
                    crate::error::BackendError::DesktopUnavailable
                );
                let mut openbox = Command::new("openbox");
                openbox
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                configure_session(&mut openbox, config, "openbox", "Openbox");
                let child = spawn_desktop(&mut openbox, group)?;
                let pgid = if group == 0 { child.id() } else { group as u32 };
                let owned_group = (group == 0).then(|| Group(pgid));
                monitor_primary(child, dead.clone());
                let mut tint2 = Command::new("tint2");
                tint2
                    .arg("-c")
                    .arg(&panel)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                configure_session(&mut tint2, config, "openbox", "Openbox");
                reap_auxiliary(spawn_desktop(&mut tint2, pgid as i32)?);
                Ok(StartedDesktop { owned_group })
            }
        }
    }
    fn wait_for_display(config: &crate::platform::linux::Config) -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if crate::platform::linux::probe(config).is_ok() {
                return Ok(());
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                crate::error::BackendError::DesktopUnavailable
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    fn wait_for_window_manager(
        config: &crate::platform::linux::Config,
        death: &std::sync::mpsc::Receiver<()>,
    ) -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match death.try_recv() {
                Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    anyhow::bail!(crate::error::BackendError::DesktopUnavailable)
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
            if crate::platform::linux::probe(config).is_ok_and(|probe| probe.has_window_manager) {
                return Ok(());
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                crate::error::BackendError::DesktopUnavailable
            );
            std::thread::sleep(Duration::from_millis(100));
        }
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
        let plan = linux_desktop::resolve()?;
        let (dead, death) = std::sync::mpsc::channel();
        let (mut config, owned_xvfb) = match plan.ownership {
            DisplayOwnership::Owned => {
                let (config, group) = spawn_xvfb(directory.path(), &dead)?;
                (config, Some(group))
            }
            DisplayOwnership::Attached => (plan.config, None),
        };
        wait_for_display(&config)?;
        let owned_desktop = match &plan.action {
            DesktopAction::Reuse => None,
            DesktopAction::Launch(launch) => {
                wait_for_display(&config)?;
                let group = owned_xvfb.as_ref().map_or(0, |group| group.0 as i32);
                start_desktop(directory.path(), &config, launch, group, &dead)?.owned_group
            }
        };
        if matches!(plan.action, DesktopAction::Launch(_)) {
            // The process death monitor above feeds this same receiver. A
            // session that exits before publishing an EWMH window manager is a
            // failed surface, not a ready blank display.
            wait_for_window_manager(&config, &death)?;
        }
        // Ensure dependencies actually form a working desktop, not a blank frame.
        let capture = crate::platform::linux::Capture::open(&config)?;
        drop(capture);
        config.include_cursor = true;
        crate::input_guard::write(
            &mut std::io::stdout().lock(),
            &Ready {
                nonce,
                display: config.display,
                authority: config.authority,
                cookie: config.cookie,
            },
        )?;
        std::thread::spawn(move || {
            let _ = std::io::stdin().read(&mut [0]);
            let _ = dead.send(());
        });
        let _ = death.recv();
        drop(owned_desktop);
        drop(owned_xvfb);
        Ok(())
    }
}
#[cfg(target_os = "linux")]
pub use linux::*;
