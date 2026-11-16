use controlled_instance_core::local_ipc::{self, LocalIpcEndpoint};
use desktop_streaming::{
    contract::{Hello, IPC_VERSION},
    framing,
};
#[cfg(any(unix, windows))]
use std::fs::OpenOptions;
use std::io::Read;
use std::{path::PathBuf, time::Duration};
use subtle::ConstantTimeEq;

#[cfg(unix)]
unsafe extern "C" {
    fn dup2(oldfd: i32, newfd: i32) -> i32;
}

#[cfg(unix)]
fn redirect_stderr_to_instance_log() {
    use std::os::fd::AsRawFd;

    let Some(log_dir) = std::env::var_os("TASK_HANDOFF_LOG_DIR") else {
        return;
    };
    let path = PathBuf::from(log_dir).join("controlled-instance.err.log");
    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    // Safety: dup2 replaces the process stderr descriptor. The input guard is
    // spawned later and inherits the same append-only instance log.
    unsafe {
        dup2(file.as_raw_fd(), 2);
    }
}

#[cfg(windows)]
fn redirect_stderr_to_instance_log() {
    use std::os::windows::io::AsRawHandle;

    const STD_ERROR_HANDLE: u32 = (-12i32) as u32;
    const HANDLE_FLAG_INHERIT: u32 = 1;

    unsafe extern "system" {
        fn SetStdHandle(std_handle: u32, handle: *mut core::ffi::c_void) -> i32;
        fn SetHandleInformation(object: *mut core::ffi::c_void, mask: u32, flags: u32) -> i32;
    }

    let Some(log_dir) = std::env::var_os("TASK_HANDOFF_LOG_DIR") else {
        return;
    };
    let path = PathBuf::from(log_dir).join("controlled-instance.err.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let handle = file.as_raw_handle().cast::<core::ffi::c_void>();
    // Safety: the append-only handle is intentionally leaked for the process
    // lifetime and marked inheritable so the input guard writes to the same
    // instance log. SetStdHandle runs before the first stderr access.
    unsafe {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetStdHandle(STD_ERROR_HANDLE, handle);
    }
    std::mem::forget(file);
}

#[cfg(not(any(unix, windows)))]
fn redirect_stderr_to_instance_log() {}

fn main() -> anyhow::Result<()> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--version")) {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected version argument"
        );
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    redirect_stderr_to_instance_log();
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--request-input-permission"))
    {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected permission argument"
        );
        // Explicit operator action, with no native key or pointer events. Normal
        // guard initialization keeps the maintained library's prompt disabled.
        let allowed = enigo::Enigo::new(&enigo::Settings {
            open_prompt_to_get_permissions: true,
            ..Default::default()
        })
        .is_ok();
        println!("{}", serde_json::json!({"inputAllowed":allowed}));
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--check-native-permissions"))
    {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected permission argument"
        );
        let screen_capture = core_graphics::access::ScreenCaptureAccess.preflight();
        let input = enigo::Enigo::new(&enigo::Settings {
            open_prompt_to_get_permissions: false,
            ..Default::default()
        })
        .is_ok();
        println!(
            "{}",
            serde_json::json!({"screenCaptureAllowed":screen_capture,"inputAllowed":input})
        );
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--request-screen-permission"))
    {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected permission argument"
        );
        // Explicit diagnostic action only: normal capability checks and attach
        // never trigger a TCC prompt or alter the user's permission settings.
        let allowed = core_graphics::access::ScreenCaptureAccess.request();
        println!("{}", serde_json::json!({"screenCaptureAllowed":allowed}));
        return Ok(());
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--clipboard-worker")) {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected clipboard argument"
        );
        return desktop_streaming::clipboard::run();
    }
    #[cfg(target_os = "linux")]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--surface-owner")) {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected surface argument"
        );
        return desktop_streaming::surface::run();
    }

    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--input-guard")) {
        anyhow::ensure!(
            std::env::args_os().count() == 2,
            "unexpected guard argument"
        );
        return desktop_streaming::input_guard::run();
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(component())
}
async fn component() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mut first = args.next();
    if first.as_deref() == Some(std::ffi::OsStr::new("--input-guard")) {
        anyhow::ensure!(args.next().is_none(), "unexpected guard argument");
        return desktop_streaming::input_guard::run();
    }
    let mode = match first.as_deref().and_then(|s| s.to_str()) {
        Some("--synthetic") => desktop_streaming::capture::Mode::Synthetic,
        Some("--native") => desktop_streaming::capture::Mode::Local,
        Some("--virtual") => desktop_streaming::capture::Mode::Virtual,
        _ => desktop_streaming::capture::Mode::Control,
    };
    if mode != desktop_streaming::capture::Mode::Control {
        first = args.next();
    }
    anyhow::ensure!(
        first.as_deref() == Some(std::ffi::OsStr::new("--ipc")),
        "expected --ipc"
    );
    let path = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("missing IPC endpoint"))?,
    );
    let mut show_cursor = true;
    let mut state_dir = None;
    while let Some(argument) = args.next() {
        match argument.to_str() {
            Some("--system-cursor") if show_cursor => show_cursor = false,
            Some("--state-dir") if state_dir.is_none() => {
                state_dir = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("missing state directory"))?,
                ));
            }
            _ => anyhow::bail!("unexpected argument"),
        }
    }
    // Keep compatibility with hosts older than the explicit `--state-dir`
    // argument. Environment names are ignored by old components, so a newer
    // host can pass the directory without breaking a rolling component update.
    let state_dir = state_dir
        .or_else(|| std::env::var_os("TASK_HANDOFF_DESKTOP_STATE_DIR").map(PathBuf::from))
        .or_else(|| std::env::var_os("TASK_HANDOFF_DATA_DIR").map(PathBuf::from));
    let source_salt = state_dir
        .as_deref()
        .map(desktop_streaming::catalog::load_or_create_source_salt)
        .transpose()?;
    // Tokio stdin uses a blocking runtime worker that can keep runtime shutdown
    // waiting forever. A detached OS thread owns the inherited pipe instead;
    // normal component exit never waits for a still-live host to close stdin.
    let (bootstrap_tx, bootstrap_rx) = tokio::sync::oneshot::channel();
    let (death_tx, death_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut input = std::io::stdin();
        let bootstrap = (|| -> anyhow::Result<Hello> {
            let mut header = [0; 4];
            input.read_exact(&mut header)?;
            let length = u32::from_be_bytes(header) as usize;
            anyhow::ensure!(
                length > 0 && length <= desktop_streaming::contract::MAX_IPC_FRAME,
                "invalid bootstrap frame"
            );
            let mut bytes = vec![0; length];
            input.read_exact(&mut bytes)?;
            serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid bootstrap JSON"))
        })();
        if bootstrap_tx.send(bootstrap).is_err() {
            return;
        }
        let mut byte = [0];
        let _ = input.read(&mut byte);
        let _ = death_tx.send(());
    });
    let bootstrap = tokio::time::timeout(Duration::from_secs(5), bootstrap_rx).await???;
    anyhow::ensure!(
        bootstrap.protocol_version == IPC_VERSION && bootstrap.nonce.len() == 64,
        "invalid bootstrap"
    );
    let endpoint = LocalIpcEndpoint::explicit(path)?;
    let mut stream = local_ipc::connect(&endpoint).await?;
    framing::write(&mut stream, &bootstrap).await?;
    let host: Hello = tokio::time::timeout(Duration::from_secs(5), framing::read(&mut stream))
        .await??
        .ok_or_else(|| anyhow::anyhow!("host disconnected"))?;
    anyhow::ensure!(
        host.protocol_version == IPC_VERSION
            && bool::from(host.nonce.as_bytes().ct_eq(bootstrap.nonce.as_bytes())),
        "host authentication failed"
    );
    tokio::select! {
        result = desktop_streaming::service::serve_mode_with_cursor_and_source_salt(stream,mode,show_cursor,source_salt) => result,
        _ = death_rx => Ok(()),
    }
}
