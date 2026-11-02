use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::{Host, Url};

pub const GIT_CREDENTIAL_REMOTE_MAX_BYTES: usize = 4096;
pub const GIT_CREDENTIAL_USERNAME_MAX_BYTES: usize = 240;
pub const GIT_CREDENTIAL_PASSWORD_MAX_BYTES: usize = 8192;
pub const GIT_CREDENTIAL_SSH_MATERIAL_MAX_BYTES: usize = 128 * 1024;
pub const GIT_CREDENTIAL_SSH_FRAME_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitCredentialScheme {
    Https,
    Ssh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitCredentialKind {
    HttpsToken,
    SshKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCredentialScope {
    pub scheme: GitCredentialScheme,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default = "default_path_prefix")]
    pub path_prefix: String,
}

fn default_path_prefix() -> String {
    "/".to_string()
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("Invalid Git credential scope: {0}")]
pub struct GitCredentialScopeError(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedGitRemote {
    pub scheme: GitCredentialScheme,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub path_prefix: String,
    pub original: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialMatchCandidate {
    pub id: String,
    pub kind: GitCredentialKind,
    pub scope: GitCredentialScope,
    pub enabled: bool,
    pub pinned_known_hosts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GitCredentialMatchResult {
    Unique {
        remote: NormalizedGitRemote,
        credential: GitCredentialMatchCandidate,
    },
    None {
        remote: NormalizedGitRemote,
    },
    Ambiguous {
        remote: NormalizedGitRemote,
        #[serde(rename = "credentialIds")]
        credential_ids: Vec<String>,
    },
    Unsupported {
        reason: String,
    },
    MissingHostKey {
        remote: NormalizedGitRemote,
        #[serde(rename = "credentialId")]
        credential_id: String,
    },
}

pub fn normalize_git_credential_scope(
    scope: &GitCredentialScope,
) -> Result<GitCredentialScope, GitCredentialScopeError> {
    let default_port = match scope.scheme {
        GitCredentialScheme::Https => 443,
        GitCredentialScheme::Ssh => 22,
    };
    Ok(GitCredentialScope {
        scheme: scope.scheme,
        host: normalize_git_host(&scope.host)?,
        port: scope.port.filter(|port| *port != default_port),
        path_prefix: normalize_git_path_prefix(&scope.path_prefix)?,
    })
}

pub fn normalize_git_remote(remote: &str) -> Result<NormalizedGitRemote, GitCredentialScopeError> {
    let value = remote.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(invalid_scope("remote is empty or invalid"));
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ssh://")
    {
        let after_scheme = value
            .find("://")
            .map(|index| index + 3)
            .ok_or_else(|| invalid_scope("remote URL is invalid"))?;
        let raw_path = value[after_scheme..]
            .find('/')
            .map(|index| &value[after_scheme + index..])
            .unwrap_or("/")
            .split(['?', '#'])
            .next()
            .unwrap_or("/");
        normalize_git_path_prefix(raw_path)?;
        let url = Url::parse(value).map_err(|_| invalid_scope("remote URL is invalid"))?;
        if url.scheme() != "https" && url.scheme() != "ssh" {
            return Err(invalid_scope("remote scheme is unsupported"));
        }
        if url.password().is_some() || (url.scheme() == "https" && !url.username().is_empty()) {
            return Err(invalid_scope("HTTPS userinfo is forbidden"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(invalid_scope("query and fragment are forbidden"));
        }
        let scheme = if url.scheme() == "https" {
            GitCredentialScheme::Https
        } else {
            GitCredentialScheme::Ssh
        };
        let host = url
            .host()
            .map(normalize_url_host)
            .transpose()?
            .ok_or_else(|| invalid_scope("host is invalid"))?;
        let normalized = normalize_git_credential_scope(&GitCredentialScope {
            scheme,
            host,
            port: url.port(),
            path_prefix: git_remote_path(url.path())?,
        })?;
        return Ok(NormalizedGitRemote {
            scheme: normalized.scheme,
            host: normalized.host,
            port: normalized.port,
            path_prefix: normalized.path_prefix,
            original: value.to_string(),
        });
    }
    if has_unsupported_url_scheme(value) {
        return Err(invalid_scope("remote scheme is unsupported"));
    }

    let (authority, path) = value
        .split_once(':')
        .ok_or_else(|| invalid_scope("remote must use HTTPS, ssh://, or scp-like SSH syntax"))?;
    if path.is_empty() {
        return Err(invalid_scope(
            "remote must use HTTPS, ssh://, or scp-like SSH syntax",
        ));
    }
    if path.contains('?') || path.contains('#') {
        return Err(invalid_scope("query and fragment are forbidden"));
    }
    let mut authority_parts = authority.split('@');
    let host = match (
        authority_parts.next(),
        authority_parts.next(),
        authority_parts.next(),
    ) {
        (Some(host), None, None) => host,
        (Some(user), Some(host), None)
            if !user.is_empty()
                && !user.chars().any(|character| {
                    character == '/' || character == ':' || character.is_whitespace()
                }) =>
        {
            host
        }
        _ => {
            return Err(invalid_scope(
                "remote must use HTTPS, ssh://, or scp-like SSH syntax",
            ))
        }
    };
    if host.is_empty()
        || host
            .chars()
            .any(|character| character == '/' || character == ':' || character.is_whitespace())
    {
        return Err(invalid_scope(
            "remote must use HTTPS, ssh://, or scp-like SSH syntax",
        ));
    }
    let normalized = normalize_git_credential_scope(&GitCredentialScope {
        scheme: GitCredentialScheme::Ssh,
        host: host.to_string(),
        port: None,
        path_prefix: git_remote_path(path)?,
    })?;
    Ok(NormalizedGitRemote {
        scheme: normalized.scheme,
        host: normalized.host,
        port: normalized.port,
        path_prefix: normalized.path_prefix,
        original: value.to_string(),
    })
}

pub fn resolve_git_credential(
    remote: &str,
    candidates: &[GitCredentialMatchCandidate],
) -> GitCredentialMatchResult {
    let remote = match normalize_git_remote(remote) {
        Ok(remote) => remote,
        Err(error) => {
            return GitCredentialMatchResult::Unsupported {
                reason: error.to_string(),
            }
        }
    };
    let mut matches = candidates
        .iter()
        .filter(|candidate| candidate.enabled)
        .filter(|candidate| {
            matches!(
                (remote.scheme, candidate.kind),
                (GitCredentialScheme::Https, GitCredentialKind::HttpsToken)
                    | (GitCredentialScheme::Ssh, GitCredentialKind::SshKey)
            )
        })
        .filter_map(|candidate| {
            let scope = normalize_git_credential_scope(&candidate.scope).ok()?;
            let matches = scope.scheme == remote.scheme
                && scope.host == remote.host
                && scope.port == remote.port
                && (scope.path_prefix == "/" || remote.path_prefix.starts_with(&scope.path_prefix));
            matches.then_some((candidate, scope.path_prefix.len()))
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return GitCredentialMatchResult::None { remote };
    }
    let specificity = matches
        .iter()
        .map(|(_, specificity)| *specificity)
        .max()
        .unwrap_or_default();
    matches.retain(|(_, candidate_specificity)| *candidate_specificity == specificity);
    if matches.len() > 1 {
        let mut credential_ids = matches
            .iter()
            .map(|(candidate, _)| candidate.id.clone())
            .collect::<Vec<_>>();
        credential_ids.sort();
        return GitCredentialMatchResult::Ambiguous {
            remote,
            credential_ids,
        };
    }
    let credential = matches[0].0.clone();
    if credential.kind == GitCredentialKind::SshKey && !credential.pinned_known_hosts {
        return GitCredentialMatchResult::MissingHostKey {
            remote,
            credential_id: credential.id,
        };
    }
    GitCredentialMatchResult::Unique { remote, credential }
}

fn normalize_git_host(host: &str) -> Result<String, GitCredentialScopeError> {
    let trimmed = host.trim();
    let trimmed = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    if trimmed.is_empty()
        || trimmed.contains('*')
        || trimmed.chars().any(|character| {
            matches!(character, '/' | '?' | '#' | '@') || character.is_whitespace()
        })
    {
        return Err(invalid_scope("host is invalid"));
    }
    let parsed = if trimmed.contains(':') {
        Url::parse(&format!("http://[{trimmed}]/"))
    } else {
        Url::parse(&format!("http://{trimmed}/"))
    }
    .map_err(|_| invalid_scope("host is invalid"))?;
    let normalized = parsed
        .host()
        .map(normalize_url_host)
        .transpose()?
        .filter(|host| !host.is_empty() && host.len() <= 253 && !host.contains('*'))
        .ok_or_else(|| invalid_scope("host is invalid"))?;
    Ok(normalized)
}

fn normalize_url_host(host: Host<&str>) -> Result<String, GitCredentialScopeError> {
    match host {
        Host::Domain(domain) => Ok(domain.to_ascii_lowercase()),
        Host::Ipv4(address) => Ok(address.to_string()),
        Host::Ipv6(address) => Ok(address.to_string()),
    }
}

fn normalize_git_path_prefix(value: &str) -> Result<String, GitCredentialScopeError> {
    let raw = value.trim();
    let raw = if raw.is_empty() { "/" } else { raw };
    if raw
        .chars()
        .any(|character| matches!(character, '?' | '#' | '\\' | '\0'))
    {
        return Err(invalid_scope("path contains an unsupported delimiter"));
    }
    let with_slash = if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{raw}")
    };
    let segments = with_slash
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    for segment in &segments {
        if !has_valid_percent_encoding(segment) {
            return Err(invalid_scope("path contains invalid percent encoding"));
        }
        let decoded = percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| invalid_scope("path contains invalid percent encoding"))?;
        if decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('\0')
        {
            return Err(invalid_scope("path contains an unsafe segment"));
        }
    }
    if segments.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(format!("/{}/", segments.join("/")))
    }
}

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

fn git_remote_path(pathname: &str) -> Result<String, GitCredentialScopeError> {
    let without_suffix = pathname
        .strip_suffix(".git/")
        .or_else(|| pathname.strip_suffix(".git"))
        .unwrap_or(pathname);
    normalize_git_path_prefix(without_suffix)
}

fn has_unsupported_url_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    let mut characters = scheme.chars();
    matches!(characters.next(), Some(character) if character.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}

fn invalid_scope(message: &str) -> GitCredentialScopeError {
    GitCredentialScopeError(message.to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitCredentialFailureStatus {
    None,
    Ambiguous,
    Unsupported,
    MissingHostKey,
    Rejected,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GitCredentialHttpsResolveResponse {
    Ok { username: String, password: String },
    None,
    Ambiguous,
    Unsupported,
    MissingHostKey,
    Rejected,
}

impl std::fmt::Debug for GitCredentialHttpsResolveResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ok { .. } => formatter.write_str("Ok { credentials: <redacted> }"),
            Self::None => formatter.write_str("None"),
            Self::Ambiguous => formatter.write_str("Ambiguous"),
            Self::Unsupported => formatter.write_str("Unsupported"),
            Self::MissingHostKey => formatter.write_str("MissingHostKey"),
            Self::Rejected => formatter.write_str("Rejected"),
        }
    }
}

impl GitCredentialHttpsResolveResponse {
    pub fn failure(&self) -> Option<GitCredentialFailureStatus> {
        match self {
            Self::Ok { .. } => None,
            Self::None => Some(GitCredentialFailureStatus::None),
            Self::Ambiguous => Some(GitCredentialFailureStatus::Ambiguous),
            Self::Unsupported => Some(GitCredentialFailureStatus::Unsupported),
            Self::MissingHostKey => Some(GitCredentialFailureStatus::MissingHostKey),
            Self::Rejected => Some(GitCredentialFailureStatus::Rejected),
        }
    }

    pub fn validate(&self) -> bool {
        match self {
            Self::Ok { username, password } => {
                !username.is_empty()
                    && username.len() <= GIT_CREDENTIAL_USERNAME_MAX_BYTES
                    && !password.is_empty()
                    && password.len() <= GIT_CREDENTIAL_PASSWORD_MAX_BYTES
            }
            _ => true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GitCredentialSshPrepareResponse {
    Ok {
        #[serde(rename = "invocationId")]
        invocation_id: String,
        #[serde(rename = "publicIdentity")]
        public_identity: String,
        #[serde(rename = "pinnedKnownHosts")]
        pinned_known_hosts: String,
    },
    None,
    Ambiguous,
    Unsupported,
    MissingHostKey,
    Rejected,
}

impl std::fmt::Debug for GitCredentialSshPrepareResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ok {
                invocation_id,
                public_identity,
                pinned_known_hosts,
            } => formatter
                .debug_struct("Ok")
                .field("invocation_id", invocation_id)
                .field("public_identity_bytes", &public_identity.len())
                .field("pinned_known_hosts_bytes", &pinned_known_hosts.len())
                .finish(),
            Self::None => formatter.write_str("None"),
            Self::Ambiguous => formatter.write_str("Ambiguous"),
            Self::Unsupported => formatter.write_str("Unsupported"),
            Self::MissingHostKey => formatter.write_str("MissingHostKey"),
            Self::Rejected => formatter.write_str("Rejected"),
        }
    }
}

impl GitCredentialSshPrepareResponse {
    pub fn failure(&self) -> Option<GitCredentialFailureStatus> {
        match self {
            Self::Ok { .. } => None,
            Self::None => Some(GitCredentialFailureStatus::None),
            Self::Ambiguous => Some(GitCredentialFailureStatus::Ambiguous),
            Self::Unsupported => Some(GitCredentialFailureStatus::Unsupported),
            Self::MissingHostKey => Some(GitCredentialFailureStatus::MissingHostKey),
            Self::Rejected => Some(GitCredentialFailureStatus::Rejected),
        }
    }

    pub fn validate(&self) -> bool {
        match self {
            Self::Ok {
                invocation_id,
                public_identity,
                pinned_known_hosts,
            } => {
                !invocation_id.is_empty()
                    && !public_identity.is_empty()
                    && public_identity.len() <= GIT_CREDENTIAL_SSH_MATERIAL_MAX_BYTES
                    && !pinned_known_hosts.is_empty()
                    && pinned_known_hosts.len() <= GIT_CREDENTIAL_SSH_MATERIAL_MAX_BYTES
            }
            _ => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialSshAgentResponse {
    pub frame: String,
}

impl GitCredentialSshAgentResponse {
    pub fn validate(&self) -> bool {
        !self.frame.is_empty() && self.frame.len() <= GIT_CREDENTIAL_SSH_FRAME_MAX_BYTES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_statuses_match_the_node_contract() {
        assert_eq!(
            serde_json::to_value(GitCredentialHttpsResolveResponse::MissingHostKey)
                .expect("serialize"),
            serde_json::json!({ "status": "missing-host-key" })
        );
        assert_eq!(
            serde_json::from_value::<GitCredentialSshPrepareResponse>(serde_json::json!({
                "status": "ok",
                "invocationId": "gitssh_1",
                "publicIdentity": "ssh-ed25519 AAAA",
                "pinnedKnownHosts": "git.example.com ssh-ed25519 AAAA"
            }))
            .expect("deserialize"),
            GitCredentialSshPrepareResponse::Ok {
                invocation_id: "gitssh_1".to_string(),
                public_identity: "ssh-ed25519 AAAA".to_string(),
                pinned_known_hosts: "git.example.com ssh-ed25519 AAAA".to_string(),
            }
        );
    }

    #[test]
    fn credential_debug_output_never_contains_the_password() {
        let response = GitCredentialHttpsResolveResponse::Ok {
            username: "git".to_string(),
            password: "top-secret".to_string(),
        };
        assert!(!format!("{response:?}").contains("top-secret"));
    }

    fn scope(
        scheme: GitCredentialScheme,
        host: &str,
        port: Option<u16>,
        path: &str,
    ) -> GitCredentialScope {
        GitCredentialScope {
            scheme,
            host: host.to_string(),
            port,
            path_prefix: path.to_string(),
        }
    }

    fn candidate(
        id: &str,
        kind: GitCredentialKind,
        scope: GitCredentialScope,
        pinned_known_hosts: bool,
    ) -> GitCredentialMatchCandidate {
        GitCredentialMatchCandidate {
            id: id.to_string(),
            kind,
            scope,
            enabled: true,
            pinned_known_hosts,
        }
    }

    #[test]
    fn scope_normalization_matches_idna_ipv6_default_ports_and_trailing_slashes() {
        assert_eq!(
            normalize_git_credential_scope(&scope(
                GitCredentialScheme::Https,
                "Bücher.Example",
                Some(443),
                "team"
            ))
            .expect("scope"),
            scope(
                GitCredentialScheme::Https,
                "xn--bcher-kva.example",
                None,
                "/team/"
            )
        );
        assert_eq!(
            normalize_git_credential_scope(&scope(
                GitCredentialScheme::Ssh,
                "[::1]",
                Some(22),
                "/"
            ))
            .expect("scope"),
            scope(GitCredentialScheme::Ssh, "::1", None, "/")
        );
    }

    #[test]
    fn unsafe_scope_hosts_and_paths_are_rejected() {
        for host in [
            "",
            "*",
            "git.example.com/repo",
            "git.example.com?x",
            "user@host",
        ] {
            assert!(
                normalize_git_credential_scope(&scope(GitCredentialScheme::Https, host, None, "/"))
                    .is_err(),
                "{host}"
            );
        }
        for path in [
            "/../repo/",
            "/team/./repo/",
            "/team%2Frepo/",
            "/team\\repo/",
            "/team/%zz/",
        ] {
            assert!(
                normalize_git_credential_scope(&scope(
                    GitCredentialScheme::Https,
                    "git.example.com",
                    None,
                    path
                ))
                .is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn remotes_use_the_node_normalizer_for_https_ssh_and_scp() {
        assert_eq!(
            normalize_git_remote("https://git.example.com:443/team/repo.git")
                .expect("https")
                .path_prefix,
            "/team/repo/"
        );
        assert_eq!(
            normalize_git_remote("ssh://git@git.example.com:2222/team/repo.git")
                .expect("ssh")
                .port,
            Some(2222)
        );
        let scp = normalize_git_remote("git@git.example.com:team/repo.git").expect("scp");
        assert_eq!(scp.scheme, GitCredentialScheme::Ssh);
        assert_eq!(scp.host, "git.example.com");
        assert_eq!(scp.path_prefix, "/team/repo/");
        assert!(normalize_git_remote("http://git.example.com/repo.git").is_err());
        assert!(normalize_git_remote("https://user@git.example.com/repo.git").is_err());
        assert!(normalize_git_remote("https://git.example.com/repo.git?token=x").is_err());
        assert!(normalize_git_remote("ftp://git.example.com/repo.git").is_err());
    }

    #[test]
    fn credential_matching_prefers_the_longest_path_and_reports_ambiguity() {
        let remote = "https://git.example.com/team/repo.git";
        let candidates = vec![
            candidate(
                "credential-root",
                GitCredentialKind::HttpsToken,
                scope(GitCredentialScheme::Https, "git.example.com", None, "/"),
                false,
            ),
            candidate(
                "credential-repo",
                GitCredentialKind::HttpsToken,
                scope(
                    GitCredentialScheme::Https,
                    "git.example.com",
                    None,
                    "/team/repo/",
                ),
                false,
            ),
        ];
        let GitCredentialMatchResult::Unique { credential, .. } =
            resolve_git_credential(remote, &candidates)
        else {
            panic!("expected unique credential");
        };
        assert_eq!(credential.id, "credential-repo");

        let mut ambiguous = candidates;
        ambiguous.push(candidate(
            "credential-duplicate",
            GitCredentialKind::HttpsToken,
            scope(
                GitCredentialScheme::Https,
                "git.example.com",
                None,
                "/team/repo/",
            ),
            false,
        ));
        assert_eq!(
            resolve_git_credential(remote, &ambiguous),
            GitCredentialMatchResult::Ambiguous {
                remote: normalize_git_remote(remote).expect("remote"),
                credential_ids: vec![
                    "credential-duplicate".to_string(),
                    "credential-repo".to_string()
                ],
            }
        );
    }

    #[test]
    fn ssh_credentials_require_pinned_known_hosts() {
        let remote = "git@git.example.com:team/repo.git";
        let candidate = candidate(
            "credential-ssh",
            GitCredentialKind::SshKey,
            scope(GitCredentialScheme::Ssh, "git.example.com", None, "/team/"),
            false,
        );
        assert_eq!(
            resolve_git_credential(remote, &[candidate]),
            GitCredentialMatchResult::MissingHostKey {
                remote: normalize_git_remote(remote).expect("remote"),
                credential_id: "credential-ssh".to_string(),
            }
        );
    }
}
