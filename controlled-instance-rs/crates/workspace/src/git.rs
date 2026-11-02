use regex::Regex;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use thiserror::Error;
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

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
}

impl Default for GitProcessOptions {
    fn default() -> Self {
        Self {
            git_command: None,
            timeout: Duration::from_secs(15),
            output_limit_bytes: 8 * 1024 * 1024,
            remote: false,
            accepted_exit_codes: Vec::new(),
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
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take((output_limit + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take((output_limit + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = match timeout(timeout_duration, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => {
                let _ = child.kill().await;
                return Err(GitError::Process(error.to_string()));
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(GitError::Timeout(timeout_duration.as_millis() as u64));
            }
        };
        let stdout = stdout_task
            .await
            .map_err(|error| GitError::Process(error.to_string()))?
            .map_err(|error| GitError::Process(error.to_string()))?;
        let stderr = stderr_task
            .await
            .map_err(|error| GitError::Process(error.to_string()))?
            .map_err(|error| GitError::Process(error.to_string()))?;
        if stdout.len() > output_limit || stderr.len() > output_limit {
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
}
