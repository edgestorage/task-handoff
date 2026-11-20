use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use controlled_instance_app_runtime::{
    detect_final_computer_capabilities_sync, find_builtin_managed_app,
    managed_native_app_manifest_path, managed_native_app_root, select_install_recipe,
    InstallRecipe, NativeAppManifest,
};
use controlled_instance_core::paths::StoragePaths;
use controlled_instance_protocol::{
    AppManagementEvent, AppManagementJobState, AppManagementOperation,
    AppManagementOperationRequest, NODE_AGENT_PROTOCOL_VERSION_HEADER,
};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path as FsPath, sync::atomic::AtomicBool};
use tokio::{
    sync::Notify,
    time::{timeout, Duration},
};

const APP_ID: &str = "codex";

#[derive(Debug, Clone)]
struct ObservedRequest {
    path: String,
    body: Value,
}

#[derive(Clone)]
struct MockNodeAgent {
    requests: Arc<Mutex<Vec<ObservedRequest>>>,
    heartbeat_received: Arc<Notify>,
    heartbeat_not_found: Arc<AtomicBool>,
}

async fn register(
    State(state): State<MockNodeAgent>,
    Path(instance_id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state
        .requests
        .lock()
        .expect("requests")
        .push(ObservedRequest {
            path: format!("/api/node-agent/instances/{instance_id}/register"),
            body,
        });
    (
        StatusCode::CREATED,
        [(
            NODE_AGENT_PROTOCOL_VERSION_HEADER,
            HeaderValue::from_static("2026-10-02"),
        )],
        Json(json!({ "data": { "id": instance_id } })),
    )
}

async fn heartbeat(
    State(state): State<MockNodeAgent>,
    Path(instance_id): Path<String>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state
        .requests
        .lock()
        .expect("requests")
        .push(ObservedRequest {
            path: format!("/api/node-agent/instances/{instance_id}/heartbeat"),
            body,
        });
    state.heartbeat_received.notify_one();
    if state.heartbeat_not_found.swap(false, Ordering::SeqCst) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "code": "INSTANCE_NOT_FOUND", "message": "missing" } })),
        )
            .into_response();
    }
    Json(json!({ "data": { "id": instance_id } })).into_response()
}

async fn start_mock_node_agent() -> (std::net::SocketAddr, MockNodeAgent, tokio::task::JoinHandle<()>)
{
    let state = MockNodeAgent {
        requests: Arc::new(Mutex::new(Vec::new())),
        heartbeat_received: Arc::new(Notify::new()),
        heartbeat_not_found: Arc::new(AtomicBool::new(false)),
    };
    let app = Router::new()
        .route("/api/node-agent/instances/{id}/register", post(register))
        .route("/api/node-agent/instances/{id}/heartbeat", post(heartbeat))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock node agent");
    let address = listener.local_addr().expect("mock node agent address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock node agent");
    });
    (address, state, server)
}

fn test_storage_paths(root: &FsPath) -> StoragePaths {
    let data_dir = root.join("data");
    StoragePaths {
        config_path: data_dir.join("config.json"),
        data_dir: data_dir.clone(),
        app_catalog_dir: data_dir.join("app-catalog"),
        app_sessions_dir: data_dir.join("app-sessions"),
        triggers_dir: data_dir.join("triggers"),
        runtime_dir: data_dir.join("runtime"),
        events_dir: data_dir.join("events"),
        artifact_dir: data_dir.join("artifacts"),
        log_dir: data_dir.join("logs"),
        web_token_path: data_dir.join("web-token"),
    }
}

fn seed_managed_codex(managed_app_root: &FsPath) {
    let definition = find_builtin_managed_app(APP_ID).expect("built-in codex definition");
    let recipe = select_install_recipe(&definition, &detect_final_computer_capabilities_sync())
        .recipe
        .expect("codex install recipe");
    let InstallRecipe::NativePackage {
        package,
        package_version,
        version,
        integrity,
        launch_path,
        ..
    } = recipe
    else {
        panic!("codex must use a managed native package recipe");
    };
    let app_root = managed_native_app_root(managed_app_root, APP_ID);
    let launcher = app_root.join(&launch_path);
    std::fs::create_dir_all(launcher.parent().expect("launcher parent"))
        .expect("codex launcher parent");
    std::fs::write(&launcher, "#!/bin/sh\nexit 0\n").expect("codex launcher");
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
        .expect("codex launcher permissions");
    let manifest = NativeAppManifest {
        schema_version: 1,
        app_id: APP_ID.to_string(),
        version,
        package,
        package_version,
        integrity,
        install_root: app_root,
        launch_path: launch_path.clone(),
        files: vec![launch_path],
    };
    std::fs::write(
        managed_native_app_manifest_path(managed_app_root, APP_ID),
        serde_json::to_vec_pretty(&manifest).expect("codex manifest"),
    )
    .expect("write codex manifest");
}

fn availability(heartbeat: &Value, app_id: &str) -> Option<String> {
    heartbeat["appInventory"]["items"]
        .as_array()?
        .iter()
        .find(|item| item["id"].as_str() == Some(app_id))
        .and_then(|item| item["availability"].as_str())
        .map(ToString::to_string)
}

#[tokio::test]
async fn terminal_app_management_event_wakes_real_heartbeat_with_updated_inventory() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let managed_app_root = temporary.path().join("managed-apps");
    seed_managed_codex(&managed_app_root);
    let (address, mock, server) = start_mock_node_agent().await;
    let paths = test_storage_paths(temporary.path());
    std::fs::create_dir_all(&paths.data_dir).expect("data directory");
    let mut config = InstanceConfig::for_test(temporary.path().join("ui"), paths);
    config.workspace_path = temporary.path().join("workspace");
    config.node_agent_url = Some(format!("http://{address}"));
    config.heartbeat_interval = Duration::from_secs(60);
    std::fs::create_dir_all(&config.workspace_path).expect("workspace");
    let node_agent_client = NodeAgentClient::from_instance_config(&config);
    let state = AppState::try_new_with_node_agent_client_and_managed_app_root(
        config,
        WebAuthState::disabled(None),
        node_agent_client,
        managed_app_root,
    )
    .expect("app state");
    let mut events = state.events.subscribe();

    state.start_node_agent();
    timeout(Duration::from_secs(2), mock.heartbeat_received.notified())
        .await
        .expect("initial registration and heartbeat");
    let initial = mock
        .requests
        .lock()
        .expect("requests")
        .iter()
        .rev()
        .find(|request| request.path.ends_with("/heartbeat"))
        .expect("initial heartbeat")
        .body
        .clone();
    assert_eq!(availability(&initial, APP_ID).as_deref(), Some("available"));

    let queued = state
        .app_management
        .request(
            APP_ID,
            AppManagementOperation::Uninstall,
            AppManagementOperationRequest { request_id: None },
        )
        .await
        .expect("uninstall request");
    let terminal = timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.expect("event bus");
            if event.r#type != "app.management" {
                continue;
            }
            let app_event: AppManagementEvent =
                serde_json::from_value(event.payload).expect("app management event");
            if let Some(job) = app_event.job {
                if job.id == queued.id && !job.state.is_active() {
                    break job;
                }
            }
        }
    })
    .await
    .expect("terminal app management event");
    assert_eq!(terminal.state, AppManagementJobState::Succeeded);

    timeout(Duration::from_secs(2), mock.heartbeat_received.notified())
        .await
        .expect("terminal app inventory heartbeat must not wait for the periodic interval");
    let updated = mock
        .requests
        .lock()
        .expect("requests")
        .iter()
        .rev()
        .find(|request| request.path.ends_with("/heartbeat"))
        .expect("updated heartbeat")
        .body
        .clone();
    assert_eq!(
        availability(&updated, APP_ID).as_deref(),
        Some("missing-dependency")
    );

    state.stop_node_agent().await;
    server.abort();
}
