//! Independent actuator/watchdog process. It survives component SIGKILL long
//! enough to release native keys/buttons on inherited-pipe EOF or input expiry.
//! No socket, credentials on disk, process discovery or business-state registry.
use crate::{
    channel::{Input, Pointer},
    input_driver::NativeInput,
    synthetic::SyntheticInput,
    traits::{Geometry, PointerMapping},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
const INPUT_TTL: Duration = Duration::from_millis(1500);
const QUEUE_TTL: Duration = Duration::from_millis(100);
const LIMIT: usize = 64 * 1024;
const VALIDATE_CALL_BUDGET: Duration = Duration::from_millis(600);
const ARM_CALL_BUDGET: Duration = Duration::from_millis(1_200);
const REBIND_CALL_BUDGET: Duration = Duration::from_millis(2_500);
const GEOMETRY_CALL_BUDGET: Duration = Duration::from_millis(700);
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Backend {
    Synthetic,
    #[cfg(target_os = "macos")]
    MacWindow {
        identity: crate::platform::macos_window::Identity,
        geometry: Geometry,
    },
    #[cfg(target_os = "linux")]
    LinuxWindow {
        window: u32,
        geometry: Geometry,
        display: Option<String>,
        authority: Option<std::path::PathBuf>,
    },
    #[cfg(target_os = "windows")]
    WindowsWindow {
        identity: crate::platform::windows_window::Identity,
        geometry: Geometry,
    },
    Native {
        geometry: Geometry,
        display: Option<String>,
        authority: Option<std::path::PathBuf>,
    },
}
impl Backend {
    pub fn set_geometry(&mut self, geometry: Geometry) {
        match self {
            Self::Synthetic => {}
            #[cfg(target_os = "macos")]
            Self::MacWindow {
                geometry: current, ..
            } => *current = geometry,
            #[cfg(target_os = "linux")]
            Self::LinuxWindow {
                geometry: current, ..
            } => *current = geometry,
            #[cfg(target_os = "windows")]
            Self::WindowsWindow {
                geometry: current, ..
            } => *current = geometry,
            Self::Native {
                geometry: current, ..
            } => *current = geometry,
        }
    }

    /// Geometry changes during resize, but the backend kind and native identity
    /// must still match before a geometry update is applied to the guard.
    pub fn same_binding(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Synthetic, Self::Synthetic) => true,
            #[cfg(target_os = "macos")]
            (
                Self::MacWindow { identity, .. },
                Self::MacWindow {
                    identity: other, ..
                },
            ) => identity == other,
            #[cfg(target_os = "linux")]
            (
                Self::LinuxWindow {
                    window,
                    display,
                    authority,
                    ..
                },
                Self::LinuxWindow {
                    window: other_window,
                    display: other_display,
                    authority: other_authority,
                    ..
                },
            ) => window == other_window && display == other_display && authority == other_authority,
            #[cfg(target_os = "windows")]
            (
                Self::WindowsWindow { identity, .. },
                Self::WindowsWindow {
                    identity: other, ..
                },
            ) => identity == other,
            (
                Self::Native {
                    display, authority, ..
                },
                Self::Native {
                    display: other_display,
                    authority: other_authority,
                    ..
                },
            ) => display == other_display && authority == other_authority,
            _ => false,
        }
    }
}
#[derive(Serialize, Deserialize)]
pub struct Bootstrap {
    pub nonce: String,
    pub backend: Backend,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Arm { epoch: u64 },
    Rebind { backend: Backend },
    Geometry { geometry: Geometry },
    PointerMapping { mapping: PointerMapping },
    Alive { epoch: u64 },
    Input { event: Input },
    Pointer { event: Pointer },
    Suspend,
    Probe,
    Shutdown,
}
fn command_label(command: &Command) -> &'static str {
    match command {
        Command::Arm { .. } => "arm",
        Command::Rebind { .. } => "rebind",
        Command::Geometry { .. } => "geometry",
        Command::PointerMapping { .. } => "pointerMapping",
        Command::Alive { .. } => "alive",
        Command::Input { .. } => "input",
        Command::Pointer { .. } => "pointer",
        Command::Suspend => "suspend",
        Command::Probe => "probe",
        Command::Shutdown => "shutdown",
    }
}
fn command_epoch(command: &Command) -> Option<u64> {
    match command {
        Command::Arm { epoch } | Command::Alive { epoch } => Some(*epoch),
        Command::Input { event } => Some(event.epoch()),
        Command::Pointer { event } => Some(event.input_epoch),
        _ => None,
    }
}
fn command_call_budget(command: &Command) -> Duration {
    match command {
        // Arm performs native window activation. macOS focus() waits up to
        // 600ms for AX/WindowServer to publish the transition, so the IPC
        // budget must exceed that wait instead of treating it as a dead guard.
        Command::Arm { .. } => ARM_CALL_BUDGET,
        // Rebind can build a new native window lease, whose bind wait is 600ms
        // and whose lease worker handshake is itself bounded to 2s.
        Command::Rebind { .. } => REBIND_CALL_BUDGET,
        Command::Geometry { .. } => GEOMETRY_CALL_BUDGET,
        Command::Input {
            event: Input::Text(_),
        } => INPUT_TTL + QUEUE_TTL,
        _ => VALIDATE_CALL_BUDGET,
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Unavailable {
        nonce: String,
        cause: crate::error::BackendError,
    },
    Failed {
        cause: crate::error::BackendError,
    },
    Ready {
        nonce: String,
    },
    State {
        epoch: Option<u64>,
        pressed: usize,
        interactions: u64,
        characters: u64,
    },
    Suspended {
        cause: crate::error::BackendError,
    },
    Released,
    Rejected,
    Stopped,
}
pub(crate) fn read<R: Read, T: serde::de::DeserializeOwned>(r: &mut R) -> anyhow::Result<T> {
    let mut header = [0; 4];
    r.read_exact(&mut header)?;
    let len = u32::from_be_bytes(header) as usize;
    anyhow::ensure!(
        len > 0 && len <= LIMIT,
        "REMOTE_DESKTOP_GUARD_FRAME_INVALID"
    );
    let mut bytes = vec![0; len];
    r.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub(crate) fn write<W: Write, T: Serialize>(w: &mut W, value: &T) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    anyhow::ensure!(bytes.len() <= LIMIT, "guard frame too large");
    w.write_all(&(bytes.len() as u32).to_be_bytes())?;
    w.write_all(&bytes)?;
    w.flush()?;
    Ok(())
}
enum Actuator {
    Synthetic(SyntheticInput),
    Native(Box<NativeInput>),
}
fn bind_backend(backend: Backend) -> anyhow::Result<Actuator> {
    match backend {
        Backend::Synthetic => Ok(Actuator::Synthetic(SyntheticInput::default())),
        Backend::Native {
            geometry, display, ..
        } => NativeInput::new(geometry, display).map(|n| Actuator::Native(Box::new(n))),
        #[cfg(target_os = "macos")]
        Backend::MacWindow { identity, geometry } => {
            NativeInput::new_window(identity, geometry).map(|n| Actuator::Native(Box::new(n)))
        }
        #[cfg(target_os = "linux")]
        Backend::LinuxWindow {
            window,
            geometry,
            display,
            ..
        } => NativeInput::new_window(window, geometry, display)
            .map(|n| Actuator::Native(Box::new(n))),
        #[cfg(target_os = "windows")]
        Backend::WindowsWindow { identity, geometry } => {
            NativeInput::new_window(identity, geometry).map(|n| Actuator::Native(Box::new(n)))
        }
    }
}
impl Actuator {
    fn prepare(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Native(n) => n.prepare(),
            Self::Synthetic(_) => Ok(()),
        }
    }
    fn validate(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Native(n) => n.validate(None),
            Self::Synthetic(_) => Ok(()),
        }
    }
    fn geometry(&mut self, g: Geometry) -> anyhow::Result<()> {
        match self {
            Self::Native(n) => n.reconfigure(g),
            Self::Synthetic(_) => Ok(()),
        }
    }

    fn pointer_mapping(&mut self, mapping: PointerMapping) -> anyhow::Result<()> {
        match self {
            Self::Native(n) => n.set_pointer_mapping(mapping),
            Self::Synthetic(_) => Ok(()),
        }
    }

    fn release(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Synthetic(s) => {
                s.release_all();
                Ok(())
            }
            Self::Native(n) => n.release_all(),
        }
    }
    fn apply(
        &mut self,
        input: &Input,
        deadline: Instant,
        alive: &AtomicBool,
    ) -> anyhow::Result<bool> {
        match self {
            Self::Synthetic(s) => {
                s.apply(input);
                Ok(true)
            }
            Self::Native(n) => match input {
                Input::Text(text) => n.text_while(&text.text, || {
                    alive.load(Ordering::SeqCst) && Instant::now() < deadline
                }),
                _ => n.apply(input).map(|_| true),
            },
        }
    }
    fn pointer(&mut self, p: &Pointer) -> anyhow::Result<()> {
        match self {
            Self::Synthetic(s) => {
                s.pointer(p);
                Ok(())
            }
            Self::Native(n) => n.pointer(p.x, p.y),
        }
    }
    fn state(&self, epoch: Option<u64>) -> Event {
        let (pressed, interactions, characters) = match self {
            Self::Synthetic(s) => (s.pressed_count(), s.interactions, s.committed_characters),
            Self::Native(_) => (0, 0, 0),
        };
        Event::State {
            epoch,
            pressed,
            interactions,
            characters,
        }
    }
}
/// Runs on a dedicated process main thread. The pipe reader and bounded output
/// writer cannot prevent the main watchdog from running a monotonic deadline.
pub fn run() -> anyhow::Result<()> {
    let (tx, rx) = mpsc::sync_channel(16);
    let (output, writer) = mpsc::sync_channel(16);
    let (flushed, flush_complete) = mpsc::sync_channel(1);
    let writer_thread = std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        while let Ok(event) = writer.recv() {
            if write(&mut stdout, &event).is_err() {
                break;
            }
        }
        let _ = flushed.send(());
    });
    let alive = Arc::new(AtomicBool::new(true));
    let lifetime = alive.clone();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let bootstrap = read::<_, Bootstrap>(&mut stdin);
        if tx
            .send((Instant::now(), bootstrap.map(Incoming::Bootstrap)))
            .is_err()
        {
            return;
        }
        while let Ok(command) = read::<_, Command>(&mut stdin) {
            if tx
                .send((Instant::now(), Ok(Incoming::Command(command))))
                .is_err()
            {
                break;
            }
        }
        lifetime.store(false, Ordering::SeqCst);
    });
    let (_, bootstrap) = rx.recv_timeout(Duration::from_secs(5))?;
    let Incoming::Bootstrap(bootstrap) = bootstrap? else {
        anyhow::bail!("REMOTE_DESKTOP_GUARD_HANDSHAKE_FAILED");
    };
    anyhow::ensure!(
        bootstrap.nonce.len() == 64,
        "REMOTE_DESKTOP_GUARD_HANDSHAKE_FAILED"
    );
    let input = bind_backend(bootstrap.backend);
    let mut actuator = match input {
        Ok(a) => a,
        Err(error) => {
            let cause = crate::error::BackendError::from_error(&error);
            output.send(Event::Unavailable {
                nonce: bootstrap.nonce,
                cause,
            })?;
            drop(output);
            let _ = writer_thread.join();
            return Ok(());
        }
    };
    output.try_send(Event::Ready {
        nonce: bootstrap.nonce,
    })?;
    let mut epoch = None;
    let mut maximum = 0;
    let mut deadline = None;
    let result = (|| -> anyhow::Result<()> {
        loop {
            let wait = deadline.map_or(Duration::from_secs(3600), |d: Instant| {
                d.saturating_duration_since(Instant::now())
            });
            let received = rx.recv_timeout(wait);
            if !alive.load(Ordering::SeqCst) {
                break;
            }
            if deadline.is_some_and(|d| Instant::now() >= d) {
                actuator.release()?;
                epoch = None;
                deadline = None;
            }
            let (at, command) = match received {
                Ok(v) => v,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!("REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.stdin_eof");
                    break;
                }
            };
            let Incoming::Command(command) = command? else {
                anyhow::bail!("REMOTE_DESKTOP_GUARD_HANDSHAKE_FAILED");
            };
            if at.elapsed() > QUEUE_TTL {
                eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.queue_rejected command={} queueMs={} queueLimitMs={} commandEpoch={:?} activeEpoch={epoch:?}",
                    command_label(&command),
                    at.elapsed().as_millis(),
                    QUEUE_TTL.as_millis(),
                    command_epoch(&command)
                );
                actuator.release()?;
                epoch = None;
                deadline = None;
                output.try_send(Event::Rejected)?;
                continue;
            }
            if matches!(command, Command::Shutdown) {
                actuator.release()?;
                output.try_send(Event::Stopped)?;
                break;
            }
            // A lost focus/changed geometry is an input suspension, not media
            // failure. Release before reporting the authority transition.
            let response = (|| -> anyhow::Result<Event> {
                Ok(match command {
                    Command::Arm { epoch: next } if next > maximum => {
                        actuator.release()?;
                        maximum = next;
                        actuator.prepare()?;
                        epoch = Some(next);
                        deadline = Some(at + INPUT_TTL);
                        actuator.state(epoch)
                    }
                    Command::Rebind { backend } => {
                        actuator.release()?;
                        epoch = None;
                        deadline = None;
                        match bind_backend(backend) {
                            Ok(next) => {
                                actuator = next;
                                Event::Released
                            }
                            Err(error) => Event::Suspended {
                                cause: error
                                    .downcast_ref::<crate::error::BackendError>()
                                    .copied()
                                    .unwrap_or(crate::error::BackendError::InputGuardFailed),
                            },
                        }
                    }
                    Command::Alive { epoch: current } if epoch == Some(current) => {
                        actuator.validate()?;
                        deadline = Some(at + INPUT_TTL);
                        actuator.state(epoch)
                    }
                    Command::Input { event } if epoch == Some(event.epoch()) => {
                        let completed = actuator.apply(&event, deadline.unwrap(), &alive)?;
                        if !completed {
                            actuator.release()?;
                            epoch = None;
                            deadline = None;
                        }
                        actuator.state(epoch)
                    }
                    Command::Pointer { event } if epoch == Some(event.input_epoch) => {
                        actuator.pointer(&event)?;
                        actuator.state(epoch)
                    }
                    Command::Pointer { event } => {
                        eprintln!(
                            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.pointer.rejected receivedEpoch={} activeEpoch={epoch:?}",
                            event.input_epoch
                        );
                        Event::Rejected
                    }
                    Command::Input { event } => {
                        eprintln!(
                            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.input.rejected receivedEpoch={} activeEpoch={epoch:?}",
                            event.epoch()
                        );
                        Event::Rejected
                    }
                    Command::Geometry { geometry } => {
                        let started = Instant::now();
                        eprintln!(
                            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.geometry.start queueMs={} geometry={geometry:?}",
                            at.elapsed().as_millis()
                        );
                        let result = (|| -> anyhow::Result<()> {
                            actuator.release()?;
                            epoch = None;
                            deadline = None;
                            actuator.geometry(geometry)
                        })();
                        match &result {
                            Ok(()) => eprintln!(
                                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.geometry.end elapsedMs={} result=ok",
                                started.elapsed().as_millis()
                            ),
                            Err(error) => eprintln!(
                                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=guard.geometry.end elapsedMs={} result=error error={error}",
                                started.elapsed().as_millis()
                            ),
                        }
                        result?;
                        Event::Released
                    }
                    Command::PointerMapping { mapping } => {
                        actuator.pointer_mapping(mapping)?;
                        actuator.state(epoch)
                    }
                    Command::Suspend => {
                        actuator.release()?;
                        epoch = None;
                        deadline = None;
                        Event::Released
                    }
                    Command::Probe => actuator.state(epoch),
                    Command::Shutdown => unreachable!(),
                    _ => Event::Rejected,
                })
            })();
            let response = match response {
                Ok(r) => r,
                Err(error) => {
                    let cause = error.downcast_ref::<crate::error::BackendError>().copied();
                    if cause.is_some_and(|cause| cause.is_recoverable_input_suspension()) {
                        actuator.release()?;
                        epoch = None;
                        deadline = None;
                        Event::Suspended {
                            cause: cause.unwrap(),
                        }
                    } else {
                        return Err(error);
                    }
                }
            };
            output.try_send(response)?;
        }
        Ok(())
    })();
    let release = actuator.release();
    let result = result.and(release);
    if let Err(error) = &result {
        let cause = error
            .downcast_ref::<crate::error::BackendError>()
            .copied()
            .unwrap_or(crate::error::BackendError::InputGuardFailed);
        let _ = output.try_send(Event::Failed { cause });
    }
    drop(output);
    // Release is already complete. A host that stops reading must not pin the
    // independent guard in stdout flushing forever.
    let _ = flush_complete.recv_timeout(QUEUE_TTL);
    result
}
enum Incoming {
    Bootstrap(Bootstrap),
    Command(Command),
}

/// Owned inherited pipes are the only guard connection. Dropping the client
/// closes stdin; deliberately do not kill-on-drop before it can release keys.
pub struct Client {
    pub child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: tokio::process::ChildStdout,
}
impl Client {
    pub async fn spawn(binary: &std::path::Path, backend: Backend) -> anyhow::Result<Self> {
        match &backend {
            Backend::Synthetic => {}
            Backend::Native { geometry, .. } => geometry.validate()?,
            #[cfg(target_os = "macos")]
            Backend::MacWindow { geometry, .. } => geometry.validate()?,
            #[cfg(target_os = "linux")]
            Backend::LinuxWindow { geometry, .. } => geometry.validate()?,
            #[cfg(target_os = "windows")]
            Backend::WindowsWindow { geometry, .. } => geometry.validate()?,
        }
        let mut process = tokio::process::Command::new(binary);
        #[cfg(target_os = "windows")]
        if !matches!(backend, Backend::Synthetic) {
            // The host Job permits this one explicit breakaway. If an outer
            // embedding Job forbids it, CreateProcess fails and native input
            // remains unavailable; never retry inside the kill-on-close Job.
            process
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB);
        }
        if let Backend::Native {
            display, authority, ..
        } = &backend
        {
            if let Some(display) = display {
                process.env("DISPLAY", display);
            }
            if let Some(authority) = authority {
                process.env("XAUTHORITY", authority);
            }
        }
        #[cfg(target_os = "linux")]
        if let Backend::LinuxWindow {
            display, authority, ..
        } = &backend
        {
            if let Some(display) = display {
                process.env("DISPLAY", display);
            }
            if let Some(authority) = authority {
                process.env("XAUTHORITY", authority);
            }
        }
        let mut child = process
            .arg("--input-guard")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let nonce = crate::session::secret();
        crate::framing::write(
            &mut stdin,
            &Bootstrap {
                nonce: nonce.clone(),
                backend,
            },
        )
        .await?;
        let ready = tokio::time::timeout(
            Duration::from_secs(5),
            crate::framing::read::<Event>(&mut stdout),
        )
        .await??;
        match ready {
            Some(Event::Ready { nonce: echo }) if echo == nonce => {}
            Some(Event::Unavailable { nonce: echo, cause }) if echo == nonce => {
                let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                return Err(cause.into());
            }
            _ => anyhow::bail!("REMOTE_DESKTOP_GUARD_HANDSHAKE_FAILED"),
        }
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout,
        })
    }
    pub async fn call(&mut self, command: &Command) -> anyhow::Result<Event> {
        let is_geometry = matches!(command, Command::Geometry { .. });
        let started = Instant::now();
        let action = async {
            let stdin = self
                .stdin
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_GUARD_CLOSED"))?;
            crate::framing::write(stdin, command).await?;
            crate::framing::read::<Event>(&mut self.stdout)
                .await?
                .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_GUARD_CLOSED"))
        };
        // Queue age stays 100ms inside the guard. This budget is the time the
        // service waits for the command's authoritative response, including
        // native focus/bind waits that are intentionally longer than the queue.
        let call_budget = command_call_budget(command);
        if is_geometry {
            eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=client.call.start budgetMs={}",
                call_budget.as_millis()
            );
        }
        match tokio::time::timeout(call_budget, action).await {
            Ok(Ok(Event::Failed { cause })) => {
                if is_geometry {
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=client.call.failed elapsedMs={} cause={}",
                        started.elapsed().as_millis(),
                        cause
                    );
                }
                self.stdin.take();
                Err(cause.into())
            }
            Ok(Ok(response)) => {
                if is_geometry {
                    let response = match &response {
                        Event::Released => "released",
                        Event::Suspended { .. } => "suspended",
                        Event::Rejected => "rejected",
                        Event::Stopped => "stopped",
                        Event::Ready { .. } => "ready",
                        Event::Unavailable { .. } => "unavailable",
                        Event::State { .. } => "state",
                        Event::Failed { .. } => "failed",
                    };
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=client.call.end elapsedMs={} response={response}",
                        started.elapsed().as_millis()
                    );
                }
                Ok(response)
            }
            Ok(Err(error)) => {
                if is_geometry {
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=client.call.io_error elapsedMs={} error={error}",
                        started.elapsed().as_millis()
                    );
                }
                self.stdin.take();
                // A pipe read/write failure means the guard process can no longer
                // acknowledge this command. Preserve the input failure as a typed
                // backend error so the service suspends control instead of keeping
                // the lease armed against a dead process.
                Err(crate::error::BackendError::InputGuardFailed.into())
            }
            Err(_) => {
                if is_geometry {
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=client.call.timeout elapsedMs={} budgetMs={}",
                        started.elapsed().as_millis(),
                        call_budget.as_millis()
                    );
                }
                self.stdin.take();
                Err(crate::error::BackendError::InputGuardFailed.into())
            }
        }
    }
    /// Called only after child exit; recover its buffered terminal cause even
    /// when the process-exit notification won the service actor's select.
    pub async fn exited_cause(&mut self) -> crate::error::BackendError {
        let terminal = async {
            // The child has a bounded16-event writer queue. A few prior ACKs
            // may precede its terminal failure; never drain without a bound.
            for _ in 0..32 {
                match crate::framing::read::<Event>(&mut self.stdout).await {
                    Ok(Some(Event::Failed { cause })) => return cause,
                    Ok(Some(_)) => {}
                    _ => break,
                }
            }
            crate::error::BackendError::InputGuardFailed
        };
        tokio::time::timeout(QUEUE_TTL, terminal)
            .await
            .unwrap_or(crate::error::BackendError::InputGuardFailed)
    }
    pub fn close_pipe(&mut self) {
        self.stdin.take();
    }
    pub async fn close(mut self) -> anyhow::Result<()> {
        let released = self.call(&Command::Suspend).await;
        self.stdin.take();
        let exited = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await?;
        exited?;
        released?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_activation_commands_outlive_focus_and_bind_waits() {
        assert!(command_call_budget(&Command::Arm { epoch: 1 }) > Duration::from_millis(600));
        assert!(
            command_call_budget(&Command::Rebind {
                backend: Backend::Synthetic,
            }) > Duration::from_secs(2)
        );
        assert!(
            command_call_budget(&Command::Geometry {
                geometry: Geometry {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                    scale: 1.0,
                },
            }) > Duration::from_millis(300)
        );
    }
}
