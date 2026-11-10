//! Independent actuator/watchdog process. It survives component SIGKILL long
//! enough to release native keys/buttons on inherited-pipe EOF or input expiry.
//! No socket, credentials on disk, process discovery or business-state registry.
use crate::{
    channel::{Input, Pointer},
    input_driver::NativeInput,
    synthetic::SyntheticInput,
    traits::Geometry,
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
#[derive(Serialize, Deserialize)]
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
    Native {
        geometry: Geometry,
        display: Option<String>,
        authority: Option<std::path::PathBuf>,
    },
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
    Geometry { geometry: Geometry },
    Alive { epoch: u64 },
    Input { event: Input },
    Pointer { event: Pointer },
    Suspend,
    Probe,
    Shutdown,
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
    let input = match bootstrap.backend {
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
    };
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
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let Incoming::Command(command) = command? else {
                anyhow::bail!("REMOTE_DESKTOP_GUARD_HANDSHAKE_FAILED");
            };
            if at.elapsed() > QUEUE_TTL {
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
                    Command::Geometry { geometry } => {
                        actuator.release()?;
                        epoch = None;
                        deadline = None;
                        actuator.geometry(geometry)?;
                        Event::Released
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
                    if matches!(
                        cause,
                        Some(
                            crate::error::BackendError::WindowFocusRequired
                                | crate::error::BackendError::PointerTargetMismatch
                                | crate::error::BackendError::GeometryChanged
                        )
                    ) {
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
        let mut process = tokio::process::Command::new(binary);
        #[cfg(target_os = "windows")]
        {
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
            .stderr(std::process::Stdio::null())
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
        // Queue age stays100ms. Native text execution is separately bounded by
        // the independent input lease; do not confuse queue delay with batch time.
        let call_budget = if matches!(
            command,
            Command::Input {
                event: Input::Text(_)
            }
        ) {
            INPUT_TTL + QUEUE_TTL
        } else {
            QUEUE_TTL
        };
        match tokio::time::timeout(call_budget, action).await {
            Ok(Ok(Event::Failed { cause })) => {
                self.stdin.take();
                Err(cause.into())
            }
            Ok(Ok(response)) => Ok(response),
            _ => {
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
