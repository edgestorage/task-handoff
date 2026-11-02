use controlled_instance_core::git_transport::{
    parse_git_ssh_invocation, remote_from_https_credential_request,
};
use controlled_instance_protocol::{
    resolve_git_credential, GitCredentialKind, GitCredentialMatchCandidate,
    GitCredentialMatchResult, GitCredentialScope,
};
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::git_credentials::{print_credential, read_credential_input, run_ssh};

const DEFAULT_GIT_RUNTIME_DIR: &str = "/run/task-handoff/git-runtime";

#[derive(Debug, Error)]
pub enum GitProvisioningError {
    #[error("TASK_HANDOFF_GIT_PROVISIONING_ERROR={0}")]
    Marked(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl GitProvisioningError {
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Marked(code) => Some(code),
            _ => None,
        }
    }
}

struct CredentialEntry {
    candidate: GitCredentialMatchCandidate,
    directory: PathBuf,
}

pub fn git_runtime_dir() -> PathBuf {
    std::env::var_os("TASK_HANDOFF_GIT_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(DEFAULT_GIT_RUNTIME_DIR))
}

pub fn select_provisioning_credential(
    remote: &str,
    runtime_dir: &Path,
) -> Result<PathBuf, GitProvisioningError> {
    let entries = credential_candidates(runtime_dir)?;
    let candidates = entries
        .iter()
        .map(|entry| entry.candidate.clone())
        .collect::<Vec<_>>();
    match resolve_git_credential(remote, &candidates) {
        GitCredentialMatchResult::Unique { credential, .. } => entries
            .into_iter()
            .find(|entry| entry.candidate.id == credential.id)
            .map(|entry| entry.directory)
            .ok_or(GitProvisioningError::Marked("CREDENTIAL_MISSING")),
        GitCredentialMatchResult::None { .. } => {
            Err(GitProvisioningError::Marked("CREDENTIAL_MISSING"))
        }
        GitCredentialMatchResult::Ambiguous { .. } => {
            Err(GitProvisioningError::Marked("AMBIGUOUS"))
        }
        GitCredentialMatchResult::Unsupported { .. } => {
            Err(GitProvisioningError::Marked("UNSUPPORTED"))
        }
        GitCredentialMatchResult::MissingHostKey { .. } => {
            Err(GitProvisioningError::Marked("MISSING_HOST_KEY"))
        }
    }
}

fn credential_candidates(runtime_dir: &Path) -> Result<Vec<CredentialEntry>, GitProvisioningError> {
    let mut directories = std::fs::read_dir(runtime_dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("credential-")
                .then_some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| left.0.cmp(&right.0));
    let mut entries = Vec::new();
    for (id, directory) in directories {
        let scope_path = directory.join("scope.json");
        if !scope_path.is_file() {
            continue;
        }
        let has_token = directory.join("token").is_file();
        let has_ssh_identity = directory.join("public-identity").is_file();
        if !has_token && !has_ssh_identity {
            continue;
        }
        let scope: GitCredentialScope = serde_json::from_slice(&std::fs::read(scope_path)?)?;
        entries.push(CredentialEntry {
            candidate: GitCredentialMatchCandidate {
                id,
                kind: if has_token {
                    GitCredentialKind::HttpsToken
                } else {
                    GitCredentialKind::SshKey
                },
                scope,
                enabled: true,
                pinned_known_hosts: has_ssh_identity && directory.join("known_hosts").is_file(),
            },
            directory,
        });
    }
    Ok(entries)
}

pub async fn run_provisioning_git_credential_helper(
    action: Option<&str>,
) -> Result<(), GitProvisioningError> {
    if action != Some("get") {
        return Ok(());
    }
    let input = read_credential_input().await;
    let remote = remote_from_https_credential_request(
        input.get("protocol").map(String::as_str),
        input.get("host").map(String::as_str),
        input.get("path").map(String::as_str),
    )
    .ok_or(GitProvisioningError::Marked("REMOTE_UNSUPPORTED"))?;
    let directory = match select_provisioning_credential(&remote, &git_runtime_dir()) {
        Ok(directory) => directory,
        Err(error) if error.code() == Some("CREDENTIAL_MISSING") => {
            eprintln!("TASK_HANDOFF_GIT_PROVISIONING_ERROR=CREDENTIAL_MISSING");
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let username = std::fs::read_to_string(directory.join("username"))?;
    let token = std::fs::read_to_string(directory.join("token"))?;
    print_credential(&username, &token);
    Ok(())
}

pub async fn run_provisioning_git_ssh(args: &[String]) -> Result<(), GitProvisioningError> {
    let invocation =
        parse_git_ssh_invocation(args).ok_or(GitProvisioningError::Marked("REMOTE_UNSUPPORTED"))?;
    let directory = select_provisioning_credential(&invocation.remote, &git_runtime_dir())?;
    let agent_socket = directory.join("agent.sock");
    let public_identity = directory.join("public-identity");
    let known_hosts = directory.join("known_hosts");
    if !agent_socket.exists() {
        return Err(GitProvisioningError::Marked("SSH_AGENT_UNAVAILABLE"));
    }
    if !known_hosts.exists()
        || std::fs::metadata(&known_hosts)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true)
    {
        return Err(GitProvisioningError::Marked("HOST_KEY_REQUIRED"));
    }
    let mut managed_args = vec![
        "-F".to_string(),
        "/dev/null".to_string(),
        "-oBatchMode=yes".to_string(),
        "-oPasswordAuthentication=no".to_string(),
        "-oKbdInteractiveAuthentication=no".to_string(),
        "-oIdentitiesOnly=yes".to_string(),
        "-oIdentityFile=none".to_string(),
        "-oStrictHostKeyChecking=yes".to_string(),
        format!("-oUserKnownHostsFile={}", known_hosts.display()),
        "-oGlobalKnownHostsFile=/dev/null".to_string(),
        format!("-oIdentityAgent={}", agent_socket.display()),
        "-i".to_string(),
        public_identity.to_string_lossy().into_owned(),
    ];
    managed_args.extend(invocation.args);
    run_ssh(&managed_args, true, Some(&agent_socket)).map_err(GitProvisioningError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn credential(
        root: &Path,
        index: usize,
        scope: serde_json::Value,
        files: &[(&str, &str)],
    ) -> PathBuf {
        let directory = root.join(format!("credential-{index}"));
        std::fs::create_dir_all(&directory).expect("credential directory");
        std::fs::write(directory.join("scope.json"), scope.to_string()).expect("scope");
        for (name, value) in files {
            std::fs::write(directory.join(name), value).expect("credential file");
        }
        directory
    }

    #[test]
    fn provisioning_selection_uses_the_protocol_normalizer() {
        let root = tempfile::tempdir().expect("tempdir");
        credential(
            root.path(),
            0,
            json!({ "scheme": "https", "host": "git.example.com", "pathPrefix": "/" }),
            &[("username", "root"), ("token", "root-token")],
        );
        let repository = credential(
            root.path(),
            1,
            json!({ "scheme": "https", "host": "git.example.com", "pathPrefix": "/team/repo/" }),
            &[("username", "repo"), ("token", "repo-token")],
        );
        let ipv6 = credential(
            root.path(),
            2,
            json!({ "scheme": "https", "host": "::1", "port": 8443, "pathPrefix": "/Team/" }),
            &[("username", "ipv6"), ("token", "ipv6-token")],
        );
        let idna = credential(
            root.path(),
            3,
            json!({ "scheme": "https", "host": "xn--bcher-kva.example", "pathPrefix": "/" }),
            &[("username", "idna"), ("token", "idna-token")],
        );
        assert_eq!(
            select_provisioning_credential(
                "https://git.example.com:443/team/repo.git",
                root.path()
            )
            .expect("repository"),
            repository
        );
        assert_eq!(
            select_provisioning_credential("https://[::1]:8443/Team/Repo.git", root.path())
                .expect("ipv6"),
            ipv6
        );
        assert_eq!(
            select_provisioning_credential("https://bücher.example/project.git", root.path())
                .expect("idna"),
            idna
        );
    }

    #[test]
    fn provisioning_selection_preserves_longest_scope_and_ambiguity() {
        let root = tempfile::tempdir().expect("tempdir");
        credential(
            root.path(),
            0,
            json!({ "scheme": "ssh", "host": "git.example.com", "pathPrefix": "/" }),
            &[
                ("public-identity", "ssh-ed25519 root"),
                ("known_hosts", "host key"),
            ],
        );
        let team = credential(
            root.path(),
            1,
            json!({ "scheme": "ssh", "host": "git.example.com", "pathPrefix": "/team/" }),
            &[
                ("public-identity", "ssh-ed25519 team"),
                ("known_hosts", "host key"),
            ],
        );
        assert_eq!(
            select_provisioning_credential("git@git.example.com:team/submodule.git", root.path())
                .expect("team"),
            team
        );
        credential(
            root.path(),
            2,
            json!({ "scheme": "ssh", "host": "git.example.com", "pathPrefix": "/team/" }),
            &[
                ("public-identity", "ssh-ed25519 duplicate"),
                ("known_hosts", "host key"),
            ],
        );
        let error =
            select_provisioning_credential("git@git.example.com:team/submodule.git", root.path())
                .expect_err("ambiguous");
        assert_eq!(error.code(), Some("AMBIGUOUS"));
    }
}
