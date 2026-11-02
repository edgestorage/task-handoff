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
    Help,
    Version,
}

#[tokio::main]
async fn main() -> ExitCode {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .try_init();
    match run(std::env::args_os().skip(1).collect()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

async fn run(args: Vec<OsString>) -> Result<(), String> {
    match parse(args)? {
        Command::Help => {
            print_help();
            Ok(())
        }
        Command::Version => {
            println!("{}", resolve_package_version());
            Ok(())
        }
        Command::Web(options) => {
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
        port: std::env::var("TASK_HANDOFF_WEB_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .or(_port),
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
        "git-ssh-askpass" => Ok(Command::GitSshAskpass(strings.get(1).cloned())),
        "git-provisioning-helper" => Ok(Command::GitProvisioningHelper(strings[1..].to_vec())),
        "--help" | "-h" | "help" => Ok(Command::Help),
        "--version" | "-V" => Ok(Command::Version),
        value if value.starts_with('-') => parse_web(&strings),
        other => Err(format!("Unknown command: {other}")),
    }
}

fn parse_web(args: &[String]) -> Result<Command, String> {
    let mut options = ServerOptions::default();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        match argument.as_str() {
            "--help" | "-h" => return Ok(Command::Help),
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
            other => return Err(format!("Unknown web option: {other}")),
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
    let port = value
        .parse::<u16>()
        .map_err(|_| "Port must be a valid TCP port.".to_string())?;
    if port == 0 {
        return Err("Port must be a valid TCP port.".to_string());
    }
    Ok(port)
}

fn print_help() {
    println!(
		"Run a TaskHandoff controlled instance.\n\nUsage: task-handoff-controlled-instance [web] [--host <host>] [-p|--port <port>] [--static-dir <path>]"
	);
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
}
