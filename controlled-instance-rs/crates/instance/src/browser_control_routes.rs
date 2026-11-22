use axum::{
    body::Bytes,
    extract::{ws::WebSocketUpgrade, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use controlled_instance_protocol::{
    ApiEnvelope, EmbeddedBrowserDefaultContextClaimRequest, EmbeddedBrowserSourceDelta,
    EmbeddedBrowserSourceRegistrationRequest, EmbeddedBrowserSourceRegistrationView,
    EmbeddedBrowserSourceSnapshot, EmbeddedBrowserSourceSnapshotCommit,
    EmbeddedBrowserTargetDetachParams,
};
use serde::Deserialize;
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreationContextQuery {
    #[serde(default)]
    source_ref: Option<String>,
    #[serde(default)]
    expected_revision: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantAccessRequest {
    #[serde(default)]
    request_ref: Option<String>,
    #[serde(default)]
    expected_revision: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DenyAccessRequest {
    #[serde(default)]
    expected_revision: Option<u64>,
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
            "/api/browser-control/creation-context",
            get(get_creation_context)
                .put(claim_creation_context)
                .delete(revoke_creation_context),
        )
        .route(
            "/api/browser-control/access",
            get(get_instance_access)
                .post(grant_instance_access)
                .delete(revoke_instance_access),
        )
        .route(
            "/api/browser-control/access-requests/{request_ref}/deny",
            post(deny_instance_access_request),
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

async fn get_creation_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CreationContextQuery>,
) -> Response {
    let context = match browser_proxy_context(&state, &headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let claim_source_ref = query
        .source_ref
        .as_deref()
        .map(str::trim)
        .filter(|source_ref| !source_ref.is_empty());
    if let Some(source_ref) = claim_source_ref {
        if let Some((panel_id, owner_ref)) = state.browser_control.source_owner(source_ref) {
            if panel_id != context.panel_id || owner_ref != context.user_id {
                return api_error(
                    StatusCode::FORBIDDEN,
                    "BROWSER_CREATION_CONTEXT_NOT_OWNED",
                    "A panel can only inspect its own browser source.",
                );
            }
        }
    }
    Json(ApiEnvelope {
        data: state
            .browser_control
            .creation_context_snapshot(claim_source_ref),
    })
    .into_response()
}

async fn claim_creation_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EmbeddedBrowserDefaultContextClaimRequest>,
) -> Response {
    let context = match browser_proxy_context(&state, &headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let owns_source = state
        .browser_control
        .source_owner(&body.source_ref)
        .is_some_and(|(panel_id, owner_ref)| {
            panel_id == context.panel_id && owner_ref == context.user_id
        });
    if !owns_source {
        return api_error(
            StatusCode::FORBIDDEN,
            "BROWSER_CREATION_CONTEXT_NOT_OWNED",
            "A desktop source can only request itself as the default creation context.",
        );
    }
    let outcome = match state.browser_control.claim_default_context(
        &body.source_ref,
        body.expected_revision,
        &context.panel_id,
        &context.user_id,
    ) {
        Ok(outcome) => outcome,
        Err(error) => return browser_error(error),
    };
    for pending in &outcome.pending_creations {
        if let Err(error) = dispatch_creation(&state, &pending.creation_ref).await {
            tracing::warn!(
                code = error.code,
                creation_ref = %pending.creation_ref,
                "Pending browser creation could not be dispatched after default context claim"
            );
        }
    }
    publish_browser_events(&state);
    Json(ApiEnvelope {
        data: outcome.result,
    })
    .into_response()
}

async fn revoke_creation_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CreationContextQuery>,
    body: Bytes,
) -> Response {
    let context = match browser_proxy_context(&state, &headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let request = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(serde_json::Value::Object(value)) if value.is_empty() => None,
        Ok(value) => {
            match serde_json::from_value::<EmbeddedBrowserDefaultContextClaimRequest>(value) {
                Ok(request) => Some(request),
                Err(_) => {
                    return api_error(
                    StatusCode::BAD_REQUEST,
                    "BROWSER_REQUEST_INVALID",
                    "sourceRef and expectedRevision are required to revoke the default browser context.",
                );
                }
            }
        }
        Err(_) if body.iter().all(u8::is_ascii_whitespace) => None,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "BROWSER_REQUEST_INVALID",
                "sourceRef and expectedRevision are required to revoke the default browser context.",
            );
        }
    };
    let request = match request {
        Some(request) => request,
        None => {
            let source_ref = query
                .source_ref
                .as_deref()
                .map(str::trim)
                .filter(|source_ref| !source_ref.is_empty());
            let Some(source_ref) = source_ref else {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "BROWSER_REQUEST_INVALID",
                    "sourceRef and expectedRevision are required to revoke the default browser context.",
                );
            };
            let Some(expected_revision) = query.expected_revision else {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "BROWSER_REQUEST_INVALID",
                    "expectedRevision is required to revoke the default browser context.",
                );
            };
            EmbeddedBrowserDefaultContextClaimRequest {
                source_ref: source_ref.to_string(),
                expected_revision,
            }
        }
    };
    let source_ref = request.source_ref.trim();
    if source_ref.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "BROWSER_REQUEST_INVALID",
            "sourceRef is required to revoke the default browser context.",
        );
    }
    let result = match state.browser_control.clear_default_context(
        source_ref,
        request.expected_revision,
        &context.panel_id,
        &context.user_id,
    ) {
        Ok(result) => result,
        Err(error) => return browser_error(error),
    };
    publish_browser_events(&state);
    Json(ApiEnvelope {
        data: serde_json::json!({
            "cleared": result.cleared,
            "revision": result.revision,
        }),
    })
    .into_response()
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

async fn grant_instance_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<GrantAccessRequest>>,
) -> Response {
    if let Err(response) = require_browser_proxy(&state, &headers) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    match state
        .browser_control
        .grant_instance_access_with(body.request_ref.as_deref(), body.expected_revision)
    {
        Ok(access) => {
            publish_browser_events(&state);
            Json(ApiEnvelope { data: access }).into_response()
        }
        Err(error) => browser_error(error),
    }
}

async fn deny_instance_access_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_ref): Path<String>,
    body: Option<Json<DenyAccessRequest>>,
) -> Response {
    if let Err(response) = require_browser_proxy(&state, &headers) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    match state
        .browser_control
        .deny_instance_access_request(&request_ref, body.expected_revision)
    {
        Ok(view) => {
            publish_browser_events(&state);
            Json(ApiEnvelope { data: view }).into_response()
        }
        Err(error) => browser_error(error),
    }
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

pub(crate) async fn dispatch_creation(
    state: &AppState,
    creation_ref: &str,
) -> Result<Option<controlled_instance_protocol::EmbeddedBrowserCreationView>, BrowserControlError>
{
    let Some(dispatch) = state.browser_control.take_creation_dispatch(creation_ref)? else {
        return Ok(None);
    };
    let open = controlled_instance_protocol::EmbeddedBrowserTabsOpenParams {
        creation_ref: dispatch.creation.creation_ref.clone(),
        source_ref: dispatch.source_ref.clone(),
        generation: dispatch.generation,
        url: dispatch.creation.requested_url.clone(),
        title: dispatch.creation.title.clone(),
    };
    if let Err(error) = state.browser_control_relay.tabs_open(open).await {
        let _ = state.browser_control.fail_creation(
            &dispatch.source_ref,
            &dispatch.creation.creation_ref,
            &error.message,
        );
        publish_browser_events(state);
        return Err(error);
    }
    publish_browser_events(state);
    Ok(Some(dispatch.creation))
}

pub(crate) async fn dispatch_claimed_creations(
    state: &AppState,
    primary_ref: &str,
) -> Result<(), BrowserControlError> {
    for creation_ref in state.browser_control.claimed_creation_refs() {
        match dispatch_creation(state, &creation_ref).await {
            Ok(_) => {}
            Err(error) if creation_ref == primary_ref => return Err(error),
            Err(error) => {
                tracing::warn!(
                    code = error.code,
                    creation_ref = %creation_ref,
                    "Claimed browser creation could not be dispatched"
                );
            }
        }
    }
    Ok(())
}

fn browser_error(error: BrowserControlError) -> Response {
    let status =
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    api_error(status, error.code, &error.message)
}
