#![cfg(unix)]

use controlled_instance_core::local_ipc::{bind as bind_local_ipc, LocalIpcEndpoint};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    task::JoinHandle,
};

struct Broker {
    socket_path: PathBuf,
    requests: JoinHandle<Vec<Value>>,
}

async fn mock_broker(responses: Vec<Value>) -> (tempfile::TempDir, Broker) {
    let root = tempfile::Builder::new()
        .prefix("thcli-")
        .tempdir_in(if cfg!(target_os = "macos") {
            Path::new("/private/tmp")
        } else {
            Path::new("/tmp")
        })
        .expect("tempdir");
    let endpoint = LocalIpcEndpoint::in_directory(root.path(), "th-cli-test", "broker", "b.sock")
        .expect("endpoint");
    endpoint.prepare().expect("prepare");
    let mut listener = bind_local_ipc(&endpoint).expect("bind");
    let socket_path = endpoint.path().to_path_buf();
    let requests = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let mut stream = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.expect("request");
            requests.push(serde_json::from_slice(&request).expect("request json"));
            stream
                .write_all(format!("{}\n", response).as_bytes())
                .await
                .expect("response");
            stream.shutdown().await.expect("shutdown");
        }
        requests
    });
    (
        root,
        Broker {
            socket_path,
            requests,
        },
    )
}

fn command(socket_path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_controlled-instance-rs"));
    command.env("TASK_HANDOFF_GIT_CREDENTIAL_SOCKET", socket_path);
    command
}

async fn run_helper(socket_path: &Path) -> std::process::Output {
    let mut child = command(socket_path)
        .arg("git-credential-helper")
        .arg("get")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn helper");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"protocol=https\nhost=git.example.com\npath=team/repo.git\n\n")
        .await
        .expect("stdin write");
    child.wait_with_output().await.expect("helper output")
}

#[tokio::test]
async fn credential_helper_prints_only_successful_credentials() {
    let (_root, broker) = mock_broker(vec![json!({
        "status": "ok",
        "username": "git",
        "password": "secret-token"
    })])
    .await;
    let output = run_helper(&broker.socket_path).await;
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "username=git\npassword=secret-token\n\n"
    );
    assert!(output.stderr.is_empty());
    let requests = broker.requests.await.expect("broker requests");
    assert_eq!(
        requests,
        [json!({
            "type": "https",
            "protocol": "https",
            "host": "git.example.com",
            "path": "team/repo.git"
        })]
    );
}

#[tokio::test]
async fn credential_failures_are_explicit_and_never_print_stdout() {
    for (status, marker) in [
        ("unsupported", "UNSUPPORTED"),
        ("rejected", "REJECTED"),
        ("missing-host-key", "MISSING_HOST_KEY"),
        ("ambiguous", "AMBIGUOUS"),
    ] {
        let (_root, broker) = mock_broker(vec![json!({ "status": status })]).await;
        let output = run_helper(&broker.socket_path).await;
        assert!(!output.status.success(), "status={status}");
        assert!(output.stdout.is_empty(), "status={status}");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains(&format!("TASK_HANDOFF_GIT_CREDENTIAL_ERROR={marker}")),
            "status={status} stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        broker.requests.await.expect("broker requests");
    }
}

#[tokio::test]
async fn ssh_uses_the_managed_agent_and_releases_the_invocation() {
    let (_root, broker) = mock_broker(vec![
        json!({
            "status": "ok",
            "invocationId": "gitssh_cli",
            "agentSocket": "/private/tmp/thcli-agent.sock",
            "publicIdentityPath": "/private/tmp/thcli-identity.pub",
            "knownHostsPath": "/private/tmp/thcli-known-hosts"
        }),
        json!({ "status": "ok" }),
    ])
    .await;
    let bin = tempfile::Builder::new()
        .prefix("thcli-bin-")
        .tempdir_in(if cfg!(target_os = "macos") {
            Path::new("/private/tmp")
        } else {
            Path::new("/tmp")
        })
        .expect("tempdir");
    let ssh = bin.path().join("ssh");
    std::fs::write(
        &ssh,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SSH_ARGS_FILE\"\nprintf '%s\\n' \"$SSH_AUTH_SOCK\" > \"$SSH_AUTH_FILE\"\n",
    )
    .expect("fake ssh");
    std::fs::set_permissions(&ssh, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .expect("ssh mode");
    let args_file = bin.path().join("args");
    let auth_file = bin.path().join("auth");
    let path = format!(
        "{}:{}",
        bin.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let output = command(&broker.socket_path)
        .arg("git-ssh")
        .args(["git@git.example.com", "git-upload-pack 'team/repo.git'"])
        .env("PATH", path)
        .env("SSH_ARGS_FILE", &args_file)
        .env("SSH_AUTH_FILE", &auth_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .expect("git-ssh output");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = std::fs::read_to_string(args_file).expect("ssh args");
    assert!(args.contains("-oStrictHostKeyChecking=yes"));
    assert!(args.contains("-oIdentityAgent=/private/tmp/thcli-agent.sock"));
    assert!(args.contains("git@git.example.com"));
    assert_eq!(
        std::fs::read_to_string(auth_file).expect("auth socket"),
        "/private/tmp/thcli-agent.sock\n"
    );
    let requests = broker.requests.await.expect("broker requests");
    assert_eq!(requests[0]["type"], "ssh-prepare");
    assert_eq!(
        requests[1],
        json!({ "type": "ssh-release", "invocationId": "gitssh_cli" })
    );
}
