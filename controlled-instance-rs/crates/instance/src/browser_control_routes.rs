use axum::{
    extract::{ws::WebSocketUpgrade, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use controlled_instance_protocol::{
    ApiEnvelope, EmbeddedBrowserCreationClaim, EmbeddedBrowserCreationDecline,
    EmbeddedBrowserSourceDelta, EmbeddedBrowserSourceRegistrationRequest,
    EmbeddedBrowserSourceRegistrationView, EmbeddedBrowserSourceSnapshot,
    EmbeddedBrowserSourceSnapshotCommit, EmbeddedBrowserTargetDetachParams,
};
use std::time::Duration;

use crate::{
    browser_control::{BrowserControlError, BrowserSourceRegistration},
    browser_control_relay::{self, BrowserControlRelayContext},
    server::{api_error, bearer_token},
    state::AppState,
};

const CONTROL_PLANE_HEADER: &str = "x-task-handoff-control-plane-id";
const USER_HEADER: &str = "x-task-handoff-user-id";

#[derive(Debug, Clone)]
struct BrowserProxyContext {
    panel_id: String,
    user_id: String,
}

pub(crate) fn is_browser_control_path(path: &str) -> bool {
    path.starts_with("/api/browser-control/")
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/browser-control/sources", post(register_source))
        .route(
            "/api/browser-control/sources/{source_ref}/snapshot",
            put(commit_snapshot),
        )
        .route(
            "/api/browser-control/sources/{source_ref}/deltas",
            post(commit_delta),
        )
        .route(
            "/api/browser-control/sources/{source_ref}",
            delete(revoke_source),
        )
        .route(
            "/api/browser-control/creation-requests",
            get(list_creation_approvals),
        )
        .route(
            "/api/browser-control/access",
            get(get_instance_access)
                .post(grant_instance_access)
                .delete(revoke_instance_access),
        )
        .route(
            "/api/browser-control/sources/{source_ref}/creation-requests/{creation_ref}/claim",
            post(claim_creation),
        )
        .route(
            "/api/browser-control/sources/{source_ref}/creation-requests/{creation_ref}/decline",
            post(decline_creation),
        )
        .route(
            "/api/browser-control/relay",
            get(browser_control_relay_socket),
        )
}

async fn browser_control_relay_socket(
    State(state): State<AppState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Response {
    let context = match browser_proxy_context(&state, &headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let shutdown = state.shutdown_receiver();
    browser_control_relay::websocket_upgrade(websocket)
        .on_upgrade(move |socket| async move {
            browser_control_relay::handle_control_socket(
                state,
                socket,
                BrowserControlRelayContext {
                    panel_id: context.panel_id,
                    user_id: context.user_id,
                },
                Some(shutdown),
            )
            .await;
        })
        .into_response()
}

async fn list_creation_approvals(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let context = match browser_proxy_context(&state, &headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let approvals = state
        .browser_control
        .list_creation_approvals_for_source_owner(&context.panel_id, &context.user_id);
    Json(ApiEnvelope { data: approvals }).into_response()
}

async fn register_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EmbeddedBrowserSourceRegistrationRequest>,
) -> Response {
    let context = match browser_proxy_context(&state, &headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let registration = BrowserSourceRegistration {
        panel_id: context.panel_id,
        owner_ref: context.user_id,
        display_name: body.display_name,
        host_label: body.host_label,
        publisher_ref: body.publisher_ref,
        renderer_host_binding: body.renderer_host_binding,
        page_host: body.page_host,
        page_host_capabilities: body.page_host_capabilities,
    };
    match state.browser_control.register_source(registration) {
        Ok(source) => {
            publish_browser_events(&state);
            Json(ApiEnvelope {
                data: EmbeddedBrowserSourceRegistrationView {
                    source,
                    registry_epoch: state.browser_control.registry_epoch(),
                    registry_revision: state.browser_control.registry_revision(),
                },
            })
            .into_response()
        }
        Err(error) => browser_error(error),
    }
}

async fn commit_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_ref): Path<String>,
    Json(body): Json<EmbeddedBrowserSourceSnapshot>,
) -> Response {
    if let Err(response) = require_source_owner(&state, &headers, &source_ref) {
        return response;
    }
    if body.source_ref != source_ref {
        return api_error(
            StatusCode::BAD_REQUEST,
            "BROWSER_SOURCE_MISMATCH",
            "Snapshot sourceRef does not match the request path.",
        );
    }
    let generation = body.generation;
    match state.browser_control.commit_snapshot(body) {
        Ok(()) => {
            publish_browser_events(&state);
            match state
                .browser_control
                .source_binding(&source_ref, generation)
            {
                Ok(binding) => Json(ApiEnvelope {
                    data: EmbeddedBrowserSourceSnapshotCommit {
                        registry_epoch: binding.registry_epoch,
                        registry_revision: binding.registry_revision,
                        source_revision: binding.source_revision,
                    },
                })
                .into_response(),
                Err(error) => browser_error(error),
            }
        }
        Err(error) => browser_error(error),
    }
}

async fn commit_delta(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_ref): Path<String>,
    Json(body): Json<EmbeddedBrowserSourceDelta>,
) -> Response {
    if let Err(response) = require_source_owner(&state, &headers, &source_ref) {
        return response;
    }
    if body.source_ref != source_ref {
        return api_error(
            StatusCode::BAD_REQUEST,
            "BROWSER_SOURCE_MISMATCH",
            "Delta sourceRef does not match the request path.",
        );
    }
    match state.browser_control.commit_delta(body) {
        Ok(revision) => {
            publish_browser_events(&state);
            Json(ApiEnvelope { data: revision }).into_response()
        }
        Err(error) => browser_error(error),
    }
}

async fn revoke_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_ref): Path<String>,
) -> Response {
    if let Err(response) = require_source_owner(&state, &headers, &source_ref) {
        return response;
    }
    match state
        .browser_control
        .revoke_source(&source_ref, "source-revoked")
    {
        Ok(()) => {
            publish_browser_events(&state);
            Json(ApiEnvelope { data: () }).into_response()
        }
        Err(error) => browser_error(error),
    }
}

async fn get_instance_access(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_browser_proxy(&state, &headers) {
        return response;
    }
    Json(ApiEnvelope {
        data: state.browser_control.access(),
    })
    .into_response()
}

async fn grant_instance_access(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_browser_proxy(&state, &headers) {
        return response;
    }
    let access = state.browser_control.grant_instance_access();
    publish_browser_events(&state);
    Json(ApiEnvelope { data: access }).into_response()
}

async fn revoke_instance_access(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_browser_proxy(&state, &headers) {
        return response;
    }
    for (session_ref, lease_ref) in state.browser_control.lease_targets_all() {
        let Ok(target) = state
            .browser_control
            .lease_command_target(&session_ref, &lease_ref)
        else {
            continue;
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            state
                .browser_control_relay
                .target_detach(EmbeddedBrowserTargetDetachParams {
                    lease_ref: target.lease.lease_ref,
                    tab_ref: target.lease.tab_ref,
                    source_ref: target.lease.source_ref,
                    generation: target.lease.generation,
                    reason: "instance-access-revoked".to_string(),
                }),
        )
        .await;
    }
    let revoked_leases = state.browser_control.revoke_instance_access();
    publish_browser_events(&state);
    Json(ApiEnvelope {
        data: serde_json::json!({ "revokedLeases": revoked_leases }),
    })
    .into_response()
}

async fn claim_creation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((source_ref, creation_ref)): Path<(String, String)>,
    Json(body): Json<EmbeddedBrowserCreationClaim>,
) -> Response {
    if let Err(response) = require_source_owner(&state, &headers, &source_ref) {
        return response;
    }
    if body.source_ref != source_ref {
        return api_error(
            StatusCode::BAD_REQUEST,
            "BROWSER_SOURCE_MISMATCH",
            "Creation claim sourceRef does not match the request path.",
        );
    }
    match state
        .browser_control
        .claim_creation(&source_ref, &creation_ref, body.expected_revision)
    {
        Ok(_claimed) => {
            let creating = match state
                .browser_control
                .mark_creation_creating(&source_ref, &creation_ref)
            {
                Ok(creating) => creating,
                Err(error) => return browser_error(error),
            };
            publish_browser_events(&state);
            let generation = match state.browser_control.source_generation(&source_ref) {
                Some(generation) => generation,
                None => {
                    return browser_error(BrowserControlError::new(
                        "BROWSER_SOURCE_UNAVAILABLE",
                        "Browser source disconnected before creation dispatch.",
                        409,
                    ))
                }
            };
            let open = controlled_instance_protocol::EmbeddedBrowserTabsOpenParams {
                creation_ref: creating.creation_ref.clone(),
                source_ref: source_ref.clone(),
                generation,
                url: creating.requested_url.clone(),
                title: creating.title.clone(),
            };
            if let Err(error) = state.browser_control_relay.tabs_open(open).await {
                let _ =
                    state
                        .browser_control
                        .fail_creation(&source_ref, &creation_ref, &error.message);
                publish_browser_events(&state);
                return browser_error(error);
            }
            publish_browser_events(&state);
            Json(ApiEnvelope { data: creating }).into_response()
        }
        Err(error) => browser_error(error),
    }
}

async fn decline_creation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((source_ref, creation_ref)): Path<(String, String)>,
    Json(body): Json<EmbeddedBrowserCreationDecline>,
) -> Response {
    if let Err(response) = require_source_owner(&state, &headers, &source_ref) {
        return response;
    }
    if body.source_ref != source_ref {
        return api_error(
            StatusCode::BAD_REQUEST,
            "BROWSER_SOURCE_MISMATCH",
            "Creation decline sourceRef does not match the request path.",
        );
    }
    match state
        .browser_control
        .decline_creation(&source_ref, &creation_ref, body.expected_revision)
    {
        Ok(creation) => {
            publish_browser_events(&state);
            Json(ApiEnvelope { data: creation }).into_response()
        }
        Err(error) => browser_error(error),
    }
}

fn require_browser_proxy(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    browser_proxy_context(state, headers).map(|_| ())
}

fn browser_proxy_context(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<BrowserProxyContext, Response> {
    let expected = state.config.registration_token.as_deref().ok_or_else(|| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "BROWSER_CHANNEL_UNAVAILABLE",
            "Browser control requires a managed instance registration token.",
        )
    })?;
    let actual = bearer_token(headers).ok_or_else(|| {
        api_error(
            StatusCode::FORBIDDEN,
            "BROWSER_CHANNEL_FORBIDDEN",
            "The managed instance proxy credential is required.",
        )
    })?;
    if !crate::server::tokens_match(expected, &actual) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "BROWSER_CHANNEL_FORBIDDEN",
            "The managed instance proxy credential is invalid.",
        ));
    }
    let panel_id = headers
        .get(CONTROL_PLANE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 240)
        .ok_or_else(|| {
            api_error(
                StatusCode::FORBIDDEN,
                "BROWSER_CHANNEL_CONTEXT_REQUIRED",
                "The verified Control Plane context is required.",
            )
        })?;
    let user_id = headers
        .get(USER_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 240)
        .ok_or_else(|| {
            api_error(
                StatusCode::FORBIDDEN,
                "BROWSER_CHANNEL_CONTEXT_REQUIRED",
                "The verified user context is required.",
            )
        })?;
    Ok(BrowserProxyContext {
        panel_id: panel_id.to_string(),
        user_id: user_id.to_string(),
    })
}

fn require_source_owner(
    state: &AppState,
    headers: &HeaderMap,
    source_ref: &str,
) -> Result<(), Response> {
    let context = browser_proxy_context(state, headers)?;
    match state.browser_control.source_owner(source_ref) {
        Some((panel_id, owner_ref))
            if panel_id == context.panel_id && owner_ref == context.user_id =>
        {
            Ok(())
        }
        _ => Err(api_error(
            StatusCode::NOT_FOUND,
            "BROWSER_SOURCE_NOT_FOUND",
            "Browser source was not found.",
        )),
    }
}

pub(crate) fn publish_browser_events(state: &AppState) {
    for event in state.browser_control.take_events() {
        let _ = state.events.publish(event.event_type, event.payload);
    }
}

fn browser_error(error: BrowserControlError) -> Response {
    let status =
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    api_error(status, error.code, &error.message)
}
