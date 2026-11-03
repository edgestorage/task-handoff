use crate::{
    builtin_managed_app_definitions,
    executable_resolver::{resolve_executable, ExecutableResolverOptions},
    ManagedAppDefinition,
};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

pub fn managed_node_package_bin(root: &Path, app_id: &str) -> PathBuf {
    root.join("node-package")
        .join(app_id)
        .join("node_modules/.bin")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    fn executable(path: &Path, body: &str) {
        write(path, &format!("#!/bin/sh\n{body}\n")).expect("executable");
    }

    #[test]
    fn commands_never_fall_back_to_host_packages_and_keep_the_node_runtime() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let root = temporary.path().join("managed apps 'private'");
        let host = temporary.path().join("host-bin");
        let apps = ManagedNodeApps::new(root.clone());
        let mut base = std::env::vars().collect::<BTreeMap<_, _>>();
        base.insert(
            "PATH".into(),
            format!("{}:{}", host.display(), base.get("PATH").expect("PATH")),
        );
        for id in ["codex", "claude", "opencode"] {
            executable(&host.join(id), "printf host");
        }
        let env = apps.environment(&base).expect("environment");
        for id in ["codex", "claude", "opencode"] {
            let absent = Command::new(id)
                .envs(&env)
                .output()
                .expect("missing command");
            assert_eq!(absent.status.code(), Some(127));
            assert!(
                String::from_utf8_lossy(&absent.stderr).contains("not installed in this instance")
            );
            let target = managed_node_package_bin(&root, id).join(id);
            executable(
                &target,
                "printf 'managed:%s:%s:%s' \"$1\" \"${DISABLE_AUTOUPDATER:-}\" \"${OPENCODE_DISABLE_AUTOUPDATE:-}\"",
            );
            let installed = Command::new(id)
                .arg("space argument")
                .envs(&env)
                .output()
                .expect("managed command");
            assert!(installed.status.success());
            assert_eq!(
                String::from_utf8_lossy(&installed.stdout),
                format!(
                    "managed:space argument:{}:{}",
                    if id == "claude" { "1" } else { "" },
                    if id == "opencode" { "1" } else { "" }
                )
            );
            fs::remove_file(target).expect("uninstall");
            assert_eq!(
                Command::new(id)
                    .envs(&env)
                    .output()
                    .expect("uninstalled command")
                    .status
                    .code(),
                Some(127)
            );
        }
        for directory in base
            .get("PATH")
            .expect("base PATH")
            .split(':')
            .filter(|value| !value.is_empty())
        {
            assert!(env
                .get("PATH")
                .expect("PATH")
                .split(':')
                .any(|entry| entry == directory));
        }
    }

    #[test]
    fn shell_initialization_preserves_user_settings_and_restores_command_ownership() {
        for shell in ["/bin/bash", "/bin/zsh"] {
            if !Path::new(shell).exists() {
                continue;
            }
            let temporary = tempfile::tempdir().expect("tempdir");
            let root = temporary.path().join("managed");
            let home = temporary.path().join("home");
            fs::create_dir_all(&home).expect("home");
            let file = if shell.ends_with("zsh") {
                ".zshrc"
            } else {
                ".bashrc"
            };
            fs::write(home.join(file), "export PATH=/usr/bin:/bin\nalias codex='printf host-codex'\nclaude() { printf host-claude; }\nexport USER_STARTUP_RAN=yes\n").expect("user rc");
            for id in ["codex", "claude", "opencode"] {
                executable(
                    &managed_node_package_bin(&root, id).join(id),
                    &format!("printf '{id}-managed\\n'"),
                );
            }
            let apps = ManagedNodeApps::new(root);
            let mut base = std::env::vars().collect::<BTreeMap<_, _>>();
            base.insert("HOME".into(), home.display().to_string());
            base.remove("ZDOTDIR");
            base.remove("TASK_HANDOFF_SHELL_USER_ZDOTDIR");
            let (args, env) = apps
                .prepare_shell(
                    shell,
                    &[
                        "-ic".into(),
                        "codex; claude; opencode; printf '%s' \"$USER_STARTUP_RAN\"".into(),
                    ],
                    &base,
                )
                .expect("prepare");
            let output = Command::new(shell)
                .args(args)
                .envs(env)
                .output()
                .expect("shell");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                "codex-managed\nclaude-managed\nopencode-managed\nyes"
            );
        }
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write(path: &Path, content: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    controlled_instance_core::atomic::write_atomic(path, content.as_bytes(), Some(0o700))
}

/// A private command projection derived from the registry, including entries for absent apps.
/// This prevents host PATH fallback without changing or installing anything in the user's prefix.
#[derive(Clone)]
pub struct ManagedNodeApps {
    root: PathBuf,
    definitions: Vec<ManagedAppDefinition>,
}

impl ManagedNodeApps {
    pub fn new(root: PathBuf) -> Self {
        let definitions = builtin_managed_app_definitions()
            .into_iter()
            .filter(|definition| {
                definition
                    .recipes
                    .iter()
                    .any(|recipe| recipe.is_managed_node_package())
            })
            .collect();
        Self { root, definitions }
    }

    fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }

    pub fn contains(&self, app_id: &str) -> bool {
        self.definitions
            .iter()
            .any(|definition| definition.launcher.id == app_id)
    }

    pub fn environment(
        &self,
        base: &BTreeMap<String, String>,
    ) -> io::Result<BTreeMap<String, String>> {
        for definition in &self.definitions {
            let app = &definition.launcher;
            let target = managed_node_package_bin(&self.root, &app.id).join(&app.id);
            let message = format!(
                "{} is not installed in this instance. Install it from app management.",
                app.name
            );
            let exports = app
                .env
                .iter()
                .flat_map(|env| env.iter())
                .map(|(name, value)| format!("export {name}={}", quote(value)))
                .collect::<Vec<_>>()
                .join("\n");
            write(&self.bin().join(&app.id), &format!("#!/bin/sh\nif [ ! -x {} ]; then\n  printf '%s\\n' {} >&2\n  exit 127\nfi\n{exports}\nexec {} \"$@\"\n", quote(&target.display().to_string()), quote(&message), quote(&target.display().to_string())))?;
            #[cfg(windows)]
            {
                let exports = app
                    .env
                    .iter()
                    .flat_map(|env| env.iter())
                    .map(|(name, value)| format!("set \"{name}={value}\""))
                    .collect::<Vec<_>>()
                    .join("\r\n");
                write(&self.bin().join(format!("{}.cmd", app.id)), &format!("@echo off\r\nif not exist \"{}.cmd\" (\r\n echo {message} 1>&2\r\n exit /b 127\r\n)\r\n{exports}\r\ncall \"{}.cmd\" %*\r\n", target.display(), target.display()))?;
            }
        }
        let mut env = base.clone();
        if cfg!(windows) {
            if let Some(key) = env
                .keys()
                .find(|name| name.eq_ignore_ascii_case("PATH") && name.as_str() != "PATH")
                .cloned()
            {
                if let Some(value) = env.remove(&key) {
                    env.entry("PATH".into()).or_insert(value);
                }
            }
        }
        let mut prefix = vec![self.bin().display().to_string()];
        if let Some(node) = resolve_executable(
            "node",
            &ExecutableResolverOptions {
                env: env.clone(),
                ..Default::default()
            },
        ) {
            if let Some(parent) = node.executable.parent() {
                prefix.push(parent.display().to_string());
            }
            env.extend(node.env);
        }
        let current = env.get("PATH").cloned().unwrap_or_default();
        let delimiter = if cfg!(windows) { ";" } else { ":" };
        prefix.extend(
            current
                .split(delimiter)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
        );
        let mut seen = std::collections::BTreeSet::new();
        prefix.retain(|value| seen.insert(value.clone()));
        env.insert("PATH".into(), prefix.join(delimiter));
        Ok(env)
    }

    pub fn prepare_shell(
        &self,
        command: &str,
        args: &[String],
        base: &BTreeMap<String, String>,
    ) -> io::Result<(Vec<String>, BTreeMap<String, String>)> {
        let mut env = self.environment(base)?;
        let name = Path::new(command)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let directory = self.root.join("shell");
        let mut prefix = vec![self.bin().display().to_string()];
        if let Some(node) = resolve_executable(
            "node",
            &ExecutableResolverOptions {
                env: env.clone(),
                ..Default::default()
            },
        ) {
            if let Some(parent) = node.executable.parent() {
                prefix.push(parent.display().to_string());
            }
        }
        let restore = format!(
            "export PATH={}:\"$PATH\"\n{}\n",
            quote(&prefix.join(if cfg!(windows) { ";" } else { ":" })),
            self.definitions
                .iter()
                .map(|definition| format!(
                    "unalias {} 2>/dev/null || :\nunset -f {} 2>/dev/null || :",
                    definition.launcher.id, definition.launcher.id
                ))
                .collect::<Vec<_>>()
                .join("\n")
        );
        // Preserve startup files, then restore command ownership. These shell startup contracts
        // have no common library abstraction; keep the integration confined to this boundary.
        match name.as_str() {
            "cmd" => {
                let mut result = vec!["/D".to_string()];
                result.extend_from_slice(args);
                Ok((result, env))
            }
            "powershell" | "pwsh" => {
                let ps_quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
                let restore = format!("$env:PATH = {} + [IO.Path]::PathSeparator + $env:PATH; {}", ps_quote(&prefix.join(if cfg!(windows) { ";" } else { ":" })), self.definitions.iter().map(|definition| format!("Remove-Item -LiteralPath 'Alias:{}','Function:{}' -ErrorAction SilentlyContinue;", definition.launcher.id, definition.launcher.id)).collect::<Vec<_>>().join(" "));
                if let Some(index) = args
                    .iter()
                    .position(|arg| matches!(arg.to_ascii_lowercase().as_str(), "-command" | "-c"))
                {
                    if let Some(script) = args.get(index + 1) {
                        let mut result = args[..index + 1].to_vec();
                        result.push(format!("{restore} {script}"));
                        result.extend_from_slice(&args[index + 2..]);
                        return Ok((result, env));
                    }
                }
                if let Some(index) = args
                    .iter()
                    .position(|arg| matches!(arg.to_ascii_lowercase().as_str(), "-file" | "-f"))
                {
                    if args.get(index + 1).is_some() {
                        let mut result = args[..index].to_vec();
                        result.extend([
                            "-Command".into(),
                            format!(
                                "{restore} & {}",
                                args[index + 1..]
                                    .iter()
                                    .map(|arg| ps_quote(arg))
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            ),
                        ]);
                        return Ok((result, env));
                    }
                }
                let mut result = vec!["-NoExit".into()];
                result.extend_from_slice(args);
                result.extend(["-Command".into(), restore]);
                Ok((result, env))
            }
            "bash" => {
                let rc = directory.join("bashrc");
                write(
                    &rc,
                    &format!(
                        "if [ -f \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\"; fi\n{restore}"
                    ),
                )?;
                let non_interactive = directory.join("bash-env");
                write(&non_interactive, &restore)?;
                env.insert("BASH_ENV".into(), non_interactive.display().to_string());
                let mut result = vec!["--rcfile".into(), rc.display().to_string()];
                result.extend_from_slice(args);
                Ok((result, env))
            }
            "zsh" => {
                let original = base
                    .get("TASK_HANDOFF_SHELL_USER_ZDOTDIR")
                    .or_else(|| base.get("ZDOTDIR"))
                    .or_else(|| base.get("HOME"))
                    .cloned()
                    .unwrap_or_default();
                let zdot = directory.join("zsh");
                for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
                    let original_file =
                        quote(&Path::new(&original).join(file).display().to_string());
                    write(&zdot.join(file), &format!("if [ -f {original_file} ]; then . {original_file}; fi\nexport ZDOTDIR={}\n{restore}", quote(&zdot.display().to_string())))?;
                }
                env.insert("ZDOTDIR".into(), zdot.display().to_string());
                env.insert("TASK_HANDOFF_SHELL_USER_ZDOTDIR".into(), original);
                Ok((args.to_vec(), env))
            }
            "fish" => {
                let mut result = vec![
                    "--init-command".into(),
                    format!(
                        "set -gx PATH {} $PATH; {}",
                        prefix
                            .iter()
                            .map(|part| quote(part))
                            .collect::<Vec<_>>()
                            .join(" "),
                        self.definitions
                            .iter()
                            .map(|definition| format!("functions -e {};", definition.launcher.id))
                            .collect::<Vec<_>>()
                            .join(" ")
                    ),
                ];
                result.extend_from_slice(args);
                Ok((result, env))
            }
            "sh" | "dash" | "ksh" => {
                let rc = directory.join("sh-env");
                let original = base
                    .get("ENV")
                    .filter(|value| Path::new(value) != rc)
                    .map(|value| {
                        format!("if [ -f {} ]; then . {}; fi\n", quote(value), quote(value))
                    })
                    .unwrap_or_default();
                write(&rc, &format!("{original}{restore}"))?;
                env.insert("ENV".into(), rc.display().to_string());
                Ok((args.to_vec(), env))
            }
            _ => Ok((args.to_vec(), env)),
        }
    }

    pub fn terminal_environment(
        &self,
        base: &BTreeMap<String, String>,
    ) -> io::Result<BTreeMap<String, String>> {
        if cfg!(windows) {
            return self.environment(base);
        }
        let command = base
            .get("TASK_HANDOFF_SHELL_COMMAND")
            .or_else(|| base.get("SHELL"))
            .cloned()
            .unwrap_or_else(|| "/bin/sh".into());
        let (args, mut env) = self.prepare_shell(&command, &[], base)?;
        let wrapper = self.root.join("shell/interactive");
        let exports = [
            "BASH_ENV",
            "ENV",
            "ZDOTDIR",
            "TASK_HANDOFF_SHELL_USER_ZDOTDIR",
        ]
        .iter()
        .filter_map(|name| {
            env.get(*name)
                .map(|value| format!("export {name}={}", quote(value)))
        })
        .collect::<Vec<_>>()
        .join("\n");
        write(
            &wrapper,
            &format!(
                "#!/bin/sh\n{exports}\nexec {} {} \"$@\"\n",
                quote(&command),
                args.iter()
                    .map(|arg| quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        )?;
        env.insert("SHELL".into(), wrapper.display().to_string());
        env.insert("TASK_HANDOFF_SHELL_COMMAND".into(), command);
        Ok(env)
    }
}
