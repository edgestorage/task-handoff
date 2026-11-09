//! Opt-in OS clipboard in a separate, bounded inherited-pipe worker. A slow
//! clipboard owner cannot block the input watchdog or share its native handles.
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, time::Duration};
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Read,
    Write { text: String },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    Ready { nonce: String },
    Text { text: String },
    Written,
    Unavailable,
}
fn valid(text: &str) -> bool {
    text.len() <= crate::channel::MAX_CLIPBOARD_TEXT
        && !text.contains('\0')
        && serde_json::to_vec(&Reply::Text { text: text.into() })
            .is_ok_and(|wire| wire.len() <= crate::channel::MAX_CLIPBOARD_WIRE - 256)
}
pub fn run() -> anyhow::Result<()> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let nonce: String = crate::input_guard::read(&mut input)?;
    anyhow::ensure!(nonce.len() == 64, "invalid clipboard bootstrap");
    let mut clipboard = arboard::Clipboard::new()?;
    crate::input_guard::write(&mut output, &Reply::Ready { nonce })?;
    let (commands, pending) = std::sync::mpsc::sync_channel(8);
    drop(input);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        while let Ok(command) = crate::input_guard::read::<_, Command>(&mut input) {
            if commands.try_send(command).is_err() {
                break;
            }
        }
        // No held input belongs to this process. EOF/backpressure must also
        // terminate a native clipboard call blocked by an external owner.
        std::process::exit(0);
    });
    while let Ok(command) = pending.recv() {
        let reply = match command {
            Command::Read => match clipboard.get_text() {
                Ok(text) if valid(&text) => Reply::Text { text },
                _ => Reply::Unavailable,
            },
            Command::Write { text } if valid(&text) => {
                if clipboard.set_text(text).is_ok() {
                    Reply::Written
                } else {
                    Reply::Unavailable
                }
            }
            _ => Reply::Unavailable,
        };
        crate::input_guard::write(&mut output, &reply)?;
    }
    Ok(())
}
pub struct Client {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::process::ChildStdout,
    #[cfg(target_os = "windows")]
    _job: crate::platform::windows_job::Job,
}
impl Client {
    pub async fn spawn(
        binary: &Path,
        display: Option<String>,
        authority: Option<std::path::PathBuf>,
    ) -> anyhow::Result<Self> {
        let mut command = tokio::process::Command::new(binary);
        #[cfg(target_os = "windows")]
        let job = crate::platform::windows_job::Job::new(false)?;
        if let Some(display) = display {
            command.env("DISPLAY", display);
        }
        if let Some(authority) = authority {
            command.env("XAUTHORITY", authority);
        }
        let mut child = command
            .arg("--clipboard-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        #[cfg(target_os = "windows")]
        job.assign(&mut child).await?;
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let nonce = crate::session::secret();
        crate::framing::write(&mut input, &nonce).await?;
        let reply = tokio::time::timeout(
            Duration::from_secs(2),
            crate::framing::read::<Reply>(&mut output),
        )
        .await??;
        anyhow::ensure!(
            matches!(reply, Some(Reply::Ready{nonce:echo}) if echo==nonce),
            "REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE"
        );
        Ok(Self {
            child,
            input,
            output,
            #[cfg(target_os = "windows")]
            _job: job,
        })
    }
    pub async fn call(&mut self, command: &Command) -> anyhow::Result<Reply> {
        let action = async {
            crate::framing::write(&mut self.input, command).await?;
            crate::framing::read::<Reply>(&mut self.output)
                .await?
                .ok_or_else(|| anyhow::anyhow!("clipboard closed"))
        };
        match tokio::time::timeout(Duration::from_millis(100), action).await {
            Ok(Ok(reply)) => Ok(reply),
            _ => {
                let _ = self.child.start_kill();
                anyhow::bail!("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE")
            }
        }
    }
}
