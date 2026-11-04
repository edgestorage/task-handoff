use axum::extract::ws::{Message, WebSocket};
use controlled_instance_app_runtime::{
    command_invocation::{command_invocation, CommandInvocationOptions},
    executable_resolver::ExecutableResolverOptions,
    process_group_exists, spawn_pty, terminate_process_group, PtyHandle,
};
use controlled_instance_protocol::{
    decode_instance_shell_binary_frame, encode_instance_shell_binary_frame,
    encode_instance_shell_error_frame, encode_instance_shell_exit_frame,
    encode_instance_shell_started_frame, parse_instance_shell_client_control_frame,
    InstanceShellCapabilities, InstanceShellClientControlFrame, InstanceShellDataChannel,
    InstanceShellDataDirection, InstanceShellMode, InstanceShellSignal,
    INSTANCE_SHELL_ACTIVITY_LIMIT, INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES,
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{broadcast, mpsc},
};

#[derive(Debug, Clone)]
struct ShellShutdown {
    code: u16,
    reason: String,
}

#[derive(Clone)]
enum ProcessControl {
    Pty(PtyHandle),
    Exec(u32),
}

struct ActivityGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub struct InstanceShellRuntime {
    workspace: PathBuf,
    app_runtime: Option<Arc<controlled_instance_app_runtime::AppRuntime>>,
    max_activities: usize,
    active: Arc<AtomicUsize>,
    processes: Arc<Mutex<BTreeMap<u32, ProcessControl>>>,
    shutdown: broadcast::Sender<ShellShutdown>,
}

struct ShellOutbound {
    sender: Option<mpsc::UnboundedSender<(Message, usize)>>,
    pending: Arc<AtomicUsize>,
    writer: Option<tokio::task::JoinHandle<()>>,
}

impl ShellOutbound {
    fn new(mut sink: futures_util::stream::SplitSink<WebSocket, Message>) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<(Message, usize)>();
        let pending = Arc::new(AtomicUsize::new(0));
        let writer_pending = pending.clone();
        let writer = tokio::spawn(async move {
            while let Some((message, bytes)) = receiver.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
                writer_pending.fetch_sub(bytes, Ordering::SeqCst);
            }
        });
        Self {
            sender: Some(sender),
            pending,
            writer: Some(writer),
        }
    }

    fn enqueue(&self, message: Message, bytes: usize) -> bool {
        let Some(sender) = self.sender.as_ref() else {
            return false;
        };
        let current = self.pending.load(Ordering::SeqCst);
        if current.saturating_add(bytes) > INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES {
            return false;
        }
        self.pending.fetch_add(bytes, Ordering::SeqCst);
        if sender.send((message, bytes)).is_err() {
            self.pending.fetch_sub(bytes, Ordering::SeqCst);
            return false;
        }
        true
    }

    fn text(&self, text: String) -> bool {
        let bytes = text.len();
        self.enqueue(Message::Text(text.into()), bytes)
    }

    fn binary(&self, bytes: Vec<u8>) -> bool {
        let len = bytes.len();
        self.enqueue(Message::Binary(bytes.into()), len)
    }

    fn close(&self, code: u16, reason: &str) -> bool {
        let Some(sender) = self.sender.as_ref() else {
            return false;
        };
        let frame = Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.chars().take(123).collect::<String>().into(),
        }));
        // Close frames must not be dropped just because the data backlog is at
        // its limit; otherwise a backpressure close becomes a silent socket
        // teardown.
        self.pending.fetch_add(2, Ordering::SeqCst);
        if sender.send((frame, 2)).is_err() {
            self.pending.fetch_sub(2, Ordering::SeqCst);
            return false;
        }
        true
    }

    async fn finish(mut self) {
        drop(self.sender.take());
        if let Some(writer) = self.writer.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), writer).await;
        }
    }
}

impl InstanceShellRuntime {
    pub fn new(workspace: PathBuf) -> Self {
        Self::with_max_activities(workspace, INSTANCE_SHELL_ACTIVITY_LIMIT)
    }

    pub fn with_max_activities(workspace: PathBuf, max_activities: usize) -> Self {
        let (shutdown, _) = broadcast::channel(8);
        Self {
            workspace,
            app_runtime: None,
            max_activities: max_activities.max(1),
            active: Arc::new(AtomicUsize::new(0)),
            processes: Arc::new(Mutex::new(BTreeMap::new())),
            shutdown,
        }
    }

    pub fn with_app_runtime(
        mut self,
        runtime: Arc<controlled_instance_app_runtime::AppRuntime>,
    ) -> Self {
        self.app_runtime = Some(runtime);
        self
    }

    pub fn capabilities(&self) -> InstanceShellCapabilities {
        InstanceShellCapabilities::supported()
    }

    pub fn active_count(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    pub async fn shutdown(&self, code: u16, reason: &str) {
        let _ = self.shutdown.send(ShellShutdown {
            code,
            reason: reason.chars().take(123).collect(),
        });
        let controls = {
            let processes = self
                .processes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            processes.values().cloned().collect::<Vec<_>>()
        };
        if controls.is_empty() {
            return;
        }
        let _ = tokio::task::spawn_blocking(move || {
            let mut exec_pids = Vec::new();
            for control in controls {
                match control {
                    ProcessControl::Pty(handle) => handle.stop(),
                    ProcessControl::Exec(pid) => exec_pids.push(pid),
                }
            }
            if !exec_pids.is_empty() {
                controlled_instance_app_runtime::terminate_process_groups(&exec_pids);
            }
        })
        .await;
    }

    fn begin_activity(&self) -> Option<ActivityGuard> {
        if self.active.load(Ordering::SeqCst) >= self.max_activities {
            return None;
        }
        self.active.fetch_add(1, Ordering::SeqCst);
        Some(ActivityGuard {
            active: self.active.clone(),
        })
    }

    fn register_process(&self, pid: u32, control: ProcessControl) {
        self.processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(pid, control);
    }

    fn forget_process(&self, pid: u32) {
        self.processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&pid);
    }

    async fn stop_process(&self, pid: u32, pty: Option<&PtyHandle>) {
        self.forget_process(pid);
        let mut controls = vec![match pty {
            Some(handle) => ProcessControl::Pty(handle.clone()),
            None => ProcessControl::Exec(pid),
        }];
        if pty.is_none() && pid == 0 {
            controls.clear();
        }
        let _ = tokio::task::spawn_blocking(move || {
            let mut exec_pids = Vec::new();
            for control in controls {
                match control {
                    ProcessControl::Pty(handle) => handle.stop(),
                    ProcessControl::Exec(pid) => exec_pids.push(pid),
                }
            }
            if !exec_pids.is_empty() {
                controlled_instance_app_runtime::terminate_process_groups(&exec_pids);
            }
        })
        .await;
    }

    pub async fn handle_socket(&self, socket: WebSocket) {
        let (socket_sink, mut socket_rx) = socket.split();
        let outbound = ShellOutbound::new(socket_sink);
        let mut shutdown = self.shutdown.subscribe();
        let (events_tx, mut events_rx) = mpsc::channel::<ShellEvent>(32);
        let mut activity = None;
        let mut started_frame: Option<controlled_instance_protocol::InstanceShellStartFrame> = None;
        let mut terminal: Option<Terminal> = None;
        let mut pid = 0u32;
        let mut stdin_closed = false;
        let mut exit_frame: Option<(Option<i32>, Option<String>)> = None;
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut terminal_failure: Option<ShellFailure> = None;
        let mut backpressure = false;

        loop {
            tokio::select! {
                message = socket_rx.next() => {
                    let Some(message) = message else { break; };
                    let message = match message {
                        Ok(message) => message,
                        Err(_) => break,
                    };
                    match message {
                        Message::Binary(bytes) => {
                            if terminal_failure.is_some() { break; }
                            if started_frame.is_none() || terminal.is_none() {
                                terminal_failure = Some(ShellFailure::protocol(
                                    "Instance shell has not started.",
                                ));
                                break;
                            }
                            if stdin_closed {
                                terminal_failure = Some(ShellFailure::protocol(
                                    "Instance shell stdin is already closed.",
                                ));
                                break;
                            }
                            let Ok((_, payload)) = decode_instance_shell_binary_frame(
                                &bytes,
                                InstanceShellDataDirection::ClientToInstance,
                            ) else {
                                terminal_failure = Some(ShellFailure::protocol(
                                    "Instance shell protocol error.",
                                ));
                                break;
                            };
                            let write_result = match terminal.as_mut().expect("terminal") {
                                Terminal::Pty(handle) => {
                                    handle.write(payload).map_err(|error| error.to_string())
                                }
                                Terminal::Exec { stdin, .. } => match stdin.as_mut() {
                                    Some(stdin) => match stdin.write_all(payload).await {
                                        Ok(()) => Ok(()),
                                        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
                                        Err(error) => Err(error.to_string()),
                                    },
                                    None => Ok(()),
                                },
                            };
                            if write_result.is_err() {
                                terminal_failure = Some(ShellFailure::new(
                                    "INSTANCE_SHELL_STDIN_FAILED",
                                    "Instance command stdin failed.",
                                ));
                                break;
                            }
                        }
                        Message::Text(text) => {
                            let frame = match parse_instance_shell_client_control_frame(text.as_str()) {
                                Ok(frame) => frame,
                                Err(error) => {
                                    terminal_failure = Some(ShellFailure::new(error.code, error.message));
                                    break;
                                }
                            };
                            match frame {
                                InstanceShellClientControlFrame::Start(frame) => {
                                    if started_frame.is_some() {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Instance shell has already started.",
                                        ));
                                        break;
                                    }
                                    if activity.is_some() {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Instance shell has already started.",
                                        ));
                                        break;
                                    }
                                    let Some(guard) = self.begin_activity() else {
                                        terminal_failure = Some(ShellFailure::new(
                                            "INSTANCE_SHELL_LIMIT_REACHED",
                                            "Instance shell activity limit reached.",
                                        ));
                                        break;
                                    };
                                    let workspace = match self.workspace.canonicalize() {
                                        Ok(path) if path.is_dir() => path,
                                        _ => {
                                            drop(guard);
                                            terminal_failure = Some(ShellFailure::new(
                                                "INSTANCE_SHELL_WORKSPACE_UNAVAILABLE",
                                                "Instance workspace is unavailable.",
                                            ));
                                            break;
                                        }
                                    };
                                    match spawn_shell(
                                        self.app_runtime.as_deref(),
                                        &workspace,
                                        &frame,
                                        events_tx.clone(),
                                    ).await {
                                        Ok(spawned) => {
                                            activity = Some(guard);
                                            pid = spawned.pid;
                                            self.register_process(pid, spawned.control.clone());
                                            terminal = Some(spawned.terminal);
                                            started_frame = Some(frame.clone());
                                            let started = encode_instance_shell_started_frame(
                                                frame.mode,
                                                frame.tty,
                                            );
                                            if !outbound.text(started) {
                                                backpressure = true;
                                                break;
                                            }
                                        }
                                        Err(()) => {
                                            drop(guard);
                                            terminal_failure = Some(ShellFailure::new(
                                                "INSTANCE_SHELL_SPAWN_FAILED",
                                                "Instance command could not be started.",
                                            ));
                                            break;
                                        }
                                    }
                                }
                                InstanceShellClientControlFrame::StdinClose => {
                                    if started_frame.is_none() {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Instance shell must start before control messages.",
                                        ));
                                        break;
                                    }
                                    if !stdin_closed {
                                        stdin_closed = true;
                                        if let Some(terminal) = terminal.as_mut() {
                                            match terminal {
                                                Terminal::Pty(handle) => {
                                                    let _ = handle.write(b"\x04");
                                                }
                                                Terminal::Exec { stdin, .. } => {
                                                    if let Some(mut stdin) = stdin.take() {
                                                        let _ = stdin.shutdown().await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                InstanceShellClientControlFrame::Resize { cols, rows } => {
                                    let Some(started) = started_frame.as_ref() else {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Instance shell must start before control messages.",
                                        ));
                                        break;
                                    };
                                    if !started.tty {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Resize is only valid for a PTY.",
                                        ));
                                        break;
                                    }
                                    if let Some(Terminal::Pty(handle)) = terminal.as_ref() {
                                        if handle.resize(cols, rows).is_err() {
                                            terminal_failure = Some(ShellFailure::protocol(
                                                "Instance shell protocol error.",
                                            ));
                                            break;
                                        }
                                    }
                                }
                                InstanceShellClientControlFrame::Signal(signal) => {
                                    let Some(started) = started_frame.as_ref() else {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Instance shell must start before control messages.",
                                        ));
                                        break;
                                    };
                                    if started.mode != InstanceShellMode::Exec || started.tty {
                                        terminal_failure = Some(ShellFailure::protocol(
                                            "Remote signal is only valid for non-TTY exec.",
                                        ));
                                        break;
                                    }
                                    let signal_number = match signal {
                                        InstanceShellSignal::Sigint => 2,
                                        InstanceShellSignal::Sigterm => 15,
                                    };
                                    signal_process_group(pid, signal_number);
                                }
                            }
                        }
                        Message::Close(_) => break,
                        Message::Ping(_) | Message::Pong(_) => {}
                    }
                }
                event = events_rx.recv() => {
                    match event {
                        Some(ShellEvent::Output { channel, data }) => {
                            let Ok(frame) = encode_instance_shell_binary_frame(channel, &data) else {
                                terminal_failure = Some(ShellFailure::protocol(
                                    "Instance shell protocol error.",
                                ));
                                break;
                            };
                            if !outbound.binary(frame) {
                                backpressure = true;
                                break;
                            }
                        }
                        Some(ShellEvent::StreamDone { channel }) => match channel {
                            InstanceShellDataChannel::Output if started_frame.as_ref().is_some_and(|frame| !frame.tty) => {
                                stdout_done = true;
                            }
                            InstanceShellDataChannel::Stderr => stderr_done = true,
                            InstanceShellDataChannel::Output => {}
                            InstanceShellDataChannel::Input => {}
                        },
                        Some(ShellEvent::PtyStreamDone) => {
                            stdout_done = true;
                        }
                        Some(ShellEvent::Exit { code, signal }) => {
                            exit_frame = Some((code, signal));
                            self.forget_process(pid);
                        }
                        None => break,
                    }
                }
                changed = shutdown.recv() => {
                    let close = changed.ok();
                    if let Some(close) = close {
                        drop(activity.take());
                        if let Some(terminal) = terminal.as_ref() {
                            let pty = match terminal { Terminal::Pty(handle) => Some(handle), Terminal::Exec { .. } => None };
                            self.stop_process(pid, pty).await;
                        }
                        outbound.close(close.code, &close.reason);
                        outbound.finish().await;
                        return;
                    }
                    break;
                }
            }

            let tty = started_frame.as_ref().is_some_and(|frame| frame.tty);
            let streams_done = if tty {
                stdout_done || exit_frame.is_some()
            } else {
                stdout_done && stderr_done
            };
            if streams_done {
                if let Some((code, signal)) = exit_frame.take() {
                    drop(activity.take());
                    outbound.text(encode_instance_shell_exit_frame(code, signal));
                    outbound.close(1000, "Instance shell process exited.");
                    outbound.finish().await;
                    return;
                }
            }
        }

        let pty = terminal.as_ref().and_then(|terminal| match terminal {
            Terminal::Pty(handle) => Some(handle),
            Terminal::Exec { .. } => None,
        });
        self.stop_process(pid, pty).await;
        drop(activity);
        if backpressure {
            outbound.close(1008, "Instance shell socket backpressure limit reached.");
        } else if let Some(failure) = terminal_failure {
            outbound.text(encode_instance_shell_error_frame(
                &failure.code,
                &failure.message,
            ));
            outbound.close(1008, &failure.code);
        }
        outbound.finish().await;
    }
}

#[derive(Debug)]
struct ShellFailure {
    code: String,
    message: String,
}

impl ShellFailure {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self::new("INSTANCE_SHELL_PROTOCOL_ERROR", message)
    }
}

enum ShellEvent {
    Output {
        channel: InstanceShellDataChannel,
        data: Vec<u8>,
    },
    StreamDone {
        channel: InstanceShellDataChannel,
    },
    PtyStreamDone,
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
}

enum Terminal {
    Pty(PtyHandle),
    Exec { stdin: Option<ChildStdin> },
}

struct SpawnedShell {
    pid: u32,
    terminal: Terminal,
    control: ProcessControl,
}

async fn spawn_shell(
    runtime: Option<&controlled_instance_app_runtime::AppRuntime>,
    workspace: &Path,
    frame: &controlled_instance_protocol::InstanceShellStartFrame,
    events: mpsc::Sender<ShellEvent>,
) -> Result<SpawnedShell, ()> {
    let env = std::env::vars().collect::<BTreeMap<_, _>>();
    let env = runtime
        .map(|runtime| runtime.process_environment(&env))
        .transpose()
        .map_err(|_| ())?
        .unwrap_or(env);
    let cols = frame.cols.unwrap_or(120);
    let rows = frame.rows.unwrap_or(40);
    if frame.mode == InstanceShellMode::Interactive || frame.tty {
        let (command, args) = if frame.mode == InstanceShellMode::Interactive {
            (shell_command(&env), Vec::new())
        } else {
            let command = frame
                .command
                .as_ref()
                .and_then(|argv| argv.first())
                .ok_or(())?;
            (
                command.clone(),
                frame
                    .command
                    .as_ref()
                    .expect("argv")
                    .iter()
                    .skip(1)
                    .cloned()
                    .collect(),
            )
        };
        let (args, env) = runtime
            .map(|runtime| runtime.prepare_shell(&command, &args, &env))
            .transpose()
            .map_err(|_| ())?
            .unwrap_or((args, env));
        let invocation = resolve_invocation(&command, &args, workspace, &env)?;
        let spawned = spawn_pty(
            &invocation.executable.display().to_string(),
            &invocation.args,
            workspace,
            &invocation.env,
            cols,
            rows,
        )
        .map_err(|_| ())?;
        let pid = spawned.pid;
        let handle = spawned.handle.clone();
        spawn_pty_reader(spawned.reader, events.clone());
        spawn_shell_monitor(spawned.child, pid, events);
        Ok(SpawnedShell {
            pid,
            terminal: Terminal::Pty(handle.clone()),
            control: ProcessControl::Pty(handle),
        })
    } else {
        let argv = frame.command.as_ref().ok_or(())?;
        let command = argv.first().ok_or(())?;
        let args = argv.iter().skip(1).cloned().collect::<Vec<_>>();
        let (args, env) = runtime
            .map(|runtime| runtime.prepare_shell(command, &args, &env))
            .transpose()
            .map_err(|_| ())?
            .unwrap_or((args, env));
        let invocation = resolve_invocation(command, &args, workspace, &env)?;
        let mut process = Command::new(&invocation.executable);
        process
            .args(&invocation.args)
            .current_dir(workspace)
            .envs(&invocation.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        process.process_group(0);
        let mut child = process.spawn().map_err(|_| ())?;
        let pid = child.id().ok_or(())?;
        let stdout = child.stdout.take().ok_or(())?;
        let stderr = child.stderr.take().ok_or(())?;
        let stdin = child.stdin.take();
        spawn_async_reader(stdout, InstanceShellDataChannel::Output, events.clone());
        spawn_async_reader(stderr, InstanceShellDataChannel::Stderr, events.clone());
        spawn_shell_monitor(child, pid, events);
        Ok(SpawnedShell {
            pid,
            terminal: Terminal::Exec { stdin },
            control: ProcessControl::Exec(pid),
        })
    }
}

fn resolve_invocation(
    command: &str,
    args: &[String],
    workspace: &Path,
    env: &BTreeMap<String, String>,
) -> Result<controlled_instance_app_runtime::command_invocation::CommandInvocation, ()> {
    let options = CommandInvocationOptions::from(ExecutableResolverOptions {
        env: env.clone(),
        cwd: workspace.to_path_buf(),
        ..ExecutableResolverOptions::default()
    });
    command_invocation(command, args, &options).map_err(|_| ())
}

fn spawn_pty_reader(mut reader: std::fs::File, events: mpsc::Sender<ShellEvent>) {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if events
                        .blocking_send(ShellEvent::Output {
                            channel: InstanceShellDataChannel::Output,
                            data: buffer[..size].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = events.blocking_send(ShellEvent::PtyStreamDone);
    });
}

fn spawn_async_reader<R>(
    mut reader: R,
    channel: InstanceShellDataChannel,
    events: mpsc::Sender<ShellEvent>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(size) => {
                    if events
                        .send(ShellEvent::Output {
                            channel,
                            data: buffer[..size].to_vec(),
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = events.send(ShellEvent::StreamDone { channel }).await;
    });
}

fn spawn_shell_monitor(
    mut child: tokio::process::Child,
    pid: u32,
    events: mpsc::Sender<ShellEvent>,
) {
    tokio::spawn(async move {
        let status = child.wait().await.ok();
        let (code, signal) = status.map(exit_parts).unwrap_or((Some(1), None));
        if process_group_exists(pid) {
            let _ = tokio::task::spawn_blocking(move || terminate_process_group(pid)).await;
        }
        let _ = events.send(ShellEvent::Exit { code, signal }).await;
    });
}

fn shell_command(env: &BTreeMap<String, String>) -> String {
    #[cfg(windows)]
    {
        env.get("ComSpec")
            .cloned()
            .unwrap_or_else(|| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        env.get("SHELL")
            .cloned()
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

fn exit_parts(status: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return (None, Some(signal_name(signal).to_string()));
        }
    }
    (status.code(), None)
}

#[cfg(unix)]
fn signal_name(signal: i32) -> &'static str {
    match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        libc::SIGSYS => "SIGSYS",
        #[cfg(target_os = "macos")]
        libc::SIGEMT => "SIGEMT",
        #[cfg(target_os = "macos")]
        libc::SIGINFO => "SIGINFO",
        #[cfg(target_os = "linux")]
        libc::SIGSTKFLT => "SIGSTKFLT",
        #[cfg(target_os = "linux")]
        libc::SIGPWR => "SIGPWR",
        _ => "SIGUNKNOWN",
    }
}

fn signal_process_group(pid: u32, _signal: i32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as libc::pid_t), _signal);
    }
}

pub fn websocket_upgrade_options(
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> axum::extract::ws::WebSocketUpgrade {
    upgrade
        .max_message_size(crate::WEBSOCKET_MAX_PAYLOAD_BYTES)
        .max_frame_size(crate::WEBSOCKET_MAX_PAYLOAD_BYTES)
        .max_write_buffer_size(INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::ws::WebSocketUpgrade,
        response::{IntoResponse, Response},
        routing::get,
        Router,
    };
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{protocol::frame::coding::CloseCode, Message as ClientMessage},
        MaybeTlsStream, WebSocketStream,
    };

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    struct TestShellServer {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestShellServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn start_shell_server(runtime: InstanceShellRuntime) -> TestShellServer {
        async fn upgrade(
            websocket: WebSocketUpgrade,
            axum::extract::State(runtime): axum::extract::State<InstanceShellRuntime>,
        ) -> Response {
            websocket_upgrade_options(websocket)
                .on_upgrade(move |socket| async move {
                    runtime.handle_socket(socket).await;
                })
                .into_response()
        }

        let app = Router::new()
            .route("/shell", get(upgrade))
            .with_state(runtime);
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind shell test server");
        let address = listener.local_addr().expect("shell test address");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        TestShellServer {
            url: format!("ws://{address}/shell"),
            task,
        }
    }

    async fn connect(server: &TestShellServer) -> Client {
        tokio::time::timeout(Duration::from_secs(2), connect_async(&server.url))
            .await
            .expect("connect timeout")
            .expect("connect")
            .0
    }

    async fn next(client: &mut Client) -> ClientMessage {
        tokio::time::timeout(Duration::from_secs(5), client.next())
            .await
            .expect("shell message timeout")
            .expect("shell socket ended")
            .expect("shell message")
    }

    async fn send_json(client: &mut Client, value: Value) {
        client
            .send(ClientMessage::Text(value.to_string().into()))
            .await
            .expect("send shell control");
    }

    async fn send_input(client: &mut Client, bytes: &[u8]) {
        let frame = encode_instance_shell_binary_frame(InstanceShellDataChannel::Input, bytes)
            .expect("input frame");
        client
            .send(ClientMessage::Binary(frame.into()))
            .await
            .expect("send shell input");
    }

    async fn wait_for_started(client: &mut Client) -> Value {
        loop {
            let message = next(client).await;
            if let ClientMessage::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).expect("shell frame json");
                if value["type"] == "started" {
                    return value;
                }
            }
        }
    }

    async fn collect_until_exit(client: &mut Client) -> (Vec<u8>, Vec<u8>, Value) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            match next(client).await {
                ClientMessage::Binary(bytes) => {
                    let (channel, payload) = decode_instance_shell_binary_frame(
                        &bytes,
                        InstanceShellDataDirection::InstanceToClient,
                    )
                    .expect("server binary frame");
                    match channel {
                        InstanceShellDataChannel::Output => stdout.extend_from_slice(payload),
                        InstanceShellDataChannel::Stderr => stderr.extend_from_slice(payload),
                        InstanceShellDataChannel::Input => panic!("server sent input"),
                    }
                }
                ClientMessage::Text(text) => {
                    let value: Value =
                        serde_json::from_str(text.as_str()).expect("shell frame json");
                    if value["type"] == "exit" || value["type"] == "error" {
                        return (stdout, stderr, value);
                    }
                }
                ClientMessage::Ping(_) | ClientMessage::Pong(_) => {}
                ClientMessage::Close(frame) => panic!("shell closed before exit: {frame:?}"),
                ClientMessage::Frame(_) => {}
            }
        }
    }

    #[test]
    fn activity_limit_is_per_runtime_and_released() {
        let runtime = InstanceShellRuntime::with_max_activities(PathBuf::from("."), 1);
        let first = runtime.begin_activity().expect("first");
        assert!(runtime.begin_activity().is_none());
        drop(first);
        assert_eq!(runtime.active_count(), 0);
        assert!(runtime.begin_activity().is_some());
    }

    #[test]
    #[cfg(unix)]
    fn exit_status_signal_names_are_protocol_compatible() {
        use std::os::unix::process::ExitStatusExt;
        for (signal, name) in [
            (libc::SIGTERM, "SIGTERM"),
            (libc::SIGTRAP, "SIGTRAP"),
            (libc::SIGBUS, "SIGBUS"),
            (libc::SIGUSR1, "SIGUSR1"),
            (libc::SIGUSR2, "SIGUSR2"),
        ] {
            assert_eq!(signal_name(signal), name);
            assert_eq!(
                exit_parts(std::process::ExitStatus::from_raw(signal)),
                (None, Some(name.to_string()))
            );
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(signal_name(10), "SIGBUS");
            assert_eq!(signal_name(29), "SIGINFO");
            assert_eq!(signal_name(30), "SIGUSR1");
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(signal_name(10), "SIGUSR1");
            assert_eq!(signal_name(29), "SIGIO");
            assert_eq!(signal_name(30), "SIGPWR");
        }
    }

    #[tokio::test]
    async fn exec_streams_stdout_stderr_stdin_close_and_exit_code() {
        let runtime = InstanceShellRuntime::new(std::env::temp_dir());
        let server = start_shell_server(runtime).await;
        let mut client = connect(&server).await;
        send_json(
            &mut client,
            json!({
                "type": "start",
                "mode": "exec",
                "tty": false,
                "command": ["/bin/sh", "-c", "printf out; printf err >&2; exit 7"]
            }),
        )
        .await;
        let started = wait_for_started(&mut client).await;
        assert_eq!(started["mode"], "exec");
        assert_eq!(started["tty"], false);
        let (stdout, stderr, exit) = collect_until_exit(&mut client).await;
        assert_eq!(stdout, b"out");
        assert_eq!(stderr, b"err");
        assert_eq!(exit["type"], "exit");
        assert_eq!(exit["code"], 7);

        let mut client = connect(&server).await;
        send_json(
            &mut client,
            json!({
                "type": "start",
                "mode": "exec",
                "tty": false,
                "command": ["/bin/sh", "-c", "cat"]
            }),
        )
        .await;
        wait_for_started(&mut client).await;
        send_input(&mut client, b"hello from stdin\n").await;
        send_json(&mut client, json!({ "type": "stdin-close" })).await;
        let (stdout, stderr, exit) = collect_until_exit(&mut client).await;
        assert_eq!(stdout, b"hello from stdin\n");
        assert!(stderr.is_empty());
        assert_eq!(exit["code"], 0);
    }

    #[tokio::test]
    async fn interactive_pty_resize_and_exec_signal_follow_the_node_contract() {
        let runtime = InstanceShellRuntime::new(std::env::temp_dir());
        let server = start_shell_server(runtime.clone()).await;
        let mut client = connect(&server).await;
        send_json(
            &mut client,
            json!({
                "type": "start",
                "mode": "interactive",
                "tty": true,
                "cols": 100,
                "rows": 30
            }),
        )
        .await;
        let started = wait_for_started(&mut client).await;
        assert_eq!(started["tty"], true);
        send_json(
            &mut client,
            json!({ "type": "resize", "cols": 120, "rows": 40 }),
        )
        .await;
        send_input(&mut client, b"stty size\n").await;
        let mut output = Vec::new();
        loop {
            match next(&mut client).await {
                ClientMessage::Binary(bytes) => {
                    let (_, payload) = decode_instance_shell_binary_frame(
                        &bytes,
                        InstanceShellDataDirection::InstanceToClient,
                    )
                    .expect("pty output");
                    output.extend_from_slice(payload);
                    if String::from_utf8_lossy(&output).contains("40 120") {
                        break;
                    }
                }
                ClientMessage::Text(_) => {}
                ClientMessage::Ping(_) | ClientMessage::Pong(_) => {}
                ClientMessage::Close(frame) => panic!("PTY closed before resize output: {frame:?}"),
                ClientMessage::Frame(_) => {}
            }
        }
        drop(client);

        let mut client = connect(&server).await;
        send_json(
            &mut client,
            json!({
                "type": "start",
                "mode": "exec",
                "tty": false,
                "command": ["/bin/sh", "-c", "trap 'exit 23' TERM; while :; do sleep 1; done"]
            }),
        )
        .await;
        wait_for_started(&mut client).await;
        send_json(
            &mut client,
            json!({ "type": "signal", "signal": "SIGTERM" }),
        )
        .await;
        let (_, _, exit) = collect_until_exit(&mut client).await;
        assert_eq!(exit["type"], "exit");
        assert!(
            exit["signal"] == "SIGTERM" || exit["code"] == 23,
            "unexpected exec signal result: {exit}"
        );
    }

    #[tokio::test]
    async fn oversized_binary_frames_report_a_shell_protocol_error() {
        let runtime = InstanceShellRuntime::new(std::env::temp_dir());
        let server = start_shell_server(runtime).await;
        let mut client = connect(&server).await;
        send_json(
            &mut client,
            json!({
                "type": "start", "mode": "exec", "tty": false,
                "command": ["/bin/sh", "-c", "cat"],
            }),
        )
        .await;
        wait_for_started(&mut client).await;
        let mut bytes =
            vec![0; controlled_instance_protocol::INSTANCE_SHELL_DATA_FRAME_MAX_BYTES + 2];
        bytes[0] = InstanceShellDataChannel::Input as u8;
        client
            .send(ClientMessage::Binary(bytes.into()))
            .await
            .unwrap();
        let (_, _, error) = collect_until_exit(&mut client).await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], "INSTANCE_SHELL_PROTOCOL_ERROR");
        match next(&mut client).await {
            ClientMessage::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Policy),
            other => panic!("expected policy close, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn activity_limit_and_drain_close_sockets_with_the_node_codes() {
        let runtime = InstanceShellRuntime::with_max_activities(std::env::temp_dir(), 1);
        let server = start_shell_server(runtime.clone()).await;
        let mut first = connect(&server).await;
        send_json(
            &mut first,
            json!({ "type": "start", "mode": "interactive", "tty": true }),
        )
        .await;
        wait_for_started(&mut first).await;

        let mut second = connect(&server).await;
        send_json(
            &mut second,
            json!({ "type": "start", "mode": "interactive", "tty": true }),
        )
        .await;
        let (_, _, error) = collect_until_exit(&mut second).await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], "INSTANCE_SHELL_LIMIT_REACHED");

        runtime
            .shutdown(1001, "Controlled instance is draining.")
            .await;
        match next(&mut first).await {
            ClientMessage::Close(frame) => {
                assert_eq!(frame.expect("close frame").code, CloseCode::Away);
            }
            other => panic!("expected drain close, got {other:?}"),
        }
        assert_eq!(runtime.active_count(), 0);
    }
}
