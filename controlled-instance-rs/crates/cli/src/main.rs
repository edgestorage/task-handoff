use controlled_instance_core::singleton_lock::{
    acquire_local_controlled_instance_lock, ProcessLockDetails,
};
use controlled_instance_instance::{
    resolve_package_version, run_git_credential_helper, run_git_ssh, run_git_ssh_askpass,
    run_provisioning_git_credential_helper, run_provisioning_git_ssh, run_web, ServerOptions,
};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Web(ServerOptions),
    GitCredentialHelper(Vec<String>),
    GitSsh(Vec<String>),
    GitSshAskpass(Option<String>),
    GitProvisioningHelper(Vec<String>),
    Help(HelpTopic),
    Version,
}

#[derive(Debug, PartialEq, Eq)]
enum HelpTopic {
    Root,
    Web,
}

#[tokio::main]
async fn main() -> ExitCode {
    initialize_cli_path();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .try_init();
    let command = match parse(std::env::args_os().skip(1).collect()) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(1);
        }
    };
    match execute(command).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

async fn execute(command: Command) -> Result<(), String> {
    match command {
        Command::Help(topic) => {
            match topic {
                HelpTopic::Root => print_root_help(),
                HelpTopic::Web => print_web_help(),
            }
            Ok(())
        }
        Command::Version => {
            println!("{}", resolve_package_version());
            Ok(())
        }
        Command::Web(mut options) => {
            if options.port.is_none() {
                options.port = Some(env_web_port(
                    std::env::var("TASK_HANDOFF_WEB_PORT").ok().as_deref(),
                ));
            }
            let lock = acquire_lock_if_needed(options.port, options.host.as_deref())?;
            let result = run_web(options).await.map_err(|error| error.to_string());
            drop(lock);
            result
        }
        Command::GitCredentialHelper(args) => {
            run_git_credential_helper(args.first().map(String::as_str))
                .await
                .map_err(|error| error.to_string())
        }
        Command::GitSsh(args) => run_git_ssh(&args).await.map_err(|error| error.to_string()),
        Command::GitSshAskpass(_) => run_git_ssh_askpass()
            .await
            .map_err(|error| error.to_string()),
        Command::GitProvisioningHelper(args) => match args.first().map(String::as_str) {
            Some("credential") => {
                run_provisioning_git_credential_helper(args.get(1).map(String::as_str))
                    .await
                    .map_err(|error| error.to_string())
            }
            Some("ssh") => run_provisioning_git_ssh(&args[1..])
                .await
                .map_err(|error| error.to_string()),
            _ => Err("TASK_HANDOFF_GIT_PROVISIONING_ERROR=REMOTE_UNSUPPORTED".to_string()),
        },
    }
}

fn acquire_lock_if_needed(
    _port: Option<u16>,
    _host: Option<&str>,
) -> Result<Option<controlled_instance_core::singleton_lock::AcquiredProcessLock>, String> {
    if std::env::var("TASK_HANDOFF_CONTROL_MODE").ok().as_deref() != Some("controlled")
        || std::env::var("TASK_HANDOFF_RUNTIME_KIND").ok().as_deref() != Some("local")
    {
        return Ok(None);
    }
    let details = ProcessLockDetails {
        component: Some("local-controlled-instance".to_string()),
        data_dir: std::env::var("TASK_HANDOFF_DATA_DIR").ok(),
        host: _host.map(ToString::to_string),
        port: _port.or_else(|| {
            let value = std::env::var("TASK_HANDOFF_WEB_PORT").ok();
            Some(env_web_port(value.as_deref()))
        }),
        instance_id: std::env::var("TASK_HANDOFF_INSTANCE_ID").ok(),
    };
    let lock_path =
        std::env::var_os("TASK_HANDOFF_LOCAL_CONTROLLED_INSTANCE_LOCK_PATH").map(PathBuf::from);
    acquire_local_controlled_instance_lock(details, lock_path)
        .map(Some)
        .map_err(|error| format!("{} ({})", error, error.code()))
}

fn parse(args: Vec<OsString>) -> Result<Command, String> {
    let strings = args
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "Arguments must be valid UTF-8".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(command) = strings.first().map(String::as_str) else {
        return Ok(Command::Web(ServerOptions::default()));
    };
    match command {
        "web" => parse_web(&strings[1..]),
        "git-credential-helper" => Ok(Command::GitCredentialHelper(strings[1..].to_vec())),
        "git-ssh" => Ok(Command::GitSsh(strings[1..].to_vec())),
        "git-ssh-askpass" => {
            let invocation_id = strings
                .get(1)
                .cloned()
                .ok_or_else(|| "missing required argument 'invocationId'".to_string())?;
            if strings.len() > 2 {
                return Err(format!(
                    "too many arguments for 'git-ssh-askpass'. Expected 1 argument but got {}.",
                    strings.len() - 1
                ));
            }
            Ok(Command::GitSshAskpass(Some(invocation_id)))
        }
        "git-provisioning-helper" => Ok(Command::GitProvisioningHelper(strings[1..].to_vec())),
        "--help" | "-h" => Ok(Command::Help(HelpTopic::Root)),
        "help" => match strings.get(1).map(String::as_str) {
            None => Ok(Command::Help(HelpTopic::Root)),
            Some("web") => Ok(Command::Help(HelpTopic::Web)),
            Some(value) => Err(format!("Unknown command: {value}")),
        },
        "--version" | "-V" => Ok(Command::Version),
        value if value.starts_with('-') => Err(format!("unknown option '{value}'")),
        other => Err(format!("unknown command '{other}'")),
    }
}

fn parse_web(args: &[String]) -> Result<Command, String> {
    let mut options = ServerOptions::default();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        match argument.as_str() {
            "--help" | "-h" => return Ok(Command::Help(HelpTopic::Web)),
            "--version" | "-V" => return Ok(Command::Version),
            "--host" => {
                options.host = Some(take_value(args, &mut index, "--host")?);
            }
            "-p" | "--port" => {
                let value = take_value(args, &mut index, argument)?;
                options.port = Some(parse_port(&value)?);
            }
            "--static-dir" => {
                options.static_dir =
                    Some(PathBuf::from(take_value(args, &mut index, "--static-dir")?));
            }
            value if value.starts_with("--host=") => {
                options.host = Some(non_empty(value.trim_start_matches("--host="), "--host")?);
            }
            value if value.starts_with("--port=") => {
                options.port = Some(parse_port(value.trim_start_matches("--port="))?);
            }
            value if value.starts_with("--static-dir=") => {
                options.static_dir = Some(PathBuf::from(non_empty(
                    value.trim_start_matches("--static-dir="),
                    "--static-dir",
                )?));
            }
            other => return Err(format!("unknown option '{other}'")),
        }
        index += 1;
    }
    Ok(Command::Web(options))
}

fn take_value(args: &[String], index: &mut usize, option: &str) -> Result<String, String> {
    *index += 1;
    let value = args
        .get(*index)
        .ok_or_else(|| format!("{option} requires a value."))?;
    non_empty(value, option)
}

fn non_empty(value: &str, option: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err(format!("{option} requires a non-empty value."));
    }
    Ok(value.trim().to_string())
}

fn parse_port(value: &str) -> Result<u16, String> {
    parse_js_number(value)
        .and_then(valid_js_port)
        .ok_or_else(|| "Port must be a valid TCP port.".to_string())
}

fn env_web_port(value: Option<&str>) -> u16 {
    value
        .and_then(parse_js_number)
        .and_then(valid_js_port)
        .unwrap_or(8080)
}

fn valid_js_port(value: f64) -> Option<u16> {
    (value.is_finite() && value.fract() == 0.0 && (1.0..=65535.0).contains(&value))
        .then_some(value as u16)
}

fn parse_js_number(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix)
                .ok()
                .map(|value| value as f64);
        }
    }
    match value {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ if [
            "inf",
            "+inf",
            "-inf",
            "infinity",
            "+infinity",
            "-infinity",
            "nan",
        ]
        .iter()
        .any(|alias| value.eq_ignore_ascii_case(alias)) =>
        {
            None
        }
        _ => value.parse::<f64>().ok(),
    }
}

fn initialize_cli_path() {
    if std::env::var_os("TASK_HANDOFF_CLI_PATH").is_none() {
        if let Ok(executable) = std::env::current_exe() {
            std::env::set_var("TASK_HANDOFF_CLI_PATH", executable);
        }
    }
}

fn print_root_help() {
    println!(
        "Usage: task-handoff-controlled-instance [options] [command]\n\n\
Run a TaskHandoff controlled instance.\n\n\
Options:\n  \
-V, --version   output the version number\n  \
-h, --help      display help for command\n\n\
Commands:\n  \
web [options]   Run the controlled instance web server.\n  \
help [command]  display help for command"
    );
}

fn print_web_help() {
    let host = std::env::var("TASK_HANDOFF_WEB_HOST")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env_web_port(std::env::var("TASK_HANDOFF_WEB_PORT").ok().as_deref());
    let static_dir = std::env::var("TASK_HANDOFF_WEB_STATIC_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_static_dir);
    println!(
        "Usage: task-handoff-controlled-instance web [options]\n\n\
Run the controlled instance web server.\n\n\
Options:\n  \
--host <host>        Web server host (default: \"{host}\")\n  \
-p, --port <port>    Web server port (default: {port})\n  \
--static-dir <path>  Web UI static directory (default:\n                       \"{}\")\n  \
-h, --help           display help for command",
        static_dir.display()
    );
}

fn default_static_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .and_then(|path| path.parent().map(|root| root.join("ui")))
        .unwrap_or_else(|| PathBuf::from("ui"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_arguments_defaults_to_web() {
        assert_eq!(
            parse(Vec::new()).expect("parse"),
            Command::Web(ServerOptions::default())
        );
    }

    #[test]
    fn web_port_is_validated() {
        assert!(parse(vec!["web".into(), "--port".into(), "0".into()]).is_err());
        assert_eq!(
            parse(vec!["web".into(), "--port".into(), "8080".into()]).expect("parse"),
            Command::Web(ServerOptions {
                port: Some(8080),
                ..ServerOptions::default()
            })
        );
    }

    #[test]
    fn web_port_uses_javascript_number_semantics() {
        for (value, expected) in [("1e3", 1000), ("8080.0", 8080), ("0x1f90", 8080)] {
            assert_eq!(
                parse(vec!["web".into(), "--port".into(), value.into()]).expect("parse"),
                Command::Web(ServerOptions {
                    port: Some(expected),
                    ..ServerOptions::default()
                }),
                "{value}"
            );
        }
        for value in ["-1", "1.5", "65536", "NaN", "Infinity", "inf", "not-a-port"] {
            assert!(
                parse(vec!["web".into(), "--port".into(), value.into()]).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn web_port_environment_falls_back_to_the_default() {
        assert_eq!(env_web_port(None), 8080);
        assert_eq!(env_web_port(Some("")), 8080);
        assert_eq!(env_web_port(Some("0")), 8080);
        assert_eq!(env_web_port(Some("not-a-port")), 8080);
        assert_eq!(env_web_port(Some("1e3")), 1000);
        assert_eq!(env_web_port(Some("0x1f91")), 8081);
    }

    #[test]
    fn hidden_git_commands_are_recognized() {
        assert_eq!(
            parse(vec!["git-credential-helper".into(), "get".into()]).expect("parse"),
            Command::GitCredentialHelper(vec!["get".into()])
        );
        assert_eq!(
            parse(vec![
                "git-provisioning-helper".into(),
                "credential".into(),
                "get".into()
            ])
            .expect("parse"),
            Command::GitProvisioningHelper(vec!["credential".into(), "get".into()])
        );
    }

    #[test]
    fn options_without_the_web_command_are_rejected_like_commander() {
        assert_eq!(
            parse(vec!["--port".into(), "8080".into()]).expect_err("direct options are rejected"),
            "unknown option '--port'"
        );
    }

    #[test]
    fn askpass_requires_exactly_one_invocation_id() {
        assert_eq!(
            parse(vec!["git-ssh-askpass".into()]).expect_err("missing invocation"),
            "missing required argument 'invocationId'"
        );
        assert!(parse(vec![
            "git-ssh-askpass".into(),
            "invocation".into(),
            "extra".into()
        ])
        .is_err());
        assert_eq!(
            parse(vec!["git-ssh-askpass".into(), "invocation".into()]).expect("valid askpass"),
            Command::GitSshAskpass(Some("invocation".into()))
        );
    }

    #[test]
    fn help_commands_select_the_same_topics_as_commander() {
        assert_eq!(
            parse(vec!["--help".into()]).expect("root help"),
            Command::Help(HelpTopic::Root)
        );
        assert_eq!(
            parse(vec!["web".into(), "--help".into()]).expect("web help"),
            Command::Help(HelpTopic::Web)
        );
        assert_eq!(
            parse(vec!["help".into(), "web".into()]).expect("help web"),
            Command::Help(HelpTopic::Web)
        );
    }
}
