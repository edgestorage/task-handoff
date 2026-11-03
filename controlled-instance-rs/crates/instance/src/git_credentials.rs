use anyhow::{anyhow, bail, Context};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use controlled_instance_core::{
    fs_permissions::restrict_path,
    git_transport::{parse_git_ssh_invocation, remote_from_https_credential_request},
    local_ipc::{
        bind as bind_local_ipc, connect as connect_local_ipc, create_private_temporary_directory,
        temporary_root, LocalIpcEndpoint, LocalIpcStream,
    },
};
use controlled_instance_protocol::{
    GitCredentialFailureStatus, GitCredentialHttpsResolveResponse, GIT_CREDENTIAL_REMOTE_MAX_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
    task::JoinHandle,
};
use tracing::warn;

use crate::node_agent_client::NodeAgentClient;

const BROKER_REQUEST_MAX_BYTES: usize = 1024 * 1024;
const SSH_AGENT_FRAME_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct GitCredentialBrokerOptions {
    pub socket_path: Option<PathBuf>,
    pub runtime_dir: Option<PathBuf>,
}

#[derive(Clone)]
pub struct GitCredentialBroker {
    inner: Arc<GitCredentialBrokerInner>,
}

struct GitCredentialBrokerInner {
    node_agent_client: NodeAgentClient,
    endpoint: LocalIpcEndpoint,
    socket_path: PathBuf,
    runtime_dir: PathBuf,
    request_count: AtomicU64,
    stop_tx: watch::Sender<bool>,
    state: Mutex<GitCredentialBrokerState>,
}

#[derive(Default)]
struct GitCredentialBrokerState {
    accept_task: Option<JoinHandle<()>>,
    connection_tasks: Vec<JoinHandle<()>>,
    ssh_invocations: BTreeMap<String, LocalSshInvocation>,
}

struct LocalSshInvocation {
    accept_task: JoinHandle<()>,
    connection_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    directory: PathBuf,
    endpoint: LocalIpcEndpoint,
}

struct CreatedSshAgentProxy {
    directory: PathBuf,
    socket_path: PathBuf,
}

impl GitCredentialBroker {
    pub fn new(
        node_agent_client: NodeAgentClient,
        options: GitCredentialBrokerOptions,
    ) -> anyhow::Result<Self> {
        let explicit_path = options
            .socket_path
            .or_else(|| std::env::var_os("TASK_HANDOFF_GIT_CREDENTIAL_SOCKET").map(PathBuf::from))
            .filter(|path| !path.as_os_str().is_empty());
        let process_id = std::process::id();
        let endpoint = LocalIpcEndpoint::generated_with_scope_name(
            &format!("task-handoff-git-proxy-{process_id}"),
            "broker.sock",
            explicit_path,
        )?;
        let socket_path = endpoint.path().to_path_buf();
        let runtime_dir = options.runtime_dir.unwrap_or_else(|| {
            if endpoint.filesystem_backed() {
                socket_path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(temporary_root)
            } else {
                temporary_root().join(format!("task-handoff-git-proxy-{process_id}"))
            }
        });
        let (stop_tx, _) = watch::channel(false);
        Ok(Self {
            inner: Arc::new(GitCredentialBrokerInner {
                node_agent_client,
                endpoint,
                socket_path,
                runtime_dir,
                request_count: AtomicU64::new(0),
                stop_tx,
                state: Mutex::new(GitCredentialBrokerState::default()),
            }),
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.inner.socket_path
    }

    pub fn runtime_dir(&self) -> &Path {
        &self.inner.runtime_dir
    }

    pub fn handled_request_count(&self) -> u64 {
        self.inner.request_count.load(Ordering::SeqCst)
    }

    pub async fn request(&self, request: Value) -> Value {
        self.inner.handle_wire_request(request).await
    }

    pub async fn start(&self) -> anyhow::Result<()> {
        {
            let state = self.inner.lock_state();
            if state.accept_task.is_some() {
                return Ok(());
            }
        }
        self.inner.endpoint.prepare().with_context(|| {
            format!(
                "prepare Git credential broker endpoint {}",
                self.inner.socket_path.display()
            )
        })?;
        std::fs::create_dir_all(&self.inner.runtime_dir).with_context(|| {
            format!(
                "create Git credential runtime directory {}",
                self.inner.runtime_dir.display()
            )
        })?;
        restrict_path(&self.inner.runtime_dir, 0o700)?;
        let mut listener = bind_local_ipc(&self.inner.endpoint).with_context(|| {
            format!(
                "bind Git credential broker socket {}",
                self.inner.socket_path.display()
            )
        })?;
        if self.inner.endpoint.filesystem_backed() {
            restrict_path(&self.inner.socket_path, 0o600)?;
        }

        let inner = Arc::clone(&self.inner);
        let weak = Arc::downgrade(&inner);
        let mut stop = self.inner.stop_tx.subscribe();
        let accept_task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    changed = stop.changed() => {
                        if changed.is_err() || *stop.borrow() {
                            break;
                        }
                        continue;
                    }
                    accepted = listener.accept() => accepted,
                };
                let mut stream = match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        warn!(%error, "Git credential broker accept failed");
                        continue;
                    }
                };
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let task_inner = Arc::clone(&inner);
                let task = tokio::spawn(async move {
                    let request = read_broker_request(&mut stream).await;
                    let Some(request) = request else {
                        return;
                    };
                    let response = task_inner.handle_wire_request(request).await;
                    if let Ok(mut encoded) = serde_json::to_vec(&response) {
                        encoded.push(b'\n');
                        let _ = stream.write_all(&encoded).await;
                        let _ = stream.shutdown().await;
                    }
                });
                let mut state = inner.lock_state();
                state.connection_tasks.retain(|task| !task.is_finished());
                state.connection_tasks.push(task);
            }
        });
        let mut state = self.inner.lock_state();
        state.accept_task = Some(accept_task);
        Ok(())
    }

    pub async fn close(&self) -> anyhow::Result<()> {
        let (accept_task, mut connection_tasks, invocations) = {
            let mut state = self.inner.lock_state();
            (
                state.accept_task.take(),
                std::mem::take(&mut state.connection_tasks),
                std::mem::take(&mut state.ssh_invocations),
            )
        };
        let _ = self.inner.stop_tx.send(true);
        if let Some(task) = accept_task {
            task.abort();
            let _ = task.await;
        }
        for task in connection_tasks.drain(..) {
            task.abort();
        }
        for (invocation_id, invocation) in invocations {
            cleanup_ssh_invocation(invocation);
            if let Err(error) = self
                .inner
                .node_agent_client
                .release_git_ssh(&invocation_id)
                .await
            {
                warn!(%error, %invocation_id, "failed to release managed Git SSH invocation");
            }
        }
        self.inner.endpoint.cleanup()?;
        Ok(())
    }
}

impl GitCredentialBrokerInner {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, GitCredentialBrokerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn handle_wire_request(&self, request: Value) -> Value {
        self.request_count.fetch_add(1, Ordering::SeqCst);
        let result = self.handle_wire_request_inner(request).await;
        result.unwrap_or_else(|error| {
            warn!(%error, "managed Git credential proxy request was rejected");
            json!({ "status": "rejected" })
        })
    }

    async fn handle_wire_request_inner(&self, request: Value) -> anyhow::Result<Value> {
        if !self.node_agent_client.enabled() {
            return Ok(json!({ "status": "none" }));
        }
        let kind = request.get("type").and_then(Value::as_str);
        match kind {
            Some("https") => {
                let remote = remote_from_https_credential_request(
                    request.get("protocol").and_then(Value::as_str),
                    request.get("host").and_then(Value::as_str),
                    request.get("path").and_then(Value::as_str),
                );
                let Some(remote) = remote else {
                    return Ok(json!({ "status": "unsupported" }));
                };
                if remote.len() > GIT_CREDENTIAL_REMOTE_MAX_BYTES {
                    return Ok(json!({ "status": "unsupported" }));
                }
                Ok(serde_json::to_value(
                    self.node_agent_client.resolve_git_https(&remote).await?,
                )?)
            }
            Some("ssh-prepare") => {
                let args = request
                    .get("args")
                    .and_then(Value::as_array)
                    .and_then(|values| {
                        values
                            .iter()
                            .map(|value| value.as_str().map(ToString::to_string))
                            .collect::<Option<Vec<_>>>()
                    });
                let Some(args) = args else {
                    return Ok(json!({ "status": "unsupported" }));
                };
                let Some(invocation) = parse_git_ssh_invocation(&args) else {
                    return Ok(json!({ "status": "unsupported" }));
                };
                if invocation.remote.len() > GIT_CREDENTIAL_REMOTE_MAX_BYTES {
                    return Ok(json!({ "status": "unsupported" }));
                }
                let prepared = self
                    .node_agent_client
                    .prepare_git_ssh(&invocation.remote)
                    .await?;
                let (invocation_id, public_identity, pinned_known_hosts) = match prepared {
                    controlled_instance_protocol::GitCredentialSshPrepareResponse::Ok {
                        invocation_id,
                        public_identity,
                        pinned_known_hosts,
                    } => (invocation_id, public_identity, pinned_known_hosts),
                    failure => return Ok(serde_json::to_value(failure)?),
                };
                let local = match self.create_ssh_agent_proxy(invocation_id.clone()).await {
                    Ok(local) => local,
                    Err(error) => {
                        if let Err(release_error) =
                            self.node_agent_client.release_git_ssh(&invocation_id).await
                        {
                            warn!(%release_error, %invocation_id, "failed to release managed Git SSH invocation after local proxy startup failed");
                        }
                        return Err(error);
                    }
                };
                let identity_path = local.directory.join("identity.pub");
                let known_hosts_path = local.directory.join("known_hosts");
                let write_material = (|| -> anyhow::Result<()> {
                    std::fs::write(&identity_path, public_identity)
                        .with_context(|| format!("write {}", identity_path.display()))?;
                    restrict_path(&identity_path, 0o600)?;
                    std::fs::write(&known_hosts_path, pinned_known_hosts)
                        .with_context(|| format!("write {}", known_hosts_path.display()))?;
                    restrict_path(&known_hosts_path, 0o600)?;
                    Ok(())
                })();
                if let Err(error) = write_material {
                    self.release_ssh_invocation(&invocation_id).await;
                    return Err(error);
                }
                Ok(json!({
                    "status": "ok",
                    "invocationId": invocation_id,
                    "agentSocket": local.socket_path,
                    "publicIdentityPath": identity_path,
                    "knownHostsPath": known_hosts_path,
                }))
            }
            Some("ssh-release") => {
                let Some(invocation_id) = request.get("invocationId").and_then(Value::as_str)
                else {
                    return Ok(json!({ "status": "unsupported" }));
                };
                self.release_ssh_invocation(invocation_id).await;
                Ok(json!({ "status": "ok" }))
            }
            _ => Ok(json!({ "status": "unsupported" })),
        }
    }

    async fn create_ssh_agent_proxy(
        &self,
        invocation_id: String,
    ) -> anyhow::Result<CreatedSshAgentProxy> {
        let directory = create_private_temporary_directory(&self.runtime_dir, "ssh-")
            .with_context(|| {
                format!(
                    "create SSH agent directory in {}",
                    self.runtime_dir.display()
                )
            })?;
        let endpoint = LocalIpcEndpoint::in_directory(
            &directory,
            "task-handoff-git-agent",
            &invocation_id,
            "agent.sock",
        )?;
        endpoint.prepare()?;
        let mut listener = bind_local_ipc(&endpoint).with_context(|| {
            format!(
                "bind managed Git SSH agent socket {}",
                endpoint.path().display()
            )
        })?;
        if endpoint.filesystem_backed() {
            restrict_path(endpoint.path(), 0o600)?;
        }
        let connection_tasks = Arc::new(Mutex::new(Vec::<JoinHandle<()>>::new()));
        let client = self.node_agent_client.clone();
        let task_connections = connection_tasks.clone();
        let proxy_invocation_id = invocation_id.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let Ok(stream) = listener.accept().await else {
                    break;
                };
                let client = client.clone();
                let invocation_id = proxy_invocation_id.clone();
                let task = tokio::spawn(async move {
                    proxy_ssh_agent_connection(client, invocation_id, stream).await;
                });
                let mut tasks = task_connections
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                tasks.retain(|task| !task.is_finished());
                tasks.push(task);
            }
        });
        let invocation = LocalSshInvocation {
            accept_task,
            connection_tasks,
            directory: directory.clone(),
            endpoint: endpoint.clone(),
        };
        self.lock_state()
            .ssh_invocations
            .insert(invocation_id, invocation);
        Ok(CreatedSshAgentProxy {
            directory,
            socket_path: endpoint.path().to_path_buf(),
        })
    }

    async fn release_ssh_invocation(&self, invocation_id: &str) -> bool {
        let invocation = self.lock_state().ssh_invocations.remove(invocation_id);
        let local_invocation = invocation.is_some();
        if let Some(invocation) = invocation {
            cleanup_ssh_invocation(invocation);
        }
        if let Err(error) = self.node_agent_client.release_git_ssh(invocation_id).await {
            warn!(%error, %invocation_id, "failed to release managed Git SSH invocation");
        }
        local_invocation
    }
}

impl Drop for GitCredentialBrokerInner {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(true);
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(task) = state.accept_task.as_ref() {
            task.abort();
        }
        for task in &state.connection_tasks {
            task.abort();
        }
        for invocation in state.ssh_invocations.values() {
            invocation.accept_task.abort();
            for task in invocation
                .connection_tasks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
            {
                task.abort();
            }
            let _ = std::fs::remove_dir_all(&invocation.directory);
        }
        let _ = self.endpoint.cleanup();
    }
}

fn cleanup_ssh_invocation(invocation: LocalSshInvocation) {
    invocation.accept_task.abort();
    for task in invocation
        .connection_tasks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain(..)
    {
        task.abort();
    }
    let _ = std::fs::remove_dir_all(&invocation.directory);
    let _ = invocation.endpoint.cleanup();
}

async fn proxy_ssh_agent_connection(
    client: NodeAgentClient,
    invocation_id: String,
    mut stream: LocalIpcStream,
) {
    loop {
        let mut length = [0_u8; 4];
        if stream.read_exact(&mut length).await.is_err() {
            return;
        }
        let frame_length = u32::from_be_bytes(length) as usize + 4;
        if !(5..=SSH_AGENT_FRAME_MAX_BYTES).contains(&frame_length) {
            return;
        }
        let mut frame = vec![0_u8; frame_length];
        frame[..4].copy_from_slice(&length);
        if stream.read_exact(&mut frame[4..]).await.is_err() {
            return;
        }
        let encoded = BASE64.encode(&frame);
        let Ok(response) = client
            .exchange_git_ssh_agent(&invocation_id, &encoded)
            .await
        else {
            return;
        };
        let Ok(response) = BASE64.decode(response.frame) else {
            return;
        };
        if response.len() < 5
            || response.len() > SSH_AGENT_FRAME_MAX_BYTES
            || u32::from_be_bytes([response[0], response[1], response[2], response[3]]) as usize
                != response.len() - 4
        {
            return;
        }
        if stream.write_all(&response).await.is_err() {
            return;
        }
    }
}

async fn read_broker_request(stream: &mut LocalIpcStream) -> Option<Value> {
    let mut input = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            break;
        }
        if input.len() + read > BROKER_REQUEST_MAX_BYTES {
            return None;
        }
        input.extend_from_slice(&buffer[..read]);
    }
    serde_json::from_slice(&input).ok()
}

pub fn git_broker_environment_entries(
    cli_path: &Path,
    socket_path: &Path,
    original_config_count: usize,
) -> Vec<(String, String)> {
    let executable = shell_single_quote(&cli_path.to_string_lossy());
    vec![
        (
            "TASK_HANDOFF_GIT_ORIGINAL_CONFIG_COUNT".to_string(),
            original_config_count.to_string(),
        ),
        (
            "GIT_CONFIG_COUNT".to_string(),
            (original_config_count + 4).to_string(),
        ),
        (
            format!("GIT_CONFIG_KEY_{original_config_count}"),
            "credential.helper".to_string(),
        ),
        (
            format!("GIT_CONFIG_VALUE_{original_config_count}"),
            String::new(),
        ),
        (
            format!("GIT_CONFIG_KEY_{}", original_config_count + 1),
            "credential.helper".to_string(),
        ),
        (
            format!("GIT_CONFIG_VALUE_{}", original_config_count + 1),
            format!("!{executable} git-credential-helper"),
        ),
        (
            format!("GIT_CONFIG_KEY_{}", original_config_count + 2),
            "credential.useHttpPath".to_string(),
        ),
        (
            format!("GIT_CONFIG_VALUE_{}", original_config_count + 2),
            "true".to_string(),
        ),
        (
            format!("GIT_CONFIG_KEY_{}", original_config_count + 3),
            "core.sshCommand".to_string(),
        ),
        (
            format!("GIT_CONFIG_VALUE_{}", original_config_count + 3),
            format!("{executable} git-ssh"),
        ),
        (
            "TASK_HANDOFF_GIT_CREDENTIAL_SOCKET".to_string(),
            socket_path.to_string_lossy().into_owned(),
        ),
    ]
}

pub fn install_git_broker_environment(cli_path: Option<&Path>, socket_path: &Path) -> bool {
    let Some(cli_path) = cli_path else {
        return false;
    };
    let original_config_count = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    for (key, value) in git_broker_environment_entries(cli_path, socket_path, original_config_count)
    {
        std::env::set_var(key, value);
    }
    true
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum BrokerSshPrepareResponse {
    Ok {
        #[serde(rename = "invocationId")]
        invocation_id: String,
        #[serde(rename = "agentSocket")]
        agent_socket: PathBuf,
        #[serde(rename = "publicIdentityPath")]
        public_identity_path: PathBuf,
        #[serde(rename = "knownHostsPath")]
        known_hosts_path: PathBuf,
    },
    None,
    Ambiguous,
    Unsupported,
    MissingHostKey,
    Rejected,
}

pub async fn run_git_credential_helper(action: Option<&str>) -> anyhow::Result<()> {
    if action != Some("get") {
        return Ok(());
    }
    let Some(socket_path) = std::env::var_os("TASK_HANDOFF_GIT_CREDENTIAL_SOCKET")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return Ok(());
    };
    let input = read_credential_input().await;
    let response = broker_request(
        &socket_path,
        json!({
            "type": "https",
            "protocol": input.get("protocol"),
            "host": input.get("host"),
            "path": input.get("path"),
        }),
    )
    .await?;
    let response: GitCredentialHttpsResolveResponse = serde_json::from_value(response)
        .context("managed Git credential proxy returned an invalid response")?;
    match response {
        GitCredentialHttpsResolveResponse::Ok { username, password } => {
            print_credential(&username, &password);
            Ok(())
        }
        GitCredentialHttpsResolveResponse::None => {
            if let Some((username, password)) = delegate_credential_lookup(&input) {
                print_credential(&username, &password);
            }
            Ok(())
        }
        failure => bail!(
            "TASK_HANDOFF_GIT_CREDENTIAL_ERROR={}",
            failure_status_marker(failure.failure().expect("non-ok response"))
        ),
    }
}

pub async fn run_git_ssh(args: &[String]) -> anyhow::Result<()> {
    let Some(socket_path) = std::env::var_os("TASK_HANDOFF_GIT_CREDENTIAL_SOCKET")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return run_ssh(args, false, None);
    };
    let invocation = parse_git_ssh_invocation(args)
        .ok_or_else(|| anyhow!("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=UNSUPPORTED"))?;
    let response =
        broker_request(&socket_path, json!({ "type": "ssh-prepare", "args": args })).await?;
    let response: BrokerSshPrepareResponse = serde_json::from_value(response)
        .context("managed Git credential proxy returned an invalid response")?;
    let prepared = match response {
        BrokerSshPrepareResponse::Ok {
            invocation_id,
            agent_socket,
            public_identity_path,
            known_hosts_path,
        } => (
            invocation_id,
            agent_socket,
            public_identity_path,
            known_hosts_path,
        ),
        BrokerSshPrepareResponse::None => return run_ssh(&invocation.args, false, None),
        BrokerSshPrepareResponse::Ambiguous => bail!("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=AMBIGUOUS"),
        BrokerSshPrepareResponse::Unsupported => {
            bail!("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=UNSUPPORTED")
        }
        BrokerSshPrepareResponse::MissingHostKey => {
            bail!("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=MISSING_HOST_KEY")
        }
        BrokerSshPrepareResponse::Rejected => {
            bail!("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=REJECTED")
        }
    };
    let (invocation_id, agent_socket, public_identity_path, known_hosts_path) = prepared;
    let null_device = if cfg!(target_os = "windows") {
        "NUL"
    } else {
        "/dev/null"
    };
    let mut managed_args = vec![
        "-F".to_string(),
        null_device.to_string(),
        "-oBatchMode=yes".to_string(),
        "-oIdentitiesOnly=yes".to_string(),
        "-oIdentityFile=none".to_string(),
        "-oStrictHostKeyChecking=yes".to_string(),
        format!("-oUserKnownHostsFile={}", known_hosts_path.display()),
        format!("-oGlobalKnownHostsFile={null_device}"),
        format!("-oIdentityAgent={}", agent_socket.display()),
        "-i".to_string(),
        public_identity_path.to_string_lossy().into_owned(),
    ];
    managed_args.extend(invocation.args);
    let result = run_ssh(&managed_args, true, Some(&agent_socket));
    let _ = broker_request(
        &socket_path,
        json!({ "type": "ssh-release", "invocationId": invocation_id }),
    )
    .await;
    result
}

pub async fn run_git_ssh_askpass() -> anyhow::Result<()> {
    bail!("SSH passphrases are handled only by node-agent.")
}

async fn broker_request(socket_path: &Path, request: Value) -> anyhow::Result<Value> {
    let endpoint = LocalIpcEndpoint::explicit(socket_path)?;
    let mut stream = connect_local_ipc(&endpoint)
        .await
        .with_context(|| format!("connect to Git credential broker {}", socket_path.display()))?;
    let encoded = serde_json::to_vec(&request)?;
    stream.write_all(&encoded).await?;
    stream.shutdown().await?;
    let mut output = Vec::new();
    stream
        .take(BROKER_REQUEST_MAX_BYTES as u64)
        .read_to_end(&mut output)
        .await?;
    if output.len() >= BROKER_REQUEST_MAX_BYTES {
        bail!("Managed Git credential proxy returned an oversized response.");
    }
    serde_json::from_slice(&output)
        .context("Managed Git credential proxy returned an invalid response.")
}

pub(crate) async fn read_credential_input() -> BTreeMap<String, String> {
    let mut input = String::new();
    let _ = tokio::io::AsyncReadExt::read_to_string(&mut tokio::io::stdin(), &mut input).await;
    input
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            (!key.is_empty()).then(|| (key.to_string(), value.to_string()))
        })
        .collect()
}

pub(crate) fn print_credential(username: &str, password: &str) {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "username={username}");
    let _ = writeln!(stdout, "password={password}");
    let _ = writeln!(stdout);
    let _ = stdout.flush();
}

fn delegate_credential_lookup(input: &BTreeMap<String, String>) -> Option<(String, String)> {
    let original_count = std::env::var("TASK_HANDOFF_GIT_ORIGINAL_CONFIG_COUNT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let current_count = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(original_count);
    let mut command = Command::new("git");
    command
        .args(["credential", "fill"])
        .env("GIT_CONFIG_COUNT", original_count.to_string())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for index in original_count..current_count {
        command.env_remove(format!("GIT_CONFIG_KEY_{index}"));
        command.env_remove(format!("GIT_CONFIG_VALUE_{index}"));
    }
    #[cfg(not(target_os = "windows"))]
    command
        .env("GIT_ASKPASS", "/bin/false")
        .env("SSH_ASKPASS", "/bin/false");
    let mut child = command.spawn().ok()?;
    {
        use std::io::Write;
        let mut stdin = child.stdin.take()?;
        for (key, value) in input {
            writeln!(stdin, "{key}={value}").ok()?;
        }
        writeln!(stdin).ok()?;
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let values = String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    Some((
        values.get("username")?.clone(),
        values.get("password")?.clone(),
    ))
}

pub(crate) fn run_ssh(
    args: &[String],
    managed: bool,
    auth_socket: Option<&Path>,
) -> anyhow::Result<()> {
    let mut command = Command::new("ssh");
    command.args(args);
    if managed {
        command.env_remove("SSH_AUTH_SOCK");
    }
    if let Some(auth_socket) = auth_socket {
        command.env("SSH_AUTH_SOCK", auth_socket);
    }
    let status = command
        .status()
        .context("Failed to start Git SSH transport.")?;
    if status.success() {
        Ok(())
    } else {
        bail!("Git SSH transport failed.")
    }
}

fn failure_status_marker(status: GitCredentialFailureStatus) -> &'static str {
    match status {
        GitCredentialFailureStatus::None => "NONE",
        GitCredentialFailureStatus::Ambiguous => "AMBIGUOUS",
        GitCredentialFailureStatus::Unsupported => "UNSUPPORTED",
        GitCredentialFailureStatus::MissingHostKey => "MISSING_HOST_KEY",
        GitCredentialFailureStatus::Rejected => "REJECTED",
    }
}

fn shell_single_quote(value: &str) -> String {
    controlled_instance_core::git_transport::shell_single_quote(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_agent_client::NodeAgentClientConfig;
    use axum::{
        extract::State as AxumState,
        http::HeaderMap,
        routing::{delete, post},
        Json, Router,
    };
    use controlled_instance_protocol::GitCredentialSshAgentResponse;
    use std::{net::SocketAddr, time::Duration};

    type HttpsRequests = Arc<Mutex<Vec<(Option<String>, Value)>>>;

    #[derive(Clone, Default)]
    struct MockNodeAgent {
        https_token: Arc<Mutex<String>>,
        https_requests: HttpsRequests,
        ssh_agent_requests: Arc<Mutex<Vec<Value>>>,
        released: Arc<Mutex<Vec<String>>>,
    }

    async fn mock_https(
        AxumState(state): AxumState<MockNodeAgent>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        state.https_requests.lock().expect("requests").push((
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToString::to_string),
            body,
        ));
        let token = state.https_token.lock().expect("token").clone();
        Json(json!({
            "data": { "status": "ok", "username": "git", "password": token }
        }))
    }

    async fn mock_ssh_prepare(Json(body): Json<Value>) -> Json<Value> {
        assert_eq!(body["remoteUrl"], "ssh://git.example.com/team/repo.git");
        Json(json!({
            "data": {
                "status": "ok",
                "invocationId": "gitssh_test",
                "publicIdentity": "ssh-ed25519 AAAATEST",
                "pinnedKnownHosts": "git.example.com ssh-ed25519 AAAATEST"
            }
        }))
    }

    async fn mock_ssh_agent(
        AxumState(state): AxumState<MockNodeAgent>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        state
            .ssh_agent_requests
            .lock()
            .expect("requests")
            .push(body.clone());
        Json(json!({ "data": { "frame": body["frame"] } }))
    }

    async fn mock_ssh_release(
        AxumState(state): AxumState<MockNodeAgent>,
        axum::extract::Path(invocation_id): axum::extract::Path<String>,
    ) -> Json<Value> {
        state.released.lock().expect("released").push(invocation_id);
        Json(json!({ "data": { "deleted": true } }))
    }

    async fn start_mock_node_agent(token: &str) -> (SocketAddr, MockNodeAgent, JoinHandle<()>) {
        let state = MockNodeAgent {
            https_token: Arc::new(Mutex::new(token.to_string())),
            ..MockNodeAgent::default()
        };
        let app = Router::new()
            .route(
                "/api/node-agent/instances/ins_test/git-credentials/https",
                post(mock_https),
            )
            .route(
                "/api/node-agent/instances/ins_test/git-credentials/ssh/prepare",
                post(mock_ssh_prepare),
            )
            .route(
                "/api/node-agent/instances/ins_test/git-credentials/ssh/agent",
                post(mock_ssh_agent),
            )
            .route(
                "/api/node-agent/instances/ins_test/git-credentials/ssh/{invocation_id}",
                delete(mock_ssh_release),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("mock server");
        });
        (address, state, task)
    }

    fn managed_client(address: SocketAddr) -> NodeAgentClient {
        NodeAgentClient::new(NodeAgentClientConfig {
            control_mode: crate::config::ControlMode::Controlled,
            node_agent_url: Some(format!("http://{address}")),
            registration_token: Some("registration-secret".to_string()),
            instance_id: Some("ins_test".to_string()),
            project_id: None,
            node_id: None,
            runtime_id: None,
            image_id: None,
            image_tag: None,
            heartbeat_interval: Duration::from_secs(10),
        })
    }

    async fn broker_request_over_socket(path: &Path, request: Value) -> Value {
        let endpoint = LocalIpcEndpoint::explicit(path).expect("endpoint");
        let mut stream = connect_local_ipc(&endpoint).await.expect("connect");
        stream
            .write_all(&serde_json::to_vec(&request).expect("request"))
            .await
            .expect("write");
        stream.shutdown().await.expect("shutdown");
        let mut output = Vec::new();
        stream.read_to_end(&mut output).await.expect("read");
        serde_json::from_slice(&output).expect("response")
    }

    fn test_tempdir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("th-git-")
            .tempdir_in(temporary_root())
            .expect("tempdir")
    }

    #[tokio::test]
    async fn standalone_broker_returns_none_without_contacting_a_store() {
        let client = NodeAgentClient::new(NodeAgentClientConfig {
            control_mode: crate::config::ControlMode::Standalone,
            node_agent_url: None,
            registration_token: None,
            instance_id: None,
            project_id: None,
            node_id: None,
            runtime_id: None,
            image_id: None,
            image_tag: None,
            heartbeat_interval: Duration::from_secs(10),
        });
        let broker = GitCredentialBroker::new(client, GitCredentialBrokerOptions::default())
            .expect("broker");
        assert_eq!(
            broker
                .request(json!({
                    "type": "https",
                    "protocol": "https",
                    "host": "git.example.com",
                    "path": "team/repo.git"
                }))
                .await,
            json!({ "status": "none" })
        );
        assert_eq!(broker.handled_request_count(), 1);
    }

    #[tokio::test]
    async fn every_https_request_is_resolved_through_node_agent() {
        let (address, mock, server) = start_mock_node_agent("token-one").await;
        let root = test_tempdir();
        let broker = GitCredentialBroker::new(
            managed_client(address),
            GitCredentialBrokerOptions {
                socket_path: Some(root.path().join("broker.sock")),
                runtime_dir: Some(root.path().to_path_buf()),
            },
        )
        .expect("broker");
        broker.start().await.expect("start broker");

        let request = json!({
            "type": "https",
            "protocol": "https",
            "host": "git.example.com",
            "path": "team/repo.git"
        });
        assert_eq!(
            broker_request_over_socket(broker.socket_path(), request.clone()).await,
            json!({ "status": "ok", "username": "git", "password": "token-one" })
        );
        *mock.https_token.lock().expect("token") = "token-two".to_string();
        assert_eq!(
            broker_request_over_socket(broker.socket_path(), request).await,
            json!({ "status": "ok", "username": "git", "password": "token-two" })
        );

        let requests = mock.https_requests.lock().expect("requests").clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0.as_deref(), Some("Bearer registration-secret"));
        assert_eq!(
            requests[0].1["remoteUrl"],
            "https://git.example.com/team/repo.git"
        );
        assert_eq!(
            requests[1].1["remoteUrl"],
            "https://git.example.com/team/repo.git"
        );
        broker.close().await.expect("close");
        server.abort();
    }

    #[tokio::test]
    async fn ssh_prepare_creates_a_private_proxy_and_release_removes_it() {
        let (address, mock, server) = start_mock_node_agent("unused").await;
        let root = test_tempdir();
        let broker = GitCredentialBroker::new(
            managed_client(address),
            GitCredentialBrokerOptions {
                socket_path: Some(root.path().join("broker.sock")),
                runtime_dir: Some(root.path().to_path_buf()),
            },
        )
        .expect("broker");
        broker.start().await.expect("start broker");
        let prepared = broker_request_over_socket(
            broker.socket_path(),
            json!({
                "type": "ssh-prepare",
                "args": ["git@git.example.com", "git-upload-pack 'team/repo.git'"]
            }),
        )
        .await;
        assert_eq!(prepared["status"], "ok");
        assert_eq!(prepared["invocationId"], "gitssh_test");
        let agent_socket = PathBuf::from(prepared["agentSocket"].as_str().expect("socket"));
        let identity = PathBuf::from(prepared["publicIdentityPath"].as_str().expect("identity"));
        let known_hosts = PathBuf::from(prepared["knownHostsPath"].as_str().expect("known hosts"));
        assert_eq!(
            std::fs::read_to_string(&identity).expect("identity"),
            "ssh-ed25519 AAAATEST"
        );
        assert_eq!(
            std::fs::read_to_string(&known_hosts).expect("known hosts"),
            "git.example.com ssh-ed25519 AAAATEST"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(agent_socket.parent().expect("directory"))
                    .expect("directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&agent_socket)
                    .expect("socket metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let agent_endpoint = LocalIpcEndpoint::explicit(&agent_socket).expect("agent endpoint");
        let mut agent = connect_local_ipc(&agent_endpoint)
            .await
            .expect("agent connect");
        let frame = [0, 0, 0, 2, 11, 0];
        agent.write_all(&frame).await.expect("frame write");
        let mut response = [0_u8; 6];
        tokio::time::timeout(Duration::from_secs(2), agent.read_exact(&mut response))
            .await
            .expect("agent response timeout")
            .expect("agent response");
        assert_eq!(response, frame);
        assert_eq!(mock.ssh_agent_requests.lock().expect("requests").len(), 1);

        assert_eq!(
            broker_request_over_socket(
                broker.socket_path(),
                json!({ "type": "ssh-release", "invocationId": "gitssh_test" })
            )
            .await,
            json!({ "status": "ok" })
        );
        assert!(!agent_socket.exists());
        assert!(!identity.exists());
        assert_eq!(
            mock.released.lock().expect("released").as_slice(),
            ["gitssh_test"]
        );
        broker.close().await.expect("close");
        server.abort();
    }

    #[tokio::test]
    async fn ssh_release_always_notifies_the_node_agent_and_reports_local_presence() {
        let (address, mock, server) = start_mock_node_agent("unused").await;
        let root = test_tempdir();
        let broker = GitCredentialBroker::new(
            managed_client(address),
            GitCredentialBrokerOptions {
                socket_path: Some(root.path().join("broker.sock")),
                runtime_dir: Some(root.path().to_path_buf()),
            },
        )
        .expect("broker");
        broker.start().await.expect("start broker");
        assert_eq!(
            broker_request_over_socket(
                broker.socket_path(),
                json!({
                    "type": "ssh-prepare",
                    "args": ["git@git.example.com", "git-upload-pack 'team/repo.git'"]
                }),
            )
            .await["status"],
            "ok"
        );

        assert!(broker.inner.release_ssh_invocation("gitssh_test").await);
        assert!(!broker.inner.release_ssh_invocation("gitssh_test").await);
        assert_eq!(
            mock.released.lock().expect("released").as_slice(),
            ["gitssh_test", "gitssh_test"]
        );
        broker.close().await.expect("close");
        server.abort();
    }

    #[tokio::test]
    async fn ssh_prepare_releases_the_node_agent_invocation_when_local_proxy_startup_fails() {
        let (address, mock, server) = start_mock_node_agent("unused").await;
        let root = test_tempdir();
        let runtime_dir = root.path().join("runtime");
        let broker = GitCredentialBroker::new(
            managed_client(address),
            GitCredentialBrokerOptions {
                socket_path: Some(root.path().join("broker.sock")),
                runtime_dir: Some(runtime_dir.clone()),
            },
        )
        .expect("broker");
        broker.start().await.expect("start broker");
        std::fs::remove_dir_all(&runtime_dir).expect("remove runtime dir");
        std::fs::write(&runtime_dir, b"not a directory").expect("replace runtime dir");
        assert_eq!(
            broker_request_over_socket(
                broker.socket_path(),
                json!({
                    "type": "ssh-prepare",
                    "args": ["git@git.example.com", "git-upload-pack 'team/repo.git'"]
                })
            )
            .await,
            json!({ "status": "rejected" })
        );
        assert_eq!(
            mock.released.lock().expect("released").as_slice(),
            ["gitssh_test"]
        );
        broker.close().await.expect("close");
        server.abort();
    }

    #[tokio::test]
    async fn close_removes_the_socket_while_a_client_is_connected() {
        let client = NodeAgentClient::new(NodeAgentClientConfig {
            control_mode: crate::config::ControlMode::Standalone,
            node_agent_url: None,
            registration_token: None,
            instance_id: None,
            project_id: None,
            node_id: None,
            runtime_id: None,
            image_id: None,
            image_tag: None,
            heartbeat_interval: Duration::from_secs(10),
        });
        let root = test_tempdir();
        let broker = GitCredentialBroker::new(
            client,
            GitCredentialBrokerOptions {
                socket_path: Some(root.path().join("broker.sock")),
                runtime_dir: Some(root.path().to_path_buf()),
            },
        )
        .expect("broker");
        broker.start().await.expect("start broker");
        let endpoint = LocalIpcEndpoint::explicit(broker.socket_path()).expect("endpoint");
        let _client = connect_local_ipc(&endpoint).await.expect("connect");
        tokio::time::timeout(Duration::from_millis(500), broker.close())
            .await
            .expect("close timeout")
            .expect("close");
        assert!(!broker.socket_path().exists());
    }

    #[test]
    fn managed_git_environment_contains_only_helper_and_proxy_locations() {
        let entries = git_broker_environment_entries(
            Path::new("/runtime/controlled instance/controlled-instance-rs"),
            Path::new("/run/task-handoff/git-proxy/broker.sock"),
            2,
        );
        let values = entries.into_iter().collect::<BTreeMap<_, _>>();
        assert_eq!(values["GIT_CONFIG_COUNT"], "6");
        assert_eq!(values["TASK_HANDOFF_GIT_ORIGINAL_CONFIG_COUNT"], "2");
        assert_eq!(values["GIT_CONFIG_KEY_2"], "credential.helper");
        assert_eq!(values["GIT_CONFIG_VALUE_2"], "");
        assert_eq!(
            values["GIT_CONFIG_VALUE_3"],
            "!'/runtime/controlled instance/controlled-instance-rs' git-credential-helper"
        );
        assert_eq!(values["GIT_CONFIG_VALUE_4"], "true");
        assert_eq!(
            values["GIT_CONFIG_VALUE_5"],
            "'/runtime/controlled instance/controlled-instance-rs' git-ssh"
        );
        assert_eq!(
            values["TASK_HANDOFF_GIT_CREDENTIAL_SOCKET"],
            "/run/task-handoff/git-proxy/broker.sock"
        );
        assert!(!format!("{values:?}").contains("PRIVATE KEY"));
    }

    #[test]
    fn ssh_agent_response_schema_accepts_the_node_frame_shape() {
        let response: GitCredentialSshAgentResponse =
            serde_json::from_value(json!({ "frame": "AAAAAg==" })).expect("frame");
        assert!(response.validate());
    }
}
