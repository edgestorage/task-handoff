use regex::Regex;
use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{watch, Notify},
    task::JoinHandle,
};

const ALLOWED_SUBCOMMANDS: &[&str] = &[
    "add",
    "branch",
    "checkout",
    "commit",
    "diff",
    "fetch",
    "for-each-ref",
    "ls-files",
    "pull",
    "push",
    "remote",
    "reset",
    "restore",
    "rev-list",
    "rev-parse",
    "show",
    "stash",
    "status",
    "symbolic-ref",
    "update-index",
    "worktree",
    "write-tree",
];

#[derive(Debug, Clone)]
pub struct GitProcessOptions {
    pub git_command: Option<String>,
    pub timeout: Duration,
    pub output_limit_bytes: usize,
    pub remote: bool,
    pub accepted_exit_codes: Vec<i32>,
    pub cancellation: Option<GitCancellation>,
}

impl Default for GitProcessOptions {
    fn default() -> Self {
        Self {
            git_command: None,
            timeout: Duration::from_secs(15),
            output_limit_bytes: 8 * 1024 * 1024,
            remote: false,
            accepted_exit_codes: Vec::new(),
            cancellation: None,
        }
    }
}

#[derive(Clone)]
pub struct GitCancellation {
    sender: watch::Sender<bool>,
    receiver: watch::Receiver<bool>,
}

impl Default for GitCancellation {
    fn default() -> Self {
        let (sender, receiver) = watch::channel(false);
        Self { sender, receiver }
    }
}

impl std::fmt::Debug for GitCancellation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitCancellation")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl GitCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        let _ = self.sender.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    async fn cancelled(&self) {
        let mut receiver = self.receiver.clone();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct GitProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Error)]
pub enum GitError {
    #[error("Git executable is unavailable.")]
    NotFound,
    #[error("Git operation exceeded {0}ms.")]
    Timeout(u64),
    #[error("Git output exceeded {0} bytes.")]
    OutputLimit(usize),
    #[error("Git operation was aborted.")]
    Aborted,
    #[error("Git subcommand is not allowed: {0}")]
    DisallowedSubcommand(String),
    #[error("Git arguments must be NUL-free strings.")]
    InvalidArgument,
    #[error("{message}")]
    Exit {
        message: String,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("Git process failed: {0}")]
    Process(String),
}

#[derive(Clone)]
pub struct GitProcess {
    cwd: PathBuf,
    defaults: GitProcessOptions,
}

impl GitProcess {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            defaults: GitProcessOptions::default(),
        }
    }

    pub fn with_defaults(cwd: impl Into<PathBuf>, defaults: GitProcessOptions) -> Self {
        Self {
            cwd: cwd.into(),
            defaults,
        }
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub async fn run(
        &self,
        subcommand: &str,
        args: &[String],
    ) -> Result<GitProcessResult, GitError> {
        self.run_with_options(subcommand, args, GitProcessOptions::default())
            .await
    }

    pub async fn run_with_options(
        &self,
        subcommand: &str,
        args: &[String],
        options: GitProcessOptions,
    ) -> Result<GitProcessResult, GitError> {
        if !ALLOWED_SUBCOMMANDS.contains(&subcommand) {
            return Err(GitError::DisallowedSubcommand(subcommand.to_string()));
        }
        if args.iter().any(|arg| arg.contains('\0')) {
            return Err(GitError::InvalidArgument);
        }
        let git_command = options
            .git_command
            .or_else(|| self.defaults.git_command.clone())
            .or_else(|| std::env::var("TASK_HANDOFF_GIT_COMMAND").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "git".to_string());
        let timeout_duration = if options.timeout != GitProcessOptions::default().timeout {
            options.timeout
        } else {
            self.defaults.timeout
        };
        let output_limit =
            if options.output_limit_bytes != GitProcessOptions::default().output_limit_bytes {
                options.output_limit_bytes
            } else {
                self.defaults.output_limit_bytes
            };
        let remote = options.remote || self.defaults.remote;
        let accepted = if options.accepted_exit_codes.is_empty() {
            &self.defaults.accepted_exit_codes
        } else {
            &options.accepted_exit_codes
        };
        let accepted = accepted.iter().copied().collect::<HashSet<_>>();
        let cancellation = options
            .cancellation
            .clone()
            .or_else(|| self.defaults.cancellation.clone());
        if cancellation
            .as_ref()
            .is_some_and(GitCancellation::is_cancelled)
        {
            return Err(GitError::Aborted);
        }
        let mut command_args = vec![
            "-c".to_string(),
            "color.ui=false".to_string(),
            "-c".to_string(),
            "core.pager=cat".to_string(),
            "-c".to_string(),
            "pager.branch=false".to_string(),
            "-c".to_string(),
            "diff.external=".to_string(),
            "-c".to_string(),
            "diff.trustExitCode=false".to_string(),
            "-c".to_string(),
            "diff.colorMoved=false".to_string(),
            subcommand.to_string(),
        ];
        if matches!(subcommand, "diff" | "show") {
            command_args.push("--no-ext-diff".to_string());
            command_args.push("--no-textconv".to_string());
        }
        command_args.extend(args.iter().cloned());

        let mut command = Command::new(git_command);
        command
            .args(command_args)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("GIT_PAGER", "cat")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_EXTERNAL_DIFF", "")
            .env("GIT_TERMINAL_PROMPT", "0");
        #[cfg(unix)]
        command.process_group(0);
        if remote {
            command.env("GCM_INTERACTIVE", "Never");
            if std::env::var("TASK_HANDOFF_GIT_CREDENTIAL_SOCKET").is_err() {
                let askpass = if cfg!(windows) {
                    "cmd /c exit 1"
                } else {
                    "/bin/false"
                };
                command
                    .env("GIT_ASKPASS", askpass)
                    .env("SSH_ASKPASS", askpass)
                    .env("SSH_ASKPASS_REQUIRE", "force")
                    .env(
                        "GIT_SSH_COMMAND",
                        "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
                    );
            }
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::NotFound
            } else {
                GitError::Process(error.to_string())
            }
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::Process("Git stdout was unavailable.".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| GitError::Process("Git stderr was unavailable.".to_string()))?;
        let output_budget = Arc::new(OutputBudget::new(output_limit));
        let stdout_task = tokio::spawn(read_output(stdout, output_budget.clone()));
        let stderr_task = tokio::spawn(read_output(stderr, output_budget.clone()));
        let output_exceeded = output_budget.exceeded.notified();
        tokio::pin!(output_exceeded);
        let cancellation_requested = async {
            match cancellation.as_ref() {
                Some(cancellation) => cancellation.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(cancellation_requested);
        let deadline = tokio::time::sleep(timeout_duration);
        tokio::pin!(deadline);

        let outcome = tokio::select! {
            biased;
            _ = &mut cancellation_requested, if cancellation.is_some() => GitWaitOutcome::Stopped(GitStopReason::Aborted),
            _ = &mut output_exceeded => GitWaitOutcome::Stopped(GitStopReason::OutputLimit),
            _ = &mut deadline => GitWaitOutcome::Stopped(GitStopReason::Timeout),
            result = child.wait() => {
                match result {
                    Ok(status) => GitWaitOutcome::Exited(status),
                    Err(error) => {
                        terminate_process_tree(&mut child).await;
                        let _ = join_output_tasks(stdout_task, stderr_task).await;
                        return Err(GitError::Process(error.to_string()));
                    }
                }
            }
        };
        let status = match outcome {
            GitWaitOutcome::Exited(status) => status,
            GitWaitOutcome::Stopped(stop_reason) => {
                terminate_process_tree(&mut child).await;
                let _ = child.wait().await;
                let _ = join_output_tasks(stdout_task, stderr_task).await;
                return Err(match stop_reason {
                    GitStopReason::Aborted => GitError::Aborted,
                    GitStopReason::OutputLimit => GitError::OutputLimit(output_limit),
                    GitStopReason::Timeout => {
                        GitError::Timeout(timeout_duration.as_millis() as u64)
                    }
                });
            }
        };
        let (stdout, stderr) = join_output_tasks(stdout_task, stderr_task).await?;
        if output_budget.exceeded() {
            return Err(GitError::OutputLimit(output_limit));
        }
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        let stderr = redact_git_diagnostic(&String::from_utf8_lossy(&stderr));
        let exit_code = status.code().unwrap_or(-1);
        if exit_code != 0 && !accepted.contains(&exit_code) {
            let message = if stderr.trim().is_empty() {
                format!("Git exited with code {exit_code}.")
            } else {
                stderr.trim().to_string()
            };
            return Err(GitError::Exit {
                message,
                exit_code: Some(exit_code),
                stderr,
            });
        }
        Ok(GitProcessResult {
            stdout,
            stderr,
            exit_code,
        })
    }
}

enum GitStopReason {
    Aborted,
    OutputLimit,
    Timeout,
}

enum GitWaitOutcome {
    Exited(std::process::ExitStatus),
    Stopped(GitStopReason),
}

struct OutputBudget {
    limit: usize,
    bytes: AtomicUsize,
    exceeded: Notify,
}

impl OutputBudget {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            bytes: AtomicUsize::new(0),
            exceeded: Notify::new(),
        }
    }

    fn record(&self, bytes: usize) -> bool {
        let total = self.bytes.fetch_add(bytes, Ordering::AcqRel) + bytes;
        if total > self.limit {
            self.exceeded.notify_one();
            false
        } else {
            true
        }
    }

    fn exceeded(&self) -> bool {
        self.bytes.load(Ordering::Acquire) > self.limit
    }
}

async fn read_output<R>(mut reader: R, budget: Arc<OutputBudget>) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(output);
        }
        if !budget.record(read) {
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn join_output_tasks(
    stdout_task: JoinHandle<io::Result<Vec<u8>>>,
    stderr_task: JoinHandle<io::Result<Vec<u8>>>,
) -> Result<(Vec<u8>, Vec<u8>), GitError> {
    let join = async {
        let stdout = stdout_task
            .await
            .map_err(|error| GitError::Process(error.to_string()))?
            .map_err(|error| GitError::Process(error.to_string()))?;
        let stderr = stderr_task
            .await
            .map_err(|error| GitError::Process(error.to_string()))?
            .map_err(|error| GitError::Process(error.to_string()))?;
        Ok((stdout, stderr))
    };
    match tokio::time::timeout(Duration::from_secs(1), join).await {
        Ok(result) => result,
        Err(_) => Err(GitError::Process(
            "Git output reader did not stop after process termination.".to_string(),
        )),
    }
}

async fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

struct DiagnosticPattern {
    pattern: Regex,
    replacement: &'static str,
}

fn diagnostic_patterns() -> &'static Vec<DiagnosticPattern> {
    static PATTERNS: OnceLock<Vec<DiagnosticPattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            DiagnosticPattern {
                pattern: Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----").expect("private key pattern"),
                replacement: "***",
            },
            DiagnosticPattern {
                pattern: Regex::new(r"([a-z][a-z0-9+.-]*://)([^\s/@:]+)(?::[^\s/@]*)?@").expect("url credential pattern"),
                replacement: "$1***@",
            },
            DiagnosticPattern {
                pattern: Regex::new(r"\b(?:ghp|github_pat|glpat|xox[baprs])-[-_a-zA-Z0-9]+\b").expect("token pattern"),
                replacement: "***",
            },
            DiagnosticPattern {
                pattern: Regex::new(r"([?&](?:access_token|token|key|password|signature)=)[^&\s]+").expect("query token pattern"),
                replacement: "$1***",
            },
            DiagnosticPattern {
                pattern: Regex::new(r"(?i)(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+").expect("authorization pattern"),
                replacement: "$1***",
            },
            DiagnosticPattern {
                pattern: Regex::new(r#"(?:/run/task-handoff/git-broker|/private/tmp/task-handoff-git-broker|/tmp/task-handoff-git-broker)[^\s'"]*"#).expect("broker path pattern"),
                replacement: "[git-broker-runtime]",
            },
        ]
    })
}

pub fn redact_git_diagnostic(value: &str) -> String {
    let mut redacted = value.to_string();
    for pattern in diagnostic_patterns() {
        redacted = pattern
            .pattern
            .replace_all(&redacted, pattern.replacement)
            .into_owned();
    }
    redacted
}

pub fn redact_remote_url(value: &str) -> String {
    static SSH_REMOTE: OnceLock<Regex> = OnceLock::new();
    let pattern = SSH_REMOTE
        .get_or_init(|| Regex::new(r"^([^@\s]+)@([^:\s]+):").expect("ssh remote pattern"));
    pattern
        .replace_all(&redact_git_diagnostic(value), "***@$2:")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn diagnostics_keep_context_but_remove_credentials() {
        let value = concat!(
            "fetch https://user:secret@example.test/repo failed\n",
            "Authorization: Bearer abc123\n",
            "credential at ?token=secret&mode=read\n",
            "broker /run/task-handoff/git-broker/socket.sock\n"
        );
        let redacted = redact_git_diagnostic(value);
        assert!(redacted.contains("https://***@example.test/repo"));
        assert!(redacted.contains("Authorization: Bearer ***"));
        assert!(redacted.contains("?token=***&mode=read"));
        assert!(redacted.contains("[git-broker-runtime]"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("abc123"));
    }

    #[test]
    fn scp_remotes_keep_the_host_and_redact_the_user() {
        assert_eq!(
            redact_remote_url("git@github.com:owner/repo.git"),
            "***@github.com:owner/repo.git"
        );
    }

    #[cfg(unix)]
    fn install_fake_git(directory: &Path, body: &str) -> PathBuf {
        let path = directory.join("fake-git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("fake git");
        let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("permissions");
        path
    }

    #[cfg(unix)]
    fn options(git_command: &Path) -> GitProcessOptions {
        GitProcessOptions {
            git_command: Some(git_command.display().to_string()),
            timeout: Duration::from_secs(5),
            ..GitProcessOptions::default()
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_budget_is_shared_between_stdout_and_stderr() {
        let directory = tempfile::tempdir().expect("tempdir");
        let git = install_fake_git(
            directory.path(),
            "printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nprintf '%s' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' >&2",
        );
        let mut options = options(&git);
        options.output_limit_bytes = 64;

        let error = GitProcess::new(directory.path())
            .run_with_options("status", &[], options)
            .await
            .expect_err("combined output exceeds the shared budget");

        assert!(matches!(error, GitError::OutputLimit(64)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_and_cancellation_are_reported_separately() {
        let directory = tempfile::tempdir().expect("tempdir");
        let git = install_fake_git(directory.path(), "sleep 5");
        let mut timeout_options = options(&git);
        timeout_options.timeout = Duration::from_millis(50);
        let timeout_error = GitProcess::new(directory.path())
            .run_with_options("status", &[], timeout_options)
            .await
            .expect_err("timed out");
        assert!(matches!(timeout_error, GitError::Timeout(50)));

        let cancellation = GitCancellation::new();
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let mut cancellation_options = options(&git);
        cancellation_options.cancellation = Some(cancellation);
        let cancellation_error = GitProcess::new(directory.path())
            .run_with_options("status", &[], cancellation_options)
            .await
            .expect_err("cancelled");
        assert!(matches!(cancellation_error, GitError::Aborted));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_the_git_process_group() {
        let directory = tempfile::tempdir().expect("tempdir");
        let child_pid_path = directory.path().join("child.pid");
        let ready_path = directory.path().join("cancel.ready");
        let git = install_fake_git(
            directory.path(),
            &format!(
                "sleep 30 &\necho $! > '{}'\nwhile [ ! -f '{}' ]; do sleep 0.01; done\nwait",
                child_pid_path.display(),
                ready_path.display()
            ),
        );
        let cancellation = GitCancellation::new();
        let cancel = cancellation.clone();
        let observed_pid_path = child_pid_path.clone();
        let observed_ready_path = ready_path.clone();
        tokio::spawn(async move {
            for _ in 0..1_000 {
                if observed_pid_path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            std::fs::write(&observed_ready_path, b"ready").expect("release fake git");
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let mut options = options(&git);
        options.cancellation = Some(cancellation);

        let error = GitProcess::new(directory.path())
            .run_with_options("status", &[], options)
            .await
            .expect_err("cancelled");
        assert!(matches!(error, GitError::Aborted));

        let child_pid = std::fs::read_to_string(&child_pid_path)
            .expect("child pid")
            .trim()
            .parse::<i32>()
            .expect("numeric pid");
        let mut still_running = true;
        for _ in 0..40 {
            let result = unsafe { libc::kill(child_pid, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                still_running = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(!still_running, "git child process survived cancellation");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executable_and_exit_failures_are_reported_separately() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut missing_options = options(&directory.path().join("missing-git"));
        missing_options.timeout = Duration::from_secs(1);
        let missing = GitProcess::new(directory.path())
            .run_with_options("status", &[], missing_options)
            .await
            .expect_err("missing executable");
        assert!(matches!(missing, GitError::NotFound));

        let git = install_fake_git(directory.path(), "exit 7");
        let failed = GitProcess::new(directory.path())
            .run_with_options("status", &[], options(&git))
            .await
            .expect_err("git exited unsuccessfully");
        assert!(matches!(
            failed,
            GitError::Exit {
                exit_code: Some(7),
                ..
            }
        ));
    }
}
