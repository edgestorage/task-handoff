use super::*;
use crate::process_group_exists;
use std::os::unix::fs::PermissionsExt;
use tokio::time::{sleep, timeout, Duration};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/codex-shared-owner-parity.json"
    ))
    .unwrap()
}
struct Harness {
    runtime: AppRuntime,
    root: tempfile::TempDir,
    socket: PathBuf,
    command: PathBuf,
    env: BTreeMap<String, String>,
}
impl Harness {
    fn new(mode: &str, marker: &str) -> Self {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let managed = root.path().join("managed-apps");
        let platform = crate::current_platform();
        let command = crate::managed_app_launcher_path(
            &managed,
            &crate::find_builtin_managed_app("codex").unwrap(),
            platform,
            crate::current_arch(),
            crate::detect_managed_app_recipe_target(platform),
        )
        .expect("managed Codex launcher");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::write(
            &command,
            include_bytes!("../../../../test/fixtures/codex-shared-owner/fake-codex.py"),
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runtime =
            AppRuntime::new_with_managed_root(storage(root.path()), root.path(), Some(managed));
        let socket = crate::codex_app_server::listen_plan(
            crate::codex_app_server::CodexAppServerTransport::Unix,
            &root.path().join("runtime/codex-app-server"),
            || unreachable!(),
        )
        .unwrap()
        .upstream
        .socket_path()
        .unwrap()
        .to_path_buf();
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        // Story MCP args are derived from the ambient environment. Keep this
        // fixture deterministic so the shared golden does not depend on the
        // invoking shell.
        env.remove("TASK_HANDOFF_AGENT_TOOLS_ENDPOINT");
        env.remove("TASK_HANDOFF_AGENT_TOOLS_TOKEN");
        let value = Self {
            runtime,
            root,
            socket,
            command,
            env,
        };
        value.environment(mode, marker);
        value
    }
    fn environment(&self, mode: &str, marker: &str) {
        self.runtime.set_shared_resource_private_environment(
            "codex",
            BTreeMap::from([
                (
                    "OWNER_PARITY_ROOT".into(),
                    self.root.path().display().to_string(),
                ),
                ("OWNER_PARITY_MODE".into(), mode.into()),
                ("OWNER_PARITY_MARKER".into(), marker.into()),
            ]),
        );
    }
    async fn acquire(&self, id: &str) -> Result<Value, AppRuntimeError> {
        let connection = self
            .runtime
            .acquire_shared_codex(id, Some(&self.env))
            .await?;
        Ok(project_connection(connection))
    }

    fn records(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("launches.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn snapshot(&self) -> Value {
        let owner = self
            .runtime
            .shared_codex_connection()
            .map(project_connection);
        let records = self.records();
        json!({"owner":owner,"socketExists":self.socket.exists(),"launches":records,
            "processes":records.iter().map(|r| {let pid=r["pid"].as_u64().unwrap() as u32;json!({"pid":pid,"alive":alive(pid),"groupAlive":process_group_exists(pid)})}).collect::<Vec<_>>()})
    }
    async fn stopped(&self) {
        until(
            || {
                self.records()
                    .iter()
                    .all(|r| !process_group_exists(r["pid"].as_u64().unwrap() as u32))
            },
            "owned groups exit",
        )
        .await;
    }
    async fn greeting(&self) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        timeout(Duration::from_secs(2), async {
            let mut stream = tokio::net::UnixStream::connect(&self.socket).await.unwrap();
            stream.write_all(b"greet\n").await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            String::from_utf8(bytes).unwrap()
        })
        .await
        .unwrap()
    }
    fn normalize(&self, value: &mut Value) {
        let records = self.records();
        let mut pids = BTreeMap::new();
        for (index, record) in records.iter().enumerate() {
            pids.insert(
                record["pid"].as_u64().unwrap(),
                format!("<child-{}>", index + 1),
            );
            if let Some(pid) = record["childPid"].as_u64() {
                pids.insert(pid, format!("<descendant-{}>", index + 1));
            }
        }
        fn walk(value: &mut Value, root: &str, socket: &str, command: &str, pids: &BTreeMap<u64, String>) {
            match value {
                Value::Object(values) => {
                    for (key, value) in values {
                        if (key == "pid" || key == "childPid") && !value.is_null() {
                            *value = json!(pids[&value.as_u64().unwrap()]);
                        } else {
                            walk(value, root, socket, command, pids)
                        }
                    }
                }
                Value::Array(values) => {
                    for value in values {
                        walk(value, root, socket, command, pids)
                    }
                }
                Value::String(text) if text == command => *text = "<managed-codex>".into(),
                Value::String(text) => {
                    *text = text.replace(socket, "<socket>").replace(root, "<root>")
                }
                _ => {}
            }
        }
        walk(
            value,
            self.root.path().to_str().unwrap(),
            self.socket.to_str().unwrap(),
            self.command.to_str().unwrap(),
            &pids,
        );
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "U05.1 test CLI log: {}",
                std::fs::read_to_string(
                    self.root
                        .path()
                        .join("logs/app-sessions/codex-app-server/codex-app-server.log")
                )
                .unwrap_or_default()
            );
        }
        self.runtime.stop_shared_codex();
        for record in self.records() {
            let pid = record["pid"].as_u64().unwrap() as u32;
            if process_group_exists(pid) {
                terminate_process_group(pid);
            }
        }
        let _ = std::fs::remove_dir_all(self.socket.parent().unwrap());
    }
}
// Compare the shared connection boundary (Node details / Rust connection),
// rather than the larger session appServer metadata which also has status.
fn project_connection(c: SharedCodexConnection) -> Value {
    assert_eq!(
        c.upstream.transport(),
        crate::codex_app_server::CodexAppServerTransport::Unix
    );
    json!({"transport":"unix","endpoint":c.upstream.endpoint(),"socketPath":c.upstream.socket_path().unwrap(),
        "pid":c.pid,"command":c.command,"args":c.args,"logPath":c.log_path})
}
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}
async fn until(mut predicate: impl FnMut() -> bool, reason: &str) {
    timeout(Duration::from_secs(5), async {
        while !predicate() {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect(reason);
}
async fn observe(name: &str) -> Value {
    let harness = Harness::new(if name == "C02" { "exit" } else { "ready" }, "one");
    let runtime = &harness.runtime;
    let mut output = json!({});
    if name == "C01" {
        std::fs::write(&harness.socket, b"test-owned-stale-socket").unwrap();
        output["first"] = harness.acquire("consumer-a").await.unwrap();
        output["duplicate"] = harness.acquire("consumer-a").await.unwrap();
        output["second"] = harness.acquire("consumer-b").await.unwrap();
        output["greeting"] = json!(harness.greeting().await);
        output["shared"] = harness.snapshot();
        runtime.release_shared_codex("unknown");
        output["unknownReleased"] = harness.snapshot();
        runtime.release_shared_codex("consumer-a");
        output["oneReleased"] = harness.snapshot();
        runtime.release_shared_codex("consumer-a");
        output["repeatReleased"] = harness.snapshot();
        runtime.release_shared_codex("consumer-b");
        harness.stopped().await;
        output["lastReleased"] = harness.snapshot();
    } else if name == "C02" {
        let error = harness.acquire("consumer-a").await.unwrap_err();
        eprintln!("U05.1 startup error: {error}");
        output["error"] = json!({"code":error.code()});
        eprintln!("U05.1 C02 after early exit: {}", harness.snapshot());
        harness.stopped().await;
        output["failed"] = harness.snapshot();
        harness.environment("ready", "two");
        output["retry"] = harness.acquire("consumer-a").await.unwrap();
        output["greeting"] = json!(harness.greeting().await);
        output["recovered"] = harness.snapshot();
        runtime.release_shared_codex("consumer-a");
        harness.stopped().await;
        output["released"] = harness.snapshot();
    } else {
        output["first"] = harness.acquire("consumer-a").await.unwrap();
        output["greetingOne"] = json!(harness.greeting().await);
        let old_child = {
            let shared = runtime.inner.shared_codex.lock().unwrap();
            Arc::downgrade(&shared.as_ref().unwrap().child)
        };
        harness.environment("ready", "two");
        output["second"] = harness.acquire("consumer-b").await.unwrap();
        output["greetingTwo"] = json!(harness.greeting().await);
        until(
            || !process_group_exists(harness.records()[0]["pid"].as_u64().unwrap() as u32),
            "old group exit",
        )
        .await;
        // The only remaining owner of the old child Arc is its actual watcher.
        // Wait for that task to release it, then prove the replacement survives.
        until(|| old_child.upgrade().is_none(), "old watcher completion").await;
        assert_eq!(harness.greeting().await, "two");
        output["replaced"] = harness.snapshot();
        runtime.release_shared_codex("consumer-a");
        output["oldReleased"] = harness.snapshot();
        runtime.release_shared_codex("consumer-b");
        harness.stopped().await;
        output["lastReleased"] = harness.snapshot();
    }
    harness.normalize(&mut output);
    output
}
async fn compare(name: &str) {
    let actual = observe(name).await;
    assert_eq!(
        actual,
        fixture()["expected"][name],
        "shared owner/process/argv/private environment must match Node"
    );
}
#[tokio::test]
async fn c01_shared_consumers() {
    compare("C01").await;
}
#[tokio::test]
async fn c02_start_failure_retry() {
    compare("C02").await;
}
#[tokio::test]
async fn c03_replacement_survives_old_exit() {
    compare("C03").await;
}
#[tokio::test]
async fn c04_cancel_pending_start_reaps_group_and_artifacts() {
    let harness = Harness::new("cancel", "one");
    let runtime = harness.runtime.clone();
    let env = harness.env.clone();
    let pending =
        tokio::spawn(async move { runtime.acquire_shared_codex("consumer-a", Some(&env)).await });
    until(
        || !harness.records().is_empty(),
        "pending child and descendant recorded",
    )
    .await;
    let record = harness.records()[0].clone();
    let pid = record["pid"].as_u64().unwrap() as u32;
    let descendant = record["childPid"].as_u64().unwrap() as u32;
    assert!(alive(pid) && alive(descendant) && harness.socket.exists());
    assert!(harness.runtime.shared_codex_connection().is_none());
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    until(|| !alive(pid), "root exit after cancellation").await;
    let actual = json!({"rootAlive":alive(pid),"descendantAlive":alive(descendant),"groupAlive":process_group_exists(pid),"socketExists":harness.socket.exists(),"ownerPresent":harness.runtime.shared_codex_connection().is_some()});
    eprintln!("U05.1 C04 after cancellation: {actual}");
    assert_eq!(
        actual,
        json!({"rootAlive":false,"descendantAlive":false,"groupAlive":false,"socketExists":false,"ownerPresent":false})
    );
    harness.environment("ready", "two");
    let retry = harness.acquire("consumer-b").await.unwrap();
    assert_ne!(retry["pid"], pid);
    assert_eq!(harness.greeting().await, "two");
    harness.runtime.release_shared_codex("consumer-b");
    harness.stopped().await;
}
