#![cfg(unix)]

use controlled_instance_app_runtime::{
    codex_app_server::{
        start_session_proxy, wait_until_ready, CodexAppServerListenPlan, CodexAppServerTransport,
        CodexAppServerUpstream, CodexSessionProxy,
    },
    process_group_exists, AppRuntime, AppSession,
};
use controlled_instance_core::paths::StoragePaths;
use controlled_instance_protocol::AppLaunchOptions;
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixListener},
    process::{Child, Command},
    sync::Mutex,
    task::JoinHandle,
    time::{sleep, timeout, Instant},
};
use tokio_tungstenite::{
    accept_hdr_async, connect_async,
    tungstenite::{
        handshake::server::{Request, Response},
        http::Response as HttpResponse,
        Message,
    },
};

const FAKE_CODEX_SCRIPT: &str = r#"#!/bin/sh
set -eu

test_dir="${FAKE_CODEX_TEST_DIR:-}"
if [ -z "$test_dir" ]; then
  echo "FAKE_CODEX_TEST_DIR is required" >&2
  exit 64
fi
mkdir -p "$test_dir"

is_app_server=0
for arg in "$@"; do
  if [ "$arg" = "app-server" ]; then
    is_app_server=1
  fi
done

if [ "$is_app_server" = "1" ]; then
  printf '%s\n' "$$" >> "$test_dir/app-server-pids"
  printf '%s\n' "${FAKE_CODEX_LAUNCH_ENV_MARKER:-}" > "$test_dir/app-server-launch-env"
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--listen" ]; then
      printf '%s\n' "$arg" >> "$test_dir/app-server-endpoints"
      case "$arg" in
        unix://*)
          socket_path="${arg#unix://}"
          mkdir -p "$(dirname "$socket_path")"
          rm -f "$socket_path"
          python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(); time.sleep(86400)' "$socket_path" &
          ;;
      esac
    fi
    previous="$arg"
  done
  while :; do
    sleep 0.2
  done
fi

session_id="${TASK_HANDOFF_APP_SESSION_ID:-unknown}"
record="$test_dir/tty-$session_id"
record_tmp="$record.tmp.$$"
{
  printf 'pid=%s\n' "$$"
  printf 'cwd=%s\n' "$PWD"
  printf 'appSessionId=%s\n' "$session_id"
  printf 'appServerUrl=%s\n' "${TASK_HANDOFF_CODEX_APP_SERVER_URL:-}"
  printf 'proxyUrl=%s\n' "${TASK_HANDOFF_CODEX_APP_SERVER_PROXY_URL:-}"
  printf 'socket=%s\n' "${TASK_HANDOFF_CODEX_APP_SERVER_SOCKET:-}"
  printf 'marker=%s\n' "${FAKE_CODEX_MARKER:-}"
  for arg in "$@"; do
    printf 'arg=%s\n' "$arg"
  done
} > "$record_tmp"
mv "$record_tmp" "$record"

if [ -n "${FAKE_CODEX_EXIT_AFTER_SECONDS:-}" ]; then
  sleep "$FAKE_CODEX_EXIT_AFTER_SECONDS"
  exit "${FAKE_CODEX_EXIT_CODE:-0}"
fi

if [ -n "${FAKE_CODEX_WAIT_FOR_FILE:-}" ]; then
  while [ ! -e "$FAKE_CODEX_WAIT_FOR_FILE" ]; do
    sleep 0.05
  done
  exit 0
fi

while :; do
  sleep 1
done
"#;

fn serial_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct TestEnvironment {
    previous: Vec<(&'static str, Option<OsString>)>,
    socket_dir: PathBuf,
}

impl TestEnvironment {
    fn install(root: &Path, script: &Path, transport: CodexAppServerTransport) -> Self {
        let names = [
            "TASK_HANDOFF_CODEX_COMMAND",
            "TASK_HANDOFF_CODEX_APP_SERVER_COMMAND",
            "TASK_HANDOFF_CODEX_APP_SERVER_TRANSPORT",
            "TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR",
            "TASK_HANDOFF_CODEX_APP_SERVER_DISABLED",
            "TASK_HANDOFF_CODEX_MODEL",
            "CODEX_MODEL",
            "TASK_HANDOFF_AGENT_TOOLS_ENDPOINT",
            "TASK_HANDOFF_AGENT_TOOLS_TOKEN",
            "FAKE_CODEX_TEST_DIR",
            "FAKE_CODEX_LAUNCH_ENV_MARKER",
        ];
        let previous = names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect::<Vec<_>>();
        static NEXT_SOCKET_DIR: AtomicU64 = AtomicU64::new(1);
        let state_dir = root.join("fake-codex-state");
        let socket_dir = PathBuf::from("/tmp").join(format!(
            "task-handoff-ci-{}-{}",
            std::process::id(),
            NEXT_SOCKET_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&state_dir).expect("fake state directory");
        std::fs::create_dir_all(&socket_dir).expect("socket directory");
        std::env::set_var("TASK_HANDOFF_CODEX_COMMAND", script);
        std::env::set_var("TASK_HANDOFF_CODEX_APP_SERVER_COMMAND", script);
        std::env::set_var(
            "TASK_HANDOFF_CODEX_APP_SERVER_TRANSPORT",
            transport.metadata_value(),
        );
        std::env::set_var("TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR", &socket_dir);
        std::env::set_var("FAKE_CODEX_TEST_DIR", &state_dir);
        for name in [
            "TASK_HANDOFF_CODEX_APP_SERVER_DISABLED",
            "TASK_HANDOFF_CODEX_MODEL",
            "CODEX_MODEL",
            "TASK_HANDOFF_AGENT_TOOLS_ENDPOINT",
            "TASK_HANDOFF_AGENT_TOOLS_TOKEN",
            "FAKE_CODEX_LAUNCH_ENV_MARKER",
        ] {
            std::env::remove_var(name);
        }
        Self {
            previous,
            socket_dir,
        }
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        for (name, value) in self.previous.drain(..) {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
        let _ = std::fs::remove_dir_all(&self.socket_dir);
    }
}

fn write_fake_codex(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = root.join("fake-codex");
    std::fs::write(&path, FAKE_CODEX_SCRIPT).expect("fake codex script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("fake codex permissions");
    path
}

fn storage(root: &Path) -> StoragePaths {
    StoragePaths {
        config_path: root.join("config.json"),
        data_dir: root.join("data"),
        app_catalog_dir: root.join("app-catalog"),
        app_sessions_dir: root.join("app-sessions"),
        triggers_dir: root.join("triggers"),
        runtime_dir: root.join("runtime"),
        events_dir: root.join("events"),
        artifact_dir: root.join("artifacts"),
        log_dir: root.join("logs"),
        web_token_path: root.join("web-token"),
    }
}

fn fake_state(root: &Path) -> PathBuf {
    root.join("fake-codex-state")
}

fn app_server_metadata(session: &AppSession) -> &serde_json::Value {
    session
        .ai
        .as_ref()
        .and_then(|ai| ai.get("appServer"))
        .expect("Codex app-server metadata")
}

fn metadata_u64(session: &AppSession, field: &str) -> u64 {
    app_server_metadata(session)
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| panic!("missing numeric app-server field {field}"))
}

fn metadata_str<'a>(session: &'a AppSession, field: &str) -> &'a str {
    app_server_metadata(session)
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("missing string app-server field {field}"))
}

fn line_count(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|content| {
            content
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count()
        })
        .unwrap_or(0)
}

async fn wait_until(description: &str, mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if predicate() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {description}"
        );
        sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_record(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(content) = std::fs::read_to_string(path) {
            if !content.trim().is_empty() {
                return content;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for fake Codex record {}",
            path.display()
        );
        sleep(Duration::from_millis(25)).await;
    }
}

fn record_value(record: &str, name: &str) -> String {
    record
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{name}=")))
        .unwrap_or_else(|| panic!("missing record field {name}: {record}"))
        .to_string()
}

fn record_args(record: &str) -> Vec<String> {
    record
        .lines()
        .filter_map(|line| line.strip_prefix("arg="))
        .map(ToString::to_string)
        .collect()
}

async fn start_codex(
    runtime: &AppRuntime,
    cwd: &Path,
    args: Vec<String>,
    env: BTreeMap<String, String>,
) -> AppSession {
    runtime
        .start(
            "codex",
            AppLaunchOptions {
                cwd: Some(cwd.display().to_string()),
                args,
                env,
                ..AppLaunchOptions::default()
            },
        )
        .await
        .expect("start Codex session")
}

async fn sleep_child() -> Child {
    Command::new("/bin/sh")
        .args(["-c", "exec sleep 30"])
        .kill_on_drop(true)
        .spawn()
        .expect("sleep child")
}

async fn stop_child(mut child: Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn start_health_server(statuses: Vec<u16>) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("health listener");
    let port = listener.local_addr().expect("health address").port();
    let task = tokio::spawn(async move {
        let mut request_index = 0;
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let status = statuses
                .get(request_index)
                .copied()
                .or_else(|| statuses.last().copied())
                .unwrap_or(200);
            request_index += 1;
            tokio::spawn(async move {
                let mut buffer = [0_u8; 2048];
                let _ = stream.read(&mut buffer).await;
                let reason = match status {
                    200 => "OK",
                    500 => "Internal Server Error",
                    _ => "Status",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (port, task)
}

async fn wait_for_line(path: &Path, index: usize) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Some(line) = content
                .lines()
                .filter(|line| !line.trim().is_empty())
                .nth(index.saturating_sub(1))
            {
                return line.to_string();
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for line {index} in {}",
            path.display()
        );
        sleep(Duration::from_millis(25)).await;
    }
}

fn ws_port(endpoint: &str) -> u16 {
    endpoint
        .strip_prefix("ws://127.0.0.1:")
        .expect("loopback websocket endpoint")
        .parse()
        .expect("websocket port")
}

fn spawn_ws_health_server(state_dir: PathBuf, generation: usize) -> JoinHandle<()> {
    tokio::spawn(async move {
        let endpoint = wait_for_line(&state_dir.join("app-server-endpoints"), generation).await;
        let port = ws_port(&endpoint);
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("bind fake app-server health endpoint");
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = [0_u8; 2048];
                let _ = stream.read(&mut buffer).await;
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
                let _ = stream.shutdown().await;
            });
        }
    })
}

async fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("ephemeral listener");
    listener.local_addr().expect("ephemeral address").port()
}

async fn start_proxy_on_available_port(
    upstream: CodexAppServerUpstream,
    callback: std::sync::Arc<dyn Fn(String) + Send + Sync>,
) -> CodexSessionProxy {
    for _ in 0..20 {
        match start_session_proxy(upstream.clone(), free_port().await, callback.clone()).await {
            Ok(proxy) => return proxy,
            Err(error) if error.to_string().contains("Address already in use") => {
                sleep(Duration::from_millis(10)).await;
            }
            Err(error) => panic!("Codex proxy start failed: {error}"),
        }
    }
    panic!("could not reserve a Codex proxy port");
}

async fn spawn_bearer_echo_server(expected: &'static str) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("upstream listener");
    let port = listener.local_addr().expect("upstream address").port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let callback = move |request: &Request, response: Response| {
                    let authorized = request
                        .headers()
                        .get("Authorization")
                        .and_then(|value| value.to_str().ok())
                        == Some(format!("Bearer {expected}").as_str());
                    if authorized {
                        Ok(response)
                    } else {
                        Err(HttpResponse::builder()
                            .status(401)
                            .body(Some("unauthorized".to_string()))
                            .expect("unauthorized response"))
                    }
                };
                let Ok(mut socket) = accept_hdr_async(stream, callback).await else {
                    return;
                };
                while let Some(Ok(message)) = socket.next().await {
                    if message.is_text() {
                        let _ = socket.send(message).await;
                    } else if message.is_close() {
                        break;
                    }
                }
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn two_codex_tty_sessions_share_one_app_server_and_release_by_consumer_count() {
    let _serial = serial_lock().lock().await;
    let root = TempDir::new().expect("tempdir");
    let script = write_fake_codex(root.path());
    let _environment =
        TestEnvironment::install(root.path(), &script, CodexAppServerTransport::Unix);
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let runtime = AppRuntime::new(storage(root.path()), &workspace);
    runtime.set_shared_resource_private_environment(
        "codex",
        BTreeMap::from([(
            "FAKE_CODEX_TEST_DIR".to_string(),
            fake_state(root.path()).display().to_string(),
        )]),
    );

    let first = start_codex(&runtime, &workspace, Vec::new(), BTreeMap::new()).await;
    let second = start_codex(&runtime, &workspace, Vec::new(), BTreeMap::new()).await;

    let pid = metadata_u64(&first, "pid");
    assert_eq!(pid, metadata_u64(&second, "pid"));
    assert_eq!(
        metadata_str(&first, "endpoint"),
        metadata_str(&second, "endpoint")
    );
    assert_ne!(
        metadata_u64(&first, "proxyPort"),
        metadata_u64(&second, "proxyPort")
    );
    let shared = runtime
        .shared_codex_connection()
        .expect("shared Codex app-server");
    assert_eq!(shared.pid, Some(pid as u32));
    assert_eq!(shared.upstream.endpoint(), metadata_str(&first, "endpoint"));
    wait_until("one fake app-server process", || {
        line_count(&fake_state(root.path()).join("app-server-pids")) == 1
    })
    .await;

    let stopped = runtime
        .stop_session(&first.id)
        .await
        .expect("stop first session");
    assert_eq!(stopped.status, "stopped");
    let still_shared = runtime
        .shared_codex_connection()
        .expect("second consumer keeps app-server alive");
    assert_eq!(still_shared.pid, Some(pid as u32));

    let stopped = runtime
        .stop_session(&second.id)
        .await
        .expect("stop second session");
    assert_eq!(stopped.status, "stopped");
    wait_until("shared app-server shutdown after last consumer", || {
        runtime.shared_codex_connection().is_none()
    })
    .await;
    wait_until("shared app-server process group exit", || {
        !process_group_exists(pid as u32)
    })
    .await;
    runtime.stop_all().await;
}

#[tokio::test]
async fn natural_tty_exit_releases_only_its_consumer_and_last_exit_stops_shared_child() {
    let _serial = serial_lock().lock().await;
    let root = TempDir::new().expect("tempdir");
    let script = write_fake_codex(root.path());
    let _environment =
        TestEnvironment::install(root.path(), &script, CodexAppServerTransport::Unix);
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let runtime = AppRuntime::new(storage(root.path()), &workspace);
    runtime.set_shared_resource_private_environment(
        "codex",
        BTreeMap::from([(
            "FAKE_CODEX_TEST_DIR".to_string(),
            fake_state(root.path()).display().to_string(),
        )]),
    );

    let first = start_codex(
        &runtime,
        &workspace,
        Vec::new(),
        BTreeMap::from([(
            "FAKE_CODEX_EXIT_AFTER_SECONDS".to_string(),
            "0.2".to_string(),
        )]),
    )
    .await;
    let release_second = fake_state(root.path()).join("release-second");
    let second = start_codex(
        &runtime,
        &workspace,
        Vec::new(),
        BTreeMap::from([(
            "FAKE_CODEX_WAIT_FOR_FILE".to_string(),
            release_second.display().to_string(),
        )]),
    )
    .await;
    let pid = metadata_u64(&first, "pid") as u32;

    wait_until("first natural TTY exit", || {
        runtime
            .get_session(&first.id)
            .is_some_and(|session| session.status == "exited")
    })
    .await;
    assert_eq!(
        runtime
            .shared_codex_connection()
            .and_then(|connection| connection.pid),
        Some(pid),
        "the running second consumer must retain the shared child"
    );

    std::fs::write(&release_second, b"release").expect("release second session");
    wait_until("second natural TTY exit", || {
        runtime
            .get_session(&second.id)
            .is_some_and(|session| session.status == "exited")
    })
    .await;
    wait_until("shared app-server shutdown after final TTY exit", || {
        runtime.shared_codex_connection().is_none()
    })
    .await;
    wait_until("shared app-server process group exit", || {
        !process_group_exists(pid)
    })
    .await;
    runtime.stop_all().await;
}

#[tokio::test]
async fn codex_proxy_port_failure_releases_the_shared_consumer() {
    let _serial = serial_lock().lock().await;
    let root = TempDir::new().expect("tempdir");
    let script = write_fake_codex(root.path());
    let _environment =
        TestEnvironment::install(root.path(), &script, CodexAppServerTransport::Unix);
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let runtime = AppRuntime::new(storage(root.path()), &workspace);
    runtime.set_shared_resource_private_environment(
        "codex",
        BTreeMap::from([(
            "FAKE_CODEX_TEST_DIR".to_string(),
            fake_state(root.path()).display().to_string(),
        )]),
    );

    let mut held_ports = Vec::new();
    for port in 8101..=8199 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            held_ports.push(listener);
        }
    }

    let error = runtime
        .start(
            "codex",
            AppLaunchOptions {
                cwd: Some(workspace.display().to_string()),
                ..AppLaunchOptions::default()
            },
        )
        .await
        .expect_err("all proxy ports are unavailable");
    assert_eq!(error.code(), "APP_RESOURCE_EXHAUSTED");
    assert!(runtime.list_sessions().is_empty());
    assert!(runtime.shared_codex_connection().is_none());

    let pid_path = fake_state(root.path()).join("app-server-pids");
    wait_until("app-server start record before cleanup", || {
        line_count(&pid_path) == 1
    })
    .await;
    let pid = std::fs::read_to_string(&pid_path)
        .expect("app-server pid record")
        .lines()
        .next()
        .expect("app-server pid")
        .parse::<u32>()
        .expect("numeric app-server pid");
    wait_until("failed launch app-server process group exit", || {
        !process_group_exists(pid)
    })
    .await;

    drop(held_ports);
    runtime.stop_all().await;
}

#[tokio::test]
async fn proxy_bind_success_and_failure_are_reported() {
    let port = free_port().await;
    let upstream = CodexAppServerUpstream::WebSocket {
        endpoint: "ws://127.0.0.1:9".to_string(),
        token_file: None,
    };
    let callback = std::sync::Arc::new(|_thread_id: String| {})
        as std::sync::Arc<dyn Fn(String) + Send + Sync>;
    let proxy = start_session_proxy(upstream.clone(), port, callback.clone())
        .await
        .expect("first proxy bind");
    assert_eq!(proxy.port(), port);
    assert_eq!(proxy.endpoint(), format!("ws://127.0.0.1:{port}"));

    let error = match start_session_proxy(upstream.clone(), port, callback.clone()).await {
        Ok(_) => panic!("second proxy bind must fail"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "APP_LAUNCH_FAILED");
    assert!(error.to_string().contains("Codex proxy bind failed"));

    proxy.stop();
    let deadline = Instant::now() + Duration::from_secs(2);
    let replacement = loop {
        match start_session_proxy(upstream.clone(), port, callback.clone()).await {
            Ok(proxy) => break proxy,
            Err(error) if Instant::now() < deadline => {
                assert_eq!(error.code(), "APP_LAUNCH_FAILED");
                sleep(Duration::from_millis(25)).await;
            }
            Err(error) => panic!("proxy port was not released: {error}"),
        }
    };
    replacement.stop();
}

#[tokio::test]
async fn proxy_relays_authorized_bearer_and_rejects_missing_token() {
    let (upstream_port, upstream_task) = spawn_bearer_echo_server("expected-token").await;
    let root = TempDir::new().expect("tempdir");
    let token_file = root.path().join("token");
    std::fs::write(&token_file, b"expected-token").expect("token file");
    let callback = std::sync::Arc::new(|_thread_id: String| {})
        as std::sync::Arc<dyn Fn(String) + Send + Sync>;

    let authorized = start_proxy_on_available_port(
        CodexAppServerUpstream::WebSocket {
            endpoint: format!("ws://127.0.0.1:{upstream_port}"),
            token_file: Some(token_file),
        },
        callback.clone(),
    )
    .await;
    let (mut client, _) = connect_async(authorized.endpoint())
        .await
        .expect("proxy websocket");
    client
        .send(Message::Text(
            r#"{"id":1,"method":"thread/resume","params":{"threadId":"thread-a"}}"#.into(),
        ))
        .await
        .expect("send rpc");
    let reply = timeout(Duration::from_secs(2), client.next())
        .await
        .expect("authorized reply timeout")
        .expect("authorized reply frame")
        .expect("authorized reply");
    assert_eq!(
        reply.into_text().expect("text reply"),
        r#"{"id":1,"method":"thread/resume","params":{"threadId":"thread-a"}}"#
    );
    drop(client);
    authorized.stop();

    let unauthorized = start_proxy_on_available_port(
        CodexAppServerUpstream::WebSocket {
            endpoint: format!("ws://127.0.0.1:{upstream_port}"),
            token_file: None,
        },
        callback,
    )
    .await;
    let (mut client, _) = connect_async(unauthorized.endpoint())
        .await
        .expect("proxy websocket");
    client
        .send(Message::Text(r#"{"id":2,"method":"thread/start"}"#.into()))
        .await
        .expect("send rejected rpc");
    let outcome = timeout(Duration::from_secs(2), client.next())
        .await
        .expect("rejected connection timeout");
    assert!(
        matches!(outcome, None | Some(Err(_))),
        "missing bearer token must close the proxy connection"
    );
    unauthorized.stop();
    upstream_task.abort();
}

#[tokio::test]
async fn readiness_checks_unix_socket_ws_health_and_early_child_exit() {
    let root = TempDir::new().expect("tempdir");
    let socket_path = root.path().join("app-server.sock");
    let _socket = UnixListener::bind(&socket_path).expect("unix socket");
    let mut unix_child = sleep_child().await;
    let unix_plan = CodexAppServerListenPlan {
        upstream: CodexAppServerUpstream::Unix {
            socket_path: socket_path.clone(),
        },
        listen_args: Vec::new(),
        health_url: None,
    };
    timeout(
        Duration::from_secs(2),
        wait_until_ready(&mut unix_child, &unix_plan),
    )
    .await
    .expect("unix readiness timeout")
    .expect("unix readiness");
    stop_child(unix_child).await;

    let (health_port, health_task) = start_health_server(vec![500, 200]).await;
    let mut ws_child = sleep_child().await;
    let ws_plan = CodexAppServerListenPlan {
        upstream: CodexAppServerUpstream::WebSocket {
            endpoint: format!("ws://127.0.0.1:{health_port}"),
            token_file: None,
        },
        listen_args: Vec::new(),
        health_url: Some(format!("http://127.0.0.1:{health_port}/readyz")),
    };
    timeout(
        Duration::from_secs(2),
        wait_until_ready(&mut ws_child, &ws_plan),
    )
    .await
    .expect("ws readiness timeout")
    .expect("ws readiness after retry");
    stop_child(ws_child).await;
    health_task.abort();

    let mut exited_child = Command::new("/bin/sh")
        .args(["-c", "exit 7"])
        .kill_on_drop(true)
        .spawn()
        .expect("exited child");
    let exited_plan = CodexAppServerListenPlan {
        upstream: CodexAppServerUpstream::Unix {
            socket_path: root.path().join("missing.sock"),
        },
        listen_args: Vec::new(),
        health_url: None,
    };
    let error = timeout(
        Duration::from_secs(2),
        wait_until_ready(&mut exited_child, &exited_plan),
    )
    .await
    .expect("early exit readiness timeout")
    .expect_err("exited app-server must fail readiness");
    assert!(error.to_string().contains("exited before becoming ready"));
    let _ = exited_child.wait().await;
}

#[tokio::test]
async fn ws_shared_server_uses_generations_and_old_watchers_do_not_stop_new_child() {
    let _serial = serial_lock().lock().await;
    let root = TempDir::new().expect("tempdir");
    let script = write_fake_codex(root.path());
    let _environment =
        TestEnvironment::install(root.path(), &script, CodexAppServerTransport::WebSocket);
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let runtime = AppRuntime::new(storage(root.path()), &workspace);
    let state_dir = fake_state(root.path());
    runtime.set_shared_resource_private_environment(
        "codex",
        BTreeMap::from([(
            "FAKE_CODEX_TEST_DIR".to_string(),
            state_dir.display().to_string(),
        )]),
    );

    let first_health = spawn_ws_health_server(state_dir.clone(), 1);
    let first = timeout(Duration::from_secs(5), runtime.ensure_shared_codex())
        .await
        .expect("first ws readiness timeout")
        .expect("first shared ws app-server");
    wait_until("first ws app-server start record", || {
        line_count(&state_dir.join("app-server-pids")) == 1
    })
    .await;
    first_health.abort();

    runtime.set_shared_resource_private_environment(
        "codex",
        BTreeMap::from([
            (
                "FAKE_CODEX_TEST_DIR".to_string(),
                state_dir.display().to_string(),
            ),
            ("FAKE_CODEX_GENERATION".to_string(), "2".to_string()),
        ]),
    );
    assert!(runtime.shared_codex_connection().is_none());

    let second_health = spawn_ws_health_server(state_dir.clone(), 2);
    let second = timeout(Duration::from_secs(5), runtime.ensure_shared_codex())
        .await
        .expect("second ws readiness timeout")
        .expect("second shared ws app-server");
    wait_until("second ws app-server start record", || {
        line_count(&state_dir.join("app-server-pids")) == 2
    })
    .await;
    assert_ne!(first.pid, second.pid);
    assert_ne!(first.upstream.endpoint(), second.upstream.endpoint());

    sleep(Duration::from_millis(500)).await;
    assert_eq!(
        runtime
            .shared_codex_connection()
            .and_then(|connection| connection.pid),
        second.pid,
        "the previous generation watcher must not stop the replacement"
    );

    second_health.abort();
    runtime.stop_shared_codex();
    if let Some(pid) = second.pid {
        wait_until("second ws app-server process group exit", || {
            !process_group_exists(pid)
        })
        .await;
    }
    runtime.stop_all().await;
}

#[tokio::test]
async fn codex_tty_new_and_resume_preserve_remote_argument_order_and_environment() {
    let _serial = serial_lock().lock().await;
    let root = TempDir::new().expect("tempdir");
    let script = write_fake_codex(root.path());
    let _environment =
        TestEnvironment::install(root.path(), &script, CodexAppServerTransport::Unix);
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace_arg = workspace.to_str().expect("workspace utf8");
    let workspace_cwd = std::fs::canonicalize(&workspace).expect("canonical workspace");
    let workspace_cwd = workspace_cwd.to_str().expect("workspace utf8");
    let runtime = AppRuntime::new(storage(root.path()), &workspace);
    let state_dir = fake_state(root.path());
    runtime.set_shared_resource_private_environment(
        "codex",
        BTreeMap::from([(
            "FAKE_CODEX_TEST_DIR".to_string(),
            state_dir.display().to_string(),
        )]),
    );

    let new_session = start_codex(
        &runtime,
        &workspace,
        vec!["--option".to_string(), "value".to_string()],
        BTreeMap::from([
            ("FAKE_CODEX_MARKER".to_string(), "new".to_string()),
            (
                "FAKE_CODEX_LAUNCH_ENV_MARKER".to_string(),
                "launch-env".to_string(),
            ),
        ]),
    )
    .await;
    let new_record = wait_for_record(&state_dir.join(format!("tty-{}", new_session.id))).await;
    let new_proxy = metadata_str(&new_session, "proxyEndpoint").to_string();
    let new_upstream = metadata_str(&new_session, "endpoint").to_string();
    let new_socket = metadata_str(&new_session, "socketPath").to_string();
    assert_eq!(
        record_args(&new_record),
        vec![
            "-c",
            "check_for_update_on_startup=false",
            "--remote",
            new_proxy.as_str(),
            "--cd",
            workspace_arg,
            "--option",
            "value",
        ]
    );
    assert_eq!(record_value(&new_record, "cwd"), workspace_cwd);
    assert_eq!(record_value(&new_record, "appSessionId"), new_session.id);
    assert_eq!(record_value(&new_record, "appServerUrl"), new_upstream);
    assert_eq!(record_value(&new_record, "proxyUrl"), new_proxy);
    assert_eq!(record_value(&new_record, "socket"), new_socket);
    assert_eq!(record_value(&new_record, "marker"), "new");
    assert_eq!(
        wait_for_record(&state_dir.join("app-server-launch-env"))
            .await
            .trim(),
        "launch-env"
    );

    let resumed = runtime
        .start_resume(
            "codex",
            workspace_arg,
            "ai-session-123",
            "provider-session-123",
        )
        .await
        .expect("resume Codex session");
    let resume_record = wait_for_record(&state_dir.join(format!("tty-{}", resumed.id))).await;
    let resume_proxy = metadata_str(&resumed, "proxyEndpoint").to_string();
    assert_eq!(
        record_args(&resume_record),
        vec![
            "-c",
            "check_for_update_on_startup=false",
            "--remote",
            resume_proxy.as_str(),
            "--cd",
            workspace_arg,
            "resume",
            "provider-session-123",
        ]
    );
    assert_eq!(record_value(&resume_record, "appSessionId"), resumed.id);
    assert_eq!(
        resumed.launch.as_ref().and_then(|launch| {
            launch.ai_session_resume.as_ref().map(|resume| {
                (
                    resume.ai_session_id.as_str(),
                    resume.provider_session_id.as_str(),
                )
            })
        }),
        Some(("ai-session-123", "provider-session-123"))
    );
    assert_eq!(
        record_value(&resume_record, "appServerUrl"),
        metadata_str(&resumed, "endpoint")
    );
    assert_eq!(record_value(&resume_record, "proxyUrl"), resume_proxy);
    assert_eq!(
        record_value(&resume_record, "socket"),
        metadata_str(&resumed, "socketPath")
    );
    assert_eq!(
        metadata_u64(&new_session, "pid"),
        metadata_u64(&resumed, "pid")
    );

    let _ = runtime.stop_session(&new_session.id).await;
    let _ = runtime.stop_session(&resumed.id).await;
    runtime.stop_all().await;
}
