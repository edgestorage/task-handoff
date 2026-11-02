use axum::{
    body::{to_bytes, Body},
    extract::{
        rejection::JsonRejection,
        rejection::QueryRejection,
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, FromRequestParts, OriginalUri, Path, Query, Request, State,
    },
    http::{header, HeaderMap, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, delete, get, patch, post, put},
    Json, Router,
};
use controlled_instance_app_runtime::AppManagementRequestError;
use controlled_instance_protocol::{
    ai_session_transient_subscription_accepts, encode_event, project_ai_session_delta_for_consumer,
    project_ai_session_history_item_for_consumer,
    project_ai_session_stream_event_payload_for_consumer,
    project_ai_sessions_snapshot_for_consumer, AgentRunError, AgentRunMemberInstanceCloseResult,
    AgentRunMemberInstanceCreateResult, AgentRunMemberInstanceStatus, AgentRunResult,
    AiSessionTransientSubscription, AiSessionWorkspaceSelection, ApiEnvelope, ApiError,
    ApiErrorEnvelope, AppDisplayOptions, AppLaunchRequest, AppManagementOperation,
    AppManagementOperationRequest, ConfigSyncDirection, ConfigSyncPreset, ConfigSyncRequest,
    ManagedModelEnvironment, RepositoryAiSessionLaunchResult, RepositoryAiSessionWorkspace,
    RepositoryAiSessionWorkspaceBranch, RepositoryAiSessionWorkspaceBranchKind,
    RepositoryAiSessionWorkspaceCheckout, RepositoryAiSessionWorkspaceCheckoutRequest,
    RepositoryAiSessionWorkspaceInspectRequest, RepositoryAvailability, RepositoryChangeScope,
    RepositoryCheckoutBranchRequest, RepositoryCommitRequest, RepositoryCreateBranchRequest,
    RepositoryCreateFileRequest, RepositoryCreateTrackingBranchRequest,
    RepositoryCreateWorktreeAiSessionRequest, RepositoryCreateWorktreeRequest,
    RepositoryDeleteBranchRequest, RepositoryDeleteFileRequest, RepositoryFetchRequest,
    RepositoryMoveWorktreePreflightRequest, RepositoryMoveWorktreeRequest,
    RepositoryPublishRequest, RepositoryPullRequest, RepositoryPushRequest,
    RepositoryRemoveWorktreeRequest, RepositoryRenameFileRequest, RepositoryRuntimePathInput,
    RepositorySessionKind, RepositoryStartAiSessionRequest, RepositoryWriteFileRequest,
    StoryAutomationInstanceCreateResult, TriggerCreateInput, TriggerPatchInput, TriggerRunInput,
    COMPACT_EVENT_ENVELOPE_VERSION, SESSION_STREAM_PROTOCOL_VERSION, TTY_STREAM_PROTOCOL_VERSION,
};
use controlled_instance_workspace::{
    branch_mutation_result, checkout_branch, checkout_branch_for_ai_session, commit_repository,
    create_branch, create_tracking_branch, delete_branch, discard_all_tracked_paths,
    discard_worktree_paths, fetch_remote, list_branches, mutation_result, publish_branch,
    pull_branch, push_branch, repository_diff, require_repository, require_workspace, stage_paths,
    triggers::{trigger_snapshot, TriggerStoreError},
    unstage_paths, ConfigSyncBrowserProfile, ConfigSyncError, ConfigSyncService,
    RepositoryOperationError, RepositorySessionInventory, RepositorySessionTarget,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use tracing::{info, warn};

use crate::{
    ai_session_validation::{
        normalize_ai_session_command_body, normalize_ai_session_create_body,
        normalize_ai_session_fork_body, normalize_ai_session_message_body,
        normalize_ai_session_model_selection_body, normalize_ai_session_queue_edit_body,
        normalize_ai_session_queue_reorder_body, normalize_ai_session_reasoning_effort_body,
        normalize_ai_session_rename_body, normalize_ai_session_resume_body,
        normalize_ai_session_timeline_sync_body, normalize_empty_object_body,
    },
    auth::resolve_web_auth,
    config::{ControlMode, InstanceConfig, ServerOptions},
    git_credentials::{
        install_git_broker_environment, GitCredentialBroker, GitCredentialBrokerOptions,
    },
    state::AppState,
    story_agent_tool_bridge::{
        invoke_for_provider_session, optional_call_id, required_thread_id, tool_definitions,
        AgentToolInvocationInput, StoryToolInvocation,
    },
};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/status", get(status))
        .route("/api/instance/status", get(instance_status))
        .route("/api/instance/capabilities", get(capabilities))
        .route("/api/workspace/status", get(workspace_status))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/apps/catalog", get(app_catalog))
        .route("/api/apps/management", get(app_management))
        .route("/api/apps/{app_id}/install", post(app_management_install))
        .route(
            "/api/apps/{app_id}/uninstall",
            post(app_management_uninstall),
        )
        .route("/api/apps/{app_id}/update", post(app_management_update))
        .route(
            "/api/apps/{app_id}/update-check",
            post(app_management_update_check),
        )
        .route("/api/apps/jobs/{job_id}", get(app_management_job))
        .route(
            "/api/internal/model-environment",
            put(update_managed_model_environment),
        )
        .route(
            "/api/internal/model-catalog",
            get(managed_model_catalog).put(update_managed_model_catalog),
        )
        .route("/api/internal/codex-settings", put(update_codex_settings))
        .route(
            "/api/internal/ai-session-persistence-settings",
            put(update_ai_session_persistence_settings),
        )
        .route(
            "/api/internal/agent-tools/invoke",
            post(invoke_agent_tool).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/api/internal/agent-tools/mcp",
            get(agent_tool_mcp_get)
                .post(agent_tool_mcp_post)
                .delete(agent_tool_mcp_delete)
                .layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route("/api/config-sync/presets", get(config_sync_presets))
        .route("/api/config-sync/programs", get(config_sync_programs))
        .route("/api/config-sync/folders", get(config_sync_folders))
        .route("/api/config-sync", post(config_sync_batch))
        .route(
            "/api/config-sync/{direction}/{preset}",
            post(config_sync_legacy),
        )
        .route(
            "/api/apps/catalog/custom",
            get(app_custom_catalog).patch(save_app_custom_catalog),
        )
        .route(
            "/api/apps/{app_id}/profiles",
            get(app_profiles).post(app_profile_create),
        )
        .route(
            "/api/apps/{app_id}/profiles/{profile_id}",
            patch(app_profile_rename).delete(app_profile_delete),
        )
        .route(
            "/api/apps/{app_id}/profiles/{profile_id}/default",
            post(app_profile_set_default),
        )
        .route(
            "/api/apps/sessions",
            get(app_sessions).post(app_session_start),
        )
        .route("/api/apps/sessions/state", get(app_sessions_state))
        .route(
            "/api/apps/sessions/{id}",
            get(app_session_detail)
                .patch(app_session_rename)
                .delete(app_session_delete),
        )
        .route("/api/apps/sessions/{id}/stop", post(app_session_stop))
        .route("/api/apps/sessions/{id}/restart", post(app_session_restart))
        .route("/api/apps/sessions/{id}/display", post(app_session_display))
        .route(
            "/api/apps/sessions/{id}/screenshot",
            get(app_session_screenshot),
        )
        .route(
            "/api/apps/sessions/{id}/snapshot",
            get(app_session_snapshot),
        )
        .route(
            "/api/apps/sessions/{id}/automation",
            get(app_session_automation),
        )
        .route("/api/apps/sessions/{id}/logs", get(app_session_logs))
        .route("/api/apps/sessions/{id}/tty", get(app_session_tty))
        .route("/api/apps/sessions/{id}/vnc", get(app_session_vnc))
        .route(
            "/api/apps/sessions/{id}/novnc/vnc.html",
            get(app_session_novnc),
        )
        .route(
            "/api/apps/sessions/{id}/web/",
            get(app_session_web_root)
                .post(app_session_web_root)
                .put(app_session_web_root)
                .patch(app_session_web_root)
                .delete(app_session_web_root)
                .options(app_session_web_root),
        )
        .route(
            "/api/apps/sessions/{id}/web/{*rest}",
            get(app_session_web_proxy)
                .post(app_session_web_proxy)
                .put(app_session_web_proxy)
                .patch(app_session_web_proxy)
                .delete(app_session_web_proxy)
                .options(app_session_web_proxy)
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/api/ai-sessions", get(ai_sessions))
        .route(
            "/api/ai-sessions",
            post(create_ai_session).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/api/ai-sessions/state", get(ai_sessions_state))
        .route("/api/ai-sessions/history", get(ai_session_history))
        .route(
            "/api/ai-sessions/history/{id}",
            get(ai_session_history_detail),
        )
        .route("/api/ai-sessions/{id}/turns", get(ai_session_turns))
        .route(
            "/api/ai-sessions/{id}/messages",
            post(send_ai_session_message).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            "/api/ai-sessions/{id}/interrupt",
            post(interrupt_ai_session),
        )
        .route(
            "/api/ai-sessions/{id}/approval",
            post(resolve_ai_session_approval),
        )
        .route("/api/ai-sessions/{id}/resume", post(resume_ai_session))
        .route("/api/ai-sessions/{id}/fork", post(fork_ai_session))
        .route("/api/ai-sessions/{id}/open-app", post(open_ai_session_app))
        .route("/api/ai-sessions/{id}/close", post(close_ai_session))
        .route(
            "/api/ai-sessions/{id}/model-selection",
            put(update_ai_session_model_selection),
        )
        .route(
            "/api/ai-sessions/{id}/reasoning-effort",
            put(update_ai_session_reasoning_effort),
        )
        .route("/api/ai-sessions/{id}/mentions", get(ai_session_mentions))
        .route(
            "/api/ai-sessions/{id}/mentions/files",
            post(search_ai_session_mention_files),
        )
        .route(
            "/api/ai-sessions/{id}/commands",
            post(execute_ai_session_command),
        )
        .route(
            "/api/ai-sessions/{id}/story-content",
            get(ai_session_story_content),
        )
        .route(
            "/api/ai-sessions/{id}/story-content/get",
            post(get_ai_session_story_content),
        )
        .route(
            "/api/ai-sessions/{id}/story-content/set",
            post(set_ai_session_story_content),
        )
        .route("/api/ai-sessions/{id}/story", put(update_ai_session_story))
        .route(
            "/api/ai-session-attachments/drafts",
            post(upload_ai_session_attachment_draft),
        )
        .route(
            "/api/ai-session-attachments/drafts/{attachment_id}",
            delete(cancel_ai_session_attachment_draft),
        )
        .route(
            "/api/ai-session-attachments/draft-streams",
            post(begin_ai_session_attachment_draft_stream),
        )
        .route(
            "/api/ai-session-attachments/draft-streams/{attachment_id}",
            put(append_ai_session_attachment_draft_stream)
                .delete(cancel_ai_session_attachment_draft_stream),
        )
        .route(
            "/api/ai-session-attachments/draft-streams/{attachment_id}/complete",
            post(complete_ai_session_attachment_draft_stream),
        )
        .route(
            "/api/ai-sessions/{id}/messages/{message_id}/attachments/{attachment_id}/content",
            get(ai_session_message_attachment_content),
        )
        .route("/api/ai-sessions/{id}/timeline", get(ai_session_timeline))
        .route(
            "/api/ai-sessions/{id}/timeline/sync",
            post(sync_ai_session_timeline),
        )
        .route(
            "/api/ai-sessions/{id}/turns/{turn_id}/timeline",
            get(ai_session_turn_timeline),
        )
        .route(
            "/api/ai-sessions/{id}/turns/{turn_id}/timeline/sync",
            post(sync_ai_session_turn_timeline),
        )
        .route(
            "/api/ai-sessions/{id}/turns/{turn_id}",
            get(ai_session_turn),
        )
        .route(
            "/api/ai-sessions/{id}/transcript",
            get(ai_session_transcript),
        )
        .route("/api/ai-sessions/{id}/queue", get(ai_session_queue))
        .route(
            "/api/ai-sessions/{id}/queue/reorder",
            patch(reorder_ai_session_queue),
        )
        .route(
            "/api/ai-sessions/{id}/queue/pause",
            post(pause_ai_session_queue),
        )
        .route(
            "/api/ai-sessions/{id}/queue/{queue_id}/retry",
            post(retry_ai_session_queue_item),
        )
        .route(
            "/api/ai-sessions/{id}/queue/{queue_id}/steer",
            post(steer_ai_session_queue_item),
        )
        .route(
            "/api/ai-sessions/{id}/queue/{queue_id}",
            delete(remove_ai_session_queue_item).patch(edit_ai_session_queue_item),
        )
        .route("/api/ai-sessions/{id}/read", post(read_ai_session))
        .route("/api/ai-sessions/{id}/title", put(rename_ai_session))
        .route(
            "/api/ai-sessions/{id}",
            get(ai_session_detail).delete(delete_ai_session),
        )
        .route("/api/events", get(events))
        .route("/api/browser-tunnel", get(browser_tunnel_websocket))
        .route(
            "/api/internal/instance-shell",
            get(instance_shell_websocket),
        )
        .route(
            "/api/internal/node-agent/process-identity",
            get(process_identity),
        )
        .route(
            "/api/internal/node-agent/ai-sessions/idle-retention",
            get(ai_session_idle_retention),
        )
        .route(
            "/api/internal/node-agent/ai-sessions/instance-idle-retention",
            get(ai_session_instance_idle_retention),
        )
        .route(
            "/api/internal/node-agent/ai-sessions/{id}/close",
            post(close_ai_session_if_idle),
        )
        .route(
            "/api/internal/node-agent/ai-sessions/{id}/close-for-story-deletion",
            post(close_ai_session_for_story_deletion),
        )
        .route(
            "/api/internal/node-agent/ai-sessions/{id}/messages",
            post(send_private_ai_session_message).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            "/api/internal/node-agent/story-automation/ai-sessions",
            post(create_story_automation_ai_session),
        )
        .route(
            "/api/internal/node-agent/agent-runs/members",
            post(create_agent_run_member),
        )
        .route(
            "/api/internal/node-agent/agent-runs/probe-state",
            get(agent_run_probe_state),
        )
        .route(
            "/api/internal/node-agent/agent-runs/{run_id}/members/{member_id}",
            get(agent_run_member_status),
        )
        .route(
            "/api/internal/node-agent/agent-runs/{run_id}/members/{member_id}/close",
            post(close_agent_run_member),
        )
        .route(
            "/api/internal/node-agent/story-ai-sessions/{id}",
            get(story_ai_session_read),
        )
        .route(
            "/api/internal/node-agent/story-ai-sessions/{id}/turns/{turn_id}",
            get(story_ai_session_turn_read),
        )
        .route(
            "/api/internal/node-agent/story-agent-tools/invalidate",
            post(invalidate_story_agent_tools),
        )
        .route("/api/internal/node-agent/drain", post(drain))
        .route("/api/internal/node-agent/resume", post(resume))
        .route("/api/internal/node-agent/shutdown", post(shutdown))
        .route(
            "/api/internal/node-agent-connection",
            put(update_node_agent_connection),
        )
        .route(
            "/api/repository/workspace/worktrees/list",
            post(repository_workspace_worktrees_list),
        )
        .route(
            "/api/repository/workspace/worktrees",
            post(repository_workspace_worktree_create),
        )
        .route(
            "/api/repository/workspace/worktrees/remove",
            post(repository_workspace_worktree_remove),
        )
        .route(
            "/api/repository/workspace/worktrees/move-to-main/preflight",
            post(repository_workspace_worktree_move_preflight),
        )
        .route(
            "/api/repository/workspace/worktrees/move-to-main",
            post(repository_workspace_worktree_move),
        )
        .route(
            "/api/repository/workspace/branches/list",
            post(repository_workspace_branches_list),
        )
        .route(
            "/api/repository/ai-session-workspace/inspect",
            post(repository_ai_session_workspace_inspect),
        )
        .route(
            "/api/repository/ai-session-workspace/create",
            post(repository_ai_session_workspace_create)
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            "/api/repository/ai-session-workspace/checkout",
            post(repository_ai_session_workspace_checkout),
        )
        .route(
            "/api/ai-sessions/{id}/repository/ai-sessions",
            post(repository_start_ai_session),
        )
        .route(
            "/api/ai-sessions/{id}/repository/worktrees/ai-sessions",
            post(repository_create_worktree_ai_session),
        )
        .route("/api/triggers", get(trigger_list).post(trigger_create))
        .route("/api/triggers/runs", get(trigger_runs))
        .route(
            "/api/triggers/{config_hash}",
            get(trigger_get).patch(trigger_patch).delete(trigger_delete),
        )
        .route(
            "/api/triggers/{config_hash}/deployments/{deployment_id}",
            delete(trigger_deployment_delete),
        )
        .route("/api/triggers/{config_hash}/enable", post(trigger_enable))
        .route("/api/triggers/{config_hash}/disable", post(trigger_disable))
        .route("/api/triggers/{config_hash}/run", post(trigger_run))
        .route("/api/novnc/{*rest}", get(novnc_static))
        .merge(repository_routes("/api/ai-sessions/{id}/repository"))
        .merge(repository_routes("/api/apps/sessions/{id}/repository"))
        .route("/api/{*rest}", any(api_not_found))
        .fallback(static_ui_fallback)
        .method_not_allowed_fallback(static_ui_fallback)
        .layer(middleware::map_response(normalize_json_content_type))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

async fn normalize_json_content_type(mut response: Response) -> Response {
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        == Some("application/json")
    {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    response
}

async fn static_ui_fallback(State(state): State<AppState>, request: Request) -> Response {
    if request.uri().path().starts_with("/api/") {
        return api_error(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found.");
    }
    let method = request.method().clone();
    if !matches!(method, Method::GET | Method::HEAD) {
        return spa_index_response(&state.config.static_dir, Method::GET).await;
    }
    let static_dir = ServeDir::new(state.config.static_dir.clone());
    match static_dir.oneshot(request).await {
        Ok(response) if response.status() != StatusCode::NOT_FOUND => response.into_response(),
        Ok(_) => spa_index_response(&state.config.static_dir, method).await,
        Err(error) => {
            warn!(%error, "failed to serve frozen UI assets");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn spa_index_response(static_dir: &std::path::Path, method: Method) -> Response {
    let index_path = static_dir.join("index.html");
    match tokio::fs::metadata(&index_path).await {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut response = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "TaskHandoff Web UI has not been built yet. Run pnpm web:build.",
            )
                .into_response();
            if method == Method::HEAD {
                *response.body_mut() = Body::empty();
            }
            return response;
        }
        Err(error) => {
            warn!(%error, "failed to inspect the frozen UI index");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    let request = Request::builder()
        .method(method)
        .uri("/")
        .body(Body::empty())
        .expect("static UI index request");
    match ServeFile::new(index_path).oneshot(request).await {
        Ok(mut response) => {
            // Node's not-found handler serves the SPA shell with HTTP 200 so
            // Vue history routes survive a full-page refresh.
            *response.status_mut() = StatusCode::OK;
            response.into_response()
        }
        Err(error) => {
            warn!(%error, "failed to serve the frozen UI index");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn repository_routes(prefix: &str) -> Router<AppState> {
    Router::new()
        .route(&format!("{prefix}/context"), get(repository_context))
        .route(
            &format!("{prefix}/directories"),
            get(repository_directories),
        )
        .route(
            &format!("{prefix}/files/search"),
            get(repository_file_search),
        )
        .route(
            &format!("{prefix}/files"),
            get(repository_file_read)
                .post(repository_file_create)
                .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
                .put(repository_file_write)
                .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
                .delete(repository_file_delete),
        )
        .route(
            &format!("{prefix}/files/rename"),
            post(repository_file_rename).layer(DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
        .route(&format!("{prefix}/changes"), get(repository_changes))
        .route(
            &format!("{prefix}/worktrees"),
            get(repository_worktrees).post(repository_worktree_create),
        )
        .route(
            &format!("{prefix}/worktrees/remove"),
            post(repository_worktree_remove),
        )
        .route(&format!("{prefix}/diff"), get(repository_diff_route))
        .route(&format!("{prefix}/index/stage"), post(repository_stage))
        .route(&format!("{prefix}/index/unstage"), post(repository_unstage))
        .route(
            &format!("{prefix}/discard/worktree"),
            post(repository_discard_worktree),
        )
        .route(
            &format!("{prefix}/discard/all-tracked"),
            post(repository_discard_all_tracked),
        )
        .route(&format!("{prefix}/commits"), post(repository_commit))
        .route(&format!("{prefix}/branches"), get(repository_branches))
        .route(&format!("{prefix}/remotes"), get(repository_remotes))
        .route(
            &format!("{prefix}/branches/create"),
            post(repository_branch_create),
        )
        .route(
            &format!("{prefix}/branches/checkout"),
            post(repository_branch_checkout),
        )
        .route(
            &format!("{prefix}/branches/tracking"),
            post(repository_branch_tracking),
        )
        .route(
            &format!("{prefix}/branches/delete"),
            post(repository_branch_delete),
        )
        .route(&format!("{prefix}/delivery/fetch"), post(repository_fetch))
        .route(&format!("{prefix}/delivery/pull"), post(repository_pull))
        .route(
            &format!("{prefix}/delivery/publish"),
            post(repository_publish),
        )
        .route(&format!("{prefix}/delivery/push"), post(repository_push))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryDirectoryQuery {
    #[serde(default)]
    path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryFileQuery {
    path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryFileSearchQuery {
    query: String,
    #[serde(default = "default_repository_search_limit")]
    limit: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryDiffQuery {
    path: String,
    scope: RepositoryChangeScope,
    #[serde(default = "default_repository_diff_bytes")]
    byte_limit: u64,
    #[serde(default)]
    include_context: bool,
    #[serde(default = "default_repository_context_lines")]
    context_lines: usize,
}

fn default_repository_search_limit() -> usize {
    100
}

fn default_repository_diff_bytes() -> u64 {
    controlled_instance_workspace::default_diff_bytes()
}

fn default_repository_context_lines() -> usize {
    20
}

fn repository_target(state: &AppState, uri: &Uri, id: &str) -> RepositorySessionTarget {
    if uri.path().starts_with("/api/apps/sessions/") {
        let app = state.app_runtime.get_session(id);
        return RepositorySessionTarget {
            kind: RepositorySessionKind::AppSession,
            id: id.to_string(),
            cwd: state.app_runtime.get_session_cwd(id),
            status: app.map(|session| session.status),
        };
    }
    let session = state.ai_sessions.get(id);
    RepositorySessionTarget {
        kind: RepositorySessionKind::AiSession,
        id: id.to_string(),
        cwd: session.as_ref().and_then(|session| session.cwd.clone()),
        status: session.map(|session| session.status),
    }
}

async fn resolve_repository_target(
    state: &AppState,
    uri: &Uri,
    id: &str,
) -> controlled_instance_workspace::ResolvedRepository {
    state
        .repository_service
        .resolve(repository_target(state, uri, id))
        .await
}

fn repository_session_inventory(state: &AppState) -> RepositorySessionInventory {
    let app_sessions = state.app_runtime.list_session_workspaces();
    let running_app_session_ids = app_sessions
        .iter()
        .filter(|session| session.status == "running")
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    let ai_sessions = state
        .ai_sessions
        .bound_snapshot_with_limit(&running_app_session_ids, 10_000)
        .sessions
        .into_iter()
        .map(
            |session| controlled_instance_workspace::RepositoryAiSessionPresence {
                id: session.id,
                app_session_id: session.app_session_id,
                cwd: session.cwd,
                status: Some(session.status),
            },
        )
        .collect();
    RepositorySessionInventory {
        ai_sessions,
        app_sessions: app_sessions
            .into_iter()
            .map(
                |session| controlled_instance_workspace::RepositoryAppSessionPresence {
                    id: session.id,
                    cwd: session.cwd,
                    status: Some(session.status),
                },
            )
            .collect(),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryWorkspaceCwdRequest {
    cwd: RepositoryRuntimePathInput,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryWorkspaceWorktreeCreateRequest {
    cwd: RepositoryRuntimePathInput,
    worktree: RepositoryCreateWorktreeRequest,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryWorkspaceWorktreeRemoveRequest {
    cwd: RepositoryRuntimePathInput,
    removal: RepositoryRemoveWorktreeRequest,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryWorkspaceWorktreeMovePreflightRequest {
    cwd: RepositoryRuntimePathInput,
    preflight: RepositoryMoveWorktreePreflightRequest,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryWorkspaceWorktreeMoveRequest {
    cwd: RepositoryRuntimePathInput,
    #[serde(rename = "move")]
    move_request: RepositoryMoveWorktreeRequest,
}

fn authorized_workspace_cwd(
    state: &AppState,
    cwd: &RepositoryRuntimePathInput,
) -> Result<PathBuf, RepositoryOperationError> {
    if cwd.runtime_path_type != "runtime-path" {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_REQUEST_INVALID",
            "Workspace cwd must be a runtime-path.",
        ));
    }
    let canonical = std::fs::canonicalize(&cwd.path).map_err(|_| {
        RepositoryOperationError::new(
            "REPOSITORY_CWD_INACCESSIBLE",
            "The selected workspace folder is inaccessible.",
        )
    })?;
    if !canonical.is_dir() {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_CWD_INACCESSIBLE",
            "The selected workspace folder is inaccessible.",
        ));
    }
    if state.config.control_mode == ControlMode::Controlled {
        return Ok(canonical);
    }
    let authorized = state
        .repository_service
        .workspace_roots()
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| canonical.starts_with(root));
    if authorized {
        Ok(canonical)
    } else {
        Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_FORBIDDEN",
            "The selected workspace folder is outside the instance workspace boundary.",
        ))
    }
}

fn workspace_repository_target(cwd: &std::path::Path) -> RepositorySessionTarget {
    RepositorySessionTarget {
        kind: RepositorySessionKind::AiSession,
        id: "workspace-inspection".to_string(),
        cwd: Some(cwd.display().to_string()),
        status: Some("idle".to_string()),
    }
}

async fn inspect_ai_session_workspace(
    state: &AppState,
    cwd: &std::path::Path,
) -> Result<RepositoryAiSessionWorkspace, RepositoryOperationError> {
    let target = workspace_repository_target(cwd);
    let resolved = state.repository_service.resolve(&target).await;
    if resolved.context.availability != RepositoryAvailability::Available {
        return Ok(RepositoryAiSessionWorkspace {
            availability: resolved.context.availability,
            current_branch: None,
            dirty: false,
            branches: Vec::new(),
            repository_context_id: None,
            snapshot_id: None,
            worktrees: Vec::new(),
        });
    }
    let sessions = repository_session_inventory(state);
    let worktrees = state
        .repository_service
        .list_worktrees_from_state(&resolved, &sessions)
        .await?;
    let branches = list_branches(&resolved).await?;
    let dirty = worktrees
        .items
        .iter()
        .find(|item| item.summary.is_current)
        .is_some_and(|item| item.summary.dirty);
    let mut choices = Vec::new();
    if resolved
        .context
        .head
        .as_ref()
        .and_then(|head| head.oid.as_ref())
        .is_some()
    {
        choices.push(RepositoryAiSessionWorkspaceBranch {
            name: "HEAD".to_string(),
            kind: RepositoryAiSessionWorkspaceBranchKind::Head,
            current: false,
            current_folder_selectable: false,
            worktree_selectable: true,
            worktree_checkout: RepositoryAiSessionWorkspaceCheckout::Detached,
            current_folder_reason: None,
            worktree_reason: None,
        });
    }
    choices.extend(
        branches
            .branches
            .into_iter()
            .filter(|branch| branch.kind == controlled_instance_protocol::RepositoryBranchKind::Local)
            .map(|branch| {
                let checked_out_elsewhere =
                    !branch.current && !branch.checked_out_worktree_ids.is_empty();
                let current_folder_reason = checked_out_elsewhere.then_some(
                    controlled_instance_protocol::RepositoryAiSessionCurrentFolderReason::BranchOccupied,
                );
                RepositoryAiSessionWorkspaceBranch {
                    name: branch.name,
                    kind: RepositoryAiSessionWorkspaceBranchKind::Branch,
                    current: branch.current,
                    current_folder_selectable: branch.current
                        || current_folder_reason.is_none(),
                    worktree_selectable: true,
                    worktree_checkout: if branch.checked_out_worktree_ids.is_empty() {
                        RepositoryAiSessionWorkspaceCheckout::Attached
                    } else {
                        RepositoryAiSessionWorkspaceCheckout::Detached
                    },
                    current_folder_reason,
                    worktree_reason: None,
                }
            }),
    );
    Ok(RepositoryAiSessionWorkspace {
        availability: RepositoryAvailability::Available,
        current_branch: resolved.context.head.as_ref().and_then(|head| {
            (head.state == controlled_instance_protocol::RepositoryHeadState::Branch)
                .then(|| head.branch.clone())
                .flatten()
        }),
        dirty,
        branches: choices,
        repository_context_id: worktrees.repository_context_id.clone().into(),
        snapshot_id: resolved.context.snapshot_id.clone(),
        worktrees: worktrees.items,
    })
}

async fn repository_worktrees(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
) -> Response {
    let target = repository_target(&state, &uri, &id);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .list_worktrees(&target, &sessions)
        .await
    {
        Ok(worktrees) => repository_data(worktrees),
        Err(error) => repository_error(error),
    }
}

async fn repository_worktree_create(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCreateWorktreeRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let target = repository_target(&state, &uri, &id);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .create_worktree(&target, &sessions, request)
        .await
    {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_worktree_remove(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryRemoveWorktreeRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let target = repository_target(&state, &uri, &id);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .remove_worktree(&target, &sessions, request)
        .await
    {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_workspace_worktrees_list(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryWorkspaceCwdRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let target = workspace_repository_target(&cwd);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .list_worktrees(&target, &sessions)
        .await
    {
        Ok(worktrees) => repository_data(worktrees),
        Err(error) => repository_error(error),
    }
}

async fn repository_workspace_worktree_create(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryWorkspaceWorktreeCreateRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let target = workspace_repository_target(&cwd);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .create_worktree(&target, &sessions, body.worktree)
        .await
    {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_workspace_worktree_remove(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryWorkspaceWorktreeRemoveRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let target = workspace_repository_target(&cwd);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .remove_worktree(&target, &sessions, body.removal)
        .await
    {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_workspace_worktree_move_preflight(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryWorkspaceWorktreeMovePreflightRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let target = workspace_repository_target(&cwd);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .move_worktree_to_main_preflight(&target, &sessions, body.preflight)
        .await
    {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_workspace_worktree_move(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryWorkspaceWorktreeMoveRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let target = workspace_repository_target(&cwd);
    let sessions = repository_session_inventory(&state);
    match state
        .repository_service
        .move_worktree_to_main(&target, &sessions, body.move_request)
        .await
    {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_workspace_branches_list(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryWorkspaceCwdRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let target = workspace_repository_target(&cwd);
    let resolved = state.repository_service.resolve(&target).await;
    match list_branches(&resolved).await {
        Ok(branches) => repository_data(branches),
        Err(error) => repository_error(error),
    }
}

async fn repository_ai_session_workspace_inspect(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryAiSessionWorkspaceInspectRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    match inspect_ai_session_workspace(&state, &cwd).await {
        Ok(workspace) => repository_data(workspace),
        Err(error) => repository_error(error),
    }
}

async fn repository_ai_session_workspace_checkout(
    State(state): State<AppState>,
    payload: Result<Json<RepositoryAiSessionWorkspaceCheckoutRequest>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Json(body)) => body,
        Err(error) => return repository_body_error(error),
    };
    let cwd = match authorized_workspace_cwd(&state, &body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return repository_error(error),
    };
    let inspected = match inspect_ai_session_workspace(&state, &cwd).await {
        Ok(workspace) => workspace,
        Err(error) => return repository_error(error),
    };
    let selected = inspected.branches.iter().find(|branch| {
        branch.name == body.branch
            && branch.kind == RepositoryAiSessionWorkspaceBranchKind::Branch
            && branch.current_folder_selectable
    });
    let Some(selected) = selected else {
        let current = state
            .repository_service
            .resolve(workspace_repository_target(&cwd))
            .await;
        return repository_error(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_INVALID",
            "Selected local branch cannot be checked out in the current folder.",
            &current,
        ));
    };
    if !selected.current {
        let initial = require_repository(
            state
                .repository_service
                .resolve(workspace_repository_target(&cwd))
                .await,
        )
        .map_err(repository_error);
        let initial = match initial {
            Ok(initial) => initial,
            Err(response) => return response,
        };
        let _guard = state.repository_service.lock(&initial).await;
        let resolved = state
            .repository_service
            .resolve(workspace_repository_target(&cwd))
            .await;
        if let Err(error) = checkout_branch_for_ai_session(&resolved, &body.branch).await {
            return repository_error(error);
        }
    }
    match inspect_ai_session_workspace(&state, &cwd).await {
        Ok(workspace) => repository_data(workspace),
        Err(error) => repository_error(error),
    }
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum AiSessionCreateWorkspaceSelection {
    CurrentFolder {
        branch: String,
    },
    ExistingWorktree {
        repository_context_id: String,
        worktree_id: String,
    },
    NewWorktree {
        branch_name: String,
        start_ref: String,
        expected_snapshot_id: String,
    },
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionCreateGitSelection {
    mode: String,
    branch: String,
}

fn workspace_cwd(
    root: &std::path::Path,
    source: &controlled_instance_workspace::ResolvedRepository,
) -> PathBuf {
    match source
        .context
        .cwd_relative_path
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(relative) => {
            let mut path = root.to_path_buf();
            for segment in relative.split('/') {
                path.push(segment);
            }
            path
        }
        None => root.to_path_buf(),
    }
}

fn permission_mode_from_wire(
    value: Option<&str>,
) -> Result<Option<controlled_instance_ai_session::AiSessionPermissionMode>, RepositoryOperationError>
{
    match value {
        None => Ok(None),
        Some("ask") => Ok(Some(
            controlled_instance_ai_session::AiSessionPermissionMode::Ask,
        )),
        Some("auto-review") => Ok(Some(
            controlled_instance_ai_session::AiSessionPermissionMode::AutoReview,
        )),
        Some("full-access") => Ok(Some(
            controlled_instance_ai_session::AiSessionPermissionMode::FullAccess,
        )),
        Some(_) => Err(RepositoryOperationError::new(
            "REPOSITORY_REQUEST_INVALID",
            "permissionMode is invalid.",
        )),
    }
}

async fn compensate_worktree_launch(
    state: &AppState,
    target: &RepositorySessionTarget,
    worktree_id: &str,
) -> bool {
    let sessions = repository_session_inventory(state);
    let Ok(current) = state
        .repository_service
        .list_worktrees(target, &sessions)
        .await
    else {
        return false;
    };
    let Some(item) = current
        .items
        .iter()
        .find(|item| item.summary.id == worktree_id)
    else {
        return false;
    };
    if !item.can_remove {
        return false;
    }
    state
        .repository_service
        .remove_worktree(
            target,
            &sessions,
            RepositoryRemoveWorktreeRequest {
                worktree_id: worktree_id.to_string(),
                expected_snapshot_id: current.snapshot_id,
                confirm: true,
            },
        )
        .await
        .is_ok()
}

async fn create_workspace_ai_session(
    state: &AppState,
    mut input: controlled_instance_ai_session::AiSessionCreateInput,
) -> Result<controlled_instance_ai_session::AiSessionCreateResult, WorkspaceAiSessionCreateError> {
    if input.cwd.runtime_path_type != "runtime-path" {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_REQUEST_INVALID",
            "cwd must be a runtime-path.",
        )
        .into());
    }
    let source_cwd = authorized_workspace_cwd(
        state,
        &RepositoryRuntimePathInput {
            runtime_path_type: input.cwd.runtime_path_type.clone(),
            path: input.cwd.path.clone(),
        },
    )?;
    let source_target = workspace_repository_target(&source_cwd);
    let sessions = repository_session_inventory(state);
    let source = require_repository(state.repository_service.resolve(&source_target).await)?;
    let inspected = inspect_ai_session_workspace(state, &source_cwd).await?;
    let selection = input
        .workspace_selection
        .as_ref()
        .map(|value| serde_json::from_value::<AiSessionCreateWorkspaceSelection>(value.clone()))
        .transpose()
        .map_err(|error| {
            RepositoryOperationError::new("REPOSITORY_REQUEST_INVALID", error.to_string())
        })?;
    let git_selection = input
        .git_selection
        .as_ref()
        .map(|value| serde_json::from_value::<AiSessionCreateGitSelection>(value.clone()))
        .transpose()
        .map_err(|error| {
            RepositoryOperationError::new("REPOSITORY_REQUEST_INVALID", error.to_string())
        })?;
    let selection = match (selection, git_selection) {
        (Some(selection), None) => Some(selection),
        (None, Some(git_selection)) => {
            if !matches!(git_selection.mode.as_str(), "current-folder" | "worktree") {
                return Err(RepositoryOperationError::new(
                    "REPOSITORY_REQUEST_INVALID",
                    "Git selection mode is invalid.",
                )
                .into());
            }
            if git_selection.mode == "current-folder" {
                Some(AiSessionCreateWorkspaceSelection::CurrentFolder {
                    branch: git_selection.branch,
                })
            } else {
                let selected = inspected
                    .branches
                    .iter()
                    .find(|branch| branch.name == git_selection.branch)
                    .ok_or_else(|| {
                        RepositoryOperationError::with_current(
                            "REPOSITORY_BRANCH_INVALID",
                            "Selected local branch does not exist.",
                            &source,
                        )
                    })?;
                let created = state
                    .repository_service
                    .create_worktree_for_ai_session(
                        &source_target,
                        &sessions,
                        if selected.kind == RepositoryAiSessionWorkspaceBranchKind::Head {
                            controlled_instance_workspace::RepositoryWorktreeRef::Head
                        } else {
                            controlled_instance_workspace::RepositoryWorktreeRef::Branch {
                                name: selected.name.clone(),
                            }
                        },
                        input.message.client_request_id.as_deref().ok_or_else(|| {
                            RepositoryOperationError::new(
                                "REPOSITORY_REQUEST_INVALID",
                                "clientRequestId is required.",
                            )
                        })?,
                    )
                    .await;
                let created = match created {
                    Ok(created) => created,
                    Err(error) => return Err(error.into()),
                };
                let target = created
                    .worktrees
                    .items
                    .iter()
                    .find(|item| item.summary.id == created.worktree_id)
                    .ok_or_else(|| {
                        RepositoryOperationError::with_current(
                            "REPOSITORY_WORKTREE_NOT_FOUND",
                            "The selected branch worktree is unavailable.",
                            &source,
                        )
                    })?;
                let root = state
                    .repository_service
                    .resolve_worktree_workspace(
                        &source_target,
                        &sessions,
                        &created.worktrees.repository_context_id,
                        &target.summary.id,
                    )
                    .await;
                let root = match root {
                    Ok(root) => root,
                    Err(error) => {
                        let _ =
                            compensate_worktree_launch(state, &source_target, &created.worktree_id)
                                .await;
                        return Err(error.into());
                    }
                };
                input.cwd = controlled_instance_ai_session::AiSessionRuntimePathInput {
                    runtime_path_type: "runtime-path".to_string(),
                    path: workspace_cwd(&root, &source).display().to_string(),
                };
                None
            }
        }
        (Some(_), Some(_)) | (None, None) => {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_OPERATION_FAILED",
                "A workspace selection is required.",
                &source,
            )
            .into())
        }
    };
    let mut created_worktree_id = None;
    if let Some(selection) = selection {
        match selection {
            AiSessionCreateWorkspaceSelection::CurrentFolder { branch } => {
                let selected = inspected
                    .branches
                    .iter()
                    .find(|candidate| candidate.name == branch)
                    .ok_or_else(|| {
                        RepositoryOperationError::with_current(
                            "REPOSITORY_BRANCH_INVALID",
                            "Selected local branch does not exist.",
                            &source,
                        )
                    })?;
                if selected.kind == RepositoryAiSessionWorkspaceBranchKind::Head {
                    return Err(RepositoryOperationError::with_current(
                        "REPOSITORY_BRANCH_INVALID",
                        "Selected local branch does not exist.",
                        &source,
                    )
                    .into());
                }
                if !selected.current {
                    if !selected.current_folder_selectable {
                        return Err(RepositoryOperationError::with_current(
                            if selected.current_folder_reason
                                == Some(controlled_instance_protocol::RepositoryAiSessionCurrentFolderReason::BranchOccupied)
                            {
                                "REPOSITORY_BRANCH_OCCUPIED"
                            } else {
                                "REPOSITORY_WORKTREE_OCCUPIED"
                            },
                            "The selected branch cannot be checked out in the current folder.",
                            &source,
                        )
                        .into());
                    }
                    let initial =
                        require_repository(state.repository_service.resolve(&source_target).await)?;
                    let _guard = state.repository_service.lock(&initial).await;
                    let resolved = state.repository_service.resolve(&source_target).await;
                    checkout_branch_for_ai_session(&resolved, &selected.name).await?;
                }
            }
            AiSessionCreateWorkspaceSelection::ExistingWorktree {
                repository_context_id,
                worktree_id,
            } => {
                if inspected.repository_context_id.as_deref() != Some(&repository_context_id) {
                    return Err(RepositoryOperationError::with_current(
                        "REPOSITORY_STATE_STALE",
                        "The selected worktree list is stale.",
                        &source,
                    )
                    .into());
                }
                let target = inspected
                    .worktrees
                    .iter()
                    .find(|item| item.summary.id == worktree_id)
                    .ok_or_else(|| {
                        RepositoryOperationError::with_current(
                            "REPOSITORY_WORKTREE_NOT_FOUND",
                            "The selected worktree is unavailable.",
                            &source,
                        )
                    })?;
                if !target.can_create_ai_session {
                    return Err(RepositoryOperationError::with_current(
                        "REPOSITORY_WORKTREE_UNSAFE",
                        "The selected worktree cannot host a new AI session.",
                        &source,
                    )
                    .into());
                }
                let root = state
                    .repository_service
                    .resolve_worktree_workspace(
                        &source_target,
                        &sessions,
                        &repository_context_id,
                        &worktree_id,
                    )
                    .await?;
                input.cwd = controlled_instance_ai_session::AiSessionRuntimePathInput {
                    runtime_path_type: "runtime-path".to_string(),
                    path: workspace_cwd(&root, &source).display().to_string(),
                };
            }
            AiSessionCreateWorkspaceSelection::NewWorktree {
                branch_name,
                start_ref,
                expected_snapshot_id,
            } => {
                let created = state
                    .repository_service
                    .create_worktree(
                        &source_target,
                        &sessions,
                        RepositoryCreateWorktreeRequest::NewBranch {
                            branch_name,
                            start_ref,
                            expected_snapshot_id,
                        },
                    )
                    .await?;
                created_worktree_id = Some(created.worktree_id.clone());
                let target = created
                    .worktrees
                    .items
                    .iter()
                    .find(|item| item.summary.id == created.worktree_id)
                    .ok_or_else(|| {
                        RepositoryOperationError::with_current(
                            "REPOSITORY_WORKTREE_NOT_FOUND",
                            "The new worktree is unavailable.",
                            &source,
                        )
                    })?;
                let root = state
                    .repository_service
                    .resolve_worktree_workspace(
                        &source_target,
                        &sessions,
                        &created.worktrees.repository_context_id,
                        &target.summary.id,
                    )
                    .await;
                let root = match root {
                    Ok(root) => root,
                    Err(error) => {
                        let _ =
                            compensate_worktree_launch(state, &source_target, &created.worktree_id)
                                .await;
                        return Err(error.into());
                    }
                };
                input.cwd = controlled_instance_ai_session::AiSessionRuntimePathInput {
                    runtime_path_type: "runtime-path".to_string(),
                    path: workspace_cwd(&root, &source).display().to_string(),
                };
            }
        }
    }
    if !std::path::Path::new(&input.cwd.path).is_dir() {
        if let Some(worktree_id) = created_worktree_id.as_deref() {
            let _ = compensate_worktree_launch(state, &source_target, worktree_id).await;
        }
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_CWD_INACCESSIBLE",
            "The selected folder does not exist in the worktree.",
            &state.repository_service.resolve(&source_target).await,
        )
        .into());
    }
    match state.ai_session_controller.create_session(input).await {
        Ok(result) => Ok(result),
        Err(error) => {
            if let Some(worktree_id) = created_worktree_id.as_deref() {
                let _ = compensate_worktree_launch(state, &source_target, worktree_id).await;
            }
            Err(WorkspaceAiSessionCreateError::Provider(error))
        }
    }
}

enum WorkspaceAiSessionCreateError {
    Repository(RepositoryOperationError),
    Provider(controlled_instance_ai_session::ProviderError),
}

impl From<RepositoryOperationError> for WorkspaceAiSessionCreateError {
    fn from(error: RepositoryOperationError) -> Self {
        Self::Repository(error)
    }
}

async fn repository_ai_session_workspace_create(
    State(state): State<AppState>,
    payload: Result<Json<controlled_instance_ai_session::AiSessionCreateInput>, JsonRejection>,
) -> Response {
    let input = match payload {
        Ok(Json(input)) => input,
        Err(error) => return repository_body_error(error),
    };
    match create_workspace_ai_session(&state, input).await {
        Ok(result) => repository_data(result),
        Err(WorkspaceAiSessionCreateError::Repository(error)) => repository_error(error),
        Err(WorkspaceAiSessionCreateError::Provider(error)) => ai_session_launch_error(error),
    }
}

async fn repository_start_ai_session(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryStartAiSessionRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let permission_mode = match permission_mode_from_wire(request.permission_mode.as_deref()) {
        Ok(permission_mode) => permission_mode,
        Err(error) => return repository_error(error),
    };
    let source_target = repository_target(&state, &uri, &id);
    let sessions = repository_session_inventory(&state);
    let source = match require_repository(state.repository_service.resolve(&source_target).await) {
        Ok(source) => source,
        Err(error) => return repository_error(error),
    };
    let (worktree_id, workspace) = match request.workspace_selection {
        AiSessionWorkspaceSelection::Current => {
            let worktrees = match state
                .repository_service
                .list_worktrees_from_state(&source, &sessions)
                .await
            {
                Ok(worktrees) => worktrees,
                Err(error) => return repository_error(error),
            };
            let current = match worktrees.items.iter().find(|item| item.summary.is_current) {
                Some(current) => current,
                None => {
                    return repository_error(RepositoryOperationError::with_current(
                        "REPOSITORY_WORKTREE_NOT_FOUND",
                        "Current worktree no longer exists.",
                        &source,
                    ))
                }
            };
            (
                current.summary.id.clone(),
                workspace_cwd(
                    source.worktree_root.as_ref().expect("required worktree"),
                    &source,
                ),
            )
        }
        AiSessionWorkspaceSelection::Worktree {
            repository_context_id,
            worktree_id,
        } => {
            let root = match state
                .repository_service
                .resolve_worktree_workspace(
                    &source_target,
                    &sessions,
                    &repository_context_id,
                    &worktree_id,
                )
                .await
            {
                Ok(root) => root,
                Err(error) => return repository_error(error),
            };
            (worktree_id, workspace_cwd(&root, &source))
        }
    };
    let cwd_folder_id = state
        .ai_sessions
        .get(&id)
        .and_then(|session| session.cwd_folder_id);
    let input = controlled_instance_ai_session::AiSessionCreateInput {
        agent: request.agent,
        cwd: controlled_instance_ai_session::AiSessionRuntimePathInput {
            runtime_path_type: "runtime-path".to_string(),
            path: workspace.display().to_string(),
        },
        cwd_folder_id,
        git_selection: None,
        workspace_selection: None,
        model_selection: None,
        reasoning_effort: None,
        story_id: None,
        message: controlled_instance_ai_session::AiSessionMessageInput {
            message: request.message,
            mode: None,
            client_request_id: Some(request.client_request_id),
            attachments: Vec::new(),
            references: Vec::new(),
            permission_mode,
        },
    };
    match state.ai_session_controller.create_session(input).await {
        Ok(created) => repository_data(RepositoryAiSessionLaunchResult {
            ai_session_id: created.ai_session_id,
            provider_session_id: created.provider_session_id,
            worktree_id,
            disposition: "started".to_string(),
        }),
        Err(error) => ai_session_launch_error(error),
    }
}

async fn repository_create_worktree_ai_session(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCreateWorktreeAiSessionRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let permission_mode = match permission_mode_from_wire(request.permission_mode.as_deref()) {
        Ok(permission_mode) => permission_mode,
        Err(error) => return repository_error(error),
    };
    let source_target = repository_target(&state, &uri, &id);
    let sessions = repository_session_inventory(&state);
    let source = match require_repository(state.repository_service.resolve(&source_target).await) {
        Ok(source) => source,
        Err(error) => return repository_error(error),
    };
    let created = match state
        .repository_service
        .create_worktree(&source_target, &sessions, request.worktree)
        .await
    {
        Ok(created) => created,
        Err(error) => return repository_error(error),
    };
    let root = match state
        .repository_service
        .resolve_worktree_workspace(
            &source_target,
            &sessions,
            &created.worktrees.repository_context_id,
            &created.worktree_id,
        )
        .await
    {
        Ok(root) => root,
        Err(error) => {
            let _ = compensate_worktree_launch(&state, &source_target, &created.worktree_id).await;
            return repository_error(error);
        }
    };
    let input = controlled_instance_ai_session::AiSessionCreateInput {
        agent: request.agent,
        cwd: controlled_instance_ai_session::AiSessionRuntimePathInput {
            runtime_path_type: "runtime-path".to_string(),
            path: workspace_cwd(&root, &source).display().to_string(),
        },
        cwd_folder_id: state
            .ai_sessions
            .get(&id)
            .and_then(|session| session.cwd_folder_id),
        git_selection: None,
        workspace_selection: None,
        model_selection: None,
        reasoning_effort: None,
        story_id: None,
        message: controlled_instance_ai_session::AiSessionMessageInput {
            message: request.message,
            mode: None,
            client_request_id: Some(request.client_request_id),
            attachments: Vec::new(),
            references: Vec::new(),
            permission_mode,
        },
    };
    match state.ai_session_controller.create_session(input).await {
        Ok(session) => repository_data(RepositoryAiSessionLaunchResult {
            ai_session_id: session.ai_session_id,
            provider_session_id: session.provider_session_id,
            worktree_id: created.worktree_id,
            disposition: "started".to_string(),
        }),
        Err(_error) => {
            let removed =
                compensate_worktree_launch(&state, &source_target, &created.worktree_id).await;
            let mut details = std::collections::BTreeMap::new();
            details.insert("worktreeId".to_string(), json!(created.worktree_id));
            details.insert("worktreeRemoved".to_string(), json!(removed));
            details.insert("branchRetained".to_string(), json!(true));
            details.insert("recoverable".to_string(), json!(!removed));
            let mut launch_error = RepositoryOperationError::with_current(
                "REPOSITORY_OPERATION_FAILED",
                if removed {
                    "AI session launch failed; the newly created worktree was removed and its branch was retained."
                } else {
                    "AI session launch failed; the newly created worktree was retained for recovery."
                },
                &state.repository_service.resolve(&source_target).await,
            );
            launch_error.details = Some(details);
            repository_error(launch_error)
        }
    }
}

fn repository_data<T: serde::Serialize>(data: T) -> Response {
    Json(json!({ "data": data })).into_response()
}

fn repository_error(error: RepositoryOperationError) -> Response {
    let status = repository_http_status(&error.code);
    let current = error
        .current
        .as_ref()
        .map(|resolved| json!({ "context": resolved.context, "changes": resolved.changes }));
    let mut body = json!({
        "error": {
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable(),
        }
    });
    if let Some(details) = error.details {
        body["error"]["details"] = serde_json::to_value(details).unwrap_or(Value::Null);
    }
    if let Some(current) = current {
        body["current"] = current;
    }
    (status, Json(body)).into_response()
}

fn repository_http_status(code: &str) -> StatusCode {
    match code {
        "REPOSITORY_SESSION_NOT_FOUND"
        | "REPOSITORY_FILE_NOT_FOUND"
        | "REPOSITORY_WORKTREE_NOT_FOUND" => StatusCode::NOT_FOUND,
        "REPOSITORY_GIT_UNAVAILABLE" => StatusCode::SERVICE_UNAVAILABLE,
        "REPOSITORY_FILE_TOO_LARGE" | "REPOSITORY_OUTPUT_LIMIT" => StatusCode::PAYLOAD_TOO_LARGE,
        code if code.contains("STALE")
            || code.contains("CONFLICT")
            || code.contains("DIRTY")
            || code.contains("OCCUPIED")
            || code.contains("UNSAFE") =>
        {
            StatusCode::CONFLICT
        }
        _ => StatusCode::BAD_REQUEST,
    }
}

fn repository_query_error(error: impl std::fmt::Display) -> Response {
    repository_error(RepositoryOperationError::new(
        "REPOSITORY_REQUEST_INVALID",
        error.to_string(),
    ))
}

fn repository_body_error(error: JsonRejection) -> Response {
    repository_error(RepositoryOperationError::new(
        "REPOSITORY_REQUEST_INVALID",
        error.body_text(),
    ))
}

async fn repository_context(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
) -> Response {
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    repository_data(resolved.context)
}

async fn repository_remotes(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
) -> Response {
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    repository_data(json!({
        "snapshotId": resolved.context.snapshot_id.unwrap_or_default(),
        "remotes": resolved.context.remotes.unwrap_or_default(),
    }))
}

async fn repository_directories(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    query: Result<Query<RepositoryDirectoryQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let query = match query {
        Ok(Query(query)) => query,
        Err(error) => return repository_query_error(error.body_text()),
    };
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    let service = match state.repository_service.files(&resolved) {
        Ok(service) => service,
        Err(error) => return repository_error(error),
    };
    match service.list(&query.path) {
        Ok(listing) => repository_data(listing),
        Err(error) => repository_error(error),
    }
}

async fn repository_file_search(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    query: Result<Query<RepositoryFileSearchQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let query = match query {
        Ok(Query(query)) => query,
        Err(error) => return repository_query_error(error.body_text()),
    };
    if query.query.trim().is_empty() || query.query.chars().count() > 256 {
        return repository_query_error("query must contain 1 to 256 characters.");
    }
    if query.limit == 0 || query.limit > 200 {
        return repository_query_error("limit must be between 1 and 200.");
    }
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    let service = match state.repository_service.files(&resolved) {
        Ok(service) => service,
        Err(error) => return repository_error(error),
    };
    match service.search(&query.query, query.limit) {
        Ok(result) => repository_data(result),
        Err(error) => repository_error(error),
    }
}

async fn repository_file_read(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    query: Result<Query<RepositoryFileQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let query = match query {
        Ok(Query(query)) => query,
        Err(error) => return repository_query_error(error.body_text()),
    };
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    let service = match state.repository_service.files(&resolved) {
        Ok(service) => service,
        Err(error) => return repository_error(error),
    };
    match service.read(&query.path) {
        Ok(file) => repository_data(file),
        Err(error) => repository_error(error),
    }
}

async fn repository_file_create(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCreateFileRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if !request.expected_absent {
        return repository_query_error("expectedAbsent must be true.");
    }
    repository_file_mutation(
        &state,
        &uri,
        &id,
        &request.expected_snapshot_id,
        |service| service.create(&request.path, &request.content),
    )
    .await
}

async fn repository_file_write(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryWriteFileRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_file_mutation(
        &state,
        &uri,
        &id,
        &request.expected_snapshot_id,
        |service| service.write(&request.path, &request.content, &request.expected_version),
    )
    .await
}

async fn repository_file_rename(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryRenameFileRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if !request.expected_destination_absent {
        return repository_query_error("expectedDestinationAbsent must be true.");
    }
    repository_file_mutation(
        &state,
        &uri,
        &id,
        &request.expected_snapshot_id,
        |service| {
            service.rename(
                &request.path,
                &request.destination,
                &request.expected_version,
            )
        },
    )
    .await
}

async fn repository_file_delete(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryDeleteFileRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if !request.confirm {
        return repository_query_error("confirm must be true.");
    }
    let initial = resolve_repository_target(&state, &uri, &id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    if resolved.context.snapshot_id.as_deref() != Some(request.expected_snapshot_id.as_str()) {
        return repository_error(RepositoryOperationError::with_current(
            "REPOSITORY_STATE_STALE",
            "Repository state changed after it was loaded.",
            &resolved,
        ));
    }
    let service = match state.repository_service.files(&resolved) {
        Ok(service) => service,
        Err(error) => return repository_error(error),
    };
    if let Err(error) = service.delete(&request.path, &request.expected_version) {
        return repository_error(error);
    }
    let refreshed = resolve_repository_target(&state, &uri, &id).await;
    repository_data(controlled_instance_protocol::RepositoryFileMutationResult {
        file: None,
        snapshot_id: refreshed.context.snapshot_id.clone().unwrap_or_default(),
        context: refreshed.context,
        changes: refreshed.changes.unwrap_or_else(|| {
            controlled_instance_protocol::RepositoryChanges {
                snapshot_id: String::new(),
                summary: Default::default(),
                entries: Vec::new(),
            }
        }),
    })
}

async fn repository_file_mutation<F, T>(
    state: &AppState,
    uri: &Uri,
    id: &str,
    expected_snapshot_id: &str,
    mutate: F,
) -> Response
where
    F: FnOnce(
        &controlled_instance_workspace::RepositoryFileService,
    ) -> Result<T, RepositoryOperationError>,
    T: serde::Serialize,
{
    let initial = resolve_repository_target(state, uri, id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(state, uri, id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    if resolved.context.snapshot_id.as_deref() != Some(expected_snapshot_id) {
        return repository_error(RepositoryOperationError::with_current(
            "REPOSITORY_STATE_STALE",
            "Repository state changed after it was loaded.",
            &resolved,
        ));
    }
    let service = match state.repository_service.files(&resolved) {
        Ok(service) => service,
        Err(error) => return repository_error(error),
    };
    let file = match mutate(&service) {
        Ok(file) => file,
        Err(error) => return repository_error(error),
    };
    let refreshed = resolve_repository_target(state, uri, id).await;
    let file = match serde_json::to_value(file) {
        Ok(file) => file,
        Err(error) => {
            return repository_error(RepositoryOperationError::new(
                "REPOSITORY_OPERATION_FAILED",
                error.to_string(),
            ))
        }
    };
    repository_data(json!({
        "file": file,
        "snapshotId": refreshed.context.snapshot_id,
        "context": refreshed.context,
        "changes": refreshed.changes.unwrap_or_else(|| controlled_instance_protocol::RepositoryChanges {
            snapshot_id: String::new(),
            summary: Default::default(),
            entries: Vec::new(),
        }),
    }))
}

async fn repository_changes(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
) -> Response {
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let resolved = match require_workspace(resolved) {
        Ok(resolved) => resolved,
        Err(error) => return repository_error(error),
    };
    repository_data(resolved.changes)
}

async fn repository_diff_route(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    query: Result<Query<RepositoryDiffQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let query = match query {
        Ok(Query(query)) => query,
        Err(error) => return repository_query_error(error.body_text()),
    };
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    match repository_diff(
        &resolved,
        query.scope,
        &query.path,
        query.byte_limit,
        query.include_context,
        query.context_lines,
    )
    .await
    {
        Ok(diff) => repository_data(diff),
        Err(error) => repository_error(error),
    }
}

async fn repository_stage(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<
        Json<controlled_instance_protocol::RepositoryPathMutationRequest>,
        JsonRejection,
    >,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let initial = resolve_repository_target(&state, &uri, &id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    if let Err(error) = stage_paths(&resolved, &request.expected_snapshot_id, &request.paths).await
    {
        return repository_error(error);
    }
    let refreshed = resolve_repository_target(&state, &uri, &id).await;
    repository_data(mutation_result(&refreshed, None))
}

async fn repository_unstage(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<
        Json<controlled_instance_protocol::RepositoryPathMutationRequest>,
        JsonRejection,
    >,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let initial = resolve_repository_target(&state, &uri, &id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    if let Err(error) =
        unstage_paths(&resolved, &request.expected_snapshot_id, &request.paths).await
    {
        return repository_error(error);
    }
    let refreshed = resolve_repository_target(&state, &uri, &id).await;
    repository_data(mutation_result(&refreshed, None))
}

async fn repository_discard_worktree(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<
        Json<controlled_instance_protocol::RepositoryPathMutationRequest>,
        JsonRejection,
    >,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if !request.confirm {
        return repository_query_error("confirm must be true.");
    }
    let initial = resolve_repository_target(&state, &uri, &id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    if let Err(error) =
        discard_worktree_paths(&resolved, &request.expected_snapshot_id, &request.paths).await
    {
        return repository_error(error);
    }
    let refreshed = resolve_repository_target(&state, &uri, &id).await;
    repository_data(mutation_result(&refreshed, None))
}

async fn repository_discard_all_tracked(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<
        Json<controlled_instance_protocol::RepositoryPathMutationRequest>,
        JsonRejection,
    >,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if !request.confirm {
        return repository_query_error("confirm must be true.");
    }
    let initial = resolve_repository_target(&state, &uri, &id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    if let Err(error) =
        discard_all_tracked_paths(&resolved, &request.expected_snapshot_id, &request.paths).await
    {
        return repository_error(error);
    }
    let refreshed = resolve_repository_target(&state, &uri, &id).await;
    repository_data(mutation_result(&refreshed, None))
}

async fn repository_commit(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCommitRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    let initial = resolve_repository_target(&state, &uri, &id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    let message = match normalize_repository_commit_message(&request.message) {
        Ok(message) => message,
        Err(message) => return repository_query_error(message),
    };
    match commit_repository(&resolved, &request.expected_snapshot_id, message).await {
        Ok(result) => {
            let refreshed = resolve_repository_target(&state, &uri, &id).await;
            repository_data(mutation_result(&refreshed, result.commit_oid))
        }
        Err(error) => repository_error(error),
    }
}

fn normalize_repository_commit_message(message: &str) -> Result<&str, String> {
    let message = trim_js_whitespace(message);
    if message.is_empty() {
        return Err("message: Too small: expected string to have >=1 characters".to_string());
    }
    if utf16_len(message) > 64 * 1024 {
        return Err("message: Too big: expected string to have <=65536 characters".to_string());
    }
    Ok(message)
}

async fn repository_branches(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
) -> Response {
    let resolved = resolve_repository_target(&state, &uri, &id).await;
    match list_branches(&resolved).await {
        Ok(branches) => repository_data(branches),
        Err(error) => repository_error(error),
    }
}

async fn repository_branch_create(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCreateBranchRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        create_branch(&resolved, &request.expected_snapshot_id, &request.name).await
    })
    .await
}

async fn repository_branch_checkout(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCheckoutBranchRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        checkout_branch(&resolved, &request.expected_snapshot_id, &request.branch).await
    })
    .await
}

async fn repository_branch_tracking(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryCreateTrackingBranchRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        create_tracking_branch(
            &resolved,
            &request.expected_snapshot_id,
            &request.name,
            &request.remote_tracking_ref,
        )
        .await
    })
    .await
}

async fn repository_branch_delete(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryDeleteBranchRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if !request.confirm {
        return repository_query_error("confirm must be true.");
    }
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        delete_branch(&resolved, &request.expected_snapshot_id, &request.name).await
    })
    .await
}

async fn repository_fetch(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryFetchRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        fetch_remote(&resolved, &request.expected_snapshot_id, &request.remote).await
    })
    .await
}

async fn repository_pull(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryPullRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        pull_branch(&resolved, &request.expected_snapshot_id).await
    })
    .await
}

async fn repository_publish(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryPublishRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    if request.set_upstream && !request.confirm_set_upstream {
        return repository_query_error("Setting upstream requires explicit confirmation.");
    }
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        publish_branch(
            &resolved,
            &request.expected_snapshot_id,
            &request.remote,
            &request.source_branch,
            &request.target_branch,
            request.set_upstream,
            request.confirm_set_upstream,
        )
        .await
    })
    .await
}

async fn repository_push(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    payload: Result<Json<RepositoryPushRequest>, JsonRejection>,
) -> Response {
    let request = match payload {
        Ok(Json(request)) => request,
        Err(error) => return repository_body_error(error),
    };
    repository_branch_mutation(&state, &uri, &id, |resolved| async move {
        push_branch(
            &resolved,
            &request.expected_snapshot_id,
            &request.remote,
            &request.source_branch,
            &request.target_branch,
        )
        .await
    })
    .await
}

async fn repository_branch_mutation<F, Fut>(
    state: &AppState,
    uri: &Uri,
    id: &str,
    operation: F,
) -> Response
where
    F: FnOnce(controlled_instance_workspace::ResolvedRepository) -> Fut,
    Fut: std::future::Future<Output = Result<(), RepositoryOperationError>>,
{
    let initial = resolve_repository_target(state, uri, id).await;
    let _guard = state.repository_service.lock(&initial).await;
    let resolved = resolve_repository_target(state, uri, id).await;
    if let Err(error) = operation(resolved).await {
        return repository_error(error);
    }
    let refreshed = resolve_repository_target(state, uri, id).await;
    match list_branches(&refreshed).await {
        Ok(branches) => repository_data(branch_mutation_result(&refreshed, branches)),
        Err(error) => repository_error(error),
    }
}

pub async fn run_web(options: ServerOptions) -> anyhow::Result<()> {
    let config = InstanceConfig::from_env(options);
    config.storage_paths.ensure_directories()?;
    let auth = resolve_web_auth(&config.storage_paths)?;
    let bind_host = config.host.clone();
    let bind_port = config.port;
    let node_agent_client =
        crate::node_agent_client::NodeAgentClient::from_instance_config(&config);
    let git_credential_broker = GitCredentialBroker::new(
        node_agent_client.clone(),
        GitCredentialBrokerOptions::default(),
    )?;
    git_credential_broker.start().await?;
    let git_credential_broker_installed = install_git_broker_environment(
        std::env::current_exe().ok().as_deref(),
        git_credential_broker.socket_path(),
    );
    let state = match AppState::try_new_with_node_agent_client(config, auth, node_agent_client) {
        Ok(state) => state,
        Err(error) => {
            let _ = git_credential_broker.close().await;
            return Err(error);
        }
    };
    state.set_git_credential_broker_installed(git_credential_broker_installed);
    state.start_ai_session_services();
    state.start_app_session_services();
    if let Err(error) = state.trigger_manager.start() {
        warn!(%error, "failed to start trigger runtime");
    }
    state.publish_ai_session_snapshot("startup");
    let listener = TcpListener::bind((bind_host.as_str(), bind_port)).await?;
    let local = listener.local_addr()?;
    info!(address = %local, draining = state.is_draining(), "controlled instance HTTP server listening");
    state.start_node_agent();
    let server_state = state.clone();
    let shutdown = shutdown_signal(state.shutdown_receiver());
    let serve_result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await;
    server_state
        .instance_shell
        .shutdown(1001, "Controlled instance is shutting down.")
        .await;
    server_state.stop_node_agent().await;
    server_state.stop_ai_session_services().await;
    server_state.app_runtime.stop_all().await;
    server_state.trigger_manager.stop();
    git_credential_broker.close().await?;
    serve_result?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: json!({
            "ok": true,
            "version": state.config.package_version,
            "startedAt": state.started_at,
        }),
    })
}

async fn trigger_list(State(state): State<AppState>) -> Response {
    match state.trigger_store.load() {
        Ok(index) => Json(ApiEnvelope { data: index }).into_response(),
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_get(State(state): State<AppState>, Path(config_hash): Path<String>) -> Response {
    match state.trigger_store.get(&config_hash) {
        Ok(Some(entry)) => Json(ApiEnvelope { data: entry }).into_response(),
        Ok(None) => trigger_not_found(),
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_create(
    State(state): State<AppState>,
    payload: Result<Json<TriggerCreateInput>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => return trigger_invalid(error.body_text()),
    };
    match state.trigger_store.create(input) {
        Ok(created) => {
            if let Err(error) = state.trigger_manager.restart() {
                warn!(%error, "failed to restart triggers after creation");
            }
            state.events.publish(
                "trigger.created",
                serde_json::to_value(&created).unwrap_or(Value::Null),
            );
            publish_trigger_snapshot(&state);
            Json(ApiEnvelope { data: created }).into_response()
        }
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_patch(
    State(state): State<AppState>,
    Path(config_hash): Path<String>,
    payload: Result<Json<TriggerPatchInput>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => return trigger_invalid(error.body_text()),
    };
    match state.trigger_store.patch(&config_hash, input) {
        Ok(Some(updated)) => {
            if let Err(error) = state.trigger_manager.restart() {
                warn!(%error, "failed to restart triggers after update");
            }
            let entry = state
                .trigger_store
                .get(&config_hash)
                .ok()
                .flatten()
                .map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null))
                .unwrap_or(Value::Null);
            state.events.publish("trigger.updated", entry);
            Json(ApiEnvelope { data: updated }).into_response()
        }
        Ok(None) => trigger_not_found(),
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_delete(
    State(state): State<AppState>,
    Path(config_hash): Path<String>,
) -> Response {
    match state.trigger_store.delete(&config_hash) {
        Ok(true) => {
            if let Err(error) = state.trigger_manager.restart() {
                warn!(%error, "failed to restart triggers after deletion");
            }
            state
                .events
                .publish("trigger.deleted", json!({ "configHash": config_hash }));
            publish_trigger_snapshot(&state);
            Json(ApiEnvelope {
                data: json!({ "deleted": true }),
            })
            .into_response()
        }
        Ok(false) => trigger_not_found(),
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_deployment_delete(
    State(state): State<AppState>,
    Path((config_hash, deployment_id)): Path<(String, String)>,
) -> Response {
    match state
        .trigger_store
        .delete_deployment(&config_hash, &deployment_id)
    {
        Ok(true) => {
            if let Err(error) = state.trigger_manager.restart() {
                warn!(%error, "failed to restart triggers after deployment deletion");
            }
            state.events.publish(
                "trigger.deployment.deleted",
                json!({ "configHash": config_hash, "deploymentId": deployment_id }),
            );
            publish_trigger_snapshot(&state);
            Json(ApiEnvelope {
                data: json!({ "deleted": true }),
            })
            .into_response()
        }
        Ok(false) => api_error(
            StatusCode::NOT_FOUND,
            "TRIGGER_DEPLOYMENT_NOT_FOUND",
            "Trigger deployment not found.",
        ),
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_enable(
    State(state): State<AppState>,
    Path(config_hash): Path<String>,
) -> Response {
    set_trigger_enabled(state, config_hash, true).await
}

async fn trigger_disable(
    State(state): State<AppState>,
    Path(config_hash): Path<String>,
) -> Response {
    set_trigger_enabled(state, config_hash, false).await
}

async fn set_trigger_enabled(state: AppState, config_hash: String, enabled: bool) -> Response {
    match state.trigger_store.set_enabled(&config_hash, enabled) {
        Ok(Some(updated)) => {
            if let Err(error) = state.trigger_manager.restart() {
                warn!(%error, "failed to restart triggers after enabled-state update");
            }
            state.events.publish(
                if enabled {
                    "trigger.enabled"
                } else {
                    "trigger.disabled"
                },
                serde_json::to_value(&updated).unwrap_or(Value::Null),
            );
            publish_trigger_snapshot(&state);
            Json(ApiEnvelope { data: updated }).into_response()
        }
        Ok(None) => trigger_not_found(),
        Err(error) => trigger_store_error(error),
    }
}

async fn trigger_run(
    State(state): State<AppState>,
    Path(config_hash): Path<String>,
    payload: Result<Option<Json<Value>>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Some(Json(body))) => body,
        Ok(None) => Value::Null,
        Err(error) => return trigger_invalid(error.body_text()),
    };
    state
        .events
        .publish("trigger.run.started", json!({ "configHash": config_hash }));
    let input = match parse_trigger_run_input(&body) {
        Ok(input) => input,
        Err(message) => {
            state.events.publish(
                "trigger.run.failed",
                json!({ "configHash": config_hash, "error": message }),
            );
            return api_error(StatusCode::BAD_REQUEST, "TRIGGER_RUN_FAILED", &message);
        }
    };
    let entry = match state.trigger_store.get(&config_hash) {
        Ok(Some(entry)) => entry,
        Ok(None) => {
            let message = "Trigger not found.";
            state.events.publish(
                "trigger.run.failed",
                json!({ "configHash": config_hash, "error": message }),
            );
            return api_error(StatusCode::NOT_FOUND, "TRIGGER_NOT_FOUND", message);
        }
        Err(error) => {
            let message = error.to_string();
            state.events.publish(
                "trigger.run.failed",
                json!({ "configHash": config_hash, "error": message }),
            );
            return trigger_store_error(error);
        }
    };
    let deployment = match input.deployment_id.as_deref() {
        Some(deployment_id) => entry
            .deployments
            .iter()
            .find(|deployment| deployment.key() == deployment_id)
            .cloned(),
        None => entry.deployments.first().cloned(),
    };
    let Some(deployment) = deployment else {
        let message = "Trigger has no deployment.";
        state.events.publish(
            "trigger.run.failed",
            json!({ "configHash": config_hash, "error": message }),
        );
        return api_error(
            StatusCode::BAD_REQUEST,
            "TRIGGER_DEPLOYMENT_NOT_FOUND",
            message,
        );
    };
    match state
        .trigger_executor
        .execute(
            controlled_instance_workspace::triggers::TriggerExecuteInput {
                config: entry.config,
                deployment,
                event_type: controlled_instance_protocol::TriggerEventType::Manual,
                event_summary: input.event_summary,
                prompt_override: input.prompt_override,
            },
        )
        .await
    {
        Ok(result) => {
            state.events.publish(
                "trigger.run.completed",
                serde_json::to_value(&result).unwrap_or(Value::Null),
            );
            publish_trigger_snapshot(&state);
            Json(ApiEnvelope { data: result }).into_response()
        }
        Err(error) => {
            let code = error.code().to_string();
            let message = error.to_string();
            state.events.publish(
                "trigger.run.failed",
                json!({ "configHash": config_hash, "error": message }),
            );
            api_error(StatusCode::BAD_REQUEST, &code, &message)
        }
    }
}

fn parse_trigger_run_input(body: &Value) -> Result<TriggerRunInput, String> {
    if body.is_null() {
        return Ok(TriggerRunInput::default());
    }
    let Some(object) = body.as_object() else {
        return Err(format!(
            "body: Invalid input: expected object, received {}",
            zod_received_type(body)
        ));
    };
    let mut issues = Vec::new();
    let prompt_override = trigger_run_string(
        object.get("promptOverride"),
        "promptOverride",
        1,
        20_000,
        &mut issues,
    );
    let event_summary = trigger_run_string(
        object.get("eventSummary"),
        "eventSummary",
        0,
        1_000,
        &mut issues,
    );
    let deployment_id = trigger_run_string(
        object.get("deploymentId"),
        "deploymentId",
        1,
        240,
        &mut issues,
    );
    let unknown = object
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "promptOverride" | "eventSummary" | "deploymentId"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        let listed = unknown
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(format!(
            "body: Unrecognized key{}: {listed}",
            if unknown.len() == 1 { "" } else { "s" }
        ));
    }
    if !issues.is_empty() {
        return Err(issues.join("; "));
    }
    Ok(TriggerRunInput {
        prompt_override,
        event_summary,
        deployment_id,
    })
}

fn trigger_run_string(
    value: Option<&Value>,
    path: &str,
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<String>,
) -> Option<String> {
    let value = value?;
    let Some(value) = value.as_str() else {
        issues.push(format!(
            "{path}: Invalid input: expected string, received {}",
            zod_received_type(value)
        ));
        return None;
    };
    let value = trim_js_whitespace(value);
    let length = utf16_len(value);
    if length < minimum {
        issues.push(format!(
            "{path}: Too small: expected string to have >={minimum} characters"
        ));
        return None;
    }
    if length > maximum {
        issues.push(format!(
            "{path}: Too big: expected string to have <={maximum} characters"
        ));
        return None;
    }
    Some(value.to_string())
}

async fn trigger_runs(State(state): State<AppState>) -> Response {
    match state.trigger_store.load() {
        Ok(index) => Json(ApiEnvelope {
            data: index.recent_runs,
        })
        .into_response(),
        Err(error) => trigger_store_error(error),
    }
}

fn publish_trigger_snapshot(state: &AppState) {
    match state.trigger_store.load() {
        Ok(index) => {
            let snapshot = trigger_snapshot(index);
            state.events.publish(
                "trigger.updated",
                serde_json::to_value(snapshot).unwrap_or(Value::Null),
            );
        }
        Err(error) => warn!(%error, "failed to publish trigger snapshot"),
    }
}

fn trigger_store_error(error: TriggerStoreError) -> Response {
    match error {
        TriggerStoreError::Invalid(message) => trigger_invalid(message),
        other => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "TRIGGER_PERSISTENCE_FAILED",
            &other.to_string(),
        ),
    }
}

fn trigger_not_found() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "TRIGGER_NOT_FOUND",
        "Trigger not found.",
    )
}

fn trigger_invalid(message: impl AsRef<str>) -> Response {
    api_error(StatusCode::BAD_REQUEST, "TRIGGER_INVALID", message.as_ref())
}

async fn auth_status(State(state): State<AppState>) -> Json<ApiEnvelope<crate::auth::AuthStatus>> {
    Json(ApiEnvelope {
        data: state.auth.status(),
    })
}

async fn status(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: json!({
            "version": state.config.package_version,
            "startedAt": state.started_at,
            "runningAppCount": state.app_counts().running_count,
            "storage": state.config.storage_paths,
        }),
    })
}

async fn instance_status(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    let mut snapshot = serde_json::to_value(state.status_snapshot()).unwrap_or_else(|_| json!({}));
    if let Some(object) = snapshot.as_object_mut() {
        if let Some(instance_id) = state.config.configured_instance_id.clone() {
            object.insert("id".to_string(), json!(instance_id));
        }
        object.insert("name".to_string(), json!(state.config.instance_name));
        object.insert("startedAt".to_string(), json!(state.started_at));
    }
    Json(ApiEnvelope { data: snapshot })
}

async fn capabilities(
    State(state): State<AppState>,
) -> Json<ApiEnvelope<controlled_instance_protocol::ControlledInstanceCapabilities>> {
    Json(ApiEnvelope {
        data: state.capabilities(),
    })
}

async fn workspace_status(
    State(state): State<AppState>,
) -> Json<ApiEnvelope<controlled_instance_protocol::WorkspaceStatus>> {
    Json(ApiEnvelope {
        data: state.workspace_status(),
    })
}

async fn diagnostics(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: state.diagnostics(),
    })
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSessionsQuery {
    stream_id: Option<String>,
    since_revision: Option<String>,
    hierarchy: Option<String>,
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSessionsStateQuery {
    hierarchy: Option<String>,
}

async fn app_catalog(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: serde_json::to_value(state.app_runtime.catalog()).unwrap_or(Value::Null),
    })
}

async fn app_management(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    let snapshot = state.app_management.refresh_snapshot(false).await;
    Json(ApiEnvelope {
        data: serde_json::to_value(snapshot).unwrap_or(Value::Null),
    })
}

async fn app_management_install(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    payload: Result<Json<AppManagementOperationRequest>, JsonRejection>,
) -> Response {
    app_management_request(state, app_id, AppManagementOperation::Install, payload).await
}

async fn app_management_uninstall(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    payload: Result<Json<AppManagementOperationRequest>, JsonRejection>,
) -> Response {
    app_management_request(state, app_id, AppManagementOperation::Uninstall, payload).await
}

async fn app_management_update(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    payload: Result<Json<AppManagementOperationRequest>, JsonRejection>,
) -> Response {
    app_management_request(state, app_id, AppManagementOperation::Update, payload).await
}

async fn app_management_request(
    state: AppState,
    app_id: String,
    operation: AppManagementOperation,
    payload: Result<Json<AppManagementOperationRequest>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return app_management_body_error(error),
    };
    match state.app_management.request(&app_id, operation, body).await {
        Ok(job) => (
            StatusCode::ACCEPTED,
            Json(ApiEnvelope {
                data: json!({ "job": job }),
            }),
        )
            .into_response(),
        Err(error) => app_management_error(error),
    }
}

async fn app_management_update_check(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    payload: Result<Json<AppManagementOperationRequest>, JsonRejection>,
) -> Response {
    if let Err(error) = payload {
        return app_management_body_error(error);
    }
    match state.app_management.check_for_update(&app_id).await {
        Ok(check) => Json(ApiEnvelope {
            data: json!({ "check": check }),
        })
        .into_response(),
        Err(error) => app_management_error(error),
    }
}

async fn app_management_job(State(state): State<AppState>, Path(job_id): Path<String>) -> Response {
    match state.app_management.get_job(&job_id) {
        Ok(job) => Json(ApiEnvelope {
            data: json!({ "job": job }),
        })
        .into_response(),
        Err(error) => app_management_error(error),
    }
}

async fn update_managed_model_environment(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(value) = match payload {
        Ok(payload) => payload,
        Err(error) => return managed_model_body_error("MANAGED_MODEL_ENVIRONMENT_INVALID", error),
    };
    let next = match serde_json::from_value::<ManagedModelEnvironment>(value) {
        Ok(next) => next,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "MANAGED_MODEL_ENVIRONMENT_INVALID",
                &error.to_string(),
            );
        }
    };
    match state.controlled_models.apply_environment(next) {
        Ok(result) => {
            state.refresh_managed_model_environment().await;
            Json(ApiEnvelope {
                data: json!({
                    "applied": true,
                    "codexAuthConfigured": result.codex_auth_configured,
                    "claudeAuthConfigured": result.claude_auth_configured,
                    "configUpdated": result.config_updated,
                }),
            })
            .into_response()
        }
        Err(error) => managed_model_error(error),
    }
}

async fn managed_model_catalog(State(state): State<AppState>) -> Response {
    match serde_json::to_value(state.controlled_models.catalog_snapshot()) {
        Ok(data) => Json(ApiEnvelope { data }).into_response(),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "MANAGED_MODEL_CATALOG_INVALID",
            &error.to_string(),
        ),
    }
}

async fn update_managed_model_catalog(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(value) = match payload {
        Ok(payload) => payload,
        Err(error) => return managed_model_body_error("MANAGED_MODEL_CATALOG_INVALID", error),
    };
    match state.controlled_models.apply_catalog(value) {
        Ok(result) => {
            state.refresh_managed_model_environment().await;
            Json(ApiEnvelope {
                data: json!({
                    "applied": result.applied,
                    "configUpdated": result.config_updated,
                }),
            })
            .into_response()
        }
        Err(error) => managed_model_error(error),
    }
}

async fn update_codex_settings(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(value) = match payload {
        Ok(payload) => payload,
        Err(error) => return managed_model_body_error("CODEX_SETTINGS_INVALID", error),
    };
    match state.controlled_models.apply_codex_settings(value) {
        Ok(result) => Json(ApiEnvelope {
            data: json!({
                "applied": result.applied,
                "configUpdated": result.config_updated,
            }),
        })
        .into_response(),
        Err(error) => managed_model_error(error),
    }
}

async fn update_ai_session_persistence_settings(
    State(state): State<AppState>,
    payload: Result<
        Json<controlled_instance_protocol::AiSessionPersistenceSettingsInput>,
        JsonRejection,
    >,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_PERSISTENCE_SETTINGS_INVALID",
                &error.body_text(),
            );
        }
    };
    let settings = match state.ai_session_persistence_settings.put(input) {
        Ok(settings) => settings,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_PERSISTENCE_SETTINGS_INVALID",
                "AI session persistence settings are invalid.",
            );
        }
    };
    let _ = state
        .ai_session_attachments
        .set_retention_days(settings.attachment_retention_days);
    if let Err(error) = state
        .ai_session_attachments
        .set_max_file_attachment_bytes(settings.max_file_attachment_bytes)
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_PERSISTENCE_SETTINGS_INVALID",
            &error.message,
        );
    }
    let history = match state
        .ai_session_history
        .set_retention_limit(settings.history_limit)
    {
        Ok(history) => history,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_PERSISTENCE_SETTINGS_INVALID",
                "AI session persistence settings are invalid.",
            );
        }
    };
    Json(ApiEnvelope {
        data: controlled_instance_protocol::AiSessionPersistenceSettingsApplyResult {
            applied: true,
            history_limit: history.limit,
            attachment_retention_days: settings.attachment_retention_days,
            max_file_attachment_bytes: settings.max_file_attachment_bytes,
            removed_history_count: history.removed_ids.len(),
        },
    })
    .into_response()
}

fn managed_model_body_error(code: &str, error: JsonRejection) -> Response {
    api_error(StatusCode::BAD_REQUEST, code, &error.body_text())
}

fn managed_model_error(error: crate::ManagedModelError) -> Response {
    api_error(
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &error.code,
        &error.message,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigSyncFoldersQuery {
    path: Option<String>,
    depth: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct ConfigSyncLegacyRequest {
    #[serde(default)]
    preset: Option<ConfigSyncPreset>,
}

async fn config_sync_presets(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: serde_json::to_value(config_sync_service(&state).presets()).unwrap_or(Value::Null),
    })
}

async fn config_sync_programs() -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: serde_json::to_value(ConfigSyncService::programs()).unwrap_or(Value::Null),
    })
}

async fn config_sync_folders(
    State(state): State<AppState>,
    query: Result<Query<ConfigSyncFoldersQuery>, QueryRejection>,
) -> Response {
    let Query(query) = match query {
        Ok(query) => query,
        Err(error) => {
            return config_sync_error(ConfigSyncError::new(
                "CONFIG_SYNC_FOLDER_LIST_FAILED",
                error.body_text(),
                400,
            ));
        }
    };
    if query.path.as_ref().is_some_and(|path| path.len() > 1000) {
        return config_sync_error(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_LIST_FAILED",
            "Config sync folder path is too long.",
            400,
        ));
    }
    let depth = query.depth.unwrap_or(0);
    if depth > 2 {
        return config_sync_error(ConfigSyncError::new(
            "CONFIG_SYNC_FOLDER_LIST_FAILED",
            "Config sync folder depth must be between 0 and 2.",
            400,
        ));
    }
    match config_sync_service(&state).list_folders(query.path.as_deref(), depth) {
        Ok(folders) => Json(ApiEnvelope {
            data: serde_json::to_value(folders).unwrap_or(Value::Null),
        })
        .into_response(),
        Err(error) => config_sync_error(error),
    }
}

async fn config_sync_batch(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return config_sync_json_error(error),
    };
    let request = match config_sync_batch_request(body) {
        Ok(request) => request,
        Err(issues) => {
            let message = serde_json::to_string_pretty(&issues)
                .unwrap_or_else(|_| "Config sync request is invalid.".to_string());
            return config_sync_error(ConfigSyncError::new("CONFIG_SYNC_FAILED", message, 500));
        }
    };
    let direction = request.direction;
    let program_ids = request.program_ids.clone();
    match config_sync_service(&state).run_batch(request) {
        Ok(result) => {
            if direction == ConfigSyncDirection::Import {
                if let Err(error) = state
                    .controlled_models
                    .reapply_after_config_import(&program_ids)
                {
                    return managed_model_error(error);
                }
            }
            Json(ApiEnvelope {
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            })
            .into_response()
        }
        Err(error) => config_sync_error(error),
    }
}

async fn config_sync_legacy(
    State(state): State<AppState>,
    Path((direction, preset)): Path<(String, String)>,
    payload: Result<Json<ConfigSyncLegacyRequest>, JsonRejection>,
) -> Response {
    let direction = match direction.as_str() {
        "import" => ConfigSyncDirection::Import,
        "export" => ConfigSyncDirection::Export,
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "CONFIG_SYNC_DIRECTION_INVALID",
                "Config sync direction must be import or export.",
            );
        }
    };
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return config_sync_json_error(error),
    };
    match config_sync_service(&state).run(direction, &preset, body.preset.as_ref()) {
        Ok(result) => {
            if direction == ConfigSyncDirection::Import
                && matches!(preset.as_str(), "codex" | "claude")
            {
                if let Err(error) = state
                    .controlled_models
                    .reapply_after_config_import(std::slice::from_ref(&preset))
                {
                    return managed_model_error(error);
                }
            }
            Json(ApiEnvelope {
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            })
            .into_response()
        }
        Err(error) => config_sync_error(error),
    }
}

fn config_sync_service(state: &AppState) -> ConfigSyncService {
    let browser_profiles = state
        .app_runtime
        .app_profile_locations("chromium")
        .unwrap_or_default()
        .into_iter()
        .map(|profile| ConfigSyncBrowserProfile {
            id: profile.id,
            name: profile.name,
            directory: profile.directory,
            is_default: profile.is_default,
        })
        .collect();
    let runtime = state.app_runtime.clone();
    let assert_profile_idle = std::sync::Arc::new(move |profile_id: &str| {
        runtime
            .assert_app_profile_idle("chromium", profile_id)
            .map_err(|error| {
                ConfigSyncError::new(
                    error.code(),
                    error.to_string(),
                    if error.code() == "BROWSER_PROFILE_BUSY" {
                        409
                    } else {
                        500
                    },
                )
            })
    });
    ConfigSyncService::new(
        state.config_sync_environment.clone(),
        browser_profiles,
        Some(assert_profile_idle),
    )
}

fn config_sync_json_error(error: JsonRejection) -> Response {
    if matches!(error, JsonRejection::JsonDataError(_)) {
        config_sync_error(ConfigSyncError::new(
            "CONFIG_SYNC_FAILED",
            error.body_text(),
            500,
        ))
    } else {
        config_sync_error(ConfigSyncError::new(
            "CONFIG_SYNC_FAILED",
            error.body_text(),
            400,
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ConfigSyncValidationIssue {
    InvalidValue {
        code: &'static str,
        values: Vec<&'static str>,
        path: Vec<ConfigSyncValidationPath>,
        message: String,
    },
    InvalidType {
        expected: &'static str,
        code: &'static str,
        path: Vec<ConfigSyncValidationPath>,
        message: String,
    },
    TooSmall {
        origin: &'static str,
        code: &'static str,
        minimum: usize,
        inclusive: bool,
        path: Vec<ConfigSyncValidationPath>,
        message: String,
    },
    TooBig {
        origin: &'static str,
        code: &'static str,
        maximum: usize,
        inclusive: bool,
        path: Vec<ConfigSyncValidationPath>,
        message: String,
    },
    Custom {
        code: &'static str,
        path: Vec<ConfigSyncValidationPath>,
        message: String,
    },
    UnrecognizedKeys {
        code: &'static str,
        keys: Vec<String>,
        path: Vec<ConfigSyncValidationPath>,
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ConfigSyncValidationPath {
    Key(&'static str),
    Index(usize),
}

fn config_sync_batch_request(
    body: Value,
) -> Result<ConfigSyncRequest, Vec<ConfigSyncValidationIssue>> {
    let object = body.as_object().ok_or_else(|| {
        vec![ConfigSyncValidationIssue::InvalidType {
            expected: "object",
            code: "invalid_type",
            path: vec![],
            message: format!(
                "Invalid input: expected object, received {}",
                zod_received_type(&body)
            ),
        }]
    })?;
    let mut issues = Vec::new();
    let direction = match object.get("direction").and_then(Value::as_str) {
        Some("import") => Some(ConfigSyncDirection::Import),
        Some("export") => Some(ConfigSyncDirection::Export),
        _ => {
            issues.push(ConfigSyncValidationIssue::InvalidValue {
                code: "invalid_value",
                values: vec!["import", "export"],
                path: vec![ConfigSyncValidationPath::Key("direction")],
                message: "Invalid option: expected one of \"import\"|\"export\"".to_string(),
            });
            None
        }
    };
    let program_ids = match object.get("programIds") {
        None => {
            issues.push(ConfigSyncValidationIssue::InvalidType {
                expected: "array",
                code: "invalid_type",
                path: vec![ConfigSyncValidationPath::Key("programIds")],
                message: "Invalid input: expected array, received undefined".to_string(),
            });
            None
        }
        Some(Value::Array(values)) => {
            let mut parsed = Vec::with_capacity(values.len());
            let mut valid = true;
            for (index, value) in values.iter().enumerate() {
                let path = vec![
                    ConfigSyncValidationPath::Key("programIds"),
                    ConfigSyncValidationPath::Index(index),
                ];
                let Some(value) = value.as_str() else {
                    issues.push(ConfigSyncValidationIssue::InvalidType {
                        expected: "string",
                        code: "invalid_type",
                        path,
                        message: format!(
                            "Invalid input: expected string, received {}",
                            zod_received_type(value)
                        ),
                    });
                    valid = false;
                    continue;
                };
                let value = trim_js_whitespace(value);
                if value.is_empty() {
                    issues.push(ConfigSyncValidationIssue::TooSmall {
                        origin: "string",
                        code: "too_small",
                        minimum: 1,
                        inclusive: true,
                        path,
                        message: "Too small: expected string to have >=1 characters".to_string(),
                    });
                    valid = false;
                } else if utf16_len(value) > 120 {
                    issues.push(ConfigSyncValidationIssue::TooBig {
                        origin: "string",
                        code: "too_big",
                        maximum: 120,
                        inclusive: true,
                        path,
                        message: "Too big: expected string to have <=120 characters".to_string(),
                    });
                    valid = false;
                } else {
                    parsed.push(value.to_string());
                }
            }
            if values.is_empty() {
                issues.push(ConfigSyncValidationIssue::TooSmall {
                    origin: "array",
                    code: "too_small",
                    minimum: 1,
                    inclusive: true,
                    path: vec![ConfigSyncValidationPath::Key("programIds")],
                    message: "Too small: expected array to have >=1 items".to_string(),
                });
                valid = false;
            } else if values.len() > 20 {
                issues.push(ConfigSyncValidationIssue::TooBig {
                    origin: "array",
                    code: "too_big",
                    maximum: 20,
                    inclusive: true,
                    path: vec![ConfigSyncValidationPath::Key("programIds")],
                    message: "Too big: expected array to have <=20 items".to_string(),
                });
                valid = false;
            }
            if valid {
                let unique = parsed.iter().collect::<std::collections::HashSet<_>>();
                if unique.len() != parsed.len() {
                    issues.push(ConfigSyncValidationIssue::Custom {
                        code: "custom",
                        path: vec![ConfigSyncValidationPath::Key("programIds")],
                        message: "Config sync program ids must be unique.".to_string(),
                    });
                    valid = false;
                }
            }
            valid.then_some(parsed)
        }
        Some(value) => {
            issues.push(ConfigSyncValidationIssue::InvalidType {
                expected: "array",
                code: "invalid_type",
                path: vec![ConfigSyncValidationPath::Key("programIds")],
                message: format!(
                    "Invalid input: expected array, received {}",
                    zod_received_type(value)
                ),
            });
            None
        }
    };
    let workspace_folder = match object.get("workspaceFolder") {
        None => {
            issues.push(ConfigSyncValidationIssue::InvalidType {
                expected: "string",
                code: "invalid_type",
                path: vec![ConfigSyncValidationPath::Key("workspaceFolder")],
                message: "Invalid input: expected string, received undefined".to_string(),
            });
            None
        }
        Some(Value::String(value)) => {
            let value = trim_js_whitespace(value);
            if value.is_empty() {
                issues.push(ConfigSyncValidationIssue::TooSmall {
                    origin: "string",
                    code: "too_small",
                    minimum: 1,
                    inclusive: true,
                    path: vec![ConfigSyncValidationPath::Key("workspaceFolder")],
                    message: "Too small: expected string to have >=1 characters".to_string(),
                });
                None
            } else if utf16_len(value) > 1000 {
                issues.push(ConfigSyncValidationIssue::TooBig {
                    origin: "string",
                    code: "too_big",
                    maximum: 1000,
                    inclusive: true,
                    path: vec![ConfigSyncValidationPath::Key("workspaceFolder")],
                    message: "Too big: expected string to have <=1000 characters".to_string(),
                });
                None
            } else {
                Some(value.to_string())
            }
        }
        Some(value) => {
            issues.push(ConfigSyncValidationIssue::InvalidType {
                expected: "string",
                code: "invalid_type",
                path: vec![ConfigSyncValidationPath::Key("workspaceFolder")],
                message: format!(
                    "Invalid input: expected string, received {}",
                    zod_received_type(value)
                ),
            });
            None
        }
    };
    let unknown = object
        .keys()
        .filter(|key| !matches!(key.as_str(), "direction" | "programIds" | "workspaceFolder"))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        let unknown_count = unknown.len();
        let listed = unknown
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(ConfigSyncValidationIssue::UnrecognizedKeys {
            code: "unrecognized_keys",
            keys: unknown,
            path: vec![],
            message: format!(
                "Unrecognized key{}: {listed}",
                if unknown_count == 1 { "" } else { "s" }
            ),
        });
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(ConfigSyncRequest {
        direction: direction.expect("validated config sync direction"),
        program_ids: program_ids.expect("validated config sync programs"),
        workspace_folder: workspace_folder.expect("validated config sync workspace folder"),
    })
}

fn config_sync_error(error: ConfigSyncError) -> Response {
    api_error(
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &error.code,
        &error.message,
    )
}

fn app_management_body_error(error: JsonRejection) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "app_management_input_invalid",
        &error.body_text(),
    )
}

fn app_management_error(error: AppManagementRequestError) -> Response {
    let status =
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut payload = json!({
        "code": error.code,
        "message": error.message,
    });
    if let (Some(object), Some(details)) = (payload.as_object_mut(), error.details) {
        object.insert("details".to_string(), details);
    }
    (status, Json(json!({ "error": payload }))).into_response()
}

async fn app_custom_catalog(State(state): State<AppState>) -> Response {
    match state.app_runtime.custom_catalog() {
        Ok((path, catalog)) => Json(ApiEnvelope {
            data: json!({
                "path": path,
                "schemaVersion": catalog.schema_version,
                "items": catalog.items,
            }),
        })
        .into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn save_app_custom_catalog(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(body) => body,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "APP_CATALOG_INVALID",
                &error.body_text(),
            )
        }
    };
    let value = json!({
        "schemaVersion": 1,
        "items": body.get("items").cloned().unwrap_or_else(|| json!([])),
    });
    match state.app_runtime.save_custom_catalog(value) {
        Ok((path, catalog)) => Json(ApiEnvelope {
            data: json!({
                "path": path,
                "schemaVersion": catalog.schema_version,
                "items": catalog.items,
            }),
        })
        .into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_profiles(State(state): State<AppState>, Path(app_id): Path<String>) -> Response {
    match state.app_runtime.list_app_profiles(&app_id) {
        Ok(profiles) => Json(ApiEnvelope { data: profiles }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_profile_create(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return app_profile_body_error(error, "APP_PROFILE_CREATE_FAILED"),
    };
    let name = match normalize_app_text_body(&body, "name", 60) {
        Ok(name) => name,
        Err(issues) => return app_text_validation_error(issues, "APP_PROFILE_CREATE_FAILED"),
    };
    match state.app_runtime.create_app_profile(&app_id, &name) {
        Ok(profile) => Json(ApiEnvelope { data: profile }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_profile_rename(
    State(state): State<AppState>,
    Path((app_id, profile_id)): Path<(String, String)>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return app_profile_body_error(error, "APP_PROFILE_RENAME_FAILED"),
    };
    let name = match normalize_app_text_body(&body, "name", 60) {
        Ok(name) => name,
        Err(issues) => return app_text_validation_error(issues, "APP_PROFILE_RENAME_FAILED"),
    };
    match state
        .app_runtime
        .rename_app_profile(&app_id, &profile_id, &name)
    {
        Ok(profile) => Json(ApiEnvelope { data: profile }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_profile_set_default(
    State(state): State<AppState>,
    Path((app_id, profile_id)): Path<(String, String)>,
) -> Response {
    match state
        .app_runtime
        .set_default_app_profile(&app_id, &profile_id)
    {
        Ok(profile) => Json(ApiEnvelope { data: profile }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_profile_delete(
    State(state): State<AppState>,
    Path((app_id, profile_id)): Path<(String, String)>,
) -> Response {
    match state.app_runtime.remove_app_profile(&app_id, &profile_id) {
        Ok(()) => Json(ApiEnvelope {
            data: json!({ "removed": true }),
        })
        .into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_sessions(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(raw_revision) = query.get("sinceRevision") {
        let since_revision = match raw_revision.parse::<u64>() {
            Ok(value) => value,
            Err(_) => {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "APP_SESSION_DELTA_INVALID",
                    "sinceRevision must be a non-negative integer.",
                )
            }
        };
        let Some(stream_id) = query.get("streamId") else {
            return api_error(
                StatusCode::BAD_REQUEST,
                "APP_SESSION_DELTA_INVALID",
                "streamId is required with sinceRevision.",
            );
        };
        return Json(ApiEnvelope {
            data: state.app_sessions_delta(stream_id, since_revision),
        })
        .into_response();
    }
    Json(ApiEnvelope {
        data: state.app_sessions_state(),
    })
    .into_response()
}

async fn app_sessions_state(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: serde_json::to_value(state.app_sessions_state()).unwrap_or(Value::Null),
    })
}

async fn app_session_start(
    State(state): State<AppState>,
    payload: Result<Option<Json<Value>>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Some(Json(body))) => body,
        Ok(None) => Value::Null,
        Err(error) => return app_launch_body_error(error),
    };
    let request = match parse_app_launch_request(&body) {
        Ok(request) => request,
        Err(issues) => return app_launch_validation_error(issues),
    };
    let app_id = request.app_id.as_deref().unwrap_or("terminal-tty");
    match state.app_runtime.start(app_id, request.options).await {
        Ok(session) => Json(ApiEnvelope { data: session }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_detail(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.app_runtime.get_session(&id) {
        Some(session) => Json(ApiEnvelope { data: session }).into_response(),
        None => api_error(
            StatusCode::NOT_FOUND,
            "APP_SESSION_NOT_FOUND",
            "App session not found.",
        ),
    }
}

async fn app_session_rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "APP_SESSION_UPDATE_INVALID",
                &error.body_text(),
            )
        }
    };
    let title = match normalize_app_text_body(&body, "title", 120) {
        Ok(title) => title,
        Err(issues) => return app_text_validation_error(issues, "APP_SESSION_UPDATE_INVALID"),
    };
    let linked = state
        .ai_sessions
        .list()
        .into_iter()
        .filter(|session| session.app_session_id.as_deref() == Some(id.as_str()))
        .collect::<Vec<_>>();
    if linked.len() > 1 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_RENAME_BINDING_CONFLICT",
            "App session is associated with multiple AI sessions.",
        );
    }
    let Some(linked) = linked.into_iter().next() else {
        return match state.app_runtime.rename(&id, &title) {
            Ok(session) => app_session_record_response(session),
            Err(error) => app_runtime_error(error),
        };
    };
    if linked.agent == "codex" {
        return match state.app_runtime.rename(&id, &title) {
            Ok(session) => app_session_record_response(session),
            Err(error) => app_runtime_error(error),
        };
    }
    if linked.creation_source == "app-session" {
        if let Err(error) = state.app_runtime.rename(&id, &title) {
            return app_runtime_error(error);
        }
        match state
            .ai_sessions
            .rename_with_disposition(&linked.id, &title, None)
        {
            Ok((_session, changed)) => {
                if changed {
                    state.publish_ai_session_snapshot("control-action");
                }
            }
            Err(error) => {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "AI_SESSION_RENAME_FAILED",
                    &error.to_string(),
                );
            }
        }
    } else {
        if let Err(error) = state.ai_session_controller.rename(&linked.id, &title).await {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_RENAME_FAILED",
                &error.message,
            );
        }
        if let Err(error) = state.app_runtime.rename(&id, &title) {
            return app_runtime_error(error);
        }
        state.publish_ai_session_snapshot("control-action");
    }
    match state.app_runtime.get_session(&id) {
        Some(session) => app_session_record_response(session),
        None => api_error(
            StatusCode::NOT_FOUND,
            "APP_SESSION_NOT_FOUND",
            "App session not found.",
        ),
    }
}

async fn app_session_stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let closed = match state.close_ai_session_for_app_session(&id).await {
        Ok(closed) => closed.is_some(),
        Err(error) => {
            return api_error(
                StatusCode::NOT_FOUND,
                "APP_SESSION_NOT_FOUND",
                &error.message,
            )
        }
    };
    if closed {
        state.publish_ai_session_snapshot("control-action");
    }
    let session = if closed {
        state.app_runtime.get_session(&id)
    } else {
        state.app_runtime.stop_session(&id).await
    };
    match session {
        Some(session) => app_session_record_response(session),
        None => api_error(
            StatusCode::NOT_FOUND,
            "APP_SESSION_NOT_FOUND",
            "App session not found.",
        ),
    }
}

fn app_session_record_response(session: controlled_instance_protocol::AppSession) -> Response {
    let mut data = serde_json::to_value(session).unwrap_or(Value::Null);
    if let Some(object) = data.as_object_mut() {
        object
            .entry("bindings".to_string())
            .or_insert_with(|| json!([]));
    }
    Json(ApiEnvelope { data }).into_response()
}

async fn app_session_restart(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.app_runtime.restart(&id).await {
        Ok(session) => Json(ApiEnvelope { data: session }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_display(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<AppDisplayOptions>, JsonRejection>,
) -> Response {
    let Json(display) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "APP_DISPLAY_INVALID",
                &error.body_text(),
            )
        }
    };
    match state.app_runtime.resize_display(&id, display).await {
        Ok(session) => Json(ApiEnvelope { data: session }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_screenshot(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    app_session_png(&state, &id).await
}

async fn app_session_snapshot(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    app_session_png(&state, &id).await
}

async fn app_session_png(state: &AppState, id: &str) -> Response {
    match state.app_runtime.screenshot(id).await {
        Ok(image) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(image))
            .unwrap_or_else(|_| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "APP_SCREENSHOT_FAILED",
                    "Screenshot response failed.",
                )
            }),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_automation(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.app_runtime.automation_status(&id).await {
        Ok(status) => Json(ApiEnvelope { data: status }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.app_runtime.delete(&id).await {
        Ok(session) => Json(ApiEnvelope { data: session }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let max_bytes = query
        .get("maxBytes")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(64 * 1024)
        .clamp(1024, 512 * 1024);
    match state.app_runtime.read_logs(&id, max_bytes) {
        Ok(logs) => Json(ApiEnvelope { data: logs }).into_response(),
        Err(error) => app_runtime_error(error),
    }
}

async fn app_session_novnc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Some(session) = state.app_runtime.get_session(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "VNC_SESSION_NOT_FOUND",
            "VNC session not found.",
        );
    };
    let Some(vnc) = session.vnc else {
        return api_error(
            StatusCode::NOT_FOUND,
            "VNC_SESSION_NOT_FOUND",
            "VNC session not found.",
        );
    };
    let resize = if query.get("resize").is_some_and(|value| value == "remote") {
        "remote"
    } else {
        "scale"
    };
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", vnc.web_path.trim_start_matches('/'))
        .append_pair("autoconnect", "1")
        .append_pair("resize", resize)
        .finish();
    (
        StatusCode::FOUND,
        [(header::LOCATION, format!("/api/novnc/vnc.html?{params}"))],
    )
        .into_response()
}

async fn app_session_tty(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(attachment) = state.app_runtime.tty_attachment(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "TTY_SESSION_NOT_FOUND",
            "TTY session not found.",
        );
    };
    ws.on_upgrade(move |socket| app_session_tty_socket(socket, attachment))
        .into_response()
}

async fn app_session_vnc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(target) = state.app_runtime.vnc_target(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "VNC_SESSION_NOT_FOUND",
            "VNC session not found.",
        );
    };
    ws.on_upgrade(move |socket| app_session_vnc_socket(socket, target.0, target.1))
        .into_response()
}

async fn app_session_vnc_socket(mut socket: WebSocket, host: String, port: u16) {
    let Ok(stream) = TcpStream::connect((host.as_str(), port)).await else {
        let _ = socket
            .send(Message::Text(
                json!({
                    "error": {
                        "code": "VNC_CONNECT_FAILED",
                        "message": "VNC upstream connection failed.",
                    }
                })
                .to_string()
                .into(),
            ))
            .await;
        let _ = socket.close().await;
        return;
    };
    let (mut upstream_reader, mut upstream_writer) = stream.into_split();
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            read = upstream_reader.read(&mut buffer) => match read {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if socket.send(Message::Binary(buffer[..size].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            },
            message = socket.recv() => match message {
                Some(Ok(Message::Binary(data))) => {
                    if upstream_writer.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(data))) => {
                    if upstream_writer.write_all(data.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Ping(data))) => {
                    let _ = socket.send(Message::Pong(data)).await;
                }
                _ => {}
            }
        }
    }
    let _ = socket.close().await;
}

async fn app_session_tty_socket(
    mut socket: WebSocket,
    attachment: controlled_instance_app_runtime::TtyAttachment,
) {
    let dimensions = attachment.dimensions;
    let snapshot = attachment.snapshot().map(|snapshot| {
        let mut value = serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}));
        if let Some(object) = value.as_object_mut() {
            object.insert("type".to_string(), json!("snapshot"));
        }
        value
    });
    let connected = json!({
        "type": "connected",
        "protocolVersion": TTY_STREAM_PROTOCOL_VERSION,
        "session": attachment.session,
        "dimensions": {
            "cols": dimensions.0,
            "rows": dimensions.1,
        },
    });
    if socket
        .send(Message::Text(connected.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    if let Some(snapshot) = snapshot {
        if socket
            .send(Message::Text(snapshot.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
    let mut events = attachment.events.resubscribe();
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    let Ok(encoded) = serde_json::to_string(&event) else { continue };
                    if socket.send(Message::Text(encoded.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            message = socket.recv() => {
                let Some(message) = message else { break };
                match message {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            match value.get("type").and_then(Value::as_str) {
                                Some("input") => {
                                    if let Some(data) = value.get("data").and_then(Value::as_str) {
                                        let _ = attachment.write(data.as_bytes());
                                    }
                                }
                                Some("resize") => {
                                    if let (Some(cols), Some(rows)) = (
                                        value.get("cols").and_then(Value::as_u64),
                                        value.get("rows").and_then(Value::as_u64),
                                    ) {
                                        let _ = attachment.resize(cols as u16, rows as u16);
                                    }
                                }
                                _ => {}
                            }
                        } else {
                            let _ = attachment.write(text.as_bytes());
                        }
                    }
                    Ok(Message::Binary(bytes)) => {
                        let _ = attachment.write(&bytes);
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        }
    }
}

async fn app_session_web_proxy(
    State(state): State<AppState>,
    Path((id, rest)): Path<(String, String)>,
    request: Request,
) -> Response {
    app_session_web_proxy_with_rest(state, id, rest, request).await
}

async fn app_session_web_root(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    app_session_web_proxy_with_rest(state, id, String::new(), request).await
}

async fn app_session_web_proxy_with_rest(
    state: AppState,
    id: String,
    rest: String,
    request: Request,
) -> Response {
    if request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return app_session_web_websocket(state, id, rest, request).await;
    }
    let Some((host, port)) = state.app_runtime.web_target(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "WEB_SESSION_NOT_FOUND",
            "Web session not found.",
        );
    };
    let kasm_vnc = state
        .app_runtime
        .get_session(&id)
        .and_then(|session| session.vnc)
        .and_then(|vnc| vnc.backend)
        .as_deref()
        == Some("kasmvnc");
    let method = request.method().clone();
    let query = request.uri().query().unwrap_or_default().to_string();
    let headers = request.headers().clone();
    let body = match to_bytes(request.into_body(), 64 * 1024 * 1024).await {
        Ok(body) => body,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "WEB_PROXY_FAILED",
                &error.to_string(),
            )
        }
    };
    let target_path = if rest.is_empty() {
        "/".to_string()
    } else {
        format!("/{rest}")
    };
    let mut upstream = reqwest::Client::new().request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        format!(
            "http://{host}:{port}{target_path}{}",
            if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            }
        ),
    );
    for (name, value) in &headers {
        if is_hop_by_hop(name.as_str())
            || name == header::HOST
            || name == header::CONTENT_LENGTH
            || (kasm_vnc && name == header::AUTHORIZATION)
        {
            continue;
        }
        if let Ok(value) = value.to_str() {
            upstream = upstream.header(name.as_str(), value);
        }
    }
    if kasm_vnc {
        upstream = upstream.header(header::AUTHORIZATION, kasm_vnc_authorization_header());
    }
    if !body.is_empty() {
        upstream = upstream.body(body);
    }
    match upstream.send().await {
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut outgoing = Response::builder().status(status);
            for (name, value) in response.headers() {
                if is_hop_by_hop(name.as_str()) {
                    continue;
                }
                outgoing = outgoing.header(name.as_str(), value.as_bytes());
            }
            let bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    return api_error(
                        StatusCode::BAD_GATEWAY,
                        "WEB_PROXY_FAILED",
                        &error.to_string(),
                    )
                }
            };
            outgoing.body(Body::from(bytes)).unwrap_or_else(|_| {
                api_error(
                    StatusCode::BAD_GATEWAY,
                    "WEB_PROXY_FAILED",
                    "Proxy response failed.",
                )
            })
        }
        Err(error) => api_error(
            StatusCode::BAD_GATEWAY,
            "WEB_PROXY_FAILED",
            &error.to_string(),
        ),
    }
}

async fn app_session_web_websocket(
    state: AppState,
    id: String,
    rest: String,
    request: Request,
) -> Response {
    let Some((host, port)) = state.app_runtime.web_target(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "WEB_SESSION_NOT_FOUND",
            "Web session not found.",
        );
    };
    let kasm_vnc = state
        .app_runtime
        .get_session(&id)
        .and_then(|session| session.vnc)
        .and_then(|vnc| vnc.backend)
        .as_deref()
        == Some("kasmvnc");
    let query = request.uri().query().unwrap_or_default().to_string();
    let (mut parts, _body) = request.into_parts();
    let forwarded_headers = parts.headers.clone();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(upgrade) => upgrade,
        Err(error) => return error.into_response(),
    };
    let path = format!(
        "/{rest}{}",
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    );
    let url = format!("ws://{host}:{port}{path}");
    let upgrade = if kasm_vnc {
        upgrade.protocols(["binary"])
    } else {
        upgrade
    };
    let authorization = kasm_vnc.then(kasm_vnc_authorization_header);
    upgrade
        .on_upgrade(move |socket| {
            bridge_app_websocket(socket, url, forwarded_headers, authorization)
        })
        .into_response()
}

async fn bridge_app_websocket(
    mut client: WebSocket,
    url: String,
    headers: HeaderMap,
    authorization: Option<String>,
) {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as UpstreamMessage};
    let mut request = match url.into_client_request() {
        Ok(request) => request,
        Err(_) => return,
    };
    for (name, value) in &headers {
        if is_hop_by_hop(name.as_str())
            || name == header::SEC_WEBSOCKET_KEY
            || name == header::SEC_WEBSOCKET_VERSION
            || name == header::HOST
        {
            continue;
        }
        request.headers_mut().insert(name.clone(), value.clone());
    }
    if let Some(authorization) = authorization {
        if let Ok(value) = authorization.parse() {
            request.headers_mut().insert(header::AUTHORIZATION, value);
        }
        if !request
            .headers()
            .contains_key(header::SEC_WEBSOCKET_PROTOCOL)
        {
            if let Ok(value) = "binary".parse() {
                request
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, value);
            }
        }
    }
    let Ok((mut upstream, _response)) = tokio_tungstenite::connect_async(request).await else {
        let _ = client
            .send(Message::Text(
                json!({"error": {"code": "WEB_PROXY_FAILED", "message": "WebSocket proxy failed."}})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    };
    loop {
        tokio::select! {
            message = client.recv() => {
                let Some(message) = message else { break };
                let message = match message {
                    Ok(Message::Text(text)) => UpstreamMessage::Text(text.to_string().into()),
                    Ok(Message::Binary(bytes)) => UpstreamMessage::Binary(bytes),
                    Ok(Message::Ping(bytes)) => UpstreamMessage::Ping(bytes),
                    Ok(Message::Pong(bytes)) => UpstreamMessage::Pong(bytes),
                    Ok(Message::Close(frame)) => UpstreamMessage::Close(frame.map(|frame| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: frame.code.into(),
                        reason: frame.reason.to_string().into(),
                    })),
                    Err(_) => break,
                };
                if upstream.send(message).await.is_err() {
                    break;
                }
            }
            message = upstream.next() => {
                let Some(message) = message else { break };
                let message = match message {
                    Ok(UpstreamMessage::Text(text)) => Message::Text(text.to_string().into()),
                    Ok(UpstreamMessage::Binary(bytes)) => Message::Binary(bytes),
                    Ok(UpstreamMessage::Ping(bytes)) => Message::Ping(bytes),
                    Ok(UpstreamMessage::Pong(bytes)) => Message::Pong(bytes),
                    Ok(UpstreamMessage::Close(_)) | Err(_) => break,
                    Ok(UpstreamMessage::Frame(_)) => continue,
                };
                if client.send(message).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = client.close().await;
    let _ = upstream.close(None).await;
}

fn kasm_vnc_authorization_header() -> String {
    let username = std::env::var("TASK_HANDOFF_KASMVNC_USERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "agent".to_string());
    let password = std::env::var("TASK_HANDOFF_KASMVNC_PASSWORD")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "taskhandoff".to_string());
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
    )
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn app_launch_body_error(error: JsonRejection) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "APP_LAUNCH_INVALID",
        &error.body_text(),
    )
}

fn app_launch_validation_error(issues: Vec<String>) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "APP_LAUNCH_INVALID",
        &issues.join("; "),
    )
}

fn parse_app_launch_request(body: &Value) -> Result<AppLaunchRequest, Vec<String>> {
    if body.is_null() {
        return Ok(AppLaunchRequest {
            app_id: None,
            options: controlled_instance_protocol::AppLaunchOptions::default(),
        });
    }
    let Some(object) = body.as_object() else {
        return Err(vec![format!(
            "body: Invalid input: expected object, received {}",
            zod_received_type(body)
        )]);
    };
    let mut issues = Vec::new();
    let app_id = app_launch_optional_string(
        object.get("appId"),
        "appId",
        true,
        1,
        80,
        Some(AppLaunchStringPattern::AppId),
        &mut issues,
    );
    let title = app_launch_optional_string(
        object.get("title"),
        "title",
        true,
        1,
        120,
        None,
        &mut issues,
    );
    let cwd = app_launch_optional_string(object.get("cwd"), "cwd", true, 1, 512, None, &mut issues);
    let profile_id = app_launch_optional_string(
        object.get("profileId"),
        "profileId",
        true,
        1,
        120,
        None,
        &mut issues,
    );
    let mut args = Vec::new();
    match object.get("args") {
        None => {}
        Some(Value::Array(values)) => {
            if values.len() > 64 {
                issues.push("args: Too big: expected array to have <=64 items".to_string());
            }
            for (index, value) in values.iter().enumerate() {
                match value.as_str() {
                    Some(value) if utf16_len(value) <= 4096 => args.push(value.to_string()),
                    Some(_) => issues.push(format!(
                        "args.{index}: Too big: expected string to have <=4096 characters"
                    )),
                    None => issues.push(format!(
                        "args.{index}: Invalid input: expected string, received {}",
                        zod_received_type(value)
                    )),
                }
            }
        }
        Some(value) => issues.push(format!(
            "args: Invalid input: expected array, received {}",
            zod_received_type(value)
        )),
    }
    let mut env = std::collections::BTreeMap::new();
    match object.get("env") {
        None => {}
        Some(Value::Object(values)) => {
            for (key, value) in values {
                if !valid_app_env_key(key) {
                    issues.push(format!(
                        "env.{key}: Invalid string: must match pattern /^[A-Za-z_][A-Za-z0-9_]*$/"
                    ));
                }
                let Some(value) = value.as_str() else {
                    issues.push(format!(
                        "env.{key}: Invalid input: expected string, received {}",
                        zod_received_type(value)
                    ));
                    continue;
                };
                if utf16_len(value) > 4096 {
                    issues.push(format!(
                        "env.{key}: Too big: expected string to have <=4096 characters"
                    ));
                } else {
                    env.insert(key.clone(), value.to_string());
                }
            }
        }
        Some(value) => issues.push(format!(
            "env: Invalid input: expected record, received {}",
            zod_received_type(value)
        )),
    }
    let display = app_launch_display(object.get("display"), &mut issues);
    let display_target = app_launch_display_target(object.get("displayTarget"), &mut issues);
    let unknown = object
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "appId"
                    | "title"
                    | "args"
                    | "cwd"
                    | "env"
                    | "display"
                    | "displayTarget"
                    | "profileId"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        let listed = unknown
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(format!(
            "body: Unrecognized key{}: {listed}",
            if unknown.len() == 1 { "" } else { "s" }
        ));
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(AppLaunchRequest {
        app_id,
        options: controlled_instance_protocol::AppLaunchOptions {
            title,
            args,
            cwd,
            env,
            profile_id,
            display,
            display_target,
            ai_session_resume: None,
        },
    })
}

#[derive(Clone, Copy)]
enum AppLaunchStringPattern {
    AppId,
    DisplayId,
}

fn app_launch_optional_string(
    value: Option<&Value>,
    path: &str,
    trim: bool,
    minimum: usize,
    maximum: usize,
    pattern: Option<AppLaunchStringPattern>,
    issues: &mut Vec<String>,
) -> Option<String> {
    let value = value?;
    let Some(value) = value.as_str() else {
        issues.push(format!(
            "{path}: Invalid input: expected string, received {}",
            zod_received_type(value)
        ));
        return None;
    };
    let value = if trim {
        trim_js_whitespace(value)
    } else {
        value
    };
    let length = utf16_len(value);
    if length < minimum {
        issues.push(format!(
            "{path}: Too small: expected string to have >={minimum} characters"
        ));
        return None;
    }
    if length > maximum {
        issues.push(format!(
            "{path}: Too big: expected string to have <={maximum} characters"
        ));
        return None;
    }
    let valid_pattern = match pattern {
        None => true,
        Some(AppLaunchStringPattern::AppId) => valid_app_launch_id(value),
        Some(AppLaunchStringPattern::DisplayId) => valid_app_display_id(value),
    };
    if !valid_pattern {
        let regex = match pattern {
            Some(AppLaunchStringPattern::AppId) => "^[a-z0-9][a-z0-9_.-]*$",
            Some(AppLaunchStringPattern::DisplayId) => "^[a-z0-9][a-z0-9._-]*$",
            None => "",
        };
        issues.push(format!(
            "{path}: Invalid string: must match pattern /{regex}/"
        ));
        return None;
    }
    Some(value.to_string())
}

fn app_launch_display(
    value: Option<&Value>,
    issues: &mut Vec<String>,
) -> Option<AppDisplayOptions> {
    let value = value?;
    let Some(object) = value.as_object() else {
        issues.push(format!(
            "display: Invalid input: expected object, received {}",
            zod_received_type(value)
        ));
        return None;
    };
    Some(AppDisplayOptions {
        width: app_launch_integer(
            object.get("width"),
            "display.width",
            Some((320, 7680)),
            issues,
        ),
        height: app_launch_integer(
            object.get("height"),
            "display.height",
            Some((240, 4320)),
            issues,
        ),
        depth: app_launch_integer(object.get("depth"), "display.depth", None, issues).filter(
            |depth| {
                if matches!(depth, 16 | 24 | 32) {
                    true
                } else {
                    issues.push(
                        "display.depth: Invalid input: expected 16, 24 or 32, received number"
                            .to_string(),
                    );
                    false
                }
            },
        ),
    })
}

fn app_launch_integer(
    value: Option<&Value>,
    path: &str,
    range: Option<(u32, u32)>,
    issues: &mut Vec<String>,
) -> Option<u32> {
    let value = value?;
    let Some(value) = value.as_u64().and_then(|value| u32::try_from(value).ok()) else {
        issues.push(format!(
            "{path}: Invalid input: expected int, received {}",
            zod_received_type(value)
        ));
        return None;
    };
    if let Some((minimum, maximum)) = range {
        if value < minimum {
            issues.push(format!(
                "{path}: Too small: expected number to be >={minimum}"
            ));
            return None;
        }
        if value > maximum {
            issues.push(format!(
                "{path}: Too big: expected number to be <={maximum}"
            ));
            return None;
        }
    }
    Some(value)
}

fn app_launch_display_target(
    value: Option<&Value>,
    issues: &mut Vec<String>,
) -> Option<controlled_instance_protocol::AppDisplayTarget> {
    let value = value?;
    let Some(object) = value.as_object() else {
        issues.push(format!(
            "displayTarget: Invalid input: expected object, received {}",
            zod_received_type(value)
        ));
        return None;
    };
    let mode = match object.get("mode") {
        Some(Value::String(value)) if value == "isolated" => {
            controlled_instance_protocol::AppDisplayMode::Isolated
        }
        Some(Value::String(value)) if value == "shared" => {
            controlled_instance_protocol::AppDisplayMode::Shared
        }
        Some(value) => {
            issues.push(format!(
                "displayTarget.mode: Invalid option: expected one of \"isolated\"|\"shared\", received {}",
                value.as_str().map(|value| format!("\"{value}\"")).unwrap_or_else(|| zod_received_type(value).to_string())
            ));
            return None;
        }
        None => {
            issues.push(
                "displayTarget.mode: Invalid input: expected \"isolated\"|\"shared\", received undefined"
                    .to_string(),
            );
            return None;
        }
    };
    let id = app_launch_optional_string(
        object.get("id"),
        "displayTarget.id",
        true,
        1,
        80,
        Some(AppLaunchStringPattern::DisplayId),
        issues,
    );
    let auto_create = match object.get("autoCreate") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(value) => {
            issues.push(format!(
                "displayTarget.autoCreate: Invalid input: expected boolean, received {}",
                zod_received_type(value)
            ));
            None
        }
    };
    Some(controlled_instance_protocol::AppDisplayTarget {
        mode,
        id,
        auto_create,
    })
}

fn valid_app_launch_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(
        characters.next(),
        Some(character) if character.is_ascii_lowercase() || character.is_ascii_digit()
    ) && characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '.' | '-')
    })
}

fn valid_app_display_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(
        characters.next(),
        Some(character) if character.is_ascii_lowercase() || character.is_ascii_digit()
    ) && characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '.' | '-')
    })
}

fn valid_app_env_key(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(
        characters.next(),
        Some(character) if character.is_ascii_alphabetic() || character == '_'
    ) && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn app_profile_body_error(error: JsonRejection, code: &str) -> Response {
    api_error(StatusCode::BAD_REQUEST, code, &error.body_text())
}

fn normalize_app_text_body(
    body: &Value,
    field: &str,
    maximum: usize,
) -> Result<String, Vec<String>> {
    let Some(object) = body.as_object() else {
        return Err(vec![format!(
            "body: Invalid input: expected object, received {}",
            zod_received_type(body)
        )]);
    };
    let mut issues = Vec::new();
    let value = match object.get(field) {
        Some(Value::String(value)) => {
            let value = trim_js_whitespace(value);
            let length = value.chars().count();
            if length < 1 {
                issues.push(format!(
                    "{field}: Too small: expected string to have >=1 characters"
                ));
            } else if length > maximum {
                issues.push(format!(
                    "{field}: Too big: expected string to have <={maximum} characters"
                ));
            }
            value.to_string()
        }
        Some(value) => {
            issues.push(format!(
                "{field}: Invalid input: expected string, received {}",
                zod_received_type(value)
            ));
            String::new()
        }
        None => {
            issues.push(format!(
                "{field}: Invalid input: expected string, received undefined"
            ));
            String::new()
        }
    };
    let extra_keys = object
        .keys()
        .filter(|key| key.as_str() != field)
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>();
    if !extra_keys.is_empty() {
        issues.push(format!(
            "body: Unrecognized key{}: {}",
            if extra_keys.len() == 1 { "" } else { "s" },
            extra_keys.join(", ")
        ));
    }
    if issues.is_empty() {
        Ok(value)
    } else {
        Err(issues)
    }
}

fn app_text_validation_error(issues: Vec<String>, code: &str) -> Response {
    api_error(StatusCode::BAD_REQUEST, code, &issues.join("; "))
}

fn app_runtime_error(error: controlled_instance_app_runtime::AppRuntimeError) -> Response {
    let status = match error.code() {
        "APP_NOT_FOUND"
        | "APP_SESSION_NOT_FOUND"
        | "APP_DISPLAY_NOT_FOUND"
        | "BROWSER_PROFILE_NOT_FOUND"
        | "BROWSER_PROFILE_UNSUPPORTED" => StatusCode::NOT_FOUND,
        "BROWSER_PROFILE_BUSY"
        | "BROWSER_PROFILE_NAME_CONFLICT"
        | "BROWSER_PROFILE_DEFAULT_PROTECTED" => StatusCode::CONFLICT,
        "APP_SCREENSHOT_UNAVAILABLE" | "APP_AUTOMATION_UNAVAILABLE" => StatusCode::CONFLICT,
        _ => StatusCode::BAD_REQUEST,
    };
    api_error(status, error.code(), &error.to_string())
}

async fn ai_sessions(
    State(state): State<AppState>,
    Query(query): Query<AiSessionsQuery>,
) -> Response {
    let subagents = query.hierarchy.as_deref() == Some("subagents");
    let since_revision = query
        .since_revision
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(since_revision) = since_revision {
        let Some(stream_id) = query.stream_id.as_deref() else {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_DELTA_INVALID",
                "streamId is required with sinceRevision.",
            );
        };
        let mut delta = state.ai_sessions_delta(stream_id, since_revision);
        project_ai_session_delta_for_consumer(&mut delta, subagents);
        return Json(ApiEnvelope { data: delta }).into_response();
    }
    let mut state = state.ai_sessions_state();
    state.snapshot = project_ai_sessions_snapshot_for_consumer(state.snapshot, subagents);
    Json(ApiEnvelope {
        data: serde_json::to_value(state).unwrap_or_else(|_| json!({})),
    })
    .into_response()
}

async fn ai_sessions_state(
    State(state): State<AppState>,
    Query(query): Query<AiSessionsStateQuery>,
) -> Json<ApiEnvelope<Value>> {
    let mut ai_state = state.ai_sessions_state();
    ai_state.snapshot = project_ai_sessions_snapshot_for_consumer(
        ai_state.snapshot,
        query.hierarchy.as_deref() == Some("subagents"),
    );
    Json(ApiEnvelope {
        data: serde_json::to_value(ai_state).unwrap_or_else(|_| json!({})),
    })
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSessionHistoryQuery {
    agents: Option<String>,
    hierarchy: Option<String>,
}

async fn ai_session_history(
    State(state): State<AppState>,
    Query(query): Query<AiSessionHistoryQuery>,
) -> Json<ApiEnvelope<controlled_instance_protocol::AiSessionHistoryList>> {
    let requested = query
        .agents
        .as_deref()
        .map(|agents| {
            agents
                .split(',')
                .map(str::trim)
                .filter(|agent| !agent.is_empty())
                .map(ToString::to_string)
                .collect::<std::collections::HashSet<_>>()
        })
        .filter(|agents| !agents.is_empty())
        .unwrap_or_else(|| {
            std::collections::HashSet::from(["codex".to_string(), "claude".to_string()])
        });
    let member_ids = state
        .agent_run_bindings
        .list()
        .into_iter()
        .map(|binding| binding.ai_session_id)
        .collect::<std::collections::HashSet<_>>();
    let subagents = query.hierarchy.as_deref() == Some("subagents");
    Json(ApiEnvelope {
        data: controlled_instance_protocol::AiSessionHistoryList {
            items: state
                .ai_session_history
                .list(Some(&requested))
                .into_iter()
                .filter(|item| !member_ids.contains(&item.id))
                .map(|item| project_ai_session_history_item_for_consumer(item, subagents))
                .collect(),
        },
    })
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSessionHistoryDetailQuery {
    hierarchy: Option<String>,
}

async fn ai_session_history_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<AiSessionHistoryDetailQuery>,
) -> Response {
    match state.ai_session_history.detail(&id) {
        Some(mut detail) => {
            detail.item = project_ai_session_history_item_for_consumer(
                detail.item,
                query.hierarchy.as_deref() == Some("subagents"),
            );
            Json(ApiEnvelope { data: detail }).into_response()
        }
        None => api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_HISTORY_NOT_FOUND",
            "AI session history entry not found.",
        ),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionDetailQuery {
    revision: Option<String>,
}

async fn ai_session_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<AiSessionDetailQuery>,
) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_NOT_FOUND",
            "AI session not found.",
        );
    };
    let revision = session.detail_revision();
    if query.revision.as_deref() == Some(revision.as_str()) {
        return Json(ApiEnvelope {
            data: json!({ "kind": "not-modified", "revision": revision }),
        })
        .into_response();
    }
    let mut detail = session.detail();
    if let Some(object) = detail.as_object_mut() {
        object.insert("id".to_string(), json!(session.id));
    }
    Json(ApiEnvelope {
        data: json!({ "kind": "updated", "revision": revision, "detail": detail }),
    })
    .into_response()
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameAiSessionRequest {
    title: String,
    expected_title: Option<String>,
    client_request_id: String,
}

async fn rename_ai_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return ai_session_body_error(error);
        }
    };
    let body = match normalize_ai_session_rename_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<RenameAiSessionRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    if request.client_request_id.trim().is_empty()
        || request.client_request_id.chars().count() > 160
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "clientRequestId must be between 1 and 160 characters.",
        );
    }
    match state.ai_sessions.rename_with_disposition(
        &id,
        &request.title,
        request.expected_title.as_deref(),
    ) {
        Ok((session, changed)) => {
            if changed {
                state.publish_ai_session_snapshot("control-action");
            }
            Json(ApiEnvelope {
                data: json!({
                    "disposition": if changed { "renamed" } else { "already-named" },
                    "aiSessionId": session.id,
                    "appSessionId": session.app_session_id,
                    "title": session.title.unwrap_or_default(),
                }),
            })
            .into_response()
        }
        Err(controlled_instance_ai_session::AiSessionStoreError::NotFound) => {
            ai_session_not_found()
        }
        Err(controlled_instance_ai_session::AiSessionStoreError::TitleConflict) => api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_RENAME_CONFLICT",
            "The session title changed before the rename was applied.",
        ),
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AI_SESSION_PERSISTENCE_FAILED",
            &error.to_string(),
        ),
    }
}

async fn read_ai_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let was_unread = state
        .ai_sessions
        .get(&id)
        .is_some_and(|session| session.unread);
    match state.ai_sessions.mark_read(&id) {
        Ok(session) => {
            if was_unread {
                state.publish_ai_session_snapshot("control-action");
            }
            Json(ApiEnvelope {
                data: json!({ "sessionId": session.id, "unread": session.unread }),
            })
            .into_response()
        }
        Err(controlled_instance_ai_session::AiSessionStoreError::NotFound) => {
            ai_session_not_found()
        }
        Err(error) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AI_SESSION_PERSISTENCE_FAILED",
            &error.to_string(),
        ),
    }
}

async fn delete_ai_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.clear_ai_session_subtree(&id).await {
        Ok(cleared) => {
            if cleared.is_empty() {
                Json(ApiEnvelope {
                    data: json!({
                        "disposition": "already-cleared",
                        "aiSessionId": id,
                        "clearedSessionIds": [],
                    }),
                })
                .into_response()
            } else {
                state.publish_ai_session_snapshot("control-action");
                Json(ApiEnvelope {
                    data: json!({
                        "disposition": "cleared",
                        "aiSessionId": id,
                        "clearedSessionIds": cleared,
                    }),
                })
                .into_response()
            }
        }
        Err(error) => ai_session_provider_error(error),
    }
}

fn ai_session_not_found() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "AI_SESSION_NOT_FOUND",
        "AI Session was not found.",
    )
}

fn ai_session_provider_error(error: controlled_instance_ai_session::ProviderError) -> Response {
    let status =
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    api_error(status, &error.code, &error.message)
}

fn ai_session_launch_error(error: controlled_instance_ai_session::ProviderError) -> Response {
    let valid_code = error.code.starts_with("AI_SESSION_");
    let code = if valid_code {
        error.code
    } else {
        "AI_SESSION_CONTROL_FAILED".to_string()
    };
    let message = if valid_code {
        error.message
    } else {
        "AI session could not be started.".to_string()
    };
    let status = if valid_code {
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::BAD_REQUEST)
    } else {
        StatusCode::BAD_REQUEST
    };
    let retryable = valid_code
        && matches!(
            code.as_str(),
            "AI_SESSION_CONTROL_NOT_CONNECTED" | "AI_SESSION_MATERIALIZATION_FAILED"
        );
    (
        status,
        Json(json!({
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
            }
        })),
    )
        .into_response()
}

fn story_tool_error(error: crate::story_tools::StoryToolError) -> Response {
    api_error(
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::BAD_REQUEST),
        &error.code,
        &error.message,
    )
}

async fn invoke_agent_tool(
    State(state): State<AppState>,
    payload: Result<Json<AgentToolInvocationInput>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "STORY_TOOL_FAILED",
                &error.body_text(),
            )
        }
    };
    if let Err(error) = input.validate() {
        return story_tool_error(error);
    }
    let call_id = input.call_id().map(ToString::to_string);
    match invoke_for_provider_session(
        &state.story_tools,
        &state.agent_run_bindings,
        &state.ai_sessions,
        StoryToolInvocation {
            provider: &input.provider,
            provider_session_id: &input.provider_session_id,
            tool: input.tool,
            arguments: input.arguments,
            call_id: call_id.as_deref(),
        },
    )
    .await
    {
        Ok(data) => Json(ApiEnvelope { data }).into_response(),
        Err(error) => story_tool_error(error),
    }
}

async fn agent_tool_mcp_get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, DELETE")],
        Json(json!({
            "error": {
                "code": "METHOD_NOT_ALLOWED",
                "message": "The Story MCP bridge is stateless and only accepts POST requests."
            }
        })),
    )
        .into_response()
}

async fn agent_tool_mcp_delete() -> StatusCode {
    StatusCode::OK
}

async fn agent_tool_mcp_post(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(mcp_error(Value::Null, -32700, &error.body_text())),
            )
                .into_response()
        }
    };
    match input {
        Value::Array(requests) => {
            let mut responses = Vec::new();
            for request in requests {
                if let Some(response) = process_mcp_request(&state, request).await {
                    responses.push(response);
                }
            }
            if responses.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(responses)).into_response()
            }
        }
        request @ Value::Object(_) => match process_mcp_request(&state, request).await {
            Some(response) => Json(response).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
        _ => (
            StatusCode::BAD_REQUEST,
            Json(mcp_error(Value::Null, -32600, "Invalid JSON-RPC request.")),
        )
            .into_response(),
    }
}

async fn process_mcp_request(state: &AppState, request: Value) -> Option<Value> {
    let Some(object) = request.as_object() else {
        return Some(mcp_error(Value::Null, -32600, "Invalid JSON-RPC request."));
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(mcp_error(
            object.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "Invalid JSON-RPC request.",
        ));
    }
    let id = object.get("id").cloned();
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return id.map(|id| mcp_error(id, -32600, "Missing JSON-RPC method."));
    };
    let params = object.get("params");
    let response_id = id.clone().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Some(json!({
            "protocolVersion": params
                .and_then(Value::as_object)
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18"),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "task-handoff-story", "version": "1.0.0"}
        })),
        "ping" => Some(json!({})),
        "notifications/initialized" | "notifications/cancelled" => {
            return id.map(|id| mcp_error(id, -32601, "Notification ids are not supported."));
        }
        "tools/list" => Some(json!({"tools": tool_definitions()})),
        "tools/call" => match call_mcp_tool(state, params).await {
            Ok(result) => Some(result),
            Err((code, message)) => {
                return Some(mcp_error(response_id, code, &message));
            }
        },
        _ => {
            return Some(mcp_error(
                response_id,
                -32601,
                &format!("Method not found: {method}"),
            ))
        }
    };
    id.map(|id| json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn call_mcp_tool(state: &AppState, params: Option<&Value>) -> Result<Value, (i64, String)> {
    let Some(params) = params.and_then(Value::as_object) else {
        return Err((-32602, "Tool call params must be an object.".to_string()));
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err((-32602, "Tool name is required.".to_string()));
    };
    let Ok(tool) = name.parse::<controlled_instance_protocol::AiSessionAgentToolName>() else {
        return Err((-32602, format!("Unknown Story tool: {name}")));
    };
    let meta = params.get("_meta");
    let thread_id = match required_thread_id(meta) {
        Ok(thread_id) => thread_id,
        Err(error) => return Ok(mcp_tool_error(error)),
    };
    let call_id = optional_call_id(meta)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    match invoke_for_provider_session(
        &state.story_tools,
        &state.agent_run_bindings,
        &state.ai_sessions,
        StoryToolInvocation {
            provider: "codex",
            provider_session_id: thread_id,
            tool,
            arguments,
            call_id,
        },
    )
    .await
    {
        Ok(value) => Ok(json!({
            "content": [{"type": "text", "text": value.to_string()}],
            "structuredContent": value
        })),
        Err(error) => Ok(mcp_tool_error(error)),
    }
}

fn mcp_tool_error(error: crate::story_tools::StoryToolError) -> Value {
    json!({
        "content": [{"type": "text", "text": error.message}],
        "isError": true
    })
}

fn mcp_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

async fn invalidate_story_agent_tools(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return story_tool_error(crate::story_tools::StoryToolError::new(
                "STORY_AGENT_TOOL_POLICY_INVALID",
                error.body_text(),
                400,
            ))
        }
    };
    match state.story_tools.invalidate_story_agent_tools(&input) {
        Ok(invalidated) => Json(ApiEnvelope {
            data: json!({"invalidated": invalidated}),
        })
        .into_response(),
        Err(error) => story_tool_error(error),
    }
}

async fn ai_session_story_content(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    match state.story_tools.list(&session, 1, 20).await {
        Ok(documents) => Json(ApiEnvelope {
            data: json!({ "documents": documents }),
        })
        .into_response(),
        Err(error) => story_tool_error(error),
    }
}

async fn get_ai_session_story_content(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<controlled_instance_protocol::StoryContentGetInput>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    match state.story_tools.get(&session, input).await {
        Ok(result) => Json(ApiEnvelope { data: result }).into_response(),
        Err(error) => story_tool_error(error),
    }
}

async fn set_ai_session_story_content(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<controlled_instance_protocol::StoryContentSetInput>, JsonRejection>,
) -> Response {
    let Json(input) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    match state.story_tools.set(&session, input).await {
        Ok(result) => Json(ApiEnvelope { data: result }).into_response(),
        Err(error) => story_tool_error(error),
    }
}

async fn update_ai_session_story(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let story_id = match body.as_object() {
        Some(object) if object.len() == 1 && object.contains_key("storyId") => {
            match object.get("storyId") {
                Some(Value::Null) => None,
                Some(Value::String(story_id)) => {
                    let story_id = story_id.trim();
                    if story_id.is_empty() || story_id.chars().count() > 120 {
                        return api_error(
                            StatusCode::BAD_REQUEST,
                            "AI_SESSION_CONTROL_INVALID",
                            "storyId must be between 1 and 120 characters.",
                        );
                    }
                    Some(story_id.to_string())
                }
                _ => {
                    return api_error(
                        StatusCode::BAD_REQUEST,
                        "AI_SESSION_CONTROL_INVALID",
                        "storyId must be a string or null.",
                    );
                }
            }
        }
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_CONTROL_INVALID",
                "body must contain only storyId.",
            );
        }
    };
    match state.ai_session_controller.update_story(&id, story_id) {
        Ok(updated) => {
            state.publish_ai_session_snapshot("control-action");
            let mut data = json!({ "sessionId": updated.id });
            if let Some(story_id) = updated.story_id {
                data["storyId"] = json!(story_id);
            }
            Json(ApiEnvelope { data }).into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

async fn ai_session_mentions(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.ai_session_controller.mention_catalog(&id).await {
        Ok(catalog) => Json(ApiEnvelope { data: catalog }).into_response(),
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionMentionFileSearchRequest {
    #[serde(default)]
    query: String,
}

async fn search_ai_session_mention_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<AiSessionMentionFileSearchRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let query = request.query.trim();
    if query.chars().count() > 240 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "query must be at most 240 characters.",
        );
    }
    match state
        .ai_session_controller
        .search_mention_files(&id, query)
        .await
    {
        Ok(search) => Json(ApiEnvelope { data: search }).into_response(),
        Err(error) => ai_session_provider_error(error),
    }
}

async fn execute_ai_session_command(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_command_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let mut input =
        match serde_json::from_value::<controlled_instance_protocol::AiSessionCommandInput>(body) {
            Ok(input) => input,
            Err(error) => return ai_session_deserialize_error(error),
        };
    input.argument = input
        .argument
        .map(|argument| argument.trim().to_string())
        .filter(|argument| !argument.is_empty());
    if input
        .argument
        .as_ref()
        .is_some_and(|argument| argument.chars().count() > 4000)
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "argument must be at most 4000 characters.",
        );
    }
    if input.command == controlled_instance_protocol::AiSessionCommandName::Rename
        && input.argument.is_none()
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "Rename requires a thread name.",
        );
    }
    if matches!(
        input.command,
        controlled_instance_protocol::AiSessionCommandName::Review
            | controlled_instance_protocol::AiSessionCommandName::Compact
    ) && input.argument.is_some()
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            &format!("{} does not accept an argument.", input.command.as_str()),
        );
    }
    match state
        .ai_session_controller
        .execute_command(&id, &input)
        .await
    {
        Ok(result) => Json(ApiEnvelope { data: result }).into_response(),
        Err(error) => ai_session_provider_error(error),
    }
}

fn ai_session_body_error(error: JsonRejection) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "AI_SESSION_CONTROL_INVALID",
        &format!("body: {error}"),
    )
}

fn ai_session_validation_error(issues: Vec<String>) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "AI_SESSION_CONTROL_INVALID",
        &issues.join("; "),
    )
}

fn ai_session_deserialize_error(error: serde_json::Error) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "AI_SESSION_CONTROL_INVALID",
        &format!("body: {error}"),
    )
}

fn trim_js_whitespace(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn zod_received_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn validate_client_request_id(client_request_id: Option<&str>) -> Result<(), Box<Response>> {
    let Some(client_request_id) = client_request_id.map(str::trim) else {
        return Err(Box::new(api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "clientRequestId is required.",
        )));
    };
    if client_request_id.is_empty() || client_request_id.chars().count() > 160 {
        return Err(Box::new(api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "clientRequestId must be between 1 and 160 characters.",
        )));
    }
    Ok(())
}

pub fn ai_session_action_response(
    result: &controlled_instance_ai_session::AiSessionActionResult,
) -> Value {
    let latest_turn = result
        .session
        .turns
        .as_deref()
        .and_then(|turns| turns.last());
    let queued_message_id = result.action.queue_id.as_deref().and_then(|queue_id| {
        result
            .session
            .queue
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(queue_id))
            .and_then(|item| item.get("messageId"))
            .and_then(Value::as_str)
    });
    let message_id = queued_message_id.or_else(|| {
        matches!(result.action.action.as_str(), "send" | "queue" | "steer")
            .then(|| {
                latest_turn
                    .and_then(|turn| turn.get("userMessages"))
                    .and_then(Value::as_array)
                    .and_then(|messages| messages.last())
                    .and_then(|message| message.get("id"))
                    .and_then(Value::as_str)
            })
            .flatten()
    });
    let turn_id = result
        .action
        .turn_id
        .as_deref()
        .or(result.session.active_turn_id.as_deref())
        .or_else(|| {
            latest_turn
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
        });
    let provider_turn_id = result.action.provider_turn_id.as_deref().or_else(|| {
        latest_turn
            .and_then(|turn| turn.get("providerTurnId"))
            .and_then(Value::as_str)
    });
    json!({
        "sessionId": result.session.id,
        "provider": result.provider,
        "action": result.action.action,
        "decision": result.action.decision,
        "turnId": turn_id,
        "providerTurnId": provider_turn_id,
        "queueId": result.action.queue_id,
        "messageId": message_id,
    })
}

async fn create_ai_session(
    State(state): State<AppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_create_body(&body) {
        Ok(body) => body,
        Err(issues) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_CONTROL_INVALID",
                &issues.join("; "),
            )
        }
    };
    let request = match serde_json::from_value::<controlled_instance_ai_session::AiSessionCreateInput>(
        body,
    ) {
        Ok(request) => request,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_CONTROL_INVALID",
                &format!("body: {error}"),
            )
        }
    };
    if let Err(response) = validate_client_request_id(request.message.client_request_id.as_deref())
    {
        return *response;
    }
    if request.message.message.trim().is_empty() || request.message.message.chars().count() > 20_000
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "message must be between 1 and 20000 characters.",
        );
    }
    match state.ai_session_controller.create_session(request).await {
        Ok(result) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

async fn send_ai_session_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_message_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request =
        match serde_json::from_value::<controlled_instance_ai_session::AiSessionMessageInput>(body)
        {
            Ok(request) => request,
            Err(error) => return ai_session_deserialize_error(error),
        };
    send_ai_session_message_inner(state, id, Ok(Json(request))).await
}

async fn send_ai_session_message_inner(
    state: AppState,
    id: String,
    payload: Result<Json<controlled_instance_ai_session::AiSessionMessageInput>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    if request.message.trim().is_empty() || request.message.chars().count() > 20_000 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "message must be between 1 and 20000 characters.",
        );
    }
    if request.client_request_id.is_some() {
        if let Err(response) = validate_client_request_id(request.client_request_id.as_deref()) {
            return *response;
        }
    }
    match state
        .ai_session_controller
        .send_message(
            &id,
            controlled_instance_ai_session::ProviderMessageInput::from_wire(&request),
        )
        .await
    {
        Ok(result) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: ai_session_action_response(&result),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

async fn interrupt_ai_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.ai_session_controller.interrupt(&id).await {
        Ok(result) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: ai_session_action_response(&result),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionApprovalRequest {
    decision: String,
}

async fn resolve_ai_session_approval(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<AiSessionApprovalRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    match state
        .ai_session_controller
        .resolve_approval(&id, &request.decision)
        .await
    {
        Ok(result) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: ai_session_action_response(&result),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResumeAiSessionRequest {
    #[serde(default)]
    model_selection: Option<controlled_instance_ai_session::AiSessionModelSelection>,
    #[serde(default)]
    reasoning_effort: Option<String>,
}

async fn resume_ai_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_resume_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<ResumeAiSessionRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    let Some(detail) = state.ai_session_history.detail(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_HISTORY_NOT_FOUND",
            "AI session history entry not found.",
        );
    };
    if detail.item.creation_source != "ai-session" {
        return api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_RESUME_UNAVAILABLE",
            "Only Direct AI Sessions can be resumed by this provider runtime.",
        );
    }
    let (model_selection, model_selection_intent) = match request.model_selection {
        Some(selection) => (
            Some(selection),
            controlled_instance_ai_session::AiSessionModelSelectionIntent::Target,
        ),
        None => (
            detail
                .item
                .model_selection
                .clone()
                .and_then(|value| serde_json::from_value(value).ok()),
            controlled_instance_ai_session::AiSessionModelSelectionIntent::Session,
        ),
    };
    let history_item_id = detail.item.id.clone();
    let history_agent = detail.item.agent.clone();
    let history_provider_session_id = detail.item.provider_session_id.clone();
    match state
        .ai_session_controller
        .resume_archived(
            detail.item,
            detail.turns,
            model_selection,
            model_selection_intent,
            request.reasoning_effort,
        )
        .await
    {
        Ok(result) => {
            if result.disposition == "resumed" && result.creation_source == "ai-session" {
                if let Err(error) = state.ai_session_history.activate(&history_item_id) {
                    warn!(%error, ai_session_id = %history_item_id, "failed to activate AI Session history");
                }
                if let Err(error) = state
                    .ai_session_history
                    .activate_identity(&history_agent, &history_provider_session_id)
                {
                    warn!(%error, ai_session_id = %history_item_id, "failed to activate AI Session history identity");
                }
            }
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenAiSessionAppRequest {
    client_request_id: String,
}

async fn open_ai_session_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<OpenAiSessionAppRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    let _operation = state.open_app_operations.lock().await;
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    if let Some(app_session_id) = session.app_session_id.as_deref() {
        if state
            .app_runtime
            .get_session(app_session_id)
            .is_some_and(|app| app.status == "running")
        {
            return Json(ApiEnvelope {
                data: json!({
                    "disposition": "already-open",
                    "aiSessionId": session.id,
                    "providerSessionId": session.provider_session_id,
                    "appSessionId": app_session_id,
                    "creationSource": session.creation_source,
                }),
            })
            .into_response();
        }
    }
    let Some(provider_session_id) = session.provider_session_id.clone() else {
        return api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_OPEN_APP_UNAVAILABLE",
            "AI session has no resumable provider identity or cwd.",
        );
    };
    let Some(cwd) = session.cwd.clone() else {
        return api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_OPEN_APP_UNAVAILABLE",
            "AI session has no resumable provider identity or cwd.",
        );
    };
    let app = match state
        .app_runtime
        .start_resume(&session.agent, &cwd, &provider_session_id)
        .await
    {
        Ok(app) => app,
        Err(error) => {
            return api_error(
                StatusCode::CONFLICT,
                "AI_SESSION_OPEN_APP_FAILED",
                &error.to_string(),
            );
        }
    };
    let app_session_id = app.id.clone();
    let bound = state.ai_sessions.update(&session.id, |session| {
        session.app_session_id = Some(app_session_id.clone());
        let mut actions = session.actions.take().unwrap_or_else(|| json!({}));
        if let Some(actions) = actions.as_object_mut() {
            actions.insert("openApp".to_string(), json!(false));
            actions.insert("close".to_string(), json!(true));
        }
        session.actions = Some(actions);
        Ok(true)
    });
    match bound {
        Ok(bound) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: json!({
                    "disposition": "opened",
                    "aiSessionId": bound.id,
                    "providerSessionId": provider_session_id,
                    "appSessionId": app_session_id,
                    "creationSource": bound.creation_source,
                }),
            })
            .into_response()
        }
        Err(error) => {
            state.app_runtime.stop_session(&app_session_id).await;
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "AI_SESSION_OPEN_APP_FAILED",
                &error.to_string(),
            )
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkAiSessionWorkspace {
    mode: String,
}

impl Default for ForkAiSessionWorkspace {
    fn default() -> Self {
        Self {
            mode: "current".to_string(),
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkAiSessionRequest {
    client_request_id: String,
    #[serde(default)]
    through_turn_id: Option<String>,
    #[serde(default)]
    workspace: ForkAiSessionWorkspace,
}

async fn fork_ai_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_fork_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<ForkAiSessionRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    if request.workspace.mode != "current" {
        return api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
            "Managed worktree Fork is not available in this runtime.",
        );
    }
    match state
        .ai_session_controller
        .fork_session(
            &id,
            controlled_instance_ai_session::ProviderForkInput {
                through_turn_id: request.through_turn_id,
                cwd: None,
                story_agent_tools: None,
            },
        )
        .await
    {
        Ok(result) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAiSessionModelSelectionRequest {
    client_request_id: String,
    model_selection: controlled_instance_ai_session::AiSessionModelSelection,
}

async fn update_ai_session_model_selection(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_model_selection_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<UpdateAiSessionModelSelectionRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    match state
        .ai_session_controller
        .update_model_selection(&id, request.model_selection)
        .await
    {
        Ok(()) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: json!({ "sessionId": id, "accepted": true }),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAiSessionReasoningEffortRequest {
    client_request_id: String,
    reasoning_effort: String,
}

async fn update_ai_session_reasoning_effort(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_reasoning_effort_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<UpdateAiSessionReasoningEffortRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    match state
        .ai_session_controller
        .update_reasoning_effort(&id, &request.reasoning_effort)
        .await
    {
        Ok(()) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: json!({ "sessionId": id, "accepted": true }),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseAiSessionRequest {
    client_request_id: String,
}

async fn close_ai_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<CloseAiSessionRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    let Some(session) = state.ai_sessions.get(&id) else {
        return match state.ai_session_history.get(&id) {
            Some(item) => Json(ApiEnvelope {
                data: json!({
                    "disposition": "already-closed",
                    "aiSessionId": item.id,
                    "providerSessionId": item.provider_session_id,
                    "creationSource": item.creation_source,
                }),
            })
            .into_response(),
            None => ai_session_not_found(),
        };
    };
    match state.close_ai_session_subtree(&id).await {
        Ok(Some(removed)) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: json!({
                    "disposition": "closed",
                    "aiSessionId": removed.id,
                    "providerSessionId": removed.provider_session_id,
                    "creationSource": removed.creation_source,
                }),
            })
            .into_response()
        }
        Ok(None) => Json(ApiEnvelope {
            data: json!({
                "disposition": "already-closed",
                "aiSessionId": id,
                "providerSessionId": session.provider_session_id,
                "creationSource": session.creation_source,
            }),
        })
        .into_response(),
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSessionTurnsQuery {
    after_turn_id: Option<String>,
    after_revision: Option<String>,
    projection: Option<String>,
    revision: Option<String>,
}

async fn ai_session_turns(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<AiSessionTurnsQuery>,
) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    let turns = session.turns.as_deref().unwrap_or_default();
    if query.projection.as_deref() == Some("index") {
        let revision = session.turns_revision();
        if query.revision.as_deref() == Some(revision.as_str()) {
            return Json(ApiEnvelope {
                data: json!({ "kind": "not-modified", "revision": revision }),
            })
            .into_response();
        }
        let index = session
            .conversation_turns()
            .into_iter()
            .filter_map(|turn| {
                Some(json!({
                    "id": turn.get("id")?.as_str()?,
                    "providerTurnId": turn.get("providerTurnId").and_then(Value::as_str),
                    "status": turn.get("status").and_then(Value::as_str).unwrap_or("running"),
                    "phase": turn.get("phase").and_then(Value::as_str).unwrap_or("unknown"),
                    "revision": turn.get("revision").and_then(Value::as_u64).unwrap_or(0),
                    "startedAt": turn.get("startedAt").and_then(Value::as_str),
                    "updatedAt": turn.get("updatedAt").and_then(Value::as_str),
                    "completedAt": turn.get("completedAt").and_then(Value::as_str),
                    "bodyRevision": controlled_instance_ai_session::ai_session_turn_body_revision(turn),
                }))
            })
            .collect::<Vec<_>>();
        return Json(ApiEnvelope {
            data: json!({
                "kind": "updated",
                "revision": revision,
                "index": {
                    "sessionId": session.id,
                    "revision": revision,
                    "turns": index,
                },
            }),
        })
        .into_response();
    }

    let after_turn_id = query.after_turn_id.unwrap_or_default();
    let after_revision = query
        .after_revision
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok());
    let after_index = turns
        .iter()
        .position(|turn| turn.get("id").and_then(Value::as_str) == Some(after_turn_id.as_str()));
    let filtered = turns
        .iter()
        .enumerate()
        .filter(|(index, turn)| {
            if after_turn_id.is_empty() || after_index.is_none() {
                return true;
            }
            let after_index = after_index.unwrap_or_default();
            if *index > after_index {
                return true;
            }
            *index == after_index
                && after_revision.is_some_and(|after_revision| {
                    turn.get("revision").and_then(Value::as_u64).unwrap_or(0) > after_revision
                })
        })
        .map(|(_, turn)| turn.clone())
        .collect::<Vec<_>>();
    let next_cursor = filtered
        .last()
        .and_then(|turn| {
            Some(json!({
                "turnId": turn.get("id")?.as_str()?,
                "revision": turn.get("revision").and_then(Value::as_u64).unwrap_or(0),
            }))
        })
        .or_else(|| {
            (!after_turn_id.is_empty()).then(
                || json!({ "turnId": after_turn_id, "revision": after_revision.unwrap_or(0) }),
            )
        });
    Json(ApiEnvelope {
        data: json!({
            "sessionId": session.id,
            "turns": filtered,
            "nextCursor": next_cursor,
        }),
    })
    .into_response()
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiSessionTurnQuery {
    revision: Option<String>,
}

async fn ai_session_turn(
    State(state): State<AppState>,
    Path((id, turn_id)): Path<(String, String)>,
    Query(query): Query<AiSessionTurnQuery>,
) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    let Some(turn) = session
        .turns
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|turn| {
            turn.get("id").and_then(Value::as_str) == Some(turn_id.as_str())
                || turn.get("providerTurnId").and_then(Value::as_str) == Some(turn_id.as_str())
        })
    else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_TURN_NOT_FOUND",
            "AI session Turn not found.",
        );
    };
    let revision = controlled_instance_ai_session::ai_session_turn_body_revision(turn);
    if query.revision.as_deref() == Some(revision.as_str()) {
        return Json(ApiEnvelope {
            data: json!({ "kind": "not-modified", "revision": revision }),
        })
        .into_response();
    }
    Json(ApiEnvelope {
        data: json!({
            "kind": "updated",
            "revision": revision,
            "body": { "sessionId": session.id, "revision": revision, "turn": turn },
        }),
    })
    .into_response()
}

#[derive(Debug, serde::Deserialize, Default)]
struct AiSessionTimelineQuery {
    revision: Option<String>,
}

async fn ai_session_timeline(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<AiSessionTimelineQuery>,
) -> Response {
    let timeline = match state.ai_session_controller.timeline(&id).await {
        Ok(timeline) => timeline,
        Err(error) => return ai_session_provider_error(error),
    };
    let revision = controlled_instance_ai_session::ai_session_timeline_revision(&timeline.items);
    if query.revision.as_deref() == Some(revision.as_str()) {
        return Json(ApiEnvelope {
            data: json!({ "kind": "not-modified", "revision": revision }),
        })
        .into_response();
    }
    Json(ApiEnvelope {
        data: json!({ "kind": "updated", "revision": revision, "timeline": timeline }),
    })
    .into_response()
}

async fn ai_session_turn_timeline(
    State(state): State<AppState>,
    Path((id, turn_id)): Path<(String, String)>,
    Query(query): Query<AiSessionTimelineQuery>,
) -> Response {
    let timeline = match state
        .ai_session_controller
        .turn_timeline(&id, &turn_id)
        .await
    {
        Ok(timeline) => timeline,
        Err(error) => return ai_session_provider_error(error),
    };
    let revision = controlled_instance_ai_session::ai_session_timeline_revision(&timeline.items);
    if query.revision.as_deref() == Some(revision.as_str()) {
        return Json(ApiEnvelope {
            data: json!({ "kind": "not-modified", "revision": revision }),
        })
        .into_response();
    }
    Json(ApiEnvelope {
        data: json!({ "kind": "updated", "revision": revision, "timeline": timeline }),
    })
    .into_response()
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionTimelineSyncRequest {
    #[serde(default)]
    known_items: Vec<controlled_instance_protocol::AiSessionTimelineItemRevision>,
}

async fn sync_ai_session_timeline(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_timeline_sync_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<AiSessionTimelineSyncRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    if let Err(message) =
        controlled_instance_ai_session::validate_known_timeline_items(&request.known_items)
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            &message,
        );
    }
    let timeline = match state.ai_session_controller.timeline(&id).await {
        Ok(timeline) => timeline,
        Err(error) => return ai_session_provider_error(error),
    };
    Json(ApiEnvelope {
        data: controlled_instance_ai_session::sync_ai_session_timeline_items(
            &timeline.items,
            &request.known_items,
        ),
    })
    .into_response()
}

async fn sync_ai_session_turn_timeline(
    State(state): State<AppState>,
    Path((id, turn_id)): Path<(String, String)>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_timeline_sync_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<AiSessionTimelineSyncRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    if let Err(message) =
        controlled_instance_ai_session::validate_known_timeline_items(&request.known_items)
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            &message,
        );
    }
    let timeline = match state
        .ai_session_controller
        .turn_timeline(&id, &turn_id)
        .await
    {
        Ok(timeline) => timeline,
        Err(error) => return ai_session_provider_error(error),
    };
    Json(ApiEnvelope {
        data: controlled_instance_ai_session::sync_ai_session_timeline_items(
            &timeline.items,
            &request.known_items,
        ),
    })
    .into_response()
}

#[derive(Debug, serde::Deserialize, Default)]
struct AiSessionTranscriptQuery {
    tail: Option<String>,
}

async fn ai_session_transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<AiSessionTranscriptQuery>,
) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_TRANSCRIPT_NOT_FOUND",
            "AI session transcript not found.",
        );
    };
    let Some(path) = session.transcript_path.as_deref() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_TRANSCRIPT_NOT_FOUND",
            "AI session transcript not found.",
        );
    };
    let tail = query
        .tail
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(200)
        .clamp(1, 1000) as usize;
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let lines = content
                .split('\n')
                .map(|line| line.strip_suffix('\r').unwrap_or(line))
                .collect::<Vec<_>>();
            let selected = lines.len().saturating_sub(tail).min(lines.len());
            Json(ApiEnvelope {
                data: json!({
                    "path": path,
                    "lineCount": lines.len(),
                    "tail": lines[selected..].join("\n"),
                }),
            })
            .into_response()
        }
        Err(error) => api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_TRANSCRIPT_NOT_READABLE",
            &error.to_string(),
        ),
    }
}

async fn ai_session_queue(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.ai_sessions.queue(&id) {
        Some(queue) => Json(ApiEnvelope { data: queue }).into_response(),
        None => ai_session_not_found(),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentDraftUploadQuery {
    scope_type: controlled_instance_protocol::AiSessionAttachmentScopeType,
    scope_id: String,
    kind: controlled_instance_protocol::AiSessionAttachmentKind,
    name: String,
    mime: String,
    size: u64,
}

async fn upload_ai_session_attachment_draft(
    State(state): State<AppState>,
    Query(query): Query<AttachmentDraftUploadQuery>,
    body: Body,
) -> Response {
    if query.scope_type == controlled_instance_protocol::AiSessionAttachmentScopeType::Session
        && state.ai_sessions.get(query.scope_id.trim()).is_none()
    {
        return ai_session_not_found();
    }
    if !validate_attachment_draft_input(&query.scope_id, query.kind, &query.name, &query.mime) {
        return attachment_invalid_response("AI session attachment metadata is invalid.");
    }
    let content = match to_bytes(
        body,
        controlled_instance_protocol::AI_SESSION_ATTACHMENT_UPLOAD_BODY_LIMIT,
    )
    .await
    {
        Ok(content) => content,
        Err(error) => {
            return api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "AI_SESSION_ATTACHMENT_INVALID",
                &error.to_string(),
            );
        }
    };
    match state.ai_session_attachments.create_draft(
        controlled_instance_ai_session::AiSessionAttachmentDraftInput {
            id: None,
            scope_type: query.scope_type,
            scope_id: query.scope_id,
            kind: query.kind,
            name: query.name,
            mime: query.mime,
            size: query.size,
            content: content.to_vec(),
        },
    ) {
        Ok(draft) => (StatusCode::CREATED, Json(ApiEnvelope { data: draft })).into_response(),
        Err(error) => ai_session_attachment_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentDraftStreamCreateRequest {
    attachment_id: String,
    scope_type: controlled_instance_protocol::AiSessionAttachmentScopeType,
    scope_id: String,
    kind: controlled_instance_protocol::AiSessionAttachmentKind,
    name: String,
    mime: String,
    size: u64,
}

async fn begin_ai_session_attachment_draft_stream(
    State(state): State<AppState>,
    payload: Result<Json<AttachmentDraftStreamCreateRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return attachment_body_error(error),
    };
    if request.scope_type == controlled_instance_protocol::AiSessionAttachmentScopeType::Session
        && state.ai_sessions.get(request.scope_id.trim()).is_none()
    {
        return ai_session_not_found();
    }
    if !validate_attachment_draft_input(
        &request.scope_id,
        request.kind,
        &request.name,
        &request.mime,
    ) {
        return attachment_invalid_response("AI session attachment metadata is invalid.");
    }
    match state.ai_session_attachment_streams.begin(
        controlled_instance_ai_session::AiSessionAttachmentDraftStreamBegin {
            attachment_id: request.attachment_id,
            scope_type: request.scope_type,
            scope_id: request.scope_id,
            kind: request.kind,
            name: request.name,
            mime: request.mime,
            size: request.size,
        },
    ) {
        Ok(data) => (StatusCode::CREATED, Json(ApiEnvelope { data })).into_response(),
        Err(error) => ai_session_attachment_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachmentDraftStreamAppendQuery {
    offset: u64,
}

async fn append_ai_session_attachment_draft_stream(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
    Query(query): Query<AttachmentDraftStreamAppendQuery>,
    body: Body,
) -> Response {
    let chunk = match to_bytes(
        body,
        controlled_instance_protocol::AI_SESSION_ATTACHMENT_DRAFT_STREAM_BODY_LIMIT,
    )
    .await
    {
        Ok(chunk) => chunk,
        Err(error) => {
            return api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "AI_SESSION_ATTACHMENT_SIZE_MISMATCH",
                &error.to_string(),
            );
        }
    };
    match state
        .ai_session_attachment_streams
        .append(&attachment_id, query.offset, &chunk)
    {
        Ok(data) => Json(ApiEnvelope { data }).into_response(),
        Err(error) => ai_session_attachment_error(error),
    }
}

async fn complete_ai_session_attachment_draft_stream(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
    payload: Result<Option<Json<Value>>, JsonRejection>,
) -> Response {
    let body = match payload {
        Ok(Some(Json(Value::Null))) | Ok(None) => json!({}),
        Ok(Some(Json(body))) => body,
        Err(error) => return ai_session_body_error(error),
    };
    if let Err(issues) = normalize_empty_object_body(&body) {
        return ai_session_validation_error(issues);
    }
    match state.ai_session_attachment_streams.complete(&attachment_id) {
        Ok(draft) => Json(ApiEnvelope { data: draft }).into_response(),
        Err(error) => ai_session_attachment_error(error),
    }
}

async fn cancel_ai_session_attachment_draft_stream(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
) -> Response {
    match state.ai_session_attachment_streams.cancel(&attachment_id) {
        Ok(data) => Json(ApiEnvelope { data }).into_response(),
        Err(error) => ai_session_attachment_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentDraftCancelQuery {
    scope_type: controlled_instance_protocol::AiSessionAttachmentScopeType,
    scope_id: String,
}

async fn cancel_ai_session_attachment_draft(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
    Query(query): Query<AttachmentDraftCancelQuery>,
) -> Response {
    match state.ai_session_attachments.cancel_draft(
        query.scope_type,
        &query.scope_id,
        &attachment_id,
    ) {
        Ok(true) => Json(ApiEnvelope {
            data: json!({ "removed": true }),
        })
        .into_response(),
        Ok(false) => api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_ATTACHMENT_DRAFT_NOT_FOUND",
            "AI session attachment draft not found or expired.",
        ),
        Err(error) => ai_session_attachment_error(error),
    }
}

async fn ai_session_message_attachment_content(
    State(state): State<AppState>,
    Path((session_id, message_id, attachment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let content =
        match state
            .ai_session_attachments
            .content(&session_id, &message_id, &attachment_id)
        {
            Ok(content) => content,
            Err(error) => return ai_session_attachment_error(error),
        };
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(content.etag.as_str())
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let filename = url::form_urlencoded::byte_serialize(content.attachment.name.as_bytes())
        .collect::<String>();
    let inline_raster = matches!(
        content.attachment.mime.to_ascii_lowercase().as_str(),
        "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp"
    );
    let bytes = match std::fs::read(&content.path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return api_error(
                StatusCode::NOT_FOUND,
                "AI_SESSION_ATTACHMENT_NOT_FOUND",
                &error.to_string(),
            );
        }
    };
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    let response_headers = response.headers_mut();
    if let Ok(value) = content.attachment.mime.parse() {
        response_headers.insert(header::CONTENT_TYPE, value);
    }
    response_headers.insert(
        header::CONTENT_LENGTH,
        content.attachment.size.to_string().parse().expect("size"),
    );
    if let Ok(value) = content.etag.parse() {
        response_headers.insert(header::ETAG, value);
    }
    response_headers.insert(
        "x-task-handoff-attachment-cache-until",
        content
            .cache_until
            .to_string()
            .parse()
            .expect("cache deadline"),
    );
    response_headers.insert(
        "x-task-handoff-attachment-size",
        content
            .attachment
            .size
            .to_string()
            .parse()
            .expect("attachment size"),
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        "private, max-age=0, must-revalidate"
            .parse()
            .expect("cache"),
    );
    response_headers.insert(
        "x-content-type-options",
        "nosniff".parse().expect("nosniff"),
    );
    response_headers.insert("accept-ranges", "none".parse().expect("ranges"));
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        format!(
            "{}; filename*=UTF-8''{filename}",
            if inline_raster {
                "inline"
            } else {
                "attachment"
            }
        )
        .parse()
        .expect("content disposition"),
    );
    response
}

fn validate_attachment_draft_input(
    scope_id: &str,
    kind: controlled_instance_protocol::AiSessionAttachmentKind,
    name: &str,
    mime: &str,
) -> bool {
    let scope_id = scope_id.trim();
    let name = name.trim();
    let mime = mime.trim();
    if scope_id.is_empty() || scope_id.encode_utf16().count() > 160 {
        return false;
    }
    if name.is_empty() || name.encode_utf16().count() > 240 {
        return false;
    }
    if mime.is_empty() || mime.encode_utf16().count() > 120 {
        return false;
    }
    !matches!(
        kind,
        controlled_instance_protocol::AiSessionAttachmentKind::Image
    ) || matches!(
        mime.split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp"
    )
}

fn attachment_invalid_response(message: &str) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "AI_SESSION_ATTACHMENT_INVALID",
        message,
    )
}

fn attachment_body_error(error: JsonRejection) -> Response {
    api_error(
        StatusCode::BAD_REQUEST,
        "AI_SESSION_CONTROL_INVALID",
        &format!("body: {error}"),
    )
}

fn ai_session_attachment_error(
    error: controlled_instance_ai_session::AiSessionAttachmentError,
) -> Response {
    let status = StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::BAD_REQUEST);
    api_error(status, &error.code, &error.message)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionQueueEditRequest {
    expected_revision: u64,
    message: String,
    attachments: Option<Vec<AiSessionQueueAttachmentEdit>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionQueueAttachmentEdit {
    id: String,
    #[serde(default)]
    kind: Option<controlled_instance_protocol::AiSessionAttachmentKind>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    source: AiSessionQueueAttachmentSource,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionQueueAttachmentSource {
    #[serde(rename = "type")]
    source_type: String,
    #[serde(default)]
    path: Option<String>,
}

async fn edit_ai_session_queue_item(
    State(state): State<AppState>,
    Path((id, queue_id)): Path<(String, String)>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_queue_edit_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<AiSessionQueueEditRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    let result = if let Some(attachments) = request.attachments {
        let Some(session) = state.ai_sessions.get(&id) else {
            return ai_session_not_found();
        };
        let Some(queue_item) = session
            .queue
            .items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(queue_id.as_str()))
        else {
            return api_error(
                StatusCode::NOT_FOUND,
                "AI_SESSION_QUEUE_ITEM_NOT_FOUND",
                "Queued message not found.",
            );
        };
        let existing_ids = queue_item
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|attachment| attachment.get("id").and_then(Value::as_str))
            .collect::<std::collections::HashSet<_>>();
        let mut retained_ids = Vec::new();
        let mut draft_ids = Vec::new();
        let mut runtime_attachments = Vec::new();
        for attachment in attachments {
            match attachment.source.source_type.as_str() {
                "retained" => {
                    if attachment.source.path.is_some()
                        || !existing_ids.contains(attachment.id.as_str())
                    {
                        return api_error(
                            StatusCode::CONFLICT,
                            "AI_SESSION_QUEUE_ATTACHMENT_INVALID",
                            "Queued message attachment was not found.",
                        );
                    }
                    retained_ids.push(attachment.id);
                }
                "upload-ref" => {
                    if attachment.source.path.is_some() {
                        return api_error(
                            StatusCode::BAD_REQUEST,
                            "AI_SESSION_CONTROL_INVALID",
                            "upload-ref attachments cannot include a runtime path.",
                        );
                    }
                    draft_ids.push(attachment.id);
                }
                "runtime-path" => {
                    let (Some(kind), Some(name), Some(mime), Some(size), Some(path)) = (
                        attachment.kind,
                        attachment.name,
                        attachment.mime,
                        attachment.size,
                        attachment.source.path,
                    ) else {
                        return api_error(
                            StatusCode::BAD_REQUEST,
                            "AI_SESSION_CONTROL_INVALID",
                            "runtime-path attachments require kind, name, mime and path.",
                        );
                    };
                    runtime_attachments.push(
                        controlled_instance_ai_session::AiSessionMessageAttachmentInput::RuntimePath {
                            id: attachment.id,
                            kind,
                            name,
                            mime,
                            size,
                            path: PathBuf::from(path),
                        },
                    );
                }
                _ => {
                    return api_error(
                        StatusCode::BAD_REQUEST,
                        "AI_SESSION_CONTROL_INVALID",
                        "attachment source type is invalid.",
                    );
                }
            }
        }
        let replacement_message_id =
            format!("msg_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
        let staged = match state.ai_session_attachments.stage_message(
            controlled_instance_ai_session::StageMessageAttachmentsInput {
                session_id: id.clone(),
                message_id: replacement_message_id.clone(),
                attachments: runtime_attachments,
                retained_attachment_ids: retained_ids,
                runtime_path_root: session.cwd.clone().map(PathBuf::from),
                draft_scope_type: Some(
                    controlled_instance_protocol::AiSessionAttachmentScopeType::Session,
                ),
                draft_scope_id: Some(id.clone()),
                draft_attachment_ids: draft_ids,
            },
        ) {
            Ok(staged) => staged,
            Err(error) => return ai_session_attachment_error(error),
        };
        let queue_attachments = staged
            .provider_attachments
            .iter()
            .map(|attachment| {
                serde_json::to_value(&attachment.meta)
                    .unwrap_or_else(|_| json!({ "id": attachment.meta.id }))
            })
            .collect::<Vec<_>>();
        let previous_message_id = queue_item
            .get("messageId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                let ids = queue_item
                    .get("attachments")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|attachment| {
                        attachment
                            .get("id")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>();
                state
                    .ai_session_attachments
                    .message_id_for_attachments(&id, &ids)
            });
        let edited = state.ai_sessions.edit_queue_item_details(
            &id,
            &queue_id,
            request.expected_revision,
            &request.message,
            Some(&replacement_message_id),
            Some(queue_attachments),
        );
        if edited.is_err() {
            state
                .ai_session_attachments
                .rollback_message(&id, &replacement_message_id);
        }
        if let (Ok(_), Some(previous_message_id)) = (&edited, previous_message_id) {
            if previous_message_id != replacement_message_id {
                state
                    .ai_session_attachments
                    .rollback_message(&id, &previous_message_id);
            }
        }
        edited
    } else {
        state.ai_sessions.edit_queue_item(
            &id,
            &queue_id,
            request.expected_revision,
            &request.message,
        )
    };
    match result {
        Ok(session) => {
            state.publish_ai_session_snapshot("control-action");
            queue_mutation_response(&session, "edit", Some(&queue_id))
        }
        Err(error) => ai_session_store_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiSessionQueueReorderRequest {
    expected_revision: u64,
    queue_ids: Vec<String>,
}

async fn reorder_ai_session_queue(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let body = match normalize_ai_session_queue_reorder_body(&body) {
        Ok(body) => body,
        Err(issues) => return ai_session_validation_error(issues),
    };
    let request = match serde_json::from_value::<AiSessionQueueReorderRequest>(body) {
        Ok(request) => request,
        Err(error) => return ai_session_deserialize_error(error),
    };
    match state
        .ai_sessions
        .reorder_queue_items(&id, request.expected_revision, &request.queue_ids)
    {
        Ok(session) => {
            state.publish_ai_session_snapshot("control-action");
            queue_mutation_response(&session, "reorder", None)
        }
        Err(error) => ai_session_store_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AiSessionQueuePauseRequest {
    paused: bool,
}

async fn pause_ai_session_queue(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<AiSessionQueuePauseRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "AI_SESSION_CONTROL_INVALID",
                &format!("body: {error}"),
            );
        }
    };
    match state.ai_sessions.set_queue_paused(&id, request.paused) {
        Ok(session) => {
            state.publish_ai_session_snapshot("control-action");
            queue_mutation_response(&session, "pause", None)
        }
        Err(error) => ai_session_store_error(error),
    }
}

async fn retry_ai_session_queue_item(
    State(state): State<AppState>,
    Path((id, queue_id)): Path<(String, String)>,
) -> Response {
    match state.ai_sessions.retry_queue_item(&id, &queue_id) {
        Ok(session) => {
            state.publish_ai_session_snapshot("control-action");
            queue_mutation_response(&session, "retry", Some(&queue_id))
        }
        Err(error) => ai_session_store_error(error),
    }
}

async fn remove_ai_session_queue_item(
    State(state): State<AppState>,
    Path((id, queue_id)): Path<(String, String)>,
) -> Response {
    match state.ai_sessions.remove_queue_item(&id, &queue_id) {
        Ok(session) => {
            state.publish_ai_session_snapshot("control-action");
            queue_mutation_response(&session, "remove", Some(&queue_id))
        }
        Err(error) => ai_session_store_error(error),
    }
}

async fn steer_ai_session_queue_item(
    State(state): State<AppState>,
    Path((id, queue_id)): Path<(String, String)>,
) -> Response {
    match state
        .ai_session_controller
        .steer_queued_message(&id, &queue_id)
        .await
    {
        Ok(result) => {
            state.publish_ai_session_snapshot("control-action");
            Json(ApiEnvelope {
                data: ai_session_action_response(&result),
            })
            .into_response()
        }
        Err(error) => ai_session_provider_error(error),
    }
}

fn queue_mutation_response(
    session: &controlled_instance_ai_session::AiSession,
    action: &str,
    queue_id: Option<&str>,
) -> Response {
    let mut data = json!({
        "sessionId": session.id,
        "queueRevision": session.queue.revision,
        "action": action,
    });
    if let (Some(object), Some(queue_id)) = (data.as_object_mut(), queue_id) {
        object.insert("queueId".to_string(), json!(queue_id));
    }
    Json(ApiEnvelope { data }).into_response()
}

fn ai_session_store_error(error: controlled_instance_ai_session::AiSessionStoreError) -> Response {
    use controlled_instance_ai_session::AiSessionStoreError;
    match error {
        AiSessionStoreError::NotFound => ai_session_not_found(),
        AiSessionStoreError::QueueRevisionConflict { current_revision } => api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_QUEUE_REVISION_CONFLICT",
            &format!("AI session queue changed at revision {current_revision}."),
        ),
        AiSessionStoreError::QueueItemNotFound => api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_QUEUE_ITEM_NOT_FOUND",
            "Queued message not found.",
        ),
        AiSessionStoreError::QueueItemNotEditable => api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_QUEUE_ITEM_NOT_EDITABLE",
            "Only queued messages can be edited.",
        ),
        AiSessionStoreError::QueueOrderInvalid => api_error(
            StatusCode::CONFLICT,
            "AI_SESSION_QUEUE_ORDER_INVALID",
            "Queue order must contain every currently queued message exactly once.",
        ),
        AiSessionStoreError::InvalidId
        | AiSessionStoreError::TitleConflict
        | AiSessionStoreError::Io(_)
        | AiSessionStoreError::Json(_) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "AI_SESSION_PERSISTENCE_FAILED",
            &error.to_string(),
        ),
    }
}

async fn process_identity(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    Json(ApiEnvelope {
        data: json!({
            "instanceId": state.config.instance_id,
            "pid": std::process::id(),
            "processNonce": std::env::var("TASK_HANDOFF_LOCAL_PROCESS_NONCE").unwrap_or_default(),
            "startIdentity": state.process_start_identity(),
        }),
    })
}

async fn ai_session_idle_retention(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    let data = state
        .ai_session_retention_candidates()
        .into_iter()
        .filter_map(|candidate| {
            let session = state.ai_sessions.get(&candidate.root_id)?;
            let story_id = session.story_id?;
            Some(json!({
                "sessionId": candidate.root_id,
                "storyId": story_id,
                "status": "idle",
                "updatedAt": candidate.last_active_at,
            }))
        })
        .collect::<Vec<_>>();
    Json(ApiEnvelope {
        data: Value::Array(data),
    })
}

async fn ai_session_instance_idle_retention(
    State(state): State<AppState>,
) -> Json<ApiEnvelope<Value>> {
    let data = state
        .ai_session_retention_candidates()
        .into_iter()
        .map(|candidate| {
            json!({
                "sessionId": candidate.root_id,
                "status": "idle",
                "updatedAt": candidate.last_active_at,
            })
        })
        .collect::<Vec<_>>();
    Json(ApiEnvelope {
        data: Value::Array(data),
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateCloseAiSessionRequest {
    client_request_id: String,
}

async fn close_ai_session_if_idle(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<PrivateCloseAiSessionRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    let existed = state.ai_sessions.get(&id).is_some();
    match state.close_ai_session_subtree_if_idle(&id).await {
        Ok(Some(closed)) => {
            state.publish_ai_session_snapshot("control-action");
            closed_ai_session_response(&state, &id, Some(closed))
        }
        Ok(None) if existed => StatusCode::NO_CONTENT.into_response(),
        Ok(None) => closed_ai_session_response(&state, &id, None),
        Err(error) => ai_session_provider_error(error),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseAiSessionForStoryDeletionRequest {
    client_request_id: String,
    story_id: String,
}

async fn close_ai_session_for_story_deletion(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<CloseAiSessionForStoryDeletionRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    if let Err(response) = validate_client_request_id(Some(&request.client_request_id)) {
        return *response;
    }
    if request.story_id.trim().is_empty() || request.story_id.chars().count() > 120 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            "storyId must be between 1 and 120 characters.",
        );
    }
    if let Some(session) = state.ai_sessions.get(&id) {
        if session.story_id.as_deref() != Some(request.story_id.as_str()) {
            return api_error(
                StatusCode::CONFLICT,
                "AI_SESSION_STORY_MISMATCH",
                "AI Session no longer belongs to the Story being deleted.",
            );
        }
    }
    match state.close_ai_session_subtree(&id).await {
        Ok(closed) => {
            state.publish_ai_session_snapshot("control-action");
            closed_ai_session_response(&state, &id, closed)
        }
        Err(error) => ai_session_provider_error(error),
    }
}

fn closed_ai_session_response(
    state: &AppState,
    id: &str,
    closed: Option<controlled_instance_ai_session::AiSession>,
) -> Response {
    if let Some(session) = closed {
        return Json(ApiEnvelope {
            data: json!({
                "disposition": "closed",
                "aiSessionId": session.id,
                "providerSessionId": session.provider_session_id,
                "creationSource": session.creation_source,
            }),
        })
        .into_response();
    }
    match state.ai_session_history.get(id) {
        Some(item) => Json(ApiEnvelope {
            data: json!({
                "disposition": "already-closed",
                "aiSessionId": item.id,
                "providerSessionId": item.provider_session_id,
                "creationSource": item.creation_source,
            }),
        })
        .into_response(),
        None => ai_session_not_found(),
    }
}

async fn send_private_ai_session_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    payload: Result<Json<controlled_instance_ai_session::AiSessionMessageInput>, JsonRejection>,
) -> Response {
    send_ai_session_message_inner(state, id, payload).await
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryAutomationCwd {
    #[serde(rename = "type")]
    runtime_path_type: String,
    path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryAutomationCreateRequest {
    agent: String,
    cwd: StoryAutomationCwd,
    #[serde(default)]
    cwd_folder_id: Option<String>,
    #[serde(default)]
    git_selection: Option<Value>,
    #[serde(default)]
    workspace_selection: Option<Value>,
    message: String,
    #[serde(default)]
    permission_mode: Option<String>,
    client_request_id: String,
    #[serde(default)]
    model_selection: Option<controlled_instance_protocol::AgentRunModelSelection>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    story_id: String,
}

async fn create_story_automation_ai_session(
    State(state): State<AppState>,
    payload: Result<Json<StoryAutomationCreateRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    let wire = controlled_instance_protocol::StoryAutomationInstanceCreateInput {
        agent: request.agent.clone(),
        cwd: controlled_instance_protocol::StoryAutomationRuntimePath {
            runtime_path_type: request.cwd.runtime_path_type.clone(),
            path: request.cwd.path.clone(),
        },
        cwd_folder_id: request.cwd_folder_id.clone(),
        git_selection: request.git_selection.clone(),
        workspace_selection: request.workspace_selection.clone(),
        message: request.message.clone(),
        permission_mode: request.permission_mode.clone(),
        client_request_id: request.client_request_id.clone(),
        model_selection: request.model_selection.clone(),
        reasoning_effort: request.reasoning_effort.clone(),
        story_id: request.story_id.clone(),
    };
    if let Err(message) = wire.validate() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            &message,
        );
    }
    let permission_mode = match permission_mode_from_wire(request.permission_mode.as_deref()) {
        Ok(permission_mode) => permission_mode,
        Err(error) => return repository_error(error),
    };
    let input = controlled_instance_ai_session::AiSessionCreateInput {
        agent: request.agent,
        cwd: controlled_instance_ai_session::AiSessionRuntimePathInput {
            runtime_path_type: request.cwd.runtime_path_type,
            path: request.cwd.path,
        },
        cwd_folder_id: request.cwd_folder_id,
        git_selection: request.git_selection,
        workspace_selection: request.workspace_selection,
        model_selection: request
            .model_selection
            .map(ai_session_model_selection_from_agent_run),
        reasoning_effort: request.reasoning_effort,
        story_id: Some(request.story_id),
        message: controlled_instance_ai_session::AiSessionMessageInput {
            message: request.message,
            mode: None,
            client_request_id: Some(request.client_request_id),
            attachments: Vec::new(),
            references: Vec::new(),
            permission_mode,
        },
    };
    let workspace_selected = input.git_selection.is_some() || input.workspace_selection.is_some();
    let result = if workspace_selected {
        match create_workspace_ai_session(&state, input).await {
            Ok(result) => result,
            Err(WorkspaceAiSessionCreateError::Repository(error)) => {
                return repository_error(error)
            }
            Err(WorkspaceAiSessionCreateError::Provider(error)) => {
                return ai_session_provider_error(error)
            }
        }
    } else {
        match state.ai_session_controller.create_session(input).await {
            Ok(result) => result,
            Err(error) => return ai_session_provider_error(error),
        }
    };
    state.publish_ai_session_snapshot("control-action");
    Json(ApiEnvelope {
        data: StoryAutomationInstanceCreateResult {
            disposition: result.disposition,
            ai_session_id: result.ai_session_id,
        },
    })
    .into_response()
}

fn ai_session_model_selection_from_agent_run(
    selection: controlled_instance_protocol::AgentRunModelSelection,
) -> controlled_instance_ai_session::AiSessionModelSelection {
    controlled_instance_ai_session::AiSessionModelSelection {
        model_entity_id: selection.model_entity_id,
        model_name: selection.model_name,
        model_upstream_name: selection.model_upstream_name,
    }
}

async fn create_agent_run_member(
    State(state): State<AppState>,
    payload: Result<
        Json<controlled_instance_protocol::AgentRunMemberInstanceCreateInput>,
        JsonRejection,
    >,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => return ai_session_body_error(error),
    };
    if let Err(message) = request.validate() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "AI_SESSION_CONTROL_INVALID",
            &message,
        );
    }
    if request.provider_id != "codex" {
        return api_error(
            StatusCode::CONFLICT,
            "AGENT_RUN_PROVIDER_UNSUPPORTED",
            "This controlled instance has not proven Agent Run thread isolation for the requested provider.",
        );
    }
    let permission_mode = match permission_mode_from_wire(request.permission_mode.as_deref()) {
        Ok(permission_mode) => permission_mode,
        Err(error) => return repository_error(error),
    };
    let message = if request.appended_prompt.trim().is_empty() {
        request.prompt.clone()
    } else {
        format!(
            "{}\n\nAdditional Agent instructions:\n{}",
            request.prompt, request.appended_prompt
        )
    };
    let input = controlled_instance_ai_session::AiSessionCreateInput {
        agent: request.provider_id.clone(),
        cwd: controlled_instance_ai_session::AiSessionRuntimePathInput {
            runtime_path_type: request.cwd.runtime_path_type.clone(),
            path: request.cwd.path.clone(),
        },
        cwd_folder_id: None,
        git_selection: None,
        workspace_selection: None,
        model_selection: request
            .model_selection
            .clone()
            .map(ai_session_model_selection_from_agent_run),
        reasoning_effort: request.reasoning_effort.clone(),
        story_id: None,
        message: controlled_instance_ai_session::AiSessionMessageInput {
            message,
            mode: None,
            client_request_id: Some(request.client_request_id.clone()),
            attachments: Vec::new(),
            references: Vec::new(),
            permission_mode,
        },
    };
    let options = controlled_instance_ai_session::AiSessionManagedCreateOptions {
        runtime_workspace_roots: vec![
            PathBuf::from(&request.writable_roots.workspace.path),
            PathBuf::from(&request.writable_roots.shared.path),
        ],
        agent_tools: Some(request.enabled_tools.clone()),
    };
    let result = match state
        .ai_session_controller
        .create_managed_session(input, options)
        .await
    {
        Ok(result) => result,
        Err(error) => return ai_session_provider_error(error),
    };
    let binding = match state
        .agent_run_bindings
        .bind(crate::AgentRunMemberBindingInput {
            run_id: request.run_id,
            member_id: request.member_id,
            ai_session_id: result.ai_session_id.clone(),
            provider_session_id: result.provider_session_id.clone(),
        }) {
        Ok(binding) => binding,
        Err(error) => return ai_session_provider_error(error),
    };
    if binding.closed_at.is_some() {
        return api_error(
            StatusCode::CONFLICT,
            "AGENT_RUN_MEMBER_SESSION_CLOSED",
            "The Agent Run member session was already permanently closed.",
        );
    }
    state.publish_ai_session_snapshot("control-action");
    Json(ApiEnvelope {
        data: AgentRunMemberInstanceCreateResult {
            disposition: result.disposition,
            ai_session_id: result.ai_session_id,
            provider_session_id: result.provider_session_id,
        },
    })
    .into_response()
}

async fn agent_run_probe_state(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    let member_session_ids = state
        .agent_run_bindings
        .list()
        .into_iter()
        .map(|binding| binding.ai_session_id)
        .collect::<std::collections::HashSet<_>>();
    let mut ordinary_ai_session_ids = state
        .bound_ai_sessions()
        .into_iter()
        .filter(|session| !member_session_ids.contains(&session.id))
        .map(|session| session.id)
        .collect::<Vec<_>>();
    ordinary_ai_session_ids.sort();
    Json(ApiEnvelope {
        data: json!({ "ordinaryAiSessionIds": ordinary_ai_session_ids }),
    })
}

async fn agent_run_member_status(
    State(state): State<AppState>,
    Path((run_id, member_id)): Path<(String, String)>,
) -> Response {
    let Some(binding) = state.agent_run_bindings.get(&run_id, &member_id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AGENT_RUN_MEMBER_SESSION_NOT_FOUND",
            "Agent Run member session was not found.",
        );
    };
    let Some(session) = state.ai_sessions.get(&binding.ai_session_id) else {
        return api_error(
            StatusCode::CONFLICT,
            "AGENT_RUN_MEMBER_SESSION_CLOSED",
            "Agent Run member session is already closed.",
        );
    };
    Json(ApiEnvelope {
        data: project_agent_run_member_status(&binding, &session),
    })
    .into_response()
}

fn project_agent_run_member_status(
    binding: &crate::AgentRunMemberBinding,
    session: &controlled_instance_ai_session::AiSession,
) -> AgentRunMemberInstanceStatus {
    let identity = || {
        (
            binding.run_id.clone(),
            binding.member_id.clone(),
            binding.ai_session_id.clone(),
        )
    };
    let (run_id, member_id, ai_session_id) = identity();
    if session.status == "failed" {
        return AgentRunMemberInstanceStatus {
            run_id,
            member_id,
            ai_session_id,
            status: "failed".to_string(),
            result: None,
            error: Some(AgentRunError {
                code: "AGENT_RUN_PROVIDER_FAILED".to_string(),
                message: session
                    .error
                    .clone()
                    .filter(|message| !message.trim().is_empty())
                    .unwrap_or_else(|| "The provider member session failed.".to_string()),
                retryable: false,
                details: None,
            }),
        };
    }
    if session.status != "idle" {
        return AgentRunMemberInstanceStatus {
            run_id,
            member_id,
            ai_session_id,
            status: "running".to_string(),
            result: None,
            error: None,
        };
    }
    let text = session
        .last_message
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| session.summary.clone())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return AgentRunMemberInstanceStatus {
            run_id,
            member_id,
            ai_session_id,
            status: "failed".to_string(),
            result: None,
            error: Some(AgentRunError {
                code: "AGENT_RUN_PROVIDER_NO_FINAL_MESSAGE".to_string(),
                message: "The provider member session completed without a final message."
                    .to_string(),
                retryable: false,
                details: None,
            }),
        };
    }
    let truncated =
        text.chars().count() > controlled_instance_protocol::AGENT_RUN_MAX_RESULT_CHARACTERS;
    AgentRunMemberInstanceStatus {
        run_id,
        member_id,
        ai_session_id,
        status: "completed".to_string(),
        result: Some(AgentRunResult {
            text: text
                .chars()
                .take(controlled_instance_protocol::AGENT_RUN_MAX_RESULT_CHARACTERS)
                .collect(),
            truncated,
            source: "provider-final-message".to_string(),
        }),
        error: None,
    }
}

async fn close_agent_run_member(
    State(state): State<AppState>,
    Path((run_id, member_id)): Path<(String, String)>,
) -> Response {
    let Some(binding) = state.agent_run_bindings.get(&run_id, &member_id) else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AGENT_RUN_MEMBER_SESSION_NOT_FOUND",
            "Agent Run member session was not found.",
        );
    };
    if binding.closed_at.is_none() {
        if let Err(error) = state.close_ai_session_subtree(&binding.ai_session_id).await {
            return ai_session_provider_error(error);
        }
        if let Err(error) = state
            .agent_run_bindings
            .close(&binding.run_id, &binding.member_id)
        {
            return ai_session_provider_error(error);
        }
    }
    state.publish_ai_session_snapshot("control-action");
    Json(ApiEnvelope {
        data: AgentRunMemberInstanceCloseResult {
            run_id: binding.run_id,
            member_id: binding.member_id,
            ai_session_id: binding.ai_session_id,
            closed: true,
        },
    })
    .into_response()
}

async fn story_ai_session_read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    let mut detail = session.detail();
    if let Some(detail) = detail.as_object_mut() {
        detail.insert("id".to_string(), Value::String(session.id.clone()));
    }
    Json(ApiEnvelope {
        data: json!({
            "detail": detail,
            "turnIndex": {
                "sessionId": session.id,
                "revision": session.turns_revision(),
                "turns": session.conversation_turns().into_iter().filter_map(|turn| {
                    Some(json!({
                        "id": turn.get("id")?.as_str()?,
                        "providerTurnId": turn.get("providerTurnId").and_then(Value::as_str),
                        "status": turn.get("status").and_then(Value::as_str).unwrap_or("running"),
                        "phase": turn.get("phase").and_then(Value::as_str).unwrap_or("unknown"),
                        "revision": turn.get("revision").and_then(Value::as_u64).unwrap_or(0),
                        "startedAt": turn.get("startedAt").and_then(Value::as_str),
                        "updatedAt": turn.get("updatedAt").and_then(Value::as_str),
                        "completedAt": turn.get("completedAt").and_then(Value::as_str),
                        "bodyRevision": controlled_instance_ai_session::ai_session_turn_body_revision(turn),
                    }))
                }).collect::<Vec<_>>(),
            },
        }),
    })
    .into_response()
}

async fn story_ai_session_turn_read(
    State(state): State<AppState>,
    Path((id, turn_id)): Path<(String, String)>,
) -> Response {
    let Some(session) = state.ai_sessions.get(&id) else {
        return ai_session_not_found();
    };
    let Some(turn) = session
        .turns
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|turn| {
            turn.get("id").and_then(Value::as_str) == Some(turn_id.as_str())
                || turn.get("providerTurnId").and_then(Value::as_str) == Some(turn_id.as_str())
        })
        .cloned()
    else {
        return api_error(
            StatusCode::NOT_FOUND,
            "AI_SESSION_TURN_NOT_FOUND",
            "AI session Turn not found.",
        );
    };
    let actual_turn_id = turn
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(turn_id.as_str());
    let timeline = match state
        .ai_session_controller
        .turn_timeline(&session.id, actual_turn_id)
        .await
    {
        Ok(timeline) => timeline,
        Err(error) => return ai_session_provider_error(error),
    };
    let revision = controlled_instance_ai_session::ai_session_turn_body_revision(&turn);
    Json(ApiEnvelope {
        data: json!({
            "body": { "sessionId": session.id, "revision": revision, "turn": turn },
            "timeline": timeline,
        }),
    })
    .into_response()
}

async fn drain(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    state
        .instance_shell
        .shutdown(1001, "Controlled instance is draining.")
        .await;
    state.set_draining(true);
    state.app_runtime.stop_all().await;
    state.publish_app_session_snapshot("app-session-updated");
    state.publish_ai_session_snapshot("app-session-updated");
    state.heartbeat_node_agent().await;
    Json(ApiEnvelope {
        data: json!({ "drained": true, "instanceId": state.config.instance_id }),
    })
}

async fn resume(State(state): State<AppState>) -> Json<ApiEnvelope<Value>> {
    state.set_draining(false);
    Json(ApiEnvelope {
        data: json!({ "resumed": true, "instanceId": state.config.instance_id }),
    })
}

async fn shutdown(State(state): State<AppState>) -> (StatusCode, Json<ApiEnvelope<Value>>) {
    state.request_shutdown();
    (
        StatusCode::ACCEPTED,
        Json(ApiEnvelope {
            data: json!({ "accepted": true, "instanceId": state.config.instance_id }),
        }),
    )
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateNodeAgentConnectionRequest {
    node_agent_url: String,
}

async fn update_node_agent_connection(
    State(state): State<AppState>,
    payload: Result<Json<UpdateNodeAgentConnectionRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "NODE_AGENT_CONNECTION_UPDATE_INVALID",
                &format!("body: {error}"),
            );
        }
    };
    match state
        .node_agent_client
        .update_node_agent_url(&request.node_agent_url)
    {
        Ok(node_agent_url) => Json(ApiEnvelope {
            data: json!({ "applied": true, "nodeAgentUrl": node_agent_url }),
        })
        .into_response(),
        Err(error) => api_error(
            StatusCode::BAD_REQUEST,
            "NODE_AGENT_CONNECTION_UPDATE_INVALID",
            &error.to_string(),
        ),
    }
}

async fn events(
    websocket: WebSocketUpgrade,
    State(state): State<AppState>,
    uri: Uri,
) -> impl IntoResponse {
    let query = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    let expects_transient = query.get("aiSessionTransient").map(String::as_str) == Some("1");
    let includes_authority_snapshot =
        query.get("aiSessionAuthoritySnapshot").map(String::as_str) == Some("1");
    let subagents = query.get("aiSessionHierarchy").map(String::as_str) == Some("subagents");
    websocket.on_upgrade(move |socket| {
        handle_events_socket(
            socket,
            state,
            expects_transient,
            includes_authority_snapshot,
            subagents,
        )
    })
}

async fn instance_shell_websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Response {
    let protocols = headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if protocols.len() != 1
        || protocols[0] != controlled_instance_protocol::INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "INSTANCE_SHELL_PROTOCOL_ERROR",
            "Instance shell subprotocol is required.",
        );
    }
    crate::instance_shell::websocket_upgrade_options(websocket)
        .protocols([controlled_instance_protocol::INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL])
        .on_upgrade(move |socket| async move { state.instance_shell.handle_socket(socket).await })
        .into_response()
}

async fn browser_tunnel_websocket(websocket: WebSocketUpgrade) -> Response {
    crate::browser_tunnel::websocket_upgrade(websocket)
        .on_upgrade(|socket| async move {
            crate::browser_tunnel::handle_browser_tunnel(socket).await;
        })
        .into_response()
}

const MAX_EVENT_CLIENT_BUFFERED_BYTES: usize = 16 * 1024 * 1024;

struct EventWireFrame {
    message: Message,
    bytes: usize,
}

struct EventWire {
    sender: tokio::sync::mpsc::UnboundedSender<EventWireFrame>,
    queued_bytes: Arc<AtomicUsize>,
    too_slow: tokio::sync::watch::Sender<bool>,
}

impl EventWire {
    fn new(
        sender: tokio::sync::mpsc::UnboundedSender<EventWireFrame>,
        queued_bytes: Arc<AtomicUsize>,
        too_slow: tokio::sync::watch::Sender<bool>,
    ) -> Self {
        Self {
            sender,
            queued_bytes,
            too_slow,
        }
    }

    fn enqueue(&self, message: Message) -> bool {
        let bytes = wire_message_bytes(&message);
        if !reserve_event_bytes(&self.queued_bytes, bytes) {
            self.mark_too_slow();
            return false;
        }
        if self.sender.send(EventWireFrame { message, bytes }).is_err() {
            self.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
            return false;
        }
        true
    }

    fn mark_too_slow(&self) {
        let _ = self.too_slow.send(true);
    }
}

fn reserve_event_bytes(queued_bytes: &AtomicUsize, bytes: usize) -> bool {
    let mut current = queued_bytes.load(Ordering::SeqCst);
    loop {
        let Some(next) = current.checked_add(bytes) else {
            return false;
        };
        if next > MAX_EVENT_CLIENT_BUFFERED_BYTES {
            return false;
        }
        match queued_bytes.compare_exchange(current, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

fn wire_message_bytes(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) => bytes.len(),
        Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
        Message::Close(_) => 2,
    }
}

async fn handle_events_socket(
    socket: WebSocket,
    state: AppState,
    expects_transient: bool,
    includes_authority_snapshot: bool,
    subagents: bool,
) {
    let (mut socket, mut stream) = socket.split();
    let (wire_sender, mut wire_receiver) = tokio::sync::mpsc::unbounded_channel();
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let (too_slow, mut too_slow_receiver) = tokio::sync::watch::channel(false);
    let wire = EventWire::new(wire_sender, queued_bytes.clone(), too_slow);
    let event_writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                changed = too_slow_receiver.changed() => {
                    if changed.is_ok() && *too_slow_receiver.borrow() {
                        let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1013,
                            reason: "Event consumer is too slow.".into(),
                        }))).await;
                        break;
                    }
                }
                frame = wire_receiver.recv() => {
                    let Some(frame) = frame else { break; };
                    let result = socket.send(frame.message).await;
                    queued_bytes.fetch_sub(frame.bytes, Ordering::SeqCst);
                    if result.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let events = state.events.clone();
    let instance_id = state.config.instance_id.clone();
    let (ai_stream_id, ai_revision, ai_earliest_retained_revision) = state.ai_session_stream_info();
    let (app_stream_id, app_revision, app_earliest_retained_revision) =
        state.app_session_stream_info();
    let mut receiver = events.subscribe();
    let mut subscription = ClientSubscription {
        topics: std::collections::HashSet::from(["*".to_string()]),
        transient: expects_transient.then(AiSessionTransientSubscription::default),
        compact: false,
        subagents,
    };
    let mut last_replayed_seq = 0;
    let hello = events.new_event(
        "streams.hello",
        json!({
            "protocolVersion": SESSION_STREAM_PROTOCOL_VERSION,
            "streams": [
                {
                    "topic": "ai.sessions",
                    "instanceId": instance_id,
                    "streamId": ai_stream_id,
                    "latestRevision": ai_revision,
                    "earliestRetainedRevision": ai_earliest_retained_revision,
                },
                {
                    "topic": "app.sessions",
                    "instanceId": instance_id,
                    "streamId": app_stream_id,
                    "latestRevision": app_revision,
                    "earliestRetainedRevision": app_earliest_retained_revision,
                },
            ],
        }),
    );
    if !enqueue_wire_event(&wire, &hello, false, false) {
        return;
    }
    if includes_authority_snapshot {
        let snapshot = state.ai_session_startup_snapshot_event(subagents);
        if !enqueue_wire_event(&wire, &snapshot, false, false) {
            return;
        }
    }
    let management = events.new_event(
        "app.management",
        serde_json::to_value(state.app_management.snapshot_event()).unwrap_or(Value::Null),
    );
    if !enqueue_wire_event(&wire, &management, false, false) {
        return;
    }
    // Match the Node connection bootstrap: refresh managed-app ownership after
    // the snapshot frame and publish the resulting sequence. The refresh is
    // asynchronous and connection-scoped so one slow capability probe does not
    // delay the event stream handshake.
    let app_management = state.app_management.clone();
    tokio::spawn(async move {
        app_management.refresh_snapshot(false).await;
        app_management.publish_snapshot();
    });
    loop {
        tokio::select! {
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(next) = parse_subscription(text.as_str()) {
                            subscription = next;
                            if let Some(replay_since) = subscription
                                .transient
                                .as_ref()
                                .and_then(|transient| transient.replay_since.as_deref())
                            {
                                for event in events.replay_since(
                                    replay_since,
                                    &subscription.topics,
                                    subscription.transient.as_ref(),
                                ) {
                                    last_replayed_seq = last_replayed_seq.max(event.seq);
                                    let projected = project_ai_session_event_for_consumer(
                                        &event,
                                        subscription.subagents,
                                    );
                                    if !enqueue_wire_event(
                                        &wire,
                                        &projected,
                                        subscription.compact,
                                        true,
                                    )
                                    {
                                        return;
                                    }
                                }
                            }
                        }
                    },
                    Some(Ok(Message::Ping(payload))) => {
                        if !wire.enqueue(Message::Pong(payload)) {
                            break;
                        }
                    },
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {},
                }
            },
            event = receiver.recv() => {
                match event {
                    Ok(event)
                        if event.seq > last_replayed_seq
                            && subscribed(&subscription.topics, &event.topic, &event.r#type)
                            && ai_session_transient_subscription_accepts(
                                subscription.transient.as_ref(),
                                &event,
                            ) =>
                    {
                        let projected = project_ai_session_event_for_consumer(
                            &event,
                            subscription.subagents,
                        );
                        if !enqueue_wire_event(
                            &wire,
                            &projected,
                            subscription.compact,
                            false,
                        )
                        {
                            break;
                        }
                    },
                    Ok(_) => {},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        wire.mark_too_slow();
                        break;
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    drop(wire);
    let _ = event_writer.await;
}

#[derive(Debug, Clone)]
struct ClientSubscription {
    topics: std::collections::HashSet<String>,
    transient: Option<AiSessionTransientSubscription>,
    compact: bool,
    subagents: bool,
}

fn parse_subscription(message: &str) -> Option<ClientSubscription> {
    let value: Value = serde_json::from_str(message).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("subscribe") {
        return None;
    }
    let topics = value
        .get("topics")
        .and_then(Value::as_array)
        .map(|topics| {
            topics
                .iter()
                .filter_map(Value::as_str)
                .filter(|topic| !topic.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_else(|| std::collections::HashSet::from(["*".to_string()]));
    let transient = match value.get("aiSessionTransient") {
        None | Some(Value::Null) => None,
        Some(value) => Some(serde_json::from_value(value.clone()).ok()?),
    };
    Some(ClientSubscription {
        topics,
        transient,
        compact: value.get("eventEnvelopeVersion").and_then(Value::as_str)
            == Some(COMPACT_EVENT_ENVELOPE_VERSION),
        subagents: value
            .get("aiSessionHierarchy")
            .and_then(|hierarchy| hierarchy.get("subagents"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn project_ai_session_event_for_consumer(
    event: &controlled_instance_protocol::EventEnvelope<Value>,
    subagents: bool,
) -> controlled_instance_protocol::EventEnvelope<Value> {
    let mut projected = event.clone();
    project_ai_session_stream_event_payload_for_consumer(
        &event.r#type,
        &mut projected.payload,
        subagents,
    );
    projected
}

fn subscribed(topics: &std::collections::HashSet<String>, topic: &str, event_type: &str) -> bool {
    topics.contains("*") || topics.contains(topic) || topics.contains(event_type)
}

fn enqueue_wire_event(
    wire: &EventWire,
    event: &controlled_instance_protocol::EventEnvelope<Value>,
    compact: bool,
    replay: bool,
) -> bool {
    let encoded = encode_event(event, compact, replay);
    wire.enqueue(Message::Text(encoded.into()))
}

async fn novnc_static(Path(rest): Path<String>, request: Request) -> Response {
    let Some(root) = crate::diagnostics::resolve_novnc_root() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "NOVNC_NOT_FOUND",
            "noVNC static files were not found. Install noVNC or set TASK_HANDOFF_NOVNC_ROOT to a directory containing vnc.html.",
        );
    };
    novnc_file_response(&root, &rest, request).await
}

async fn novnc_file_response(root: &std::path::Path, rest: &str, request: Request) -> Response {
    let relative = std::path::Path::new(&rest);
    if relative.components().any(|component| {
        !matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        return api_error(
            StatusCode::NOT_FOUND,
            "NOVNC_NOT_FOUND",
            "noVNC asset not found.",
        );
    }
    let path = root.join(relative);
    match serve_static_file(path, request).await {
        Ok(response) if response.status() == StatusCode::NOT_FOUND => api_error(
            StatusCode::NOT_FOUND,
            "NOVNC_NOT_FOUND",
            "noVNC asset not found.",
        ),
        Ok(response) => response.into_response(),
        Err(_) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "NOVNC_NOT_FOUND",
            "noVNC asset could not be read.",
        ),
    }
}

async fn serve_static_file(
    path: std::path::PathBuf,
    request: Request,
) -> Result<Response, std::io::Error> {
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let modified = metadata.modified().ok();
    let etag = modified.map(|modified| {
        let modified_ms = modified
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("W/\"{:x}-{modified_ms:x}\"", metadata.len())
    });
    let method = request.method().clone();
    if matches!(method, Method::GET | Method::HEAD)
        && etag.as_deref().is_some_and(|etag| {
            request
                .headers()
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| static_etag_matches(value, etag))
        })
    {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        let headers = response.headers_mut();
        if let Some(etag) = etag {
            if let Ok(value) = header::HeaderValue::from_str(&etag) {
                headers.insert(header::ETAG, value);
            }
        }
        if let Some(modified) = modified {
            if let Ok(value) = header::HeaderValue::from_str(
                &chrono::DateTime::<chrono::Utc>::from(modified)
                    .format("%a, %d %b %Y %H:%M:%S GMT")
                    .to_string(),
            ) {
                headers.insert(header::LAST_MODIFIED, value);
            }
        }
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("public, max-age=0"),
        );
        headers.insert(
            header::ACCEPT_RANGES,
            header::HeaderValue::from_static("bytes"),
        );
        return Ok(response);
    }
    let mut response = ServeFile::new(path)
        .oneshot(request)
        .await
        .expect("ServeFile is infallible")
        .into_response();
    if let Some(etag) = etag {
        if let Ok(value) = header::HeaderValue::from_str(&etag) {
            response.headers_mut().insert(header::ETAG, value);
        }
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=0"),
    );
    if let Some(content_type) = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        let utf8_type = content_type.starts_with("text/")
            || content_type.starts_with("application/javascript")
            || content_type.starts_with("application/json");
        if utf8_type && !content_type.contains("charset=") {
            if let Ok(value) =
                header::HeaderValue::from_str(&format!("{content_type}; charset=utf-8"))
            {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
        }
    }
    Ok(response)
}

fn static_etag_matches(value: &str, etag: &str) -> bool {
    let etag = etag.strip_prefix("W/").unwrap_or(etag);
    value.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
    })
}

async fn api_not_found() -> Response {
    api_error(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found.")
}

async fn auth_middleware(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api/") {
        return next.run(request).await;
    }
    let token = request_token(request.headers(), request.uri());
    if path == "/api/health" || path == "/api/auth/status" {
        return next.run(request).await;
    }
    if path == "/api/internal/instance-shell" {
        let expected = state.config.registration_token.as_deref();
        let authorized = state.config.control_mode == ControlMode::Controlled
            && expected
                .zip(token.as_deref())
                .map(|(expected, token)| tokens_match(expected, token))
                .unwrap_or(false);
        if !authorized {
            return api_error(
                StatusCode::FORBIDDEN,
                "INSTANCE_SHELL_UNAUTHORIZED",
                "Instance registration token is required.",
            );
        }
        return next.run(request).await;
    }
    if path.starts_with("/api/internal/agent-tools/") {
        let authorized = token
            .as_deref()
            .map(|token| tokens_match(state.story_tools.token(), token))
            .unwrap_or(false);
        if !authorized {
            return api_error(
                StatusCode::FORBIDDEN,
                "AGENT_TOOL_FORBIDDEN",
                "Agent tool token is required.",
            );
        }
        return next.run(request).await;
    }
    if path.starts_with("/api/internal/node-agent/")
        || path == "/api/internal/node-agent-connection"
    {
        let expected = state.config.registration_token.as_deref();
        let authorized = state.config.control_mode == ControlMode::Controlled
            && expected
                .zip(token.as_deref())
                .map(|(expected, token)| tokens_match(expected, token))
                .unwrap_or(false);
        if !authorized {
            return api_error(
                StatusCode::FORBIDDEN,
                "MANAGED_INSTANCE_CONTROL_FORBIDDEN",
                "Instance registration token is required.",
            );
        }
        return next.run(request).await;
    }
    let managed_model_forbidden = match path {
        "/api/internal/model-environment" => Some("MANAGED_MODEL_ENVIRONMENT_FORBIDDEN"),
        "/api/internal/model-catalog" => Some("MANAGED_MODEL_CATALOG_FORBIDDEN"),
        "/api/internal/codex-settings" => Some("CODEX_SETTINGS_FORBIDDEN"),
        "/api/internal/ai-session-persistence-settings" => {
            Some("AI_SESSION_PERSISTENCE_SETTINGS_FORBIDDEN")
        }
        _ => None,
    };
    if let Some(code) = managed_model_forbidden {
        let authorized = state
            .config
            .registration_token
            .as_deref()
            .zip(token.as_deref())
            .map(|(expected, token)| tokens_match(expected, token))
            .unwrap_or(false);
        if !authorized {
            return api_error(
                StatusCode::FORBIDDEN,
                code,
                "Instance registration token is required.",
            );
        }
        return next.run(request).await;
    }
    if !state.auth.accepts(token.as_deref()) {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Missing or invalid web token.",
        );
    }
    if request.method() != Method::GET {
        if let Some(session_id) = ai_session_path_id(path) {
            let session_id = percent_encoding::percent_decode_str(session_id).decode_utf8_lossy();
            if state.is_agent_run_member_session(&session_id) {
                return api_error(
                    StatusCode::CONFLICT,
                    "AGENT_RUN_MEMBER_SESSION_MANAGED",
                    "Agent Run member sessions are managed by the Node Agent and cannot be changed through the public AI Session API.",
                );
            }
        }
    }
    next.run(request).await
}

fn ai_session_path_id(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/api/ai-sessions/")?;
    let session_id = rest.split('/').next().unwrap_or_default();
    (!session_id.is_empty()).then_some(session_id)
}

fn request_token(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        let mut parts = value.splitn(2, char::is_whitespace);
        if parts
            .next()
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
        {
            let token = parts.next().unwrap_or_default().trim_start();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
}

fn tokens_match(expected: &str, actual: &str) -> bool {
    expected.as_bytes().ct_eq(actual.as_bytes()).into()
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(ApiErrorEnvelope {
            error: ApiError {
                code: code.to_string(),
                message: message.to_string(),
            },
        }),
    )
        .into_response()
}

async fn shutdown_signal(mut internal: tokio::sync::watch::Receiver<bool>) {
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    warn!(%error, "failed to install SIGTERM handler");
                    let _ = internal.changed().await;
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
            _ = internal.changed() => {},
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = internal.changed() => {},
        }
    }
}

pub fn default_static_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .and_then(|path| path.parent().map(|root| root.join("ui")))
        .unwrap_or_else(|| PathBuf::from("ui"))
}

pub fn bind_addr(host: &str, port: u16) -> anyhow::Result<SocketAddr> {
    use std::net::ToSocketAddrs;
    (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("no socket address resolved for {host}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::WebAuthState;
    use axum::body::Body;
    use controlled_instance_ai_session::AiSession;
    use controlled_instance_app_runtime::AppSession;
    use controlled_instance_core::paths::StoragePaths;
    use controlled_instance_protocol::{
        AiSessionCommandInput, AiSessionCommandResult, AiSessionMentionCandidate,
        AiSessionMentionCatalog, AiSessionMentionFileSearch, AiSessionMentionKind,
        AiSessionProviderActions, AiSessionProviderCapability,
        AiSessionProviderTimelineCapabilities, AppLaunchOptions,
    };
    use controlled_instance_workspace::ConfigSyncEnvironment;
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn config_sync_issues(value: Value) -> Value {
        serde_json::to_value(
            config_sync_batch_request(value).expect_err("config sync request should be rejected"),
        )
        .expect("validation issues")
    }

    #[tokio::test]
    async fn missing_static_ui_matches_the_node_plain_text_fallback_for_get_and_head() {
        let (mut state, root) = test_state();
        let mut config = (*state.config).clone();
        config.static_dir = root.path().join("missing-ui");
        state.config = Arc::new(config);
        let app = router(state);

        for method in [Method::GET, Method::HEAD] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method.clone())
                        .uri("/apps")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("static fallback");
            assert_eq!(response.status(), StatusCode::OK, "{method}");
            assert_eq!(
                response.headers().get(header::CONTENT_TYPE),
                Some(&header::HeaderValue::from_static(
                    "text/plain; charset=utf-8"
                ))
            );
            let body = response
                .into_body()
                .collect()
                .await
                .expect("body")
                .to_bytes();
            if method == Method::HEAD {
                assert!(body.is_empty());
            } else {
                assert_eq!(
                    String::from_utf8_lossy(&body),
                    "TaskHandoff Web UI has not been built yet. Run pnpm web:build."
                );
            }
        }
    }

    #[tokio::test]
    async fn novnc_static_files_support_node_equivalent_headers_ranges_and_head() {
        let root = tempfile::tempdir().expect("novnc root");
        std::fs::write(root.path().join("vnc.html"), "0123456789").expect("vnc html");

        let full = novnc_file_response(
            root.path(),
            "vnc.html",
            Request::builder()
                .uri("/api/novnc/vnc.html")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(
            full.headers().get(header::CONTENT_TYPE),
            Some(&header::HeaderValue::from_static(
                "text/html; charset=utf-8"
            ))
        );
        assert_eq!(
            full.headers().get(header::CACHE_CONTROL),
            Some(&header::HeaderValue::from_static("public, max-age=0"))
        );
        let etag = full
            .headers()
            .get(header::ETAG)
            .expect("etag")
            .to_str()
            .expect("etag string")
            .to_string();
        assert_eq!(
            full.into_body().collect().await.expect("body").to_bytes(),
            "0123456789"
        );

        let range = novnc_file_response(
            root.path(),
            "vnc.html",
            Request::builder()
                .uri("/api/novnc/vnc.html")
                .header(header::RANGE, "bytes=2-5")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            range.headers().get(header::CONTENT_RANGE),
            Some(&header::HeaderValue::from_static("bytes 2-5/10"))
        );
        assert_eq!(
            range.into_body().collect().await.expect("body").to_bytes(),
            "2345"
        );

        let head = novnc_file_response(
            root.path(),
            "vnc.html",
            Request::builder()
                .method(Method::HEAD)
                .uri("/api/novnc/vnc.html")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(
            head.headers().get(header::CONTENT_LENGTH),
            Some(&"10".parse().expect("length"))
        );
        assert!(head
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .is_empty());

        let not_modified = novnc_file_response(
            root.path(),
            "vnc.html",
            Request::builder()
                .uri("/api/novnc/vnc.html")
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
        assert!(not_modified
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .is_empty());

        let traversal = novnc_file_response(
            root.path(),
            "../secret",
            Request::builder()
                .uri("/api/novnc/../secret")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(traversal.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(traversal).await["error"]["code"],
            "NOVNC_NOT_FOUND"
        );
    }

    #[test]
    fn request_tokens_match_the_node_bearer_and_query_boundaries() {
        let token = |authorization: Option<&str>, uri: &str| {
            let mut headers = HeaderMap::new();
            if let Some(authorization) = authorization {
                headers.insert(
                    header::AUTHORIZATION,
                    authorization.parse().expect("authorization header"),
                );
            }
            request_token(&headers, &uri.parse().expect("uri"))
        };
        assert_eq!(
            token(Some("Bearer token  "), "/api/status"),
            Some("token  ".to_string())
        );
        assert_eq!(
            token(None, "/api/status?token=first&token=second"),
            Some("first".to_string())
        );
        assert_eq!(
            token(Some("Bearer "), "/api/status?token=query"),
            Some("query".to_string())
        );
        assert_eq!(token(None, "/api/status?token="), None);
    }

    #[test]
    fn config_sync_validation_matches_zod_array_issue_paths() {
        assert_eq!(
            config_sync_issues(json!({
                "direction": "import",
                "programIds": "codex",
                "workspaceFolder": "."
            })),
            json!([{
                "expected": "array",
                "code": "invalid_type",
                "path": ["programIds"],
                "message": "Invalid input: expected array, received string"
            }])
        );
        assert_eq!(
            config_sync_issues(json!({
                "direction": "import",
                "programIds": ["codex", 2],
                "workspaceFolder": "."
            })),
            json!([{
                "expected": "string",
                "code": "invalid_type",
                "path": ["programIds", 1],
                "message": "Invalid input: expected string, received number"
            }])
        );
    }

    #[test]
    fn config_sync_validation_trims_and_enforces_zod_constraints() {
        let request = config_sync_batch_request(json!({
            "direction": "import",
            "programIds": [" codex "],
            "workspaceFolder": "  project  "
        }))
        .expect("trimmed request");
        assert_eq!(request.program_ids, vec!["codex"]);
        assert_eq!(request.workspace_folder, "project");

        assert_eq!(
            config_sync_issues(json!({
                "direction": "import",
                "programIds": ["codex", " codex "],
                "workspaceFolder": "."
            })),
            json!([{
                "code": "custom",
                "path": ["programIds"],
                "message": "Config sync program ids must be unique."
            }])
        );
    }

    #[derive(Clone)]
    struct DurableTimelineProvider(controlled_instance_ai_session::AiSessionTimelineStore);

    #[async_trait::async_trait]
    impl controlled_instance_ai_session::AiSessionControlProvider for DurableTimelineProvider {
        fn agent(&self) -> &str {
            "codex"
        }

        fn capability(&self) -> AiSessionProviderCapability {
            AiSessionProviderCapability {
                agent: "codex".to_string(),
                actions: AiSessionProviderActions::default(),
                permission_modes: Vec::new(),
                timeline: AiSessionProviderTimelineCapabilities {
                    session_read: true,
                    turn_read: true,
                    live_items: false,
                },
                model_selection: None,
                reasoning_effort: None,
                hierarchy: None,
            }
        }

        async fn timeline(
            &self,
            session: &AiSession,
        ) -> Result<
            controlled_instance_protocol::AiSessionTimeline,
            controlled_instance_ai_session::ProviderError,
        > {
            self.0.timeline(session).map_err(|error| {
                controlled_instance_ai_session::ProviderError::bad_gateway(
                    "AI_SESSION_TIMELINE_UNAVAILABLE",
                    error.to_string(),
                )
            })
        }

        async fn turn_timeline(
            &self,
            session: &AiSession,
            turn_id: &str,
        ) -> Result<
            controlled_instance_protocol::AiSessionTurnTimeline,
            controlled_instance_ai_session::ProviderError,
        > {
            self.0.turn_timeline(session, turn_id).map_err(|error| {
                controlled_instance_ai_session::ProviderError::bad_gateway(
                    "AI_SESSION_TIMELINE_UNAVAILABLE",
                    error.to_string(),
                )
            })
        }

        async fn mention_catalog(
            &self,
            session: &AiSession,
        ) -> Result<
            controlled_instance_protocol::AiSessionMentionCatalog,
            controlled_instance_ai_session::ProviderError,
        > {
            Ok(AiSessionMentionCatalog {
                session_id: session.id.clone(),
                provider_session_id: session.provider_session_id.clone().unwrap_or_default(),
                cwd: session.cwd.clone().unwrap_or_default(),
                candidates: vec![AiSessionMentionCandidate {
                    kind: AiSessionMentionKind::File,
                    name: "main.rs".to_string(),
                    description: None,
                    path: "src/main.rs".to_string(),
                    icon: None,
                }],
                diagnostics: Vec::new(),
            })
        }

        async fn search_mention_files(
            &self,
            session: &AiSession,
            query: &str,
        ) -> Result<
            controlled_instance_protocol::AiSessionMentionFileSearch,
            controlled_instance_ai_session::ProviderError,
        > {
            Ok(AiSessionMentionFileSearch {
                session_id: session.id.clone(),
                cwd: session.cwd.clone().unwrap_or_default(),
                query: query.to_string(),
                request_id: "mention_fixture".to_string(),
                candidates: Vec::new(),
                complete: true,
            })
        }

        async fn execute_command(
            &self,
            _session: &AiSession,
            input: &AiSessionCommandInput,
        ) -> Result<
            controlled_instance_protocol::AiSessionCommandResult,
            controlled_instance_ai_session::ProviderError,
        > {
            Ok(AiSessionCommandResult {
                command: input.command,
                value: input.argument.clone(),
                turn_id: None,
            })
        }

        async fn resume_session(
            &self,
            session: &AiSession,
        ) -> Result<
            controlled_instance_ai_session::ProviderResumeResult,
            controlled_instance_ai_session::ProviderError,
        > {
            Ok(controlled_instance_ai_session::ProviderResumeResult {
                model_selection: session
                    .model_selection
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok()),
                reasoning_effort: session.reasoning_effort.clone(),
            })
        }

        async fn archive_session(
            &self,
            _provider_session_id: &str,
        ) -> Result<(), controlled_instance_ai_session::ProviderError> {
            Ok(())
        }

        async fn delete_session(
            &self,
            _provider_session_id: &str,
        ) -> Result<(), controlled_instance_ai_session::ProviderError> {
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FailingCreateProvider(controlled_instance_ai_session::ProviderError);

    #[async_trait::async_trait]
    impl controlled_instance_ai_session::AiSessionControlProvider for FailingCreateProvider {
        fn agent(&self) -> &str {
            "codex"
        }

        fn capability(&self) -> AiSessionProviderCapability {
            AiSessionProviderCapability {
                agent: "codex".to_string(),
                actions: AiSessionProviderActions::default(),
                permission_modes: Vec::new(),
                timeline: AiSessionProviderTimelineCapabilities::default(),
                model_selection: None,
                reasoning_effort: None,
                hierarchy: None,
            }
        }

        async fn create_session(
            &self,
            _input: controlled_instance_ai_session::ProviderCreateInput,
        ) -> Result<
            controlled_instance_ai_session::ProviderCreateResult,
            controlled_instance_ai_session::ProviderError,
        > {
            Err(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct TriggerSendProvider;

    #[async_trait::async_trait]
    impl controlled_instance_ai_session::AiSessionControlProvider for TriggerSendProvider {
        fn agent(&self) -> &str {
            "codex"
        }

        fn capability(&self) -> AiSessionProviderCapability {
            AiSessionProviderCapability {
                agent: "codex".to_string(),
                actions: AiSessionProviderActions {
                    send: true,
                    queue: true,
                    steer: true,
                    ..AiSessionProviderActions::default()
                },
                permission_modes: Vec::new(),
                timeline: AiSessionProviderTimelineCapabilities::default(),
                model_selection: None,
                reasoning_effort: None,
                hierarchy: None,
            }
        }

        async fn start_message(
            &self,
            _session: &AiSession,
            _input: controlled_instance_ai_session::ProviderMessage,
        ) -> Result<
            controlled_instance_ai_session::ProviderAction,
            controlled_instance_ai_session::ProviderError,
        > {
            Ok(controlled_instance_ai_session::ProviderAction {
                action: "send".to_string(),
                turn_id: Some("trigger-turn".to_string()),
                provider_turn_id: Some("provider-trigger-turn".to_string()),
                decision: None,
                queue_id: None,
            })
        }

        async fn steer_message(
            &self,
            _session: &AiSession,
            _input: controlled_instance_ai_session::ProviderMessage,
        ) -> Result<
            controlled_instance_ai_session::ProviderAction,
            controlled_instance_ai_session::ProviderError,
        > {
            Ok(controlled_instance_ai_session::ProviderAction {
                action: "steer".to_string(),
                turn_id: Some("turn-2".to_string()),
                provider_turn_id: Some("provider-turn-2".to_string()),
                decision: None,
                queue_id: None,
            })
        }
    }

    fn test_state() -> (AppState, tempfile::TempDir) {
        test_state_with_control_mode(ControlMode::Controlled)
    }

    fn test_state_standalone() -> (AppState, tempfile::TempDir) {
        test_state_with_control_mode(ControlMode::Standalone)
    }

    fn test_state_with_control_mode(control_mode: ControlMode) -> (AppState, tempfile::TempDir) {
        let root = tempfile::tempdir().expect("tempdir");
        let ui = root.path().join("ui");
        std::fs::create_dir_all(&ui).expect("ui dir");
        std::fs::write(ui.join("index.html"), "<html>frozen ui</html>").expect("index");
        let data = root.path().join("data");
        let paths = StoragePaths {
            config_path: data.join("config.json"),
            data_dir: data.clone(),
            app_catalog_dir: data.join("app-catalog"),
            app_sessions_dir: data.join("app-sessions"),
            triggers_dir: data.join("triggers"),
            runtime_dir: data.join("runtime"),
            events_dir: data.join("events"),
            artifact_dir: data.join("artifacts"),
            log_dir: data.join("logs"),
            web_token_path: data.join("web-token"),
        };
        let mut config = InstanceConfig::for_test(ui, paths);
        config.control_mode = control_mode;
        let mut state = AppState::new(config, WebAuthState::disabled(None));
        let environment = ConfigSyncEnvironment {
            home: root.path().join("home"),
            workspace: root.path().join("workspace"),
            codex_home: root.path().join("home/.codex"),
            claude_home: root.path().join("home/.claude"),
            data_dir: data.clone(),
            log_dir: data.join("logs"),
            artifact_dir: data.join("artifacts"),
        };
        let model_config = crate::ControlledModelConfig::load(
            &state.config.instance_id,
            control_mode,
            &environment,
            std::collections::BTreeMap::from([
                (
                    "HOME".to_string(),
                    root.path().join("home").display().to_string(),
                ),
                (
                    "CODEX_HOME".to_string(),
                    root.path().join("home/.codex").display().to_string(),
                ),
                (
                    "CLAUDE_HOME".to_string(),
                    root.path().join("home/.claude").display().to_string(),
                ),
                (
                    "TASK_HANDOFF_REGISTRATION_TOKEN".to_string(),
                    "test-registration-token".to_string(),
                ),
            ]),
            &state.started_at,
        )
        .expect("model config");
        model_config.sync_app_environment(&state.app_runtime);
        state.controlled_models = Arc::new(model_config);
        state.config_sync_environment = environment;
        (state, root)
    }

    async fn body_json(response: Response) -> Value {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        serde_json::from_slice(&bytes).expect("json")
    }

    fn git_stdout(root: &std::path::Path, args: &[&str]) -> String {
        use std::process::Command;

        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("git command");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn git_repository() -> tempfile::TempDir {
        let repository = tempfile::tempdir().expect("repository");
        git_stdout(repository.path(), &["init", "-q"]);
        git_stdout(
            repository.path(),
            &["symbolic-ref", "HEAD", "refs/heads/main"],
        );
        git_stdout(
            repository.path(),
            &["config", "user.email", "controlled-instance@example.test"],
        );
        git_stdout(
            repository.path(),
            &["config", "user.name", "Controlled Instance"],
        );
        std::fs::write(repository.path().join("README.md"), "first\n").expect("readme");
        git_stdout(repository.path(), &["add", "README.md"]);
        git_stdout(repository.path(), &["commit", "-q", "-m", "initial"]);
        repository
    }

    async fn post_json(app: &Router, uri: &str, body: Value) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&body).expect("json body")))
                    .expect("request"),
            )
            .await
            .expect("response")
    }

    async fn get_json(app: &Router, uri: &str) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response")
    }

    fn managed_worktree_path(managed_root: &std::path::Path, worktree_id: &str) -> PathBuf {
        let registry: Value = serde_json::from_slice(
            &std::fs::read(managed_root.join("registry.json")).expect("registry"),
        )
        .expect("registry json");
        let path = registry["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["worktreeId"] == worktree_id)
            .and_then(|entry| entry["path"].as_str())
            .expect("managed worktree entry");
        PathBuf::from(path)
    }

    fn ai_session_record(id: &str, app_session_id: &str) -> AiSession {
        serde_json::from_value(json!({
            "id": id,
            "agent": "codex",
            "creationSource": "app-session",
            "appSessionId": app_session_id,
            "providerSessionId": "provider-thread",
            "title": "Initial title",
            "cwd": "/workspace",
            "turns": [
                {
                    "id": "turn-1",
                    "providerTurnId": "provider-turn-1",
                    "userPrompt": "First prompt",
                    "status": "completed",
                    "phase": "responding",
                    "revision": 1,
                    "startedAt": "2026-11-02T00:00:00.000Z",
                    "updatedAt": "2026-11-02T00:01:00.000Z"
                },
                {
                    "id": "turn-2",
                    "providerTurnId": "provider-turn-2",
                    "userPrompt": "Second prompt",
                    "status": "running",
                    "phase": "thinking",
                    "revision": 2,
                    "startedAt": "2026-11-02T00:02:00.000Z",
                    "updatedAt": "2026-11-02T00:03:00.000Z"
                }
            ],
            "unread": true,
            "status": "running",
            "phase": "thinking",
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        }))
        .expect("AI session")
    }

    fn app_session_record(id: &str, app_id: &str, status: &str) -> AppSession {
        serde_json::from_value(json!({
            "id": id,
            "appId": app_id,
            "title": app_id,
            "kind": "tty",
            "status": status,
            "createdAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z",
            "workspace": { "cwd": "/workspace" },
            "paths": { "sessionDir": "/tmp/session", "logDir": "/tmp/logs" }
        }))
        .expect("app session")
    }

    #[tokio::test]
    async fn health_and_frozen_ui_are_available() {
        let (state, _root) = test_state();
        let app = router(state.clone());

        let invalid = post_json(
            &app,
            "/api/triggers",
            json!({
                "name": "Invalid",
                "source": { "type": "schedule", "intervalMs": 60000, "timezone": "UTC" },
                "action": { "promptTemplate": "Run" },
                "deployment": {
                    "target": { "type": "ai-session", "aiSessionId": "ses_0000000000001" }
                }
            }),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(invalid).await["error"]["code"], "TRIGGER_INVALID");
        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("health");
        assert_eq!(health.status(), StatusCode::OK);
        let health = body_json(health).await;
        assert_eq!(health["data"]["ok"], true);
        let capabilities = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/instance/capabilities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("capabilities");
        assert_eq!(capabilities.status(), StatusCode::OK);
        let capabilities = body_json(capabilities).await;
        assert_eq!(
            capabilities["data"]["features"]["privateModelCatalog"],
            true
        );
        assert_eq!(
            capabilities["data"]["features"]["codexManagedSettings"],
            true
        );
        assert_eq!(
            capabilities["data"]["features"]["managedModelEnvironment"]["openCodeConfig"],
            true
        );
        assert_eq!(
            capabilities["data"]["features"]["modelRelay"]["protocols"],
            json!([
                "openai-responses",
                "openai-chat-completions",
                "anthropic-messages"
            ])
        );
        for route in ["/triggers", "/apps", "/unknown-ui-route"] {
            let fallback = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(route)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("UI route refresh");
            assert_eq!(fallback.status(), StatusCode::OK, "{route}");
            let body = fallback
                .into_body()
                .collect()
                .await
                .expect("body")
                .to_bytes();
            assert!(
                String::from_utf8_lossy(&body).contains("frozen ui"),
                "{route}"
            );
        }
        let missing_api = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/unknown")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("missing API");
        assert_eq!(missing_api.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(missing_api).await["error"]["code"], "NOT_FOUND");
        let index = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("index");
        assert_eq!(index.status(), StatusCode::OK);
        let body = index.into_body().collect().await.expect("body").to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("frozen ui"));
    }

    #[tokio::test]
    async fn trigger_routes_cover_store_mutations_manual_runs_and_events() {
        let (state, _root) = test_state();
        state
            .ai_session_controller
            .register_provider(Arc::new(TriggerSendProvider));
        let mut session = ai_session_record("ses_0000000000001", "app-session-1");
        session.status = "idle".to_string();
        session.phase = "unknown".to_string();
        session.active_turn_id = None;
        state.ai_sessions.save(session).expect("seed session");
        let mut events = state.events.subscribe();
        let app = router(state.clone());

        let created = post_json(
            &app,
            "/api/triggers",
            json!({
                "name": "  Trigger smoke  ",
                "source": {
                    "type": "schedule",
                    "intervalMs": 60000
                },
                "action": { "promptTemplate": "Run {{trigger.name}} for {{event.type}}" },
                "policy": { "maxConcurrentRuns": 1, "whenBusy": "skip" },
                "deployment": {
                    "deploymentId": "dep-smoke",
                    "origin": "controlled-instance",
                    "target": { "type": "ai-session", "aiSessionId": "ses_0000000000001" }
                }
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created = body_json(created).await;
        let config_hash = created["data"]["config"]["configHash"]
            .as_str()
            .expect("config hash")
            .to_string();
        assert_eq!(created["data"]["config"]["name"], "Trigger smoke");
        assert_eq!(created["data"]["runtime"]["status"], "idle");

        let listed = get_json(&app, "/api/triggers").await;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = body_json(listed).await;
        assert_eq!(
            listed["data"]["configs"].as_array().expect("configs").len(),
            1
        );

        let fetched = get_json(&app, &format!("/api/triggers/{config_hash}")).await;
        assert_eq!(fetched.status(), StatusCode::OK);
        assert_eq!(
            body_json(fetched).await["data"]["deployments"][0]["deploymentId"],
            "dep-smoke"
        );

        let patched = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/triggers/{config_hash}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "description": null })).expect("json"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("patch");
        assert_eq!(patched.status(), StatusCode::OK);
        assert!(body_json(patched).await["data"]
            .get("description")
            .is_none());

        let disabled = post_json(
            &app,
            &format!("/api/triggers/{config_hash}/disable"),
            json!({}),
        )
        .await;
        assert_eq!(disabled.status(), StatusCode::OK);
        assert_eq!(
            body_json(disabled).await["data"]["runtime"][0]["status"],
            "disabled"
        );
        let enabled = post_json(
            &app,
            &format!("/api/triggers/{config_hash}/enable"),
            json!({}),
        )
        .await;
        assert_eq!(enabled.status(), StatusCode::OK);

        state.set_draining(true);
        let draining = post_json(
            &app,
            &format!("/api/triggers/{config_hash}/run"),
            json!({ "promptOverride": "blocked" }),
        )
        .await;
        assert_eq!(draining.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(draining).await["error"]["code"],
            "TRIGGER_RUNTIME_DRAINING"
        );
        state.set_draining(false);

        let run = post_json(
            &app,
            &format!("/api/triggers/{config_hash}/run"),
            json!({ "promptOverride": "Triggered {{trigger.name}}" }),
        )
        .await;
        assert_eq!(run.status(), StatusCode::OK);
        let run = body_json(run).await;
        assert_eq!(run["data"]["run"]["status"], "completed");
        assert_eq!(run["data"]["run"]["eventType"], "manual");
        assert_eq!(run["data"]["result"]["action"], "send");

        let runs = get_json(&app, "/api/triggers/runs").await;
        assert_eq!(runs.status(), StatusCode::OK);
        assert_eq!(body_json(runs).await["data"][0]["status"], "completed");

        let status = get_json(&app, "/api/instance/status").await;
        assert_eq!(status.status(), StatusCode::OK);
        assert_eq!(
            body_json(status).await["data"]["triggers"]["enabledCount"],
            1
        );

        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            seen.push(event.r#type);
        }
        for expected in [
            "trigger.created",
            "trigger.updated",
            "trigger.disabled",
            "trigger.enabled",
            "trigger.run.started",
            "trigger.run.completed",
        ] {
            assert!(
                seen.iter().any(|event| event == expected),
                "missing {expected}"
            );
        }

        let deployment_deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/triggers/{config_hash}/deployments/dep-smoke"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delete deployment");
        assert_eq!(deployment_deleted.status(), StatusCode::OK);
        let missing = get_json(&app, &format!("/api/triggers/{config_hash}")).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn app_session_routes_cover_catalog_lifecycle_logs_and_events() {
        let (state, _root) = test_state();
        state.start_app_session_services();
        let mut events = state.events.subscribe();
        let app = router(state.clone());

        let catalog = get_json(&app, "/api/apps/catalog").await;
        assert_eq!(catalog.status(), StatusCode::OK);
        let catalog = body_json(catalog).await;
        assert!(catalog["data"]
            .as_array()
            .expect("catalog")
            .iter()
            .any(|item| item["id"] == "terminal-tty"));

        let custom = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/apps/catalog/custom")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "items": [{
                                "id": "fixture-shell",
                                "name": "Fixture Shell",
                                "kind": "tty",
                                "command": "/bin/sh"
                            }]
                        }))
                        .expect("json"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("custom catalog");
        assert_eq!(custom.status(), StatusCode::OK);
        assert_eq!(
            body_json(custom).await["data"]["items"][0]["id"],
            "fixture-shell"
        );

        let created = post_json(
            &app,
            "/api/apps/sessions",
            json!({
                "appId": "fixture-shell",
                "title": "Running fixture",
                "args": ["-c", "cat"],
                "cwd": state.config.workspace_path
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created = body_json(created).await;
        let id = created["data"]["id"].as_str().expect("app id").to_string();
        assert_eq!(created["data"]["status"], "running");
        assert_eq!(created["data"]["title"], "Running fixture");

        let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("event");
                if event.r#type.starts_with("app-session.") {
                    break event;
                }
            }
        })
        .await
        .expect("app event");
        assert_eq!(event.r#type, "app-session.snapshot");

        let state_response = get_json(&app, "/api/apps/sessions/state").await;
        assert_eq!(state_response.status(), StatusCode::OK);
        let state_response = body_json(state_response).await;
        assert_eq!(state_response["data"]["snapshot"]["runningCount"], 1);
        let stream_id = state_response["data"]["streamId"]
            .as_str()
            .expect("stream id")
            .to_string();
        let revision = state_response["data"]["revision"]
            .as_u64()
            .expect("revision");
        let delta = get_json(
            &app,
            &format!("/api/apps/sessions?streamId={stream_id}&sinceRevision={revision}"),
        )
        .await;
        assert_eq!(delta.status(), StatusCode::OK);
        assert_eq!(body_json(delta).await["data"]["syncRequired"], false);

        let renamed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/apps/sessions/{id}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"Renamed"}"#))
                    .expect("request"),
            )
            .await
            .expect("rename");
        assert_eq!(renamed.status(), StatusCode::OK);
        assert_eq!(body_json(renamed).await["data"]["title"], "Renamed");
        assert_eq!(
            state
                .app_runtime
                .get_session(&id)
                .and_then(|session| session.launch)
                .and_then(|launch| launch.title)
                .as_deref(),
            Some("Renamed")
        );
        let invalid_rename = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/apps/sessions/{id}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"   "}"#))
                    .expect("request"),
            )
            .await
            .expect("rename");
        assert_eq!(invalid_rename.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(invalid_rename).await["error"]["code"],
            "APP_SESSION_UPDATE_INVALID"
        );

        let logs = get_json(&app, &format!("/api/apps/sessions/{id}/logs?maxBytes=2048")).await;
        assert_eq!(logs.status(), StatusCode::OK);
        let logs = body_json(logs).await;
        assert_eq!(logs["data"]["sessionId"], id);
        assert_eq!(logs["data"]["maxBytes"], 2048);

        let stopped = post_json(&app, &format!("/api/apps/sessions/{id}/stop"), json!({})).await;
        assert_eq!(stopped.status(), StatusCode::OK);
        assert_eq!(body_json(stopped).await["data"]["status"], "stopped");

        let deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/apps/sessions/{id}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delete");
        assert_eq!(deleted.status(), StatusCode::OK);
        assert!(state.app_runtime.get_session(&id).is_none());
    }

    #[tokio::test]
    async fn provider_transient_events_keep_the_authoritative_session_identity() {
        let (state, _root) = test_state();
        let mut session = ai_session_record("ses_0000000000001", "app-session-1");
        session.creation_source = "ai-session".to_string();
        session.provider_session_id = Some("provider-live".to_string());
        state.ai_sessions.save(session).expect("seed session");
        let mut events = state.events.subscribe();

        state.publish_ai_session_transient_event(
            controlled_instance_ai_session::ProviderEvent::AgentMessageDelta {
                provider_session_id: "provider-live".to_string(),
                turn_id: "turn-live".to_string(),
                item_id: "message-live".to_string(),
                delta: "hello".to_string(),
            },
        );
        let delta = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .expect("message delta")
            .expect("event");
        assert_eq!(delta.r#type, "ai-session.message-delta");
        assert_eq!(delta.topic, "ai.sessions");
        assert_eq!(delta.payload["instanceId"], state.config.instance_id);
        assert_eq!(delta.payload["sessionId"], "ses_0000000000001");
        assert_eq!(delta.payload["providerSessionId"], "provider-live");
        assert_eq!(delta.payload["turnId"], "turn-live");
        assert_eq!(delta.payload["itemId"], "message-live");
        assert_eq!(delta.payload["delta"], "hello");
        assert!(delta.payload.get("generatedAt").is_some());

        state.publish_ai_session_transient_event(
            controlled_instance_ai_session::ProviderEvent::TimelineItemDelta {
                provider_session_id: "provider-live".to_string(),
                turn_id: "turn-live".to_string(),
                item_id: "reasoning-live".to_string(),
                field: "output".to_string(),
                delta: "thinking".to_string(),
            },
        );
        let timeline_delta = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .expect("timeline delta")
            .expect("event");
        assert_eq!(timeline_delta.r#type, "ai-session.timeline-item-delta");
        assert_eq!(timeline_delta.payload["sessionId"], "ses_0000000000001");
        assert_eq!(timeline_delta.payload["providerSessionId"], "provider-live");
        assert_eq!(timeline_delta.payload["itemId"], "reasoning-live");
        assert_eq!(timeline_delta.payload["field"], "output");

        state.publish_ai_session_transient_event(
            controlled_instance_ai_session::ProviderEvent::TimelineItem {
                provider_session_id: "provider-live".to_string(),
                item: controlled_instance_protocol::AiSessionTimelineItem::Activity {
                    id: "retry-live".to_string(),
                    turn_id: "turn-live".to_string(),
                    activity_kind: "retry".to_string(),
                    title: "Retry".to_string(),
                    status: Some(
                        controlled_instance_protocol::AiSessionTimelineActivityStatus::Waiting,
                    ),
                    summary: Some("Provider is busy".to_string()),
                    input: None,
                    output: None,
                    paths: None,
                    exit_code: None,
                    duration_ms: None,
                },
            },
        );
        let item = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .expect("timeline item")
            .expect("event");
        assert_eq!(item.r#type, "ai-session.timeline-item");
        assert_eq!(item.payload["sessionId"], "ses_0000000000001");
        assert_eq!(item.payload["providerSessionId"], "provider-live");
        assert_eq!(item.payload["item"]["id"], "retry-live");
        assert_eq!(item.payload["item"]["activityKind"], "retry");
        assert_eq!(item.payload["item"]["status"], "waiting");
    }

    #[tokio::test]
    async fn app_profile_routes_cover_crud_defaults_conflicts_and_busy_sessions() {
        let (state, _root) = test_state();
        let app = router(state.clone());

        let initial = get_json(&app, "/api/apps/chromium/profiles").await;
        assert_eq!(initial.status(), StatusCode::OK);
        let initial = body_json(initial).await;
        let original_default = initial["data"]["defaultProfileId"]
            .as_str()
            .expect("default profile")
            .to_string();
        assert_eq!(
            initial["data"]["profiles"]
                .as_array()
                .expect("profiles")
                .len(),
            1
        );

        let created = post_json(
            &app,
            "/api/apps/chromium/profiles",
            json!({ "name": "Work" }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created = body_json(created).await;
        let work_id = created["data"]["id"]
            .as_str()
            .expect("work profile")
            .to_string();
        assert_eq!(created["data"]["isDefault"], false);

        let renamed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/apps/chromium/profiles/{work_id}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"name":"Work Renamed"}"#))
                    .expect("request"),
            )
            .await
            .expect("rename profile");
        assert_eq!(renamed.status(), StatusCode::OK);
        assert_eq!(body_json(renamed).await["data"]["name"], "Work Renamed");

        let conflict = post_json(
            &app,
            "/api/apps/chromium/profiles",
            json!({ "name": "Default" }),
        )
        .await;
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(conflict).await["error"]["code"],
            "BROWSER_PROFILE_NAME_CONFLICT"
        );

        let invalid = post_json(
            &app,
            "/api/apps/chromium/profiles",
            json!({ "name": "   " }),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(invalid).await["error"]["code"],
            "APP_PROFILE_CREATE_FAILED"
        );

        let unsupported = get_json(&app, "/api/apps/terminal-tty/profiles").await;
        assert_eq!(unsupported.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(unsupported).await["error"]["code"],
            "BROWSER_PROFILE_UNSUPPORTED"
        );

        let set_default = post_json(
            &app,
            &format!("/api/apps/chromium/profiles/{work_id}/default"),
            json!({}),
        )
        .await;
        assert_eq!(set_default.status(), StatusCode::OK);
        assert_eq!(body_json(set_default).await["data"]["isDefault"], true);

        let old_default = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/apps/chromium/profiles/{original_default}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delete old default");
        assert_eq!(old_default.status(), StatusCode::OK);

        let protected = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/apps/chromium/profiles/{work_id}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delete default");
        assert_eq!(protected.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(protected).await["error"]["code"],
            "BROWSER_PROFILE_DEFAULT_PROTECTED"
        );

        let spare = post_json(
            &app,
            "/api/apps/chromium/profiles",
            json!({ "name": "Spare" }),
        )
        .await;
        let spare_id = body_json(spare).await["data"]["id"]
            .as_str()
            .expect("spare profile")
            .to_string();
        let set_spare = post_json(
            &app,
            &format!("/api/apps/chromium/profiles/{spare_id}/default"),
            json!({}),
        )
        .await;
        assert_eq!(set_spare.status(), StatusCode::OK);

        let tty = state
            .app_runtime
            .start(
                "terminal-tty",
                AppLaunchOptions {
                    args: vec!["-c".to_string(), "cat".to_string()],
                    ..AppLaunchOptions::default()
                },
            )
            .await
            .expect("tty session");
        let mut busy = tty.clone();
        busy.id = "app_profile_busy".to_string();
        busy.app_id = "chromium".to_string();
        busy.launch.as_mut().expect("launch options").profile_id = Some(work_id.clone());
        state.app_runtime.insert_session(busy);

        let busy_list = get_json(&app, "/api/apps/chromium/profiles").await;
        assert_eq!(busy_list.status(), StatusCode::OK);
        let busy_list = body_json(busy_list).await;
        let busy_profile = busy_list["data"]["profiles"]
            .as_array()
            .expect("profiles")
            .iter()
            .find(|profile| profile["id"] == work_id)
            .expect("busy profile");
        assert_eq!(busy_profile["runningSessionId"], "app_profile_busy");

        let busy_delete = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/apps/chromium/profiles/{work_id}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delete busy profile");
        assert_eq!(busy_delete.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(busy_delete).await["error"]["code"],
            "BROWSER_PROFILE_BUSY"
        );

        state
            .app_runtime
            .stop_session(&tty.id)
            .await
            .expect("stop tty");
    }

    #[tokio::test]
    async fn app_management_routes_keep_agent_projection_and_error_contracts() {
        let (state, _root) = test_state();
        let app = router(state);

        let snapshot = get_json(&app, "/api/apps/management").await;
        assert_eq!(snapshot.status(), StatusCode::OK);
        let snapshot = body_json(snapshot).await;
        assert!(snapshot["data"]["streamId"]
            .as_str()
            .is_some_and(|value| value.starts_with("appstream_")));
        assert!(snapshot["data"]["sequence"].is_u64());
        assert!(snapshot["data"]["capabilities"]["platform"].is_string());
        let apps = snapshot["data"]["apps"].as_array().expect("apps");
        assert!(apps.iter().any(|app| app["id"] == "codex"));
        assert!(apps.iter().any(|app| app["id"] == "thctl"));

        let unknown = post_json(&app, "/api/apps/not-an-app/install", json!({})).await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(unknown).await["error"]["code"], "unknown_app");

        let bundled = post_json(&app, "/api/apps/terminal-tty/install", json!({})).await;
        assert_eq!(bundled.status(), StatusCode::CONFLICT);
        let bundled = body_json(bundled).await;
        assert_eq!(bundled["error"]["code"], "app_operation_unavailable");
        assert_eq!(bundled["error"]["details"]["reason"]["code"], "BUNDLED");

        let check = post_json(&app, "/api/apps/terminal-tty/update-check", json!({})).await;
        assert_eq!(check.status(), StatusCode::CONFLICT);

        let invalid_request = post_json(
            &app,
            "/api/apps/codex/install",
            json!({ "requestId": "INVALID" }),
        )
        .await;
        assert_eq!(invalid_request.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(invalid_request).await["error"]["code"],
            "app_management_input_invalid"
        );

        let missing_job = get_json(&app, "/api/apps/jobs/appjob_0000000000000").await;
        assert_eq!(missing_job.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(missing_job).await["error"]["code"],
            "app_job_not_found"
        );
    }

    #[tokio::test]
    async fn app_vnc_web_trailing_slash_alias_matches_node_wildcard() {
        let (state, _root) = test_state();
        let app = router(state);

        let without_slash = get_json(&app, "/api/apps/sessions/missing/web").await;
        assert_eq!(without_slash.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(without_slash).await["error"]["code"], "NOT_FOUND");

        let trailing_slash = get_json(&app, "/api/apps/sessions/missing/web/").await;
        assert_eq!(trailing_slash.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(trailing_slash).await["error"]["code"],
            "WEB_SESSION_NOT_FOUND"
        );
    }

    #[tokio::test]
    async fn config_sync_routes_preserve_batch_folder_and_profile_contracts() {
        let (state, root) = test_state();
        std::fs::create_dir_all(root.path().join("workspace/project/config")).expect("workspace");
        std::fs::write(
            root.path().join("workspace/project/config/example"),
            "fixture",
        )
        .expect("fixture");
        let app = router(state.clone());

        let presets = get_json(&app, "/api/config-sync/presets").await;
        assert_eq!(presets.status(), StatusCode::OK);
        let presets = body_json(presets).await;
        assert!(presets["data"]
            .as_array()
            .expect("presets")
            .iter()
            .any(|preset| preset["id"] == "browser"));

        let programs = get_json(&app, "/api/config-sync/programs").await;
        assert_eq!(programs.status(), StatusCode::OK);
        assert_eq!(
            body_json(programs).await["data"].as_array().map(Vec::len),
            Some(3)
        );

        let folders = get_json(&app, "/api/config-sync/folders?path=project&depth=1").await;
        assert_eq!(folders.status(), StatusCode::OK);
        assert_eq!(body_json(folders).await["data"][0]["path"], "project");

        let escaped = get_json(&app, "/api/config-sync/folders?path=..%2Foutside").await;
        assert_eq!(escaped.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(escaped).await["error"]["code"],
            "CONFIG_SYNC_FOLDER_INVALID"
        );

        let batch = post_json(
            &app,
            "/api/config-sync",
            json!({
                "direction": "export",
                "programIds": ["codex"],
                "workspaceFolder": "project"
            }),
        )
        .await;
        assert_eq!(batch.status(), StatusCode::OK);
        let batch = body_json(batch).await;
        assert_eq!(batch["data"]["workspaceFolder"], "project");
        assert_eq!(
            batch["data"]["programs"][0]["preset"]["projectRoot"],
            "project/codex"
        );

        let duplicate = post_json(
            &app,
            "/api/config-sync",
            json!({
                "direction": "export",
                "programIds": ["codex", "codex"],
                "workspaceFolder": "."
            }),
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body_json(duplicate).await["error"]["code"],
            "CONFIG_SYNC_FAILED"
        );

        let invalid_direction = post_json(&app, "/api/config-sync/copy/codex", json!({})).await;
        assert_eq!(invalid_direction.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(invalid_direction).await["error"]["code"],
            "CONFIG_SYNC_DIRECTION_INVALID"
        );

        let profiles = get_json(&app, "/api/apps/chromium/profiles").await;
        let profile_id = body_json(profiles).await["data"]["profiles"][0]["id"]
            .as_str()
            .expect("profile id")
            .to_string();
        let tty = state
            .app_runtime
            .start(
                "terminal-tty",
                AppLaunchOptions {
                    args: vec!["-c".to_string(), "cat".to_string()],
                    ..AppLaunchOptions::default()
                },
            )
            .await
            .expect("tty session");
        let mut busy = tty.clone();
        busy.id = "app_config_sync_busy".to_string();
        busy.app_id = "chromium".to_string();
        busy.launch.as_mut().expect("launch options").profile_id = Some(profile_id);
        state.app_runtime.insert_session(busy);
        let browser = post_json(
            &app,
            "/api/config-sync",
            json!({
                "direction": "export",
                "programIds": ["browser"],
                "workspaceFolder": "project"
            }),
        )
        .await;
        assert_eq!(browser.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(browser).await["error"]["code"],
            "BROWSER_PROFILE_BUSY"
        );
        state
            .app_runtime
            .stop_session(&tty.id)
            .await
            .expect("stop tty");
    }

    #[tokio::test]
    async fn app_display_screenshot_and_automation_routes_report_typed_errors() {
        let (state, _root) = test_state();
        let app = router(state.clone());
        let unavailable = app_session_record("app_tty_only", "terminal-tty", "running");
        state.app_runtime.insert_session(unavailable);

        let screenshot = get_json(&app, "/api/apps/sessions/app_tty_only/screenshot").await;
        assert_eq!(screenshot.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(screenshot).await["error"]["code"],
            "APP_SCREENSHOT_UNAVAILABLE"
        );

        let display = post_json(
            &app,
            "/api/apps/sessions/app_tty_only/display",
            json!({ "width": 1280, "height": 800 }),
        )
        .await;
        assert_eq!(display.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(display).await["error"]["code"],
            "APP_DISPLAY_NOT_FOUND"
        );

        let automation = get_json(&app, "/api/apps/sessions/app_tty_only/automation").await;
        assert_eq!(automation.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(automation).await["error"]["code"],
            "APP_AUTOMATION_UNAVAILABLE"
        );

        let mut configured = app_session_record("app_automation_stopped", "chromium", "stopped");
        configured.automation = Some(
            serde_json::from_value(json!({
                "type": "cdp",
                "endpoint": "http://127.0.0.1:1",
                "port": 1
            }))
            .expect("automation"),
        );
        state.app_runtime.insert_session(configured);
        let stopped = get_json(&app, "/api/apps/sessions/app_automation_stopped/automation").await;
        assert_eq!(stopped.status(), StatusCode::OK);
        let stopped = body_json(stopped).await;
        assert_eq!(stopped["data"]["ready"], false);
        assert_eq!(
            stopped["data"]["error"]["code"],
            "APP_AUTOMATION_NOT_RUNNING"
        );

        let missing = get_json(&app, "/api/apps/sessions/missing/automation").await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(missing).await["error"]["code"],
            "APP_SESSION_NOT_FOUND"
        );

        for path in [
            "/api/apps/sessions/missing/screenshot",
            "/api/apps/sessions/missing/logs",
        ] {
            let response = get_json(&app, path).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(
                body_json(response).await["error"]["code"],
                "APP_SESSION_NOT_FOUND",
                "{path}"
            );
        }

        let restart = post_json(&app, "/api/apps/sessions/missing/restart", json!({})).await;
        assert_eq!(restart.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(restart).await["error"]["code"],
            "APP_SESSION_NOT_FOUND"
        );

        for (error, expected) in [
            (
                controlled_instance_app_runtime::AppRuntimeError::Draining("draining".into()),
                StatusCode::BAD_REQUEST,
            ),
            (
                controlled_instance_app_runtime::AppRuntimeError::MissingCommand("missing".into()),
                StatusCode::BAD_REQUEST,
            ),
            (
                controlled_instance_app_runtime::AppRuntimeError::Storage("failed".into()),
                StatusCode::BAD_REQUEST,
            ),
            (
                controlled_instance_app_runtime::AppRuntimeError::DisplaySessionNotFound(
                    "missing".into(),
                ),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(app_runtime_error(error).status(), expected);
        }
    }

    #[tokio::test]
    async fn web_and_node_agent_auth_are_separate() {
        let (mut state, _root) = test_state();
        state.auth = std::sync::Arc::new(WebAuthState {
            enabled: true,
            source: Some(crate::auth::AuthSource::Env),
            token_file: None,
            token: Some("web-secret".to_string()),
        });
        let app = router(state);
        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/status")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("status");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let authorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/status")
                    .header(header::AUTHORIZATION, "Bearer web-secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("status");
        assert_eq!(authorized.status(), StatusCode::OK);
        let node_agent = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/internal/node-agent/process-identity")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("identity");
        assert_eq!(node_agent.status(), StatusCode::OK);

        let web_token_cannot_update_node_agent = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/node-agent-connection")
                    .header(header::AUTHORIZATION, "Bearer web-secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"nodeAgentUrl":"http://127.0.0.1:9100"}"#))
                    .expect("request"),
            )
            .await
            .expect("node agent update");
        assert_eq!(
            web_token_cannot_update_node_agent.status(),
            StatusCode::FORBIDDEN
        );

        let invalid_origin = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/node-agent-connection")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"nodeAgentUrl":"http://127.0.0.1:9100/api"}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("node agent update");
        assert_eq!(invalid_origin.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(invalid_origin).await["error"]["code"],
            "NODE_AGENT_CONNECTION_UPDATE_INVALID"
        );

        let updated = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/node-agent-connection")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"nodeAgentUrl":"HTTP://127.0.0.1:9100/"}"#))
                    .expect("request"),
            )
            .await
            .expect("node agent update");
        assert_eq!(updated.status(), StatusCode::OK);
        let updated = body_json(updated).await;
        assert_eq!(updated["data"]["applied"], true);
        assert_eq!(updated["data"]["nodeAgentUrl"], "http://127.0.0.1:9100");
    }

    #[tokio::test]
    async fn managed_model_routes_require_the_registration_token_and_never_echo_keys() {
        let (state, root) = test_state();
        let app = router(state);
        let catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "route-primary",
                "protocols": ["openai-responses", "anthropic-messages"],
                "modelNames": [{
                    "upstreamName": "upstream-route-primary",
                    "name": "Route Primary",
                    "order": 0
                }],
                "endpoint": "https://models.example/v1",
                "key": "route-secret-key"
            }],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        });

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/model-catalog")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&catalog).expect("catalog")))
                    .expect("request"),
            )
            .await
            .expect("catalog");
        assert_eq!(unauthorized.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body_json(unauthorized).await["error"]["code"],
            "MANAGED_MODEL_CATALOG_FORBIDDEN"
        );

        let updated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/model-catalog")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&catalog).expect("catalog")))
                    .expect("request"),
            )
            .await
            .expect("catalog");
        assert_eq!(updated.status(), StatusCode::OK);
        let updated = body_json(updated).await;
        assert_eq!(updated["data"]["applied"], true);
        assert_eq!(updated["data"]["configUpdated"], true);

        let diagnostic = app
            .oneshot(
                Request::builder()
                    .uri("/api/internal/model-catalog")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("catalog");
        assert_eq!(diagnostic.status(), StatusCode::OK);
        let diagnostic = body_json(diagnostic).await;
        assert_eq!(diagnostic["data"]["source"], "live-sync");
        assert_eq!(
            diagnostic["data"]["catalog"]["entities"][0]["modelNames"][0]["upstreamName"],
            "upstream-route-primary"
        );
        assert!(!diagnostic.to_string().contains("route-secret-key"));
        assert!(!diagnostic.to_string().contains("https://models.example"));

        let config = std::fs::read_to_string(root.path().join("home/.codex/config.toml"))
            .expect("codex config");
        let config: toml::Value = toml::from_str(&config).expect("toml");
        assert_eq!(config["model"].as_str(), Some("upstream-route-primary"));
        assert_eq!(
            config["model_providers"]["task-handoff-route-primary"]["base_url"].as_str(),
            Some("https://models.example/v1")
        );
    }

    #[tokio::test]
    async fn managed_model_environment_updates_codex_auth_and_claude_settings() {
        let (state, root) = test_state();
        std::fs::create_dir_all(root.path().join("home/.claude")).expect("claude home");
        std::fs::write(
            root.path().join("home/.claude/settings.json"),
            br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"stale","KEEP":"value"}}"#,
        )
        .expect("claude settings");
        let app = router(state);
        let body = json!({
            "OPENAI_API_KEY": "codex-key",
            "TASK_HANDOFF_CODEX_BASE_URL": "https://codex.example/v1",
            "TASK_HANDOFF_CODEX_MODEL": "codex-private",
            "ANTHROPIC_API_KEY": "claude-key",
            "ANTHROPIC_BASE_URL": "https://claude.example",
            "TASK_HANDOFF_CLAUDE_MODEL": "claude-private"
        });

        let forbidden = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/model-environment")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&body).expect("body")))
                    .expect("request"),
            )
            .await
            .expect("environment");
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body_json(forbidden).await["error"]["code"],
            "MANAGED_MODEL_ENVIRONMENT_FORBIDDEN"
        );

        let updated = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/model-environment")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&body).expect("body")))
                    .expect("request"),
            )
            .await
            .expect("environment");
        assert_eq!(updated.status(), StatusCode::OK);
        let updated = body_json(updated).await;
        assert_eq!(updated["data"]["codexAuthConfigured"], true);
        assert_eq!(updated["data"]["claudeAuthConfigured"], true);
        assert_eq!(updated["data"]["configUpdated"], true);

        let auth: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("home/.codex/auth.json")).expect("auth"),
        )
        .expect("auth json");
        assert_eq!(auth["OPENAI_API_KEY"], "codex-key");
        let claude: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("home/.claude/settings.json")).expect("claude"),
        )
        .expect("claude json");
        assert_eq!(claude["env"]["KEEP"], "value");
        assert_eq!(claude["env"]["ANTHROPIC_API_KEY"], "claude-key");
        assert_eq!(claude["env"]["ANTHROPIC_MODEL"], "claude-private");
        assert!(claude["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());

        let settings = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/codex-settings")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"modelVerbosity":"high","multiAgent":{"enabled":false,"futureField":"ignored"},"futureField":"ignored"}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("settings");
        assert_eq!(settings.status(), StatusCode::OK);
        assert_eq!(body_json(settings).await["data"]["configUpdated"], true);
        let config: toml::Value = toml::from_str(
            &std::fs::read_to_string(root.path().join("home/.codex/config.toml"))
                .expect("codex config"),
        )
        .expect("toml");
        assert_eq!(config["model_verbosity"].as_str(), Some("high"));
        assert_eq!(config["agents"]["enabled"].as_bool(), Some(false));
    }

    #[tokio::test]
    async fn config_sync_import_reapplies_the_managed_model_configuration() {
        let (state, root) = test_state();
        let app = router(state);
        let catalog = json!({
            "protocolVersion": "2026-08-27",
            "instanceId": "ins_0000000000000",
            "entities": [{
                "id": "sync-primary",
                "protocols": ["openai-responses"],
                "modelNames": [{
                    "upstreamName": "managed-after-import",
                    "name": "Managed After Import",
                    "order": 0
                }],
                "endpoint": "https://models.example/v1",
                "key": "sync-secret"
            }],
            "updatedAt": "2026-11-02T00:00:00.000Z"
        });
        let catalog_update = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/internal/model-catalog")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&catalog).expect("catalog")))
                    .expect("request"),
            )
            .await
            .expect("catalog");
        assert_eq!(catalog_update.status(), StatusCode::OK);

        let source = root.path().join("workspace/codex/config.toml");
        std::fs::create_dir_all(source.parent().expect("source parent")).expect("source dir");
        std::fs::write(&source, "model = \"imported-model\"\n").expect("source config");
        let imported = post_json(
            &app,
            "/api/config-sync",
            json!({
                "direction": "import",
                "programIds": ["codex"],
                "workspaceFolder": "."
            }),
        )
        .await;
        assert_eq!(imported.status(), StatusCode::OK);
        let config: toml::Value = toml::from_str(
            &std::fs::read_to_string(root.path().join("home/.codex/config.toml"))
                .expect("managed config"),
        )
        .expect("toml");
        assert_eq!(config["model"].as_str(), Some("managed-after-import"));
    }

    #[tokio::test]
    async fn ai_session_snapshot_detail_read_title_and_delta_share_one_stream() {
        let (state, _root) = test_state();
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000001",
            "codex",
            "running",
        ));
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000001", "aps_0000000000001"))
            .expect("save AI session");
        let event = state
            .publish_ai_session_snapshot("startup")
            .expect("startup event");
        assert_eq!(event.r#type, "ai-session.snapshot");
        let app = router(state);

        let state_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/state")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("state");
        assert_eq!(state_response.status(), StatusCode::OK);
        let state_body = body_json(state_response).await;
        let stream_id = state_body["data"]["streamId"]
            .as_str()
            .expect("stream id")
            .to_string();
        assert_eq!(state_body["data"]["revision"], 1);
        assert_eq!(
            state_body["data"]["snapshot"]["sessions"][0]["id"],
            "ses_0000000000001"
        );

        let detail = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000001")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("detail");
        let detail = body_json(detail).await;
        let revision = detail["data"]["revision"]
            .as_str()
            .expect("detail revision")
            .to_string();
        assert_eq!(detail["data"]["kind"], "updated");
        assert_eq!(detail["data"]["detail"]["id"], "ses_0000000000001");

        let not_modified = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/ai-sessions/ses_0000000000001?revision={revision}"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("detail");
        let not_modified = body_json(not_modified).await;
        assert_eq!(not_modified["data"]["kind"], "not-modified");

        let renamed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/ai-sessions/ses_0000000000001/title")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "title": "Renamed",
                            "expectedTitle": "Initial title",
                            "clientRequestId": "rename-1"
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("rename");
        assert_eq!(renamed.status(), StatusCode::OK);
        let renamed = body_json(renamed).await;
        assert_eq!(renamed["data"]["disposition"], "renamed");
        assert_eq!(renamed["data"]["title"], "Renamed");

        let read = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000001/read")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("read");
        let read = body_json(read).await;
        assert_eq!(read["data"]["unread"], false);

        let delta = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/ai-sessions?streamId={stream_id}&sinceRevision=1"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delta");
        let delta = body_json(delta).await;
        assert_eq!(delta["data"]["syncRequired"], false);
        let events = delta["data"]["events"].as_array().expect("events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["payload"]["upserted"][0]["title"], "Renamed");
        assert_eq!(events[1]["payload"]["upserted"][0]["unread"], false);
    }

    #[tokio::test]
    async fn ai_session_history_route_reads_the_node_compatible_index() {
        let (state, _root) = test_state();
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000002", "aps_0000000000002"))
            .expect("save AI session");
        assert!(state
            .archive_ai_session("ses_0000000000002")
            .expect("archive"));
        let app = router(state);

        let list = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/history?agents=codex")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("history");
        assert_eq!(list.status(), StatusCode::OK);
        let list = body_json(list).await;
        assert_eq!(list["data"]["items"][0]["id"], "ses_0000000000002");
        assert_eq!(
            list["data"]["items"][0]["providerSessionId"],
            "provider-thread"
        );

        let detail = app
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/history/ses_0000000000002")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("history detail");
        assert_eq!(detail.status(), StatusCode::OK);
        let detail = body_json(detail).await;
        assert_eq!(detail["data"]["item"]["id"], "ses_0000000000002");
        assert!(detail["data"]["turns"].is_array());
    }

    #[tokio::test]
    async fn ai_session_public_reads_hide_agent_run_members_and_honor_hierarchy() {
        let (state, _root) = test_state();
        for app_session_id in [
            "aps_0000000000200",
            "aps_0000000000201",
            "aps_0000000000202",
        ] {
            state.app_runtime.insert_session(app_session_record(
                app_session_id,
                "codex",
                "running",
            ));
        }
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000200", "aps_0000000000200"))
            .expect("root session");
        let mut child = ai_session_record("ses_0000000000201", "aps_0000000000201");
        child.provider_session_id = Some("provider-child".to_string());
        child.lineage = Some(json!({
            "kind": "subagent",
            "parentProviderSessionId": "provider-thread"
        }));
        state.ai_sessions.save(child).expect("child session");
        let mut member = ai_session_record("ses_0000000000202", "aps_0000000000202");
        member.provider_session_id = Some("provider-member".to_string());
        state.ai_sessions.save(member).expect("member session");
        state
            .agent_run_bindings
            .bind(crate::AgentRunMemberBindingInput {
                run_id: "run-2".to_string(),
                member_id: "member-2".to_string(),
                ai_session_id: "ses_0000000000202".to_string(),
                provider_session_id: "provider-member".to_string(),
            })
            .expect("member binding");
        let mut opencode = ai_session_record("ses_0000000000203", "aps_0000000000203");
        opencode.agent = "opencode".to_string();
        state.ai_sessions.save(opencode).expect("opencode session");
        for id in [
            "ses_0000000000200",
            "ses_0000000000201",
            "ses_0000000000202",
            "ses_0000000000203",
        ] {
            assert!(state.archive_ai_session(id).expect("archive"));
        }
        let app = router(state);

        let list = body_json(get_json(&app, "/api/ai-sessions").await).await;
        let mut ids = list["data"]["snapshot"]["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .filter_map(|session| session["id"].as_str())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["ses_0000000000200", "ses_0000000000201"]);
        assert!(list["data"]["snapshot"]["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .find(|session| session["id"] == "ses_0000000000201")
            .expect("child")
            .get("lineage")
            .is_none());

        let nested = body_json(get_json(&app, "/api/ai-sessions?hierarchy=subagents").await).await;
        assert_eq!(
            nested["data"]["snapshot"]["sessions"]
                .as_array()
                .expect("nested sessions")
                .iter()
                .find(|session| session["id"] == "ses_0000000000201")
                .expect("nested child")["lineage"]["kind"],
            "subagent"
        );

        let state_snapshot = body_json(get_json(&app, "/api/ai-sessions/state").await).await;
        assert!(state_snapshot["data"]["snapshot"]["sessions"]
            .as_array()
            .expect("state sessions")
            .iter()
            .all(|session| session["id"] != "ses_0000000000202"));

        let history = body_json(get_json(&app, "/api/ai-sessions/history").await).await;
        let mut history_ids = history["data"]["items"]
            .as_array()
            .expect("history items")
            .iter()
            .filter_map(|item| item["id"].as_str())
            .collect::<Vec<_>>();
        history_ids.sort();
        assert_eq!(history_ids, vec!["ses_0000000000200", "ses_0000000000201"]);

        let blocked = post_json(
            &app,
            "/api/ai-sessions/ses%5F0000000000202/messages",
            json!({}),
        )
        .await;
        assert_eq!(blocked.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(blocked).await["error"]["code"],
            "AGENT_RUN_MEMBER_SESSION_MANAGED"
        );
        let readable = get_json(&app, "/api/ai-sessions/ses_0000000000202/turns").await;
        assert_ne!(readable.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn ai_session_turn_and_transcript_reads_expose_stable_revisions() {
        let (state, root) = test_state();
        let transcript = root.path().join("transcript.jsonl");
        std::fs::write(&transcript, "line-1\nline-2\r\nline-3\n").expect("transcript");
        let mut session = ai_session_record("ses_0000000000003", "aps_0000000000003");
        session.transcript_path = Some(transcript.display().to_string());
        state.ai_sessions.save(session).expect("save");
        let app = router(state);

        let index = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000003/turns?projection=index")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("turn index");
        let index = body_json(index).await;
        assert_eq!(index["data"]["kind"], "updated");
        assert_eq!(index["data"]["index"]["turns"].as_array().unwrap().len(), 2);
        let index_revision = index["data"]["revision"].as_str().unwrap().to_string();
        assert_eq!(index["data"]["index"]["revision"], index_revision);

        let turn = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000003/turns/provider-turn-2")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("turn");
        let turn = body_json(turn).await;
        assert_eq!(turn["data"]["kind"], "updated");
        assert_eq!(turn["data"]["body"]["turn"]["id"], "turn-2");
        let turn_revision = turn["data"]["revision"].as_str().unwrap().to_string();

        let not_modified = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/ai-sessions/ses_0000000000003/turns/turn-2?revision={turn_revision}"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("turn");
        assert_eq!(
            body_json(not_modified).await["data"]["kind"],
            "not-modified"
        );

        let transcript = app
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000003/transcript?tail=2")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("transcript");
        let transcript = body_json(transcript).await;
        assert_eq!(transcript["data"]["lineCount"], 4);
        assert_eq!(transcript["data"]["tail"], "line-3\n");
    }

    #[tokio::test]
    async fn ai_session_timeline_reads_syncs_and_scopes_turns() {
        use sha2::{Digest, Sha256};

        let (state, _root) = test_state();
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000005", "aps_0000000000005"))
            .expect("save");
        let provider_session_id = "provider-thread";
        let timeline_dir = state
            .config
            .storage_paths
            .data_dir
            .join("ai-session-timeline")
            .join("codex");
        std::fs::create_dir_all(&timeline_dir).expect("timeline dir");
        let key = hex::encode(Sha256::digest(provider_session_id.as_bytes()));
        std::fs::write(
            timeline_dir.join(format!("{key}.json")),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "providerSessionId": provider_session_id,
                "items": [
                    {
                        "id": "item-1",
                        "turnId": "provider-turn-1",
                        "type": "user-message",
                        "text": "First prompt"
                    },
                    {
                        "id": "item-2",
                        "turnId": "provider-turn-1",
                        "type": "ai-message",
                        "text": "First answer"
                    },
                    {
                        "id": "item-3",
                        "turnId": "provider-turn-2",
                        "type": "ai-message",
                        "text": "Second answer"
                    }
                ]
            }))
            .expect("timeline json"),
        )
        .expect("timeline fixture");
        state
            .ai_session_controller
            .register_provider(Arc::new(DurableTimelineProvider(
                state.ai_session_timeline.as_ref().clone(),
            )));

        let app = router(state);
        let timeline = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000005/timeline")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("timeline");
        assert_eq!(timeline.status(), StatusCode::OK);
        let timeline = body_json(timeline).await;
        assert_eq!(timeline["data"]["kind"], "updated");
        assert_eq!(
            timeline["data"]["timeline"]["sessionId"],
            "ses_0000000000005"
        );
        assert_eq!(
            timeline["data"]["timeline"]["providerSessionId"],
            provider_session_id
        );
        assert_eq!(
            timeline["data"]["timeline"]["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        let revision = timeline["data"]["revision"]
            .as_str()
            .expect("revision")
            .to_string();
        assert_eq!(revision.len(), 22);

        let not_modified = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/ai-sessions/ses_0000000000005/timeline?revision={revision}"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("timeline");
        assert_eq!(
            body_json(not_modified).await["data"]["kind"],
            "not-modified"
        );

        let snapshot = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000005/timeline/sync")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"knownItems":[]}"#))
                    .expect("request"),
            )
            .await
            .expect("timeline sync");
        let snapshot = body_json(snapshot).await;
        assert_eq!(snapshot["data"]["kind"], "snapshot");
        assert_eq!(snapshot["data"]["items"].as_array().unwrap().len(), 3);

        let turn_timeline = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000005/turns/provider-turn-1/timeline")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("turn timeline");
        let turn_timeline = body_json(turn_timeline).await;
        assert_eq!(turn_timeline["data"]["timeline"]["turnId"], "turn-1");
        assert_eq!(
            turn_timeline["data"]["timeline"]["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let known_items = turn_timeline["data"]["timeline"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                json!({
                    "id": item["id"],
                    "revision": controlled_instance_ai_session::ai_session_timeline_item_revision(
                        &serde_json::from_value(item.clone()).expect("timeline item"),
                    ),
                })
            })
            .collect::<Vec<_>>();
        let sync = serde_json::to_string(&json!({ "knownItems": known_items })).expect("json");
        let synced = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000005/turns/turn-1/timeline/sync")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(sync))
                    .expect("request"),
            )
            .await
            .expect("turn timeline sync");
        assert_eq!(body_json(synced).await["data"]["kind"], "not-modified");
    }

    #[tokio::test]
    async fn ai_session_attachment_drafts_and_streams_match_the_upload_contract() {
        let (state, _root) = test_state();
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000006", "aps_0000000000006"))
            .expect("save");
        let app = router(state);

        let draft = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-session-attachments/drafts?scopeType=session&scopeId=ses_0000000000006&kind=file&name=notes.txt&mime=text%2Fplain&size=5")
                    .body(Body::from("hello"))
                    .expect("request"),
            )
            .await
            .expect("draft upload");
        assert_eq!(draft.status(), StatusCode::CREATED);
        let draft = body_json(draft).await;
        assert_eq!(draft["data"]["kind"], "file");
        assert_eq!(draft["data"]["size"], 5);
        let draft_id = draft["data"]["id"].as_str().expect("draft id").to_string();
        assert!(draft_id.starts_with("att_"));

        let removed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/ai-session-attachments/drafts/{draft_id}?scopeType=session&scopeId=ses_0000000000006"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("draft delete");
        assert_eq!(body_json(removed).await["data"]["removed"], true);

        let stream_id = "cia_0123456789abcdef01234567";
        let begun = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-session-attachments/draft-streams")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "attachmentId": stream_id,
                            "scopeType": "session",
                            "scopeId": "ses_0000000000006",
                            "kind": "file",
                            "name": "stream.txt",
                            "mime": "text/plain",
                            "size": 10
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("stream begin");
        assert_eq!(begun.status(), StatusCode::CREATED);
        assert_eq!(body_json(begun).await["data"]["offset"], 0);

        let appended = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!(
                        "/api/ai-session-attachments/draft-streams/{stream_id}?offset=0"
                    ))
                    .body(Body::from("hello"))
                    .expect("request"),
            )
            .await
            .expect("stream append");
        assert_eq!(body_json(appended).await["data"]["offset"], 5);
        let offset_mismatch = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!(
                        "/api/ai-session-attachments/draft-streams/{stream_id}?offset=0"
                    ))
                    .body(Body::from("world"))
                    .expect("request"),
            )
            .await
            .expect("stream append");
        assert_eq!(offset_mismatch.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(offset_mismatch).await["error"]["code"],
            "AI_SESSION_ATTACHMENT_OFFSET_MISMATCH"
        );
        let appended = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!(
                        "/api/ai-session-attachments/draft-streams/{stream_id}?offset=5"
                    ))
                    .body(Body::from("world"))
                    .expect("request"),
            )
            .await
            .expect("stream append");
        assert_eq!(appended.status(), StatusCode::OK);

        let completed = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/ai-session-attachments/draft-streams/{stream_id}/complete"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("stream complete");
        assert_eq!(completed.status(), StatusCode::OK);
        let completed = body_json(completed).await;
        assert_eq!(completed["data"]["id"], stream_id);
        assert_eq!(completed["data"]["size"], 10);
    }

    #[tokio::test]
    async fn ai_session_attachment_content_uses_etag_and_proxy_headers() {
        use controlled_instance_protocol::{AiSessionAttachmentKind, AiSessionAttachmentScopeType};

        let (state, _root) = test_state();
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000007", "aps_0000000000007"))
            .expect("save");
        let draft = state
            .ai_session_attachments
            .create_draft(
                controlled_instance_ai_session::AiSessionAttachmentDraftInput {
                    id: Some("att_0123456789abcdef01234567".to_string()),
                    scope_type: AiSessionAttachmentScopeType::Session,
                    scope_id: "ses_0000000000007".to_string(),
                    kind: AiSessionAttachmentKind::File,
                    name: "notes.txt".to_string(),
                    mime: "text/plain".to_string(),
                    size: 5,
                    content: b"hello".to_vec(),
                },
            )
            .expect("draft");
        state
            .ai_session_attachments
            .stage_message(
                controlled_instance_ai_session::StageMessageAttachmentsInput {
                    session_id: "ses_0000000000007".to_string(),
                    message_id: "msg_0000000000007".to_string(),
                    attachments: Vec::new(),
                    retained_attachment_ids: Vec::new(),
                    runtime_path_root: None,
                    draft_scope_type: Some(AiSessionAttachmentScopeType::Session),
                    draft_scope_id: Some("ses_0000000000007".to_string()),
                    draft_attachment_ids: vec![draft.id.clone()],
                },
            )
            .expect("stage");
        state.ai_session_attachments.commit_message(
            "ses_0000000000007",
            "msg_0000000000007",
            Some("turn-1"),
        );
        let app = router(state);
        let uri = format!(
            "/api/ai-sessions/ses_0000000000007/messages/msg_0000000000007/attachments/{}/content",
            draft.id
        );
        let content = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("content");
        assert_eq!(content.status(), StatusCode::OK);
        assert_eq!(
            content
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/plain")
        );
        let etag = content
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .expect("etag")
            .to_string();
        assert!(content
            .headers()
            .contains_key("x-task-handoff-attachment-cache-until"));
        let bytes = content
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert_eq!(&bytes[..], b"hello");
        let not_modified = app
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("content not modified");
        assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn ai_session_queue_mutations_are_revision_checked_and_persisted() {
        let (state, _root) = test_state();
        let mut session = ai_session_record("ses_0000000000004", "aps_0000000000004");
        session.queue.revision = 3;
        session.queue.items = vec![
            json!({
                "id": "queue-1",
                "message": "First",
                "attachments": [],
                "references": [],
                "status": "queued",
                "createdAt": "2026-11-02T00:00:00.000Z",
                "updatedAt": "2026-11-02T00:00:00.000Z"
            }),
            json!({
                "id": "queue-2",
                "message": "Second",
                "attachments": [],
                "references": [],
                "status": "queued",
                "createdAt": "2026-11-02T00:01:00.000Z",
                "updatedAt": "2026-11-02T00:01:00.000Z"
            }),
            json!({
                "id": "queue-3",
                "message": "Failed",
                "attachments": [],
                "references": [],
                "status": "failed",
                "error": "boom",
                "createdAt": "2026-11-02T00:02:00.000Z",
                "updatedAt": "2026-11-02T00:02:00.000Z"
            }),
        ];
        state.ai_sessions.save(session).expect("save");
        let app = router(state);

        let queue = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000004/queue")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("queue");
        let queue = body_json(queue).await;
        assert_eq!(queue["data"]["revision"], 3);
        assert_eq!(queue["data"]["pendingCount"], 2);

        let edited = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/ai-sessions/ses_0000000000004/queue/queue-1")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "expectedRevision": 3, "message": "Edited" }).to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("edit");
        let edited = body_json(edited).await;
        assert_eq!(edited["data"]["queueRevision"], 4);

        let reordered = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/ai-sessions/ses_0000000000004/queue/reorder")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "expectedRevision": 4, "queueIds": ["queue-2", "queue-1"] })
                            .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("reorder");
        assert_eq!(reordered.status(), StatusCode::OK);
        assert_eq!(body_json(reordered).await["data"]["queueRevision"], 5);

        let paused = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000004/queue/pause")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "paused": true }).to_string()))
                    .expect("request"),
            )
            .await
            .expect("pause");
        assert_eq!(body_json(paused).await["data"]["queueRevision"], 5);

        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/ai-sessions/ses_0000000000004/queue/reorder")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "expectedRevision": 3, "queueIds": ["queue-1", "queue-2"] })
                            .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("reorder");
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(stale).await["error"]["code"],
            "AI_SESSION_QUEUE_REVISION_CONFLICT"
        );

        let retried = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000004/queue/queue-3/retry")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("retry");
        assert_eq!(body_json(retried).await["data"]["queueRevision"], 6);
    }

    #[tokio::test]
    async fn ai_session_queue_steer_uses_the_active_provider_turn_and_removes_the_item() {
        let (state, _root) = test_state();
        state
            .ai_session_controller
            .register_provider(Arc::new(TriggerSendProvider));
        let mut session = ai_session_record("ses_0000000000009", "aps_0000000000009");
        session.active_turn_id = Some("turn-2".to_string());
        state.ai_sessions.save(session).expect("save");
        let queued = state
            .ai_sessions
            .enqueue_message(
                "ses_0000000000009",
                "Steer into the running turn",
                Vec::new(),
                Vec::new(),
                None,
                Some("msg_0000000000009"),
            )
            .expect("queue message")
            .expect("queued item");
        let app = router(state.clone());

        let steered = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/ai-sessions/ses_0000000000009/queue/{}/steer",
                        queued.queue_id
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("steer queued message");

        assert_eq!(steered.status(), StatusCode::OK);
        let steered = body_json(steered).await;
        assert_eq!(steered["data"]["action"], "steer");
        assert_eq!(steered["data"]["queueId"], queued.queue_id);
        assert_eq!(steered["data"]["turnId"], "turn-2");
        assert_eq!(steered["data"]["providerTurnId"], "provider-turn-2");
        assert!(state
            .ai_sessions
            .queue("ses_0000000000009")
            .expect("queue")
            .items
            .is_empty());
    }

    #[tokio::test]
    async fn ai_session_queue_attachment_edits_stage_content_and_update_the_queue_item() {
        use controlled_instance_protocol::{AiSessionAttachmentKind, AiSessionAttachmentScopeType};

        let (state, _root) = test_state();
        let mut session = ai_session_record("ses_0000000000008", "aps_0000000000008");
        session.queue.revision = 3;
        session.queue.items = vec![json!({
            "id": "queue-1",
            "message": "Original",
            "attachments": [],
            "references": [],
            "status": "queued",
            "createdAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        })];
        state.ai_sessions.save(session).expect("save");
        let draft = state
            .ai_session_attachments
            .create_draft(
                controlled_instance_ai_session::AiSessionAttachmentDraftInput {
                    id: Some("att_0123456789abcdef01234567".to_string()),
                    scope_type: AiSessionAttachmentScopeType::Session,
                    scope_id: "ses_0000000000008".to_string(),
                    kind: AiSessionAttachmentKind::File,
                    name: "notes.txt".to_string(),
                    mime: "text/plain".to_string(),
                    size: 5,
                    content: b"hello".to_vec(),
                },
            )
            .expect("draft");
        let app = router(state);
        let edited = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/ai-sessions/ses_0000000000008/queue/queue-1")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "expectedRevision": 3,
                            "message": "Edited with attachment",
                            "attachments": [{
                                "id": draft.id,
                                "kind": "file",
                                "source": { "type": "upload-ref" }
                            }]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("queue edit");
        assert_eq!(edited.status(), StatusCode::OK);
        assert_eq!(body_json(edited).await["data"]["queueRevision"], 4);

        let queue = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000008/queue")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("queue");
        let queue = body_json(queue).await;
        let item = &queue["data"]["items"][0];
        assert_eq!(item["message"], "Edited with attachment");
        assert_eq!(item["attachments"][0]["id"], draft.id);
        assert_eq!(item["attachments"][0]["sourceType"], "inline");
        let message_id = item["messageId"].as_str().expect("message id").to_string();
        assert!(message_id.starts_with("msg_"));

        let content = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/ai-sessions/ses_0000000000008/messages/{message_id}/attachments/{}/content",
                        draft.id
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("content");
        assert_eq!(content.status(), StatusCode::OK);
        let bytes = content
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert_eq!(&bytes[..], b"hello");
    }

    #[tokio::test]
    async fn ai_session_mentions_commands_story_and_story_content_follow_the_node_contract() {
        let (state, root) = test_state_standalone();
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let mut session = ai_session_record("ses_0000000000009", "aps_0000000000009");
        session.cwd = Some(workspace.display().to_string());
        state.ai_sessions.save(session).expect("save");
        state
            .ai_session_controller
            .register_provider(Arc::new(DurableTimelineProvider(
                controlled_instance_ai_session::AiSessionTimelineStore::new(
                    &root.path().join("data"),
                ),
            )));
        let app = router(state);

        let mentions = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000009/mentions")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("mentions");
        assert_eq!(mentions.status(), StatusCode::OK);
        let mentions = body_json(mentions).await;
        assert_eq!(mentions["data"]["sessionId"], "ses_0000000000009");
        assert_eq!(mentions["data"]["candidates"][0]["kind"], "file");
        assert_eq!(mentions["data"]["candidates"][0]["path"], "src/main.rs");

        let search = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000009/mentions/files")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"query":"main"}"#))
                    .expect("request"),
            )
            .await
            .expect("mention search");
        assert_eq!(search.status(), StatusCode::OK);
        let search = body_json(search).await;
        assert_eq!(search["data"]["query"], "main");
        assert_eq!(search["data"]["complete"], true);

        let command = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000009/commands")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"command":"goal","argument":"  HEAD  "}"#))
                    .expect("request"),
            )
            .await
            .expect("command");
        assert_eq!(command.status(), StatusCode::OK);
        let command = body_json(command).await;
        assert_eq!(command["data"]["command"], "goal");
        assert_eq!(command["data"]["value"], "HEAD");

        let story = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/ai-sessions/ses_0000000000009/story")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"storyId":"story-1"}"#))
                    .expect("request"),
            )
            .await
            .expect("story");
        assert_eq!(story.status(), StatusCode::OK);
        assert_eq!(body_json(story).await["data"]["storyId"], "story-1");

        let story_content = app
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000009/story-content")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("story content");
        assert_eq!(story_content.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(story_content).await["error"]["code"],
            "STORY_NODE_AGENT_REQUIRED"
        );
    }

    #[tokio::test]
    async fn ai_session_close_and_delete_walk_the_subagent_subtree() {
        let (state, root) = test_state();
        state
            .ai_session_controller
            .register_provider(Arc::new(DurableTimelineProvider(
                controlled_instance_ai_session::AiSessionTimelineStore::new(
                    &root.path().join("data"),
                ),
            )));
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000010",
            "codex",
            "running",
        ));
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000011",
            "codex",
            "running",
        ));
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000010", "aps_0000000000010"))
            .expect("save root");
        let mut child = ai_session_record("ses_0000000000011", "aps_0000000000011");
        child.provider_session_id = Some("provider-child".to_string());
        child.lineage = Some(json!({
            "kind": "subagent",
            "parentProviderSessionId": "provider-thread"
        }));
        state.ai_sessions.save(child).expect("save child");
        let app = router(state.clone());

        let closed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000010/close")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"clientRequestId":"close-root"}"#))
                    .expect("request"),
            )
            .await
            .expect("close");
        assert_eq!(closed.status(), StatusCode::OK);
        let closed = body_json(closed).await;
        assert_eq!(closed["data"]["disposition"], "closed");
        assert_eq!(closed["data"]["aiSessionId"], "ses_0000000000010");
        assert!(state.ai_sessions.list().is_empty());
        let stopped_apps = state.app_runtime.list_sessions();
        assert_eq!(stopped_apps.len(), 2);
        assert!(stopped_apps
            .iter()
            .all(|session| session.status == "stopped"));
        assert!(state.ai_session_history.get("ses_0000000000010").is_some());
        assert!(state.ai_session_history.get("ses_0000000000011").is_some());

        let already_closed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000010/close")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"clientRequestId":"close-root-again"}"#))
                    .expect("request"),
            )
            .await
            .expect("close again");
        assert_eq!(already_closed.status(), StatusCode::OK);
        assert_eq!(
            body_json(already_closed).await["data"]["disposition"],
            "already-closed"
        );

        let cleared = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/ai-sessions/ses_0000000000010")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("delete");
        assert_eq!(cleared.status(), StatusCode::OK);
        let cleared = body_json(cleared).await;
        assert_eq!(cleared["data"]["disposition"], "cleared");
        assert_eq!(
            cleared["data"]["clearedSessionIds"],
            json!(["ses_0000000000011", "ses_0000000000010"])
        );
        assert!(state.ai_session_history.list(None).is_empty());
    }

    #[tokio::test]
    async fn app_session_stop_closes_the_bound_ai_session() {
        let (state, root) = test_state();
        state
            .ai_session_controller
            .register_provider(Arc::new(DurableTimelineProvider(
                controlled_instance_ai_session::AiSessionTimelineStore::new(
                    &root.path().join("data"),
                ),
            )));
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000300",
            "codex",
            "running",
        ));
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000300", "aps_0000000000300"))
            .expect("AI session");
        let app = router(state.clone());

        let stopped = post_json(&app, "/api/apps/sessions/aps_0000000000300/stop", json!({})).await;
        assert_eq!(stopped.status(), StatusCode::OK);
        assert_eq!(body_json(stopped).await["data"]["status"], "stopped");
        assert!(state.ai_sessions.list().is_empty());
        assert!(state.ai_session_history.get("ses_0000000000300").is_some());
        assert_eq!(
            state
                .app_runtime
                .get_session("aps_0000000000300")
                .expect("app session")
                .status,
            "stopped"
        );
    }

    #[tokio::test]
    async fn app_session_rename_synchronizes_an_app_derived_ai_session_title() {
        let (state, _root) = test_state();
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000301",
            "claude",
            "running",
        ));
        let mut session = ai_session_record("ses_0000000000301", "aps_0000000000301");
        session.agent = "claude".to_string();
        state.ai_sessions.save(session).expect("AI session");
        let app = router(state.clone());

        let renamed = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/apps/sessions/aps_0000000000301")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"Renamed from App"}"#))
                    .expect("request"),
            )
            .await
            .expect("rename");
        assert_eq!(renamed.status(), StatusCode::OK);
        assert_eq!(
            body_json(renamed).await["data"]["title"],
            "Renamed from App"
        );
        assert_eq!(
            state
                .app_runtime
                .get_session("aps_0000000000301")
                .expect("app session")
                .title,
            "Renamed from App"
        );
        assert_eq!(
            state
                .ai_sessions
                .get("ses_0000000000301")
                .expect("AI session")
                .title
                .as_deref(),
            Some("Renamed from App")
        );
    }

    #[tokio::test]
    async fn drain_stops_apps_and_publishes_authoritative_snapshots() {
        let (state, _root) = test_state();
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000302",
            "codex",
            "running",
        ));
        let before_app_revision = state.app_sessions_state().revision;
        let before_ai_revision = state.ai_sessions_state().revision;
        let app = router(state.clone());
        let drained = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/internal/node-agent/drain")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("drain");
        assert_eq!(drained.status(), StatusCode::OK);
        assert_eq!(body_json(drained).await["data"]["drained"], true);
        assert!(state.is_draining());
        assert!(state.app_runtime.is_draining());
        assert_eq!(
            state
                .app_runtime
                .get_session("aps_0000000000302")
                .expect("app session")
                .status,
            "stopped"
        );
        assert!(state.app_sessions_state().revision > before_app_revision);
        assert!(state.ai_sessions_state().revision > before_ai_revision);

        let resumed = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/internal/node-agent/resume")
                    .header(header::AUTHORIZATION, "Bearer test-registration-token")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("resume");
        assert_eq!(resumed.status(), StatusCode::OK);
        assert_eq!(body_json(resumed).await["data"]["resumed"], true);
        assert!(!state.is_draining());
        assert!(!state.app_runtime.is_draining());
    }

    #[tokio::test]
    async fn ai_session_open_app_reports_unavailable_and_reuses_a_running_binding() {
        let (state, _root) = test_state();
        let mut unavailable = ai_session_record("ses_0000000000020", "aps_0000000000020");
        unavailable.provider_session_id = None;
        unavailable.cwd = None;
        unavailable.app_session_id = None;
        state
            .ai_sessions
            .save(unavailable)
            .expect("save unavailable");
        let mut already_open = ai_session_record("ses_0000000000021", "aps_0000000000021");
        already_open.provider_session_id = Some("provider-open".to_string());
        already_open.cwd = Some("/workspace".to_string());
        state
            .ai_sessions
            .save(already_open)
            .expect("save already open");
        state.app_runtime.insert_session(app_session_record(
            "aps_0000000000021",
            "codex",
            "running",
        ));
        let app = router(state);

        let unavailable = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000020/open-app")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"clientRequestId":"open-unavailable"}"#))
                    .expect("request"),
            )
            .await
            .expect("open unavailable");
        assert_eq!(unavailable.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(unavailable).await["error"]["code"],
            "AI_SESSION_OPEN_APP_UNAVAILABLE"
        );

        let already_open = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000021/open-app")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"clientRequestId":"open-existing"}"#))
                    .expect("request"),
            )
            .await
            .expect("open existing");
        assert_eq!(already_open.status(), StatusCode::OK);
        let already_open = body_json(already_open).await;
        assert_eq!(already_open["data"]["disposition"], "already-open");
        assert_eq!(already_open["data"]["appSessionId"], "aps_0000000000021");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ai_session_open_app_starts_binds_and_closes_the_managed_app() {
        use std::os::unix::fs::PermissionsExt;

        let (state, _root) = test_state();
        let workspace = tempfile::tempdir().expect("workspace");
        let script = workspace.path().join("resume.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");
        std::env::set_var("TASK_HANDOFF_CODEX_COMMAND", &script);
        std::env::set_var("TASK_HANDOFF_CODEX_APP_SERVER_DISABLED", "1");
        state
            .ai_session_controller
            .register_provider(Arc::new(DurableTimelineProvider(
                state.ai_session_timeline.as_ref().clone(),
            )));
        let mut session = ai_session_record("ses_0000000000022", "aps_0000000000022");
        session.provider_session_id = Some("provider-open".to_string());
        session.cwd = Some(workspace.path().display().to_string());
        session.app_session_id = None;
        state.ai_sessions.save(session).expect("save session");
        let app = router(state.clone());

        let opened = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000022/open-app")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"clientRequestId":"open-success"}"#))
                    .expect("request"),
            )
            .await
            .expect("open app");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = body_json(opened).await;
        assert_eq!(opened["data"]["disposition"], "opened");
        let app_session_id = opened["data"]["appSessionId"]
            .as_str()
            .expect("app session id")
            .to_string();
        assert_eq!(
            state
                .app_runtime
                .get_session(&app_session_id)
                .expect("running app")
                .status,
            "running"
        );
        let bound = state
            .ai_sessions
            .get("ses_0000000000022")
            .expect("bound session");
        assert_eq!(
            bound.app_session_id.as_deref(),
            Some(app_session_id.as_str())
        );
        let actions = bound.actions.expect("actions");
        assert_eq!(actions["openApp"], false);
        assert_eq!(actions["close"], true);

        let closed = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000022/close")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"clientRequestId":"close-opened"}"#))
                    .expect("request"),
            )
            .await
            .expect("close app");
        assert_eq!(closed.status(), StatusCode::OK);
        assert_eq!(body_json(closed).await["data"]["disposition"], "closed");
        assert_eq!(
            state
                .app_runtime
                .get_session(&app_session_id)
                .expect("stopped app metadata")
                .status,
            "stopped"
        );
        assert!(state.ai_sessions.get("ses_0000000000022").is_none());
        assert!(state.ai_session_history.get("ses_0000000000022").is_some());
        std::env::remove_var("TASK_HANDOFF_CODEX_COMMAND");
        std::env::remove_var("TASK_HANDOFF_CODEX_APP_SERVER_DISABLED");
    }

    #[tokio::test]
    async fn repository_routes_follow_the_node_file_change_and_branch_contract() {
        use std::process::Command;

        let (state, _root) = test_state();
        let repository = tempfile::tempdir().expect("repository");
        let run_git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(repository.path())
                .output()
                .expect("git command");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&["init", "-q"]);
        run_git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        run_git(&["config", "user.email", "controlled-instance@example.test"]);
        run_git(&["config", "user.name", "Controlled Instance"]);
        std::fs::write(repository.path().join("README.md"), "first\n").expect("readme");
        run_git(&["add", "README.md"]);
        run_git(&["commit", "-q", "-m", "initial"]);

        let mut session = ai_session_record("ses_0000000000030", "aps_0000000000030");
        session.cwd = Some(repository.path().display().to_string());
        session.status = "idle".to_string();
        state.ai_sessions.save(session).expect("save session");
        let app = router(state);

        let context = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000030/repository/context")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("context");
        assert_eq!(context.status(), StatusCode::OK);
        let context = body_json(context).await;
        assert_eq!(context["data"]["availability"], "available");
        assert_eq!(context["data"]["head"]["branch"], "main");
        assert_eq!(context["data"]["changes"]["unstaged"], 0);
        let snapshot_id = context["data"]["snapshotId"]
            .as_str()
            .expect("snapshot")
            .to_string();

        let directories = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000030/repository/directories")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("directories");
        assert_eq!(directories.status(), StatusCode::OK);
        let directories = body_json(directories).await;
        assert!(directories["data"]["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["path"] == "README.md" && entry["kind"] == "file"));

        let file = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000030/repository/files?path=README.md")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("file");
        assert_eq!(file.status(), StatusCode::OK);
        let file = body_json(file).await;
        assert_eq!(file["data"]["content"], "first\n");
        let version = file["data"]["version"]
            .as_str()
            .expect("version")
            .to_string();

        let write = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/ai-sessions/ses_0000000000030/repository/files")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "path": "README.md",
                            "content": "first\nsecond\n",
                            "expectedVersion": version,
                            "expectedSnapshotId": snapshot_id,
                        }))
                        .expect("body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("write");
        assert_eq!(write.status(), StatusCode::OK);
        let write = body_json(write).await;
        assert_eq!(write["data"]["file"]["content"], "first\nsecond\n");
        assert_eq!(write["data"]["changes"]["summary"]["unstaged"], 1);
        let changed_snapshot = write["data"]["snapshotId"]
            .as_str()
            .expect("changed snapshot")
            .to_string();
        let changed_version = write["data"]["changes"]["entries"][0]["version"]
            .as_str()
            .expect("changed version")
            .to_string();

        let diff = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000030/repository/diff?path=README.md&scope=unstaged")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("diff");
        assert_eq!(diff.status(), StatusCode::OK);
        let diff = body_json(diff).await;
        assert_eq!(diff["data"]["complete"], true);
        assert!(diff["data"]["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .any(|line| line["kind"] == "addition" && line["content"] == "second"));

        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/ai-sessions/ses_0000000000030/repository/files")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "path": "README.md",
                            "content": "stale\n",
                            "expectedVersion": version,
                            "expectedSnapshotId": snapshot_id,
                        }))
                        .expect("body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("stale write");
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(stale).await["error"]["code"],
            "REPOSITORY_STATE_STALE"
        );

        let traversal = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ai-sessions/ses_0000000000030/repository/files?path=../outside")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("traversal");
        assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(traversal).await["error"]["code"],
            "REPOSITORY_PATH_INVALID"
        );

        let stage = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000030/repository/index/stage")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "expectedSnapshotId": changed_snapshot,
                            "paths": [{"path": "README.md", "expectedVersion": changed_version}],
                        }))
                        .expect("body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("stage");
        assert_eq!(stage.status(), StatusCode::OK);
        let stage = body_json(stage).await;
        assert_eq!(stage["data"]["changes"]["summary"]["staged"], 1);
        let staged_snapshot = stage["data"]["snapshotId"]
            .as_str()
            .expect("staged snapshot")
            .to_string();

        let commit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000030/repository/commits")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "expectedSnapshotId": staged_snapshot,
                            "message": "Update README",
                        }))
                        .expect("body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit");
        assert_eq!(commit.status(), StatusCode::OK);
        let commit = body_json(commit).await;
        assert!(commit["data"]["commitOid"]
            .as_str()
            .is_some_and(|oid| oid.len() >= 40));

        let branch = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai-sessions/ses_0000000000030/repository/branches/create")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "expectedSnapshotId": commit["data"]["snapshotId"],
                            "name": "feature/rust",
                        }))
                        .expect("body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("branch");
        assert_eq!(branch.status(), StatusCode::OK);
        let branch = body_json(branch).await;
        assert_eq!(branch["data"]["context"]["head"]["branch"], "feature/rust");
        assert!(branch["data"]["branches"]["branches"]
            .as_array()
            .expect("branches")
            .iter()
            .any(|branch| branch["name"] == "feature/rust" && branch["current"] == true));
    }

    #[tokio::test]
    async fn worktree_routes_cover_creation_detached_checkout_stale_state_and_removal_blockers() {
        let (mut state, _root) = test_state();
        let repository = git_repository();
        let managed = tempfile::tempdir().expect("managed root");
        state.repository_service =
            controlled_instance_workspace::RepositoryService::new_with_managed_root(
                vec![repository.path().to_path_buf()],
                managed.path(),
            );
        let mut source = ai_session_record("ses_0000000000040", "aps_0000000000040");
        source.cwd = Some(repository.path().display().to_string());
        source.status = "idle".to_string();
        state.ai_sessions.save(source).expect("save source session");
        let app = router(state.clone());

        let initial = get_json(
            &app,
            "/api/ai-sessions/ses_0000000000040/repository/worktrees",
        )
        .await;
        assert_eq!(initial.status(), StatusCode::OK);
        let initial = body_json(initial).await;
        assert_eq!(initial["data"]["items"].as_array().expect("items").len(), 1);
        assert_eq!(initial["data"]["items"][0]["isCurrent"], true);
        assert_eq!(initial["data"]["items"][0]["isMain"], true);
        let current_worktree_id = initial["data"]["items"][0]["id"]
            .as_str()
            .expect("current worktree")
            .to_string();
        let inspected = post_json(
            &app,
            "/api/repository/ai-session-workspace/inspect",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        let inspected = body_json(inspected).await;
        let context_snapshot = inspected["data"]["snapshotId"]
            .as_str()
            .expect("context snapshot")
            .to_string();

        let workspace_list = post_json(
            &app,
            "/api/repository/workspace/worktrees/list",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        assert_eq!(workspace_list.status(), StatusCode::OK);
        assert_eq!(
            body_json(workspace_list).await["data"]["items"]
                .as_array()
                .expect("workspace items")
                .len(),
            1
        );

        let created = post_json(
            &app,
            "/api/repository/workspace/worktrees",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "worktree": {
                    "mode": "new-branch",
                    "branchName": "feature-http",
                    "startRef": "HEAD",
                    "expectedSnapshotId": context_snapshot.clone(),
                },
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created = body_json(created).await;
        let created_id = created["data"]["worktreeId"]
            .as_str()
            .expect("created worktree")
            .to_string();
        let linked_path = managed_worktree_path(managed.path(), &created_id);
        assert!(linked_path.is_dir());
        assert_eq!(
            created["data"]["worktrees"]["items"]
                .as_array()
                .expect("created items")
                .len(),
            2
        );
        let refreshed = post_json(
            &app,
            "/api/repository/ai-session-workspace/inspect",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        let refreshed = body_json(refreshed).await;
        let snapshot_after_create = refreshed["data"]["snapshotId"]
            .as_str()
            .expect("context snapshot after create")
            .to_string();

        let detached = post_json(
            &app,
            "/api/repository/workspace/worktrees",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "worktree": {
                    "mode": "existing-branch",
                    "branchName": "feature-http",
                    "expectedSnapshotId": snapshot_after_create,
                },
            }),
        )
        .await;
        assert_eq!(detached.status(), StatusCode::OK);
        let detached = body_json(detached).await;
        let detached_id = detached["data"]["worktreeId"]
            .as_str()
            .expect("detached worktree")
            .to_string();
        let detached_item = detached["data"]["worktrees"]["items"]
            .as_array()
            .expect("detached items")
            .iter()
            .find(|item| item["id"] == detached_id)
            .expect("detached item");
        assert_eq!(detached_item["head"]["state"], "detached");
        assert_eq!(detached_item["head"]["branch"], Value::Null);

        let stale = post_json(
            &app,
            "/api/repository/workspace/worktrees",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "worktree": {
                    "mode": "new-branch",
                    "branchName": "stale-worktree",
                    "startRef": "HEAD",
                    "expectedSnapshotId": context_snapshot,
                },
            }),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(stale).await["error"]["code"],
            "REPOSITORY_STATE_STALE"
        );

        let branches = post_json(
            &app,
            "/api/repository/workspace/branches/list",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        assert_eq!(branches.status(), StatusCode::OK);
        assert!(body_json(branches).await["data"]["branches"]
            .as_array()
            .expect("branches")
            .iter()
            .any(|branch| branch["name"] == "feature-http"));

        let inspected = post_json(
            &app,
            "/api/repository/ai-session-workspace/inspect",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        assert_eq!(inspected.status(), StatusCode::OK);
        assert_eq!(
            body_json(inspected).await["data"]["availability"],
            "available"
        );

        let listed = get_json(
            &app,
            "/api/ai-sessions/ses_0000000000040/repository/worktrees",
        )
        .await;
        let listed = body_json(listed).await;
        assert_eq!(listed["data"]["items"].as_array().expect("items").len(), 3);
        let current_snapshot = listed["data"]["snapshotId"]
            .as_str()
            .expect("current snapshot")
            .to_string();

        let move_preflight = post_json(
            &app,
            "/api/repository/workspace/worktrees/move-to-main/preflight",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "preflight": {"worktreeId": created_id},
            }),
        )
        .await;
        assert_eq!(move_preflight.status(), StatusCode::OK);
        let move_preflight = body_json(move_preflight).await;
        assert_eq!(move_preflight["data"]["canMove"], true);
        assert_eq!(move_preflight["data"]["targetBranch"], "feature-http");

        let current_removal = post_json(
            &app,
            "/api/repository/workspace/worktrees/remove",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "removal": {
                    "worktreeId": current_worktree_id,
                    "expectedSnapshotId": current_snapshot,
                    "confirm": true,
                },
            }),
        )
        .await;
        assert_eq!(current_removal.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(current_removal).await["error"]["code"],
            "REPOSITORY_WORKTREE_UNSAFE"
        );

        std::fs::write(linked_path.join("README.md"), "dirty\n").expect("dirty worktree");
        let dirty_list = get_json(
            &app,
            "/api/ai-sessions/ses_0000000000040/repository/worktrees",
        )
        .await;
        let dirty_list = body_json(dirty_list).await;
        assert!(dirty_list["data"]["items"]
            .as_array()
            .expect("dirty items")
            .iter()
            .any(|item| item["id"] == created_id && item["dirty"] == true));
        let dirty_removal = post_json(
            &app,
            "/api/repository/workspace/worktrees/remove",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "removal": {
                    "worktreeId": created_id,
                    "expectedSnapshotId": dirty_list["data"]["snapshotId"],
                    "confirm": true,
                },
            }),
        )
        .await;
        assert_eq!(dirty_removal.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(dirty_removal).await["error"]["code"],
            "REPOSITORY_WORKTREE_UNSAFE"
        );
        std::fs::write(linked_path.join("README.md"), "first\n").expect("clean worktree");

        let mut occupier = ai_session_record("ses_0000000000041", "aps_0000000000041");
        occupier.app_session_id = None;
        occupier.creation_source = "ai-session".to_string();
        occupier.cwd = Some(linked_path.display().to_string());
        occupier.status = "running".to_string();
        state.ai_sessions.save(occupier).expect("save occupier");
        let occupied = get_json(
            &app,
            "/api/ai-sessions/ses_0000000000040/repository/worktrees",
        )
        .await;
        let occupied = body_json(occupied).await;
        let occupied_item = occupied["data"]["items"]
            .as_array()
            .expect("occupied items")
            .iter()
            .find(|item| item["id"] == created_id)
            .expect("occupied item");
        assert!(
            occupied_item["activeAiSessionIds"]
                .as_array()
                .expect("active sessions")
                .contains(&json!("ses_0000000000041")),
            "{occupied_item}"
        );
        let occupied_removal = post_json(
            &app,
            "/api/repository/workspace/worktrees/remove",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "removal": {
                    "worktreeId": created_id,
                    "expectedSnapshotId": occupied["data"]["snapshotId"],
                    "confirm": true,
                },
            }),
        )
        .await;
        assert_eq!(occupied_removal.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(occupied_removal).await["error"]["code"],
            "REPOSITORY_WORKTREE_UNSAFE"
        );

        let mut occupier = state
            .ai_sessions
            .get("ses_0000000000041")
            .expect("occupier");
        occupier.status = "failed".to_string();
        state.ai_sessions.save(occupier).expect("release occupier");
        let clean = get_json(
            &app,
            "/api/ai-sessions/ses_0000000000040/repository/worktrees",
        )
        .await;
        let clean = body_json(clean).await;
        let removed = post_json(
            &app,
            "/api/repository/workspace/worktrees/remove",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "removal": {
                    "worktreeId": created_id,
                    "expectedSnapshotId": clean["data"]["snapshotId"],
                    "confirm": true,
                },
            }),
        )
        .await;
        let removed_status = removed.status();
        let removed = body_json(removed).await;
        assert_eq!(removed_status, StatusCode::OK, "{removed}");
        assert_eq!(removed["data"]["removedWorktreeId"], created_id);
        assert_eq!(removed["data"]["branchRetained"], true);
        assert!(
            git_stdout(repository.path(), &["branch", "--list", "feature-http"])
                .contains("feature-http")
        );

        git_stdout(repository.path(), &["branch", "workspace-checkout"]);
        let checked_out = post_json(
            &app,
            "/api/repository/ai-session-workspace/checkout",
            json!({
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "branch": "workspace-checkout",
            }),
        )
        .await;
        assert_eq!(checked_out.status(), StatusCode::OK);
        assert_eq!(
            body_json(checked_out).await["data"]["currentBranch"],
            "workspace-checkout"
        );
    }

    #[tokio::test]
    async fn workspace_ai_session_create_preserves_provider_errors_after_worktree_compensation() {
        let (mut state, _root) = test_state();
        let repository = git_repository();
        let managed = tempfile::tempdir().expect("managed root");
        state.repository_service =
            controlled_instance_workspace::RepositoryService::new_with_managed_root(
                vec![repository.path().to_path_buf()],
                managed.path(),
            );
        state
            .ai_session_controller
            .register_provider(Arc::new(FailingCreateProvider(
                controlled_instance_ai_session::ProviderError::new(
                    "AI_SESSION_MATERIALIZATION_FAILED",
                    "The provider workspace could not be materialized.",
                    503,
                ),
            )));
        let app = router(state);

        let inspected = post_json(
            &app,
            "/api/repository/ai-session-workspace/inspect",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        let inspected = body_json(inspected).await;
        let launched = post_json(
            &app,
            "/api/repository/ai-session-workspace/create",
            json!({
                "agent": "codex",
                "cwd": {"type": "runtime-path", "path": repository.path()},
                "workspaceSelection": {
                    "type": "new-worktree",
                    "branchName": "workspace-failed",
                    "startRef": "HEAD",
                    "expectedSnapshotId": inspected["data"]["snapshotId"],
                },
                "message": "create in a new worktree",
                "clientRequestId": "workspace-failed-request",
            }),
        )
        .await;
        assert_eq!(launched.status(), StatusCode::SERVICE_UNAVAILABLE);
        let launched = body_json(launched).await;
        assert_eq!(
            launched["error"]["code"],
            "AI_SESSION_MATERIALIZATION_FAILED"
        );
        assert_eq!(launched["error"]["retryable"], true);

        let remaining = post_json(
            &app,
            "/api/repository/workspace/worktrees/list",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        assert_eq!(remaining.status(), StatusCode::OK);
        assert_eq!(
            body_json(remaining).await["data"]["items"]
                .as_array()
                .expect("remaining items")
                .len(),
            1
        );
        assert!(
            git_stdout(repository.path(), &["branch", "--list", "workspace-failed"])
                .contains("workspace-failed")
        );
    }

    #[tokio::test]
    async fn worktree_ai_session_launch_failure_returns_recovery_details_and_retains_the_branch() {
        let (mut state, _root) = test_state();
        let repository = git_repository();
        let managed = tempfile::tempdir().expect("managed root");
        state.repository_service =
            controlled_instance_workspace::RepositoryService::new_with_managed_root(
                vec![repository.path().to_path_buf()],
                managed.path(),
            );
        state
            .ai_session_controller
            .register_provider(Arc::new(FailingCreateProvider(
                controlled_instance_ai_session::ProviderError::new(
                    "AI_SESSION_CONTROL_NOT_CONNECTED",
                    "AI session control is unavailable.",
                    503,
                ),
            )));
        let mut source = ai_session_record("ses_0000000000060", "aps_0000000000060");
        source.cwd = Some(repository.path().display().to_string());
        source.status = "idle".to_string();
        state.ai_sessions.save(source).expect("save source");
        let app = router(state);

        let inspected = post_json(
            &app,
            "/api/repository/ai-session-workspace/inspect",
            json!({"cwd": {"type": "runtime-path", "path": repository.path()}}),
        )
        .await;
        let inspected = body_json(inspected).await;
        let launched = post_json(
            &app,
            "/api/ai-sessions/ses_0000000000060/repository/worktrees/ai-sessions",
            json!({
                "agent": "codex",
                "worktree": {
                    "mode": "new-branch",
                    "branchName": "launch-compensated",
                    "startRef": "HEAD",
                    "expectedSnapshotId": inspected["data"]["snapshotId"],
                },
                "message": "launch and fail",
                "clientRequestId": "launch-compensated-request",
            }),
        )
        .await;
        assert_eq!(launched.status(), StatusCode::BAD_REQUEST);
        let launched = body_json(launched).await;
        assert_eq!(launched["error"]["code"], "REPOSITORY_OPERATION_FAILED");
        assert_eq!(launched["error"]["retryable"], false);
        assert_eq!(launched["error"]["details"]["worktreeRemoved"], true);
        assert_eq!(launched["error"]["details"]["branchRetained"], true);
        assert_eq!(launched["error"]["details"]["recoverable"], false);

        let remaining = get_json(
            &app,
            "/api/ai-sessions/ses_0000000000060/repository/worktrees",
        )
        .await;
        assert_eq!(
            body_json(remaining).await["data"]["items"]
                .as_array()
                .expect("remaining items")
                .len(),
            1
        );
        assert!(git_stdout(
            repository.path(),
            &["branch", "--list", "launch-compensated"]
        )
        .contains("launch-compensated"));
    }

    #[tokio::test]
    async fn instance_shell_route_requires_controlled_registration_and_exact_subprotocol() {
        fn shell_request(token: Option<&str>, protocol: Option<&str>) -> Request<Body> {
            let mut builder = Request::builder()
                .method("GET")
                .uri("/api/internal/instance-shell")
                .header(header::CONNECTION, "upgrade")
                .header(header::UPGRADE, "websocket")
                .header(header::SEC_WEBSOCKET_VERSION, "13")
                .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==");
            if let Some(token) = token {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            if let Some(protocol) = protocol {
                builder = builder.header(header::SEC_WEBSOCKET_PROTOCOL, protocol);
            }
            builder.body(Body::empty()).expect("shell request")
        }

        let (state, _root) = test_state();
        let app = router(state);
        let unauthorized = app
            .clone()
            .oneshot(shell_request(None, None))
            .await
            .expect("unauthorized shell request");
        assert_eq!(unauthorized.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body_json(unauthorized).await["error"]["code"],
            "INSTANCE_SHELL_UNAUTHORIZED"
        );

        let wrong_token = app
            .clone()
            .oneshot(shell_request(Some("wrong-token"), None))
            .await
            .expect("wrong-token shell request");
        assert_eq!(wrong_token.status(), StatusCode::FORBIDDEN);

        let (standalone, _root) = test_state_standalone();
        let standalone = router(standalone)
            .oneshot(shell_request(
                Some("test-registration-token"),
                Some(controlled_instance_protocol::INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL),
            ))
            .await
            .expect("standalone shell request");
        assert_eq!(standalone.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            body_json(standalone).await["error"]["code"],
            "INSTANCE_SHELL_UNAUTHORIZED"
        );

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind shell route");
        let address = listener.local_addr().expect("shell route address");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let url =
            format!("ws://{address}/api/internal/instance-shell?token=test-registration-token");
        let missing_protocol = tokio_tungstenite::connect_async(&url)
            .await
            .expect_err("missing subprotocol must be rejected");
        let tokio_tungstenite::tungstenite::Error::Http(response) = missing_protocol else {
            panic!("unexpected missing-subprotocol error: {missing_protocol:?}");
        };
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut wrong_protocol = url
            .as_str()
            .into_client_request()
            .expect("wrong-protocol request");
        wrong_protocol.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            header::HeaderValue::from_static("wrong-protocol"),
        );
        let wrong_protocol = tokio_tungstenite::connect_async(wrong_protocol)
            .await
            .expect_err("wrong subprotocol must be rejected");
        let tokio_tungstenite::tungstenite::Error::Http(response) = wrong_protocol else {
            panic!("unexpected wrong-subprotocol error: {wrong_protocol:?}");
        };
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let mut accepted = url
            .as_str()
            .into_client_request()
            .expect("accepted shell request");
        accepted.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            header::HeaderValue::from_static(
                controlled_instance_protocol::INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL,
            ),
        );
        let (client, response) = tokio_tungstenite::connect_async(accepted)
            .await
            .expect("accepted shell upgrade");
        assert_eq!(
            response.headers()[header::SEC_WEBSOCKET_PROTOCOL],
            controlled_instance_protocol::INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL
        );
        drop(client);
        task.abort();
    }

    #[tokio::test]
    async fn events_hello_projects_the_authoritative_stream_revisions() {
        let (state, _root) = test_state();
        state.publish_app_session_snapshot("test");
        let expected_ai = state.ai_sessions_state();
        let expected_app = state.app_sessions_state();
        let app = router(state);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind events route");
        let address = listener.local_addr().expect("events route address");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let (mut client, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/api/events"))
                .await
                .expect("events upgrade");
        let message = client.next().await.expect("hello").expect("hello frame");
        let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
            panic!("expected hello text frame");
        };
        let hello: Value = serde_json::from_str(&text).expect("hello json");
        assert_eq!(hello["type"], "streams.hello");
        assert_eq!(
            hello["payload"]["streams"][0]["streamId"],
            expected_ai.stream_id
        );
        assert_eq!(
            hello["payload"]["streams"][0]["latestRevision"],
            expected_ai.revision
        );
        assert_eq!(
            hello["payload"]["streams"][1]["streamId"],
            expected_app.stream_id
        );
        assert_eq!(
            hello["payload"]["streams"][1]["latestRevision"],
            expected_app.revision
        );
        assert_eq!(
            hello["payload"]["streams"][1]["earliestRetainedRevision"],
            1
        );
        let management = client
            .next()
            .await
            .expect("app management snapshot")
            .expect("app management frame");
        let tokio_tungstenite::tungstenite::Message::Text(text) = management else {
            panic!("expected app management text frame");
        };
        let management: Value = serde_json::from_str(&text).expect("app management json");
        assert_eq!(management["type"], "app.management");
        assert_eq!(management["payload"]["type"], "app-management");
        let initial_sequence = management["payload"]["sequence"]
            .as_u64()
            .expect("initial app management sequence");

        let refreshed = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .expect("refreshed app management frame")
            .expect("refreshed app management message")
            .expect("refreshed app management frame");
        let tokio_tungstenite::tungstenite::Message::Text(text) = refreshed else {
            panic!("expected refreshed app management text frame");
        };
        let refreshed: Value = serde_json::from_str(&text).expect("refreshed app management json");
        assert_eq!(refreshed["type"], "app.management");
        assert_eq!(
            refreshed["payload"]["sequence"].as_u64(),
            Some(initial_sequence + 1)
        );
        drop(client);
        task.abort();
    }

    #[tokio::test]
    async fn events_authority_bootstrap_filters_agent_run_members_and_projects_hierarchy() {
        let (state, _root) = test_state();
        for app_session_id in [
            "aps_0000000000100",
            "aps_0000000000101",
            "aps_0000000000102",
        ] {
            state.app_runtime.insert_session(app_session_record(
                app_session_id,
                "codex",
                "running",
            ));
        }
        state
            .ai_sessions
            .save(ai_session_record("ses_0000000000100", "aps_0000000000100"))
            .expect("root session");
        let mut child = ai_session_record("ses_0000000000101", "aps_0000000000101");
        child.provider_session_id = Some("provider-child".to_string());
        child.lineage = Some(json!({
            "kind": "subagent",
            "parentProviderSessionId": "provider-thread"
        }));
        state.ai_sessions.save(child).expect("child session");
        let mut member = ai_session_record("ses_0000000000102", "aps_0000000000102");
        member.provider_session_id = Some("provider-member".to_string());
        state.ai_sessions.save(member).expect("member session");
        state
            .agent_run_bindings
            .bind(crate::AgentRunMemberBindingInput {
                run_id: "run-1".to_string(),
                member_id: "member-1".to_string(),
                ai_session_id: "ses_0000000000102".to_string(),
                provider_session_id: "provider-member".to_string(),
            })
            .expect("member binding");

        let app = router(state);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind events route");
        let address = listener.local_addr().expect("events route address");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let (mut client, _) = tokio_tungstenite::connect_async(format!(
            "ws://{address}/api/events?aiSessionAuthoritySnapshot=1"
        ))
        .await
        .expect("events upgrade");
        let hello = client.next().await.expect("hello").expect("hello frame");
        let tokio_tungstenite::tungstenite::Message::Text(text) = hello else {
            panic!("expected hello text frame");
        };
        let hello: Value = serde_json::from_str(&text).expect("hello json");
        assert_eq!(hello["type"], "streams.hello");
        let snapshot = client
            .next()
            .await
            .expect("authority snapshot")
            .expect("authority snapshot frame");
        let tokio_tungstenite::tungstenite::Message::Text(text) = snapshot else {
            panic!("expected authority snapshot text frame");
        };
        let snapshot: Value = serde_json::from_str(&text).expect("snapshot json");
        assert_eq!(snapshot["type"], "ai-session.snapshot");
        assert_eq!(snapshot["payload"]["meta"]["reason"], "startup");
        assert!(snapshot["payload"]["meta"]
            .get("previousRevision")
            .is_none());
        assert_eq!(snapshot["payload"]["snapshot"]["runningCount"], 2);
        let sessions = snapshot["payload"]["snapshot"]["sessions"]
            .as_array()
            .expect("snapshot sessions");
        assert_eq!(sessions.len(), 2);
        assert!(sessions
            .iter()
            .all(|session| session["id"] != "ses_0000000000102"));
        assert!(sessions
            .iter()
            .find(|session| session["id"] == "ses_0000000000101")
            .expect("child")
            .get("lineage")
            .is_none());
        drop(client);

        let (mut client, _) = tokio_tungstenite::connect_async(format!(
            "ws://{address}/api/events?aiSessionAuthoritySnapshot=1&aiSessionHierarchy=subagents"
        ))
        .await
        .expect("nested events upgrade");
        let _hello = client.next().await.expect("hello").expect("hello frame");
        let snapshot = client
            .next()
            .await
            .expect("nested authority snapshot")
            .expect("nested authority snapshot frame");
        let tokio_tungstenite::tungstenite::Message::Text(text) = snapshot else {
            panic!("expected nested authority snapshot text frame");
        };
        let snapshot: Value = serde_json::from_str(&text).expect("nested snapshot json");
        assert_eq!(
            snapshot["payload"]["snapshot"]["sessions"]
                .as_array()
                .expect("nested sessions")
                .iter()
                .find(|session| session["id"] == "ses_0000000000101")
                .expect("nested child")["lineage"]["kind"],
            "subagent"
        );
        drop(client);
        task.abort();
    }

    #[test]
    fn event_subscriptions_apply_connection_scoped_hierarchy() {
        let nested = parse_subscription(
            r#"{"type":"subscribe","topics":["ai.sessions"],"aiSessionHierarchy":{"subagents":true}}"#,
        )
        .expect("nested subscription");
        assert!(nested.subagents);
        let flat = parse_subscription(
            r#"{"type":"subscribe","topics":["ai.sessions"],"aiSessionHierarchy":{"subagents":false}}"#,
        )
        .expect("flat subscription");
        assert!(!flat.subagents);
        let default = parse_subscription(r#"{"type":"subscribe","topics":["ai.sessions"]}"#)
            .expect("default subscription");
        assert!(!default.subagents);
    }

    #[test]
    fn app_launch_request_matches_the_node_strict_wire_schema() {
        let valid = parse_app_launch_request(&json!({
            "appId": "fixture-shell",
            "title": "  Fixture  ",
            "args": ["-c", "cat"],
            "cwd": "  /workspace  ",
            "env": {"SAFE_KEY": "value"},
            "display": {"width": 1280, "height": 720, "depth": 24},
            "displayTarget": {"mode": "shared", "id": "display-a", "autoCreate": true},
            "profileId": "  profile-a  "
        }))
        .expect("valid launch");
        assert_eq!(valid.app_id.as_deref(), Some("fixture-shell"));
        assert_eq!(valid.options.title.as_deref(), Some("Fixture"));
        assert_eq!(valid.options.cwd.as_deref(), Some("/workspace"));
        assert_eq!(valid.options.profile_id.as_deref(), Some("profile-a"));
        assert_eq!(valid.options.env["SAFE_KEY"], "value");
        assert_eq!(valid.options.display.expect("display").depth, Some(24));

        for invalid in [
            json!({"unknown": true}),
            json!({"appId": "UPPER"}),
            json!({"title": "   "}),
            json!({"args": vec!["x"; 65]}),
            json!({"env": {"INVALID-KEY": "value"}}),
            json!({"display": {"width": 319}}),
            json!({"display": {"depth": 20}}),
            json!({"display": null}),
            json!({"displayTarget": {"mode": "shared", "id": "UPPER"}}),
            json!({"profileId": null}),
            json!({"aiSessionResume": {"aiSessionId": "a", "providerSessionId": "b"}}),
        ] {
            assert!(
                parse_app_launch_request(&invalid).is_err(),
                "expected rejection for {invalid}"
            );
        }
        assert!(parse_app_launch_request(&Value::Null)
            .expect("null body defaults")
            .app_id
            .is_none());
    }

    #[test]
    fn trigger_run_request_trims_and_enforces_node_limits() {
        let parsed = parse_trigger_run_input(&json!({
            "promptOverride": "  Run now  ",
            "eventSummary": "  event  ",
            "deploymentId": "  dep-1  "
        }))
        .expect("valid trigger run");
        assert_eq!(parsed.prompt_override.as_deref(), Some("Run now"));
        assert_eq!(parsed.event_summary.as_deref(), Some("event"));
        assert_eq!(parsed.deployment_id.as_deref(), Some("dep-1"));
        assert_eq!(
            parse_trigger_run_input(&json!({"eventSummary": "   "}))
                .expect("empty event summary")
                .event_summary
                .as_deref(),
            Some("")
        );

        for invalid in [
            json!({"promptOverride": "   "}),
            json!({"promptOverride": "x".repeat(20_001)}),
            json!({"eventSummary": "x".repeat(1_001)}),
            json!({"deploymentId": "   "}),
            json!({"deploymentId": "x".repeat(241)}),
            json!({"promptOverride": null}),
            json!({"unknown": true}),
        ] {
            assert!(
                parse_trigger_run_input(&invalid).is_err(),
                "expected rejection for {invalid}"
            );
        }
    }

    #[test]
    fn repository_commit_message_uses_js_trim_and_utf16_limit() {
        assert_eq!(
            normalize_repository_commit_message("  subject  ").expect("trimmed"),
            "subject"
        );
        assert_eq!(
            normalize_repository_commit_message(&"😀".repeat(32_768)).expect("boundary"),
            "😀".repeat(32_768)
        );
        assert!(normalize_repository_commit_message(&"😀".repeat(32_769)).is_err());
        assert!(normalize_repository_commit_message(" \n\t ").is_err());
    }

    #[tokio::test]
    async fn event_client_buffer_closes_at_the_node_16_mib_boundary() {
        let queued = AtomicUsize::new(0);
        assert!(reserve_event_bytes(
            &queued,
            MAX_EVENT_CLIENT_BUFFERED_BYTES
        ));
        assert_eq!(
            queued.load(Ordering::SeqCst),
            MAX_EVENT_CLIENT_BUFFERED_BYTES
        );
        assert!(!reserve_event_bytes(&queued, 1));

        let queued = Arc::new(AtomicUsize::new(0));
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let (too_slow, slow_receiver) = tokio::sync::watch::channel(false);
        let wire = EventWire::new(sender, queued.clone(), too_slow);
        assert!(!wire.enqueue(Message::Text(
            "x".repeat(MAX_EVENT_CLIENT_BUFFERED_BYTES + 1).into()
        )));
        assert!(receiver.try_recv().is_err());
        assert!(*slow_receiver.borrow());
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }
}
