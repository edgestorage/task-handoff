use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSshInvocation {
    pub remote: String,
    pub args: Vec<String>,
}

pub fn remote_from_https_credential_request(
    protocol: Option<&str>,
    host: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    if protocol != Some("https") {
        return None;
    }
    let host = host?.trim();
    if host.is_empty() {
        return None;
    }
    let path = path.unwrap_or_default().trim_start_matches('/');
    Some(format!("https://{host}/{path}"))
}

pub fn parse_git_ssh_invocation(args: &[String]) -> Option<GitSshInvocation> {
    if args
        .iter()
        .any(|argument| argument.is_empty() || argument.contains('\0'))
    {
        return None;
    }
    let mut host_argument = None;
    let mut port = None;
    let mut safe_options = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let value = &args[index];
        if value == "-p" {
            let candidate = args.get(index + 1)?;
            if port.is_some() || !candidate.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let parsed = candidate.parse::<u16>().ok().filter(|value| *value > 0)?;
            port = Some(parsed);
            safe_options.push("-p".to_string());
            safe_options.push(parsed.to_string());
            index += 2;
            continue;
        }
        if value == "-4" || value == "-6" {
            safe_options.push(value.clone());
            index += 1;
            continue;
        }
        if value == "-o" {
            if args.get(index + 1).map(String::as_str) != Some("SendEnv=GIT_PROTOCOL") {
                return None;
            }
            safe_options.push("-o".to_string());
            safe_options.push("SendEnv=GIT_PROTOCOL".to_string());
            index += 2;
            continue;
        }
        if value == "-oSendEnv=GIT_PROTOCOL" {
            safe_options.push(value.clone());
            index += 1;
            continue;
        }
        if value.starts_with('-') {
            return None;
        }
        host_argument = Some(value.clone());
        index += 1;
        if index + 1 != args.len() {
            return None;
        }
        break;
    }
    let host_argument = host_argument?;
    let host = parse_ssh_host(&host_argument)?;
    let (service, repository) = parse_git_service_command(args.last()?)?;
    let authority = match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    let mut remote = Url::parse(&format!("ssh://{authority}/")).ok()?;
    remote.set_path(&format!("/{}", repository.trim_start_matches('/')));
    let mut sanitized = safe_options;
    sanitized.push(host_argument);
    sanitized.push(format!("{service} {}", shell_single_quote(&repository)));
    Some(GitSshInvocation {
        remote: remote.to_string(),
        args: sanitized,
    })
}

pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn parse_ssh_host(value: &str) -> Option<String> {
    if value.chars().any(char::is_whitespace) {
        return None;
    }
    let mut parts = value.split('@');
    let first = parts.next()?;
    let host = match parts.next() {
        Some(host) => {
            if parts.next().is_some()
                || first.is_empty()
                || !first
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
            {
                return None;
            }
            host
        }
        None => first,
    };
    (!host.is_empty() && !host.contains('@')).then(|| host.to_string())
}

fn parse_git_service_command(value: &str) -> Option<(&str, String)> {
    let (service, argument) = ["git-upload-pack", "git-receive-pack", "git-upload-archive"]
        .into_iter()
        .find_map(|service| {
            value
                .strip_prefix(service)
                .and_then(|rest| rest.strip_prefix(' ').map(|argument| (service, argument)))
        })?;
    let repository = if let Some(argument) = argument.strip_prefix('\'') {
        let argument = argument.strip_suffix('\'')?;
        let repository = argument.replace("'\\''", "'");
        if shell_single_quote(&repository) != format!("'{argument}'") {
            return None;
        }
        repository
    } else {
        if !argument.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || "._~@%+,:/ -".contains(character) && character != ' '
        }) {
            return None;
        }
        argument.to_string()
    };
    if repository.is_empty() || repository.chars().any(|character| character.is_control()) {
        return None;
    }
    Some((service, repository))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn https_requests_preserve_the_node_remote_shape() {
        assert_eq!(
            remote_from_https_credential_request(
                Some("https"),
                Some("[::1]:8443"),
                Some("Team/Repo.git")
            ),
            Some("https://[::1]:8443/Team/Repo.git".to_string())
        );
        assert_eq!(
            remote_from_https_credential_request(Some("http"), Some("example.com"), Some("repo")),
            None
        );
    }

    #[test]
    fn ssh_invocations_match_the_node_sanitizer() {
        assert_eq!(
            parse_git_ssh_invocation(&args(&[
                "git@git.example.com",
                "git-upload-pack 'team/repo.git'"
            ]))
            .expect("basic ssh invocation"),
            GitSshInvocation {
                remote: "ssh://git.example.com/team/repo.git".to_string(),
                args: args(&["git@git.example.com", "git-upload-pack 'team/repo.git'"]),
            }
        );
        assert_eq!(
            parse_git_ssh_invocation(&args(&[
                "-p",
                "22",
                "git@git.example.com",
                "git-upload-pack 'team/repo.git'"
            ]))
            .expect("port ssh invocation")
            .remote,
            "ssh://git.example.com:22/team/repo.git"
        );
        assert_eq!(
            parse_git_ssh_invocation(&args(&[
                "git@git.example.com",
                "git-upload-pack 'team/repo'\\''s.git'"
            ]))
            .expect("quoted apostrophe")
            .remote,
            "ssh://git.example.com/team/repo's.git"
        );
    }

    #[test]
    fn unsafe_ssh_options_and_service_commands_are_rejected() {
        for command in [
            "git-upload-pack repo; id",
            "git-upload-pack 'repo'; id",
            "git-upload-pack \"repo$(id)\"",
            "git-upload-pack repo other",
            "git-upload-pack 'unterminated",
        ] {
            assert!(
                parse_git_ssh_invocation(&args(&["git@git.example.com", command])).is_none(),
                "{command}"
            );
        }
        assert!(parse_git_ssh_invocation(&args(&[
            "-o",
            "ProxyCommand=evil",
            "git.example.com",
            "git-upload-pack 'repo.git'"
        ]))
        .is_none());
    }
}
