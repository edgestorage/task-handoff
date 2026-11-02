use crate::executable_resolver::{
    command_interpreter_shim_environment, path_has_extension, resolve_executable,
    ExecutableResolverId, ExecutableResolverOptions, Platform,
};
use std::{collections::BTreeMap, path::PathBuf};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CommandInvocationError {
    #[error("Command arguments must not contain NUL or line breaks.")]
    InvalidArgument,
    #[error(
        "cmd.exe expands '%' even inside quotes, so this argument cannot be passed through a .cmd/.bat shim safely."
    )]
    UnsupportedPercent,
    #[error("Resolved executable path is not valid Unicode and cannot be passed to cmd.exe.")]
    NonUnicodeExecutable,
}

impl CommandInvocationError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument => "COMMAND_ARGUMENT_INVALID",
            Self::UnsupportedPercent => "COMMAND_ARGUMENT_UNSUPPORTED",
            Self::NonUnicodeExecutable => "COMMAND_EXECUTABLE_NON_UNICODE",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CommandInvocationOptions {
    pub resolver: ExecutableResolverOptions,
    /// Windows-only: wrap an unresolved extensionless command as `.cmd`.
    pub win32_shim_when_unresolved: bool,
}

impl From<ExecutableResolverOptions> for CommandInvocationOptions {
    fn from(resolver: ExecutableResolverOptions) -> Self {
        Self {
            resolver,
            win32_shim_when_unresolved: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInvocation {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub interpreter_wrapped: bool,
    pub resolver: Option<ExecutableResolverId>,
}

pub fn is_command_interpreter_shim(executable: &str, platform: Platform) -> bool {
    if !platform.is_windows() {
        return false;
    }
    let Some(file_name) = executable.rsplit(['/', '\\']).next() else {
        return false;
    };
    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// Quotes one argument before `cmd.exe` re-parses it.
pub fn quote_command_interpreter_argument(value: &str) -> Result<String, CommandInvocationError> {
    if value
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err(CommandInvocationError::InvalidArgument);
    }
    if value.contains('%') {
        return Err(CommandInvocationError::UnsupportedPercent);
    }
    if value.is_empty() {
        return Ok("\"\"".to_string());
    }
    if value.chars().any(is_command_interpreter_metacharacter) {
        return Ok(format!("\"{}\"", value.replace('"', "\\\"")));
    }
    Ok(value.to_string())
}

fn is_command_interpreter_metacharacter(character: char) -> bool {
    character.is_whitespace()
        || matches!(
            character,
            '"' | '&' | '|' | '<' | '>' | '^' | '(' | ')' | '[' | ']'
        )
}

/// Resolves a command into a directly spawnable executable and argv.
pub fn command_invocation(
    command: &str,
    args: &[String],
    options: &CommandInvocationOptions,
) -> Result<CommandInvocation, CommandInvocationError> {
    let platform = options.resolver.platform;
    let resolution = resolve_executable(command, &options.resolver);
    let unresolved_shim = resolution.is_none()
        && options.win32_shim_when_unresolved
        && platform.is_windows()
        && !is_command_interpreter_shim(command, platform)
        && !path_has_extension(command, platform);
    let resolved_executable = resolution
        .as_ref()
        .map(|resolution| resolution.executable.clone())
        .unwrap_or_else(|| {
            if unresolved_shim {
                PathBuf::from(format!("{command}.cmd"))
            } else {
                PathBuf::from(command)
            }
        });
    let mut env = options.resolver.env.clone();
    if let Some(resolution) = &resolution {
        merge_env(&mut env, platform, &resolution.env);
    }
    let resolver = resolution.as_ref().map(|resolution| resolution.resolver);
    let resolved_text = resolved_executable.to_string_lossy();
    if !is_command_interpreter_shim(&resolved_text, platform) {
        return Ok(CommandInvocation {
            executable: resolved_executable,
            args: args.to_vec(),
            env,
            interpreter_wrapped: false,
            resolver,
        });
    }

    let resolved_executable = resolved_executable
        .to_str()
        .ok_or(CommandInvocationError::NonUnicodeExecutable)?;
    let shim_env = command_interpreter_shim_environment(&env, &options.resolver);
    let executable = env_value(&shim_env, platform, "ComSpec")
        .filter(|value| !value.is_empty())
        .unwrap_or("cmd.exe");
    let mut interpreted_args = vec![
        "/d".to_string(),
        "/s".to_string(),
        "/c".to_string(),
        "call".to_string(),
        resolved_executable.to_string(),
    ];
    for argument in args {
        interpreted_args.push(quote_command_interpreter_argument(argument)?);
    }
    Ok(CommandInvocation {
        executable: PathBuf::from(executable),
        args: interpreted_args,
        env: shim_env,
        interpreter_wrapped: true,
        resolver,
    })
}

/// The executable that command discovery should probe.
pub fn resolve_command_executable(
    command: &str,
    options: &CommandInvocationOptions,
) -> Option<PathBuf> {
    resolve_executable(command, &options.resolver).map(|resolution| resolution.executable)
}

fn merge_env(
    env: &mut BTreeMap<String, String>,
    platform: Platform,
    additions: &BTreeMap<String, String>,
) {
    for (key, value) in additions {
        let existing = if platform.is_windows() {
            env.keys()
                .find(|candidate| candidate.eq_ignore_ascii_case(key))
                .cloned()
        } else {
            env.contains_key(key).then(|| key.clone())
        };
        env.insert(existing.unwrap_or_else(|| key.clone()), value.clone());
    }
}

fn env_value<'a>(
    env: &'a BTreeMap<String, String>,
    platform: Platform,
    key: &str,
) -> Option<&'a str> {
    env.get(key).map(String::as_str).or_else(|| {
        if platform.is_windows() {
            env.iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.as_str())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executable_resolver::ExecutableResolverId;
    use std::{fs, path::Path};
    use tempfile::TempDir;

    fn resolver_options(platform: Platform) -> ExecutableResolverOptions {
        ExecutableResolverOptions {
            env: BTreeMap::new(),
            cwd: PathBuf::from("/workspace"),
            platform,
            home_dir: PathBuf::from("/home/tester"),
            nvm_dir: None,
            homebrew_bin_directories: None,
            npm_global_bin_directories: None,
            node_runtime_directories: None,
            running_node_executable: None,
        }
    }

    fn write_executable(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn direct_command_keeps_argv_unmodified() {
        let root = TempDir::new().unwrap();
        let command = root.path().join("fixture-tool");
        write_executable(&command);
        let mut resolver = resolver_options(Platform::Linux);
        resolver
            .env
            .insert("PATH".to_string(), root.path().display().to_string());
        let options = CommandInvocationOptions::from(resolver);

        let invocation = command_invocation(
            "fixture-tool",
            &["--flag".to_string(), "two words".to_string()],
            &options,
        )
        .unwrap();

        assert_eq!(invocation.executable, command);
        assert_eq!(invocation.args, ["--flag", "two words"]);
        assert!(!invocation.interpreter_wrapped);
        assert_eq!(invocation.resolver, Some(ExecutableResolverId::Path));
    }

    #[test]
    fn unresolved_windows_command_can_be_wrapped_as_cmd_shim() {
        let mut resolver = resolver_options(Platform::Windows);
        resolver.env.insert(
            "ComSpec".to_string(),
            "C:\\Windows\\System32\\cmd.exe".to_string(),
        );
        resolver
            .env
            .insert("PATH".to_string(), "C:\\missing\\bin".to_string());
        let options = CommandInvocationOptions {
            resolver,
            win32_shim_when_unresolved: true,
        };

        let invocation = command_invocation(
            "fixture-tool",
            &["two words".to_string(), "a&b".to_string()],
            &options,
        )
        .unwrap();

        assert_eq!(
            invocation.executable,
            PathBuf::from("C:\\Windows\\System32\\cmd.exe")
        );
        assert_eq!(
            invocation.args,
            [
                "/d",
                "/s",
                "/c",
                "call",
                "fixture-tool.cmd",
                "\"two words\"",
                "\"a&b\""
            ]
        );
        assert!(invocation.interpreter_wrapped);
        assert_eq!(invocation.env["PATHEXT"], ".COM;.EXE;.BAT;.CMD");
    }

    #[test]
    fn unresolved_windows_command_stays_direct_when_shim_fallback_is_disabled() {
        let options = CommandInvocationOptions::from(resolver_options(Platform::Windows));

        let invocation =
            command_invocation("fixture-tool", &["two words".to_string()], &options).unwrap();

        assert_eq!(invocation.executable, PathBuf::from("fixture-tool"));
        assert_eq!(invocation.args, ["two words"]);
        assert!(!invocation.interpreter_wrapped);
    }

    #[test]
    fn windows_command_with_extension_is_not_fallback_wrapped() {
        let mut resolver = resolver_options(Platform::Windows);
        resolver
            .env
            .insert("ComSpec".to_string(), "cmd.exe".to_string());
        let options = CommandInvocationOptions {
            resolver,
            win32_shim_when_unresolved: true,
        };

        let invocation = command_invocation("fixture-tool.exe", &[], &options).unwrap();

        assert_eq!(invocation.executable, PathBuf::from("fixture-tool.exe"));
        assert!(!invocation.interpreter_wrapped);
    }

    #[test]
    fn resolved_cmd_shim_is_wrapped_and_arguments_are_quoted() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("fixture-tool.cmd"), "").unwrap();
        let mut resolver = resolver_options(Platform::Windows);
        resolver
            .env
            .insert("PATH".to_string(), root.path().display().to_string());
        resolver
            .env
            .insert("ComSpec".to_string(), "cmd.exe".to_string());
        let options = CommandInvocationOptions::from(resolver);

        let invocation = command_invocation(
            "fixture-tool",
            &[
                String::new(),
                "plain".to_string(),
                "a\"b".to_string(),
                "a[b]".to_string(),
                "a\\b".to_string(),
            ],
            &options,
        )
        .unwrap();

        assert_eq!(invocation.executable, PathBuf::from("cmd.exe"));
        assert_eq!(&invocation.args[..4], ["/d", "/s", "/c", "call"]);
        assert!(invocation.args[4]
            .eq_ignore_ascii_case(root.path().join("fixture-tool.cmd").to_str().unwrap()));
        assert_eq!(
            &invocation.args[5..],
            ["\"\"", "plain", "\"a\\\"b\"", "\"a[b]\"", "a\\b"]
        );
        assert!(invocation.interpreter_wrapped);
        assert_eq!(invocation.resolver, Some(ExecutableResolverId::Path));
    }

    #[test]
    fn resolved_bat_shim_is_case_insensitive() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("fixture-tool.BAT"), "").unwrap();
        let mut resolver = resolver_options(Platform::Windows);
        resolver
            .env
            .insert("PATH".to_string(), root.path().display().to_string());
        let options = CommandInvocationOptions::from(resolver);

        let invocation = command_invocation("fixture-tool", &[], &options).unwrap();

        assert!(invocation.interpreter_wrapped);
        assert_eq!(invocation.executable, PathBuf::from("cmd.exe"));
    }

    #[test]
    fn detects_command_interpreter_shims_only_on_windows() {
        assert!(is_command_interpreter_shim(
            "C:\\tools\\fixture.CMD",
            Platform::Windows
        ));
        assert!(is_command_interpreter_shim(
            "C:\\tools\\fixture.BAT",
            Platform::Windows
        ));
        assert!(!is_command_interpreter_shim("fixture.cmd", Platform::Linux));
        assert!(!is_command_interpreter_shim(
            "fixture.exe",
            Platform::Windows
        ));
        assert!(!is_command_interpreter_shim(
            "fixture.cmd.exe",
            Platform::Windows
        ));
    }

    #[test]
    fn quotes_only_cmd_metacharacters_and_preserves_backslashes() {
        assert_eq!(quote_command_interpreter_argument("").unwrap(), "\"\"");
        assert_eq!(
            quote_command_interpreter_argument("plain").unwrap(),
            "plain"
        );
        assert_eq!(
            quote_command_interpreter_argument("two words").unwrap(),
            "\"two words\""
        );
        assert_eq!(
            quote_command_interpreter_argument("a\"b").unwrap(),
            "\"a\\\"b\""
        );
        assert_eq!(
            quote_command_interpreter_argument("a[b]").unwrap(),
            "\"a[b]\""
        );
        assert_eq!(
            quote_command_interpreter_argument("a&b|c<d>e^f(g)h").unwrap(),
            "\"a&b|c<d>e^f(g)h\""
        );
        assert_eq!(quote_command_interpreter_argument("a\\b").unwrap(), "a\\b");
        assert_eq!(
            quote_command_interpreter_argument("a\u{2003}b").unwrap(),
            "\"a\u{2003}b\""
        );
    }

    #[test]
    fn rejects_arguments_cmd_cannot_represent() {
        assert_eq!(
            quote_command_interpreter_argument("a\0b"),
            Err(CommandInvocationError::InvalidArgument)
        );
        assert_eq!(
            quote_command_interpreter_argument("a\rb"),
            Err(CommandInvocationError::InvalidArgument)
        );
        assert_eq!(
            quote_command_interpreter_argument("a\nb"),
            Err(CommandInvocationError::InvalidArgument)
        );
        assert_eq!(
            quote_command_interpreter_argument("100%"),
            Err(CommandInvocationError::UnsupportedPercent)
        );
        assert_eq!(
            CommandInvocationError::InvalidArgument.code(),
            "COMMAND_ARGUMENT_INVALID"
        );
        assert_eq!(
            CommandInvocationError::UnsupportedPercent.code(),
            "COMMAND_ARGUMENT_UNSUPPORTED"
        );
    }

    #[test]
    fn invalid_shim_argument_fails_the_whole_invocation() {
        let options = CommandInvocationOptions {
            resolver: resolver_options(Platform::Windows),
            win32_shim_when_unresolved: true,
        };

        let result = command_invocation("fixture-tool", &["100%".to_string()], &options);

        assert_eq!(result, Err(CommandInvocationError::UnsupportedPercent));
    }

    #[test]
    fn max_path_augmentation_flows_through_invocation() {
        let root = TempDir::new().unwrap();
        let prefix = root.path().join("npm-prefix");
        write_executable(&prefix.join("bin").join("fixture-tool"));
        let mut resolver = resolver_options(Platform::Linux);
        resolver.env.insert(
            "NPM_CONFIG_PREFIX".to_string(),
            prefix.display().to_string(),
        );
        resolver
            .env
            .insert("PATH".to_string(), "/usr/bin".to_string());
        let options = CommandInvocationOptions::from(resolver);

        let invocation = command_invocation("fixture-tool", &[], &options).unwrap();

        assert_eq!(
            invocation.env["PATH"],
            format!("{}:/usr/bin", prefix.join("bin").display())
        );
        assert_eq!(invocation.resolver, Some(ExecutableResolverId::NpmGlobal));
    }

    #[test]
    fn resolve_command_executable_uses_the_same_resolution_order() {
        let root = TempDir::new().unwrap();
        let command = root.path().join("fixture-tool");
        write_executable(&command);
        let mut resolver = resolver_options(Platform::Linux);
        resolver
            .env
            .insert("PATH".to_string(), root.path().display().to_string());
        let options = CommandInvocationOptions::from(resolver);

        assert_eq!(
            resolve_command_executable("fixture-tool", &options),
            Some(command)
        );
    }

    #[test]
    fn resolved_cmd_without_comspec_uses_default_interpreter() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("fixture-tool.cmd"), "").unwrap();
        let mut resolver = resolver_options(Platform::Windows);
        resolver
            .env
            .insert("PATH".to_string(), root.path().display().to_string());
        let options = CommandInvocationOptions::from(resolver);

        let invocation = command_invocation("fixture-tool", &[], &options).unwrap();

        assert_eq!(invocation.executable, PathBuf::from("cmd.exe"));
    }
}
