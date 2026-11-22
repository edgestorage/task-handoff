use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use controlled_instance_protocol::{
    assert_embedded_browser_cdp_method, embedded_browser_cdp_protocol_document, mint_entity_id,
    EmbeddedBrowserCdpCommand, EmbeddedBrowserCreationStatus, EmbeddedBrowserLease,
    EmbeddedBrowserTabsCloseParams, EmbeddedBrowserTargetAttachParams,
    EmbeddedBrowserTargetAttachToTargetParams, EmbeddedBrowserTargetAttachToTargetResult,
    EmbeddedBrowserTargetCloseTargetParams, EmbeddedBrowserTargetCloseTargetResult,
    EmbeddedBrowserTargetCreateTargetParams, EmbeddedBrowserTargetCreateTargetResult,
    EmbeddedBrowserTargetDetachFromTargetParams, EmbeddedBrowserTargetDetachFromTargetResult,
    EmbeddedBrowserTargetDetachParams, EmbeddedBrowserTargetFilter,
    EmbeddedBrowserTargetGetBrowserContextsResult, EmbeddedBrowserTargetGetTargetInfoParams,
    EmbeddedBrowserTargetGetTargetInfoResult, EmbeddedBrowserTargetGetTargetsResult,
    EmbeddedBrowserTargetInfo, EmbeddedBrowserTargetSetAutoAttachParams,
    EmbeddedBrowserTargetSetAutoAttachResult, EmbeddedBrowserTargetSetDiscoverTargetsParams,
    EmbeddedBrowserTargetSetDiscoverTargetsResult, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::{browser_control::BrowserControlError, state::AppState};

const CREATION_WAIT: Duration = Duration::from_secs(10);
const WS_OUTBOUND_QUEUE: usize = 256;

#[derive(Debug, Deserialize)]
struct NewTargetQuery {
    #[serde(default)]
    url: Option<String>,
}

struct CdpRequestAuth {
    token: String,
    session_ref: String,
}

#[derive(Debug, Clone)]
struct BrowserAutoAttach {
    wait_for_debugger_on_start: bool,
    filter: Option<Vec<EmbeddedBrowserTargetFilter>>,
}

struct BrowserCdpConnection {
    session_ref: String,
    attached: HashMap<String, EmbeddedBrowserLease>,
    target_sessions: HashMap<String, String>,
    auto_attach: Option<BrowserAutoAttach>,
    discover: bool,
    known_targets: BTreeMap<String, EmbeddedBrowserTargetInfo>,
}

impl BrowserCdpConnection {
    fn new(session_ref: String) -> Self {
        Self {
            session_ref,
            attached: HashMap::new(),
            target_sessions: HashMap::new(),
            auto_attach: None,
            discover: false,
            known_targets: BTreeMap::new(),
        }
    }
}

pub(crate) fn is_path(path: &str) -> bool {
    path == "/json/version"
        || path == "/json/list"
        || path == "/json/protocol"
        || path == "/json/new"
        || path.starts_with("/json/close/")
        || path.starts_with("/devtools/page/")
        || path.starts_with("/devtools/browser/")
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/json/version", get(json_version))
        .route("/json/list", get(json_list))
        .route("/json/protocol", get(json_protocol))
        .route("/json/new", get(json_new).put(json_new))
        .route("/json/close/{tab_ref}", get(json_close))
        .route("/devtools/page/{tab_ref}", get(devtools_page))
        .route("/devtools/browser/{browser_ref}", get(devtools_browser))
}

async fn json_version(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let auth = match authenticate(&state, &headers, &uri) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let identity = state
        .browser_control
        .browser_cdp_identity(Some(&auth.session_ref));
    Json(json!({
        "Browser": identity
            .as_ref()
            .map(|identity| format!("Chrome/{}", identity.chrome_version))
            .unwrap_or_else(|| "TaskHandoff/EmbeddedBrowser".to_string()),
        "Protocol-Version": EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION,
        "User-Agent": identity
            .as_ref()
            .map(|identity| identity.user_agent.clone())
            .unwrap_or_else(|| "TaskHandoff embedded Chromium".to_string()),
        "V8-Version": identity
            .as_ref()
            .map(|identity| identity.v8_version.clone())
            .unwrap_or_else(|| "electron".to_string()),
        "WebKit-Version": identity
            .as_ref()
            .map(|identity| identity.webkit_version.clone())
            .unwrap_or_else(|| "electron".to_string()),
        "webSocketDebuggerUrl": format!(
            "{}/devtools/browser/{}?token={}",
            websocket_origin(&state),
            percent_encoding::utf8_percent_encode(
                &state.browser_control.registry_epoch(),
                percent_encoding::NON_ALPHANUMERIC,
            ),
            percent_encoding::utf8_percent_encode(&auth.token, percent_encoding::NON_ALPHANUMERIC),
        ),
    }))
    .into_response()
}

async fn json_protocol() -> Json<Value> {
    Json(embedded_browser_cdp_protocol_document())
}

async fn json_list(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let auth = match authenticate(&state, &headers, &uri) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let pages = state.browser_control.all_pages();
    Json(Value::Array(
        pages
            .into_iter()
            .map(|page| target_object(&state, &page, &auth.token))
            .collect(),
    ))
    .into_response()
}

async fn json_new(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<NewTargetQuery>,
) -> Response {
    let auth = match authenticate(&state, &headers, &uri) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let url = query.url.unwrap_or_else(|| "about:blank".to_string());
    if !browser_url_allowed(&url) {
        return cdp_error(
            StatusCode::BAD_REQUEST,
            "BROWSER_OPERATION_UNSUPPORTED",
            "Only http, https, and about:blank browser URLs are supported.",
        );
    }
    let creation = match state
        .browser_control
        .request_creation(&auth.session_ref, &url, None)
    {
        Ok(creation) => creation,
        Err(error) => return browser_error(error),
    };
    crate::browser_control_routes::publish_browser_events(&state);
    if let Err(error) =
        crate::browser_control_routes::dispatch_claimed_creations(&state, &creation.creation_ref)
            .await
    {
        return browser_error(error);
    }
    let creation = match state
        .browser_control
        .wait_for_creation(&auth.session_ref, &creation.creation_ref, CREATION_WAIT)
        .await
    {
        Ok(creation) => creation,
        Err(error) => return browser_error(error),
    };
    match creation.state {
        EmbeddedBrowserCreationStatus::Ready => {
            let page = creation
                .tab_ref
                .as_deref()
                .and_then(|tab_ref| state.browser_control.page(tab_ref).ok());
            let Some(page) = page else {
                return cdp_error(
                    StatusCode::CONFLICT,
                    "BROWSER_TAB_NOT_FOUND",
                    "The created browser tab is no longer available.",
                );
            };
            Json(target_object(&state, &page, &auth.token)).into_response()
        }
        EmbeddedBrowserCreationStatus::Pending
        | EmbeddedBrowserCreationStatus::Claimed
        | EmbeddedBrowserCreationStatus::Creating => (
            StatusCode::ACCEPTED,
            Json(json!({
                "creationRef": creation.creation_ref,
                "state": creation.state,
                "requestedUrl": creation.requested_url,
                "expiresAt": creation.expires_at,
            })),
        )
            .into_response(),
        EmbeddedBrowserCreationStatus::Declined => cdp_error(
            StatusCode::CONFLICT,
            "BROWSER_CREATION_DECLINED",
            "The browser page creation request was declined.",
        ),
        EmbeddedBrowserCreationStatus::Expired => cdp_error(
            StatusCode::REQUEST_TIMEOUT,
            "BROWSER_CREATION_EXPIRED",
            "The browser page creation request expired.",
        ),
        EmbeddedBrowserCreationStatus::Failed => cdp_error(
            StatusCode::CONFLICT,
            "BROWSER_CREATION_FAILED",
            "The browser page creation request failed on the desktop.",
        ),
    }
}

async fn json_close(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(tab_ref): Path<String>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers, &uri) {
        return response;
    }
    let page = match state.browser_control.page(&tab_ref) {
        Ok(page) => page,
        Err(error) => return browser_error(error),
    };
    let result = state
        .browser_control_relay
        .tabs_close(EmbeddedBrowserTabsCloseParams {
            source_ref: page.source_ref.clone(),
            generation: page.generation,
            tab_ref: page.tab_ref.clone(),
        })
        .await;
    if let Err(error) = result {
        return browser_error(error);
    }
    state
        .browser_control
        .invalidate_leases_for_tab(&page.tab_ref);
    crate::browser_control_routes::publish_browser_events(&state);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Target is closing",
    )
        .into_response()
}

async fn devtools_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(tab_ref): Path<String>,
    websocket: WebSocketUpgrade,
) -> Response {
    let auth = match authenticate(&state, &headers, &uri) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let page = match state.browser_control.page(&tab_ref) {
        Ok(page) => page,
        Err(error) => return browser_error(error),
    };
    let lease = match state
        .browser_control
        .attach_tab(&auth.session_ref, &tab_ref)
    {
        Ok(lease) => lease,
        Err(error) => return browser_error(error),
    };
    let target = match state
        .browser_control
        .lease_command_target(&auth.session_ref, &lease.lease_ref)
    {
        Ok(target) => target,
        Err(error) => {
            state
                .browser_control
                .detach_lease(&auth.session_ref, &lease.lease_ref);
            return browser_error(error);
        }
    };
    let attach = EmbeddedBrowserTargetAttachParams {
        lease_ref: lease.lease_ref.clone(),
        tab_ref: lease.tab_ref.clone(),
        source_ref: lease.source_ref.clone(),
        generation: lease.generation,
        page_host: target.page.page_host,
        profile: state.browser_control.page_profile().to_string(),
    };
    if let Err(error) = state.browser_control_relay.target_attach(attach).await {
        state
            .browser_control
            .detach_lease(&auth.session_ref, &lease.lease_ref);
        crate::browser_control_routes::publish_browser_events(&state);
        return browser_error(error);
    }
    crate::browser_control_routes::publish_browser_events(&state);
    websocket
        .on_upgrade(move |socket| async move {
            handle_page_socket(state, socket, auth.session_ref, lease, page.tab_ref).await;
        })
        .into_response()
}

async fn devtools_browser(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(browser_ref): Path<String>,
    websocket: WebSocketUpgrade,
) -> Response {
    let auth = match authenticate(&state, &headers, &uri) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    if browser_ref != state.browser_control.registry_epoch() {
        return cdp_error(
            StatusCode::CONFLICT,
            "BROWSER_SNAPSHOT_REQUIRED",
            "The browser target view changed. Reload /json/version.",
        );
    }
    websocket
        .on_upgrade(move |socket| async move {
            handle_browser_socket(state, socket, auth.session_ref).await;
        })
        .into_response()
}

async fn handle_browser_socket(state: AppState, socket: WebSocket, session_ref: String) {
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<Message>(WS_OUTBOUND_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut events = state.events.subscribe();
    let mut connection = BrowserCdpConnection::new(session_ref.clone());

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Text(text) => {
                        dispatch_browser_command(&state, &mut connection, &outbound, text.as_bytes()).await;
                    }
                    Message::Binary(bytes) => {
                        dispatch_browser_command(&state, &mut connection, &outbound, &bytes).await;
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if event.r#type == "browser.control.cdp-event" {
                    let Some(payload) = event.payload.as_object() else { continue; };
                    if payload.get("frameSessionRef").and_then(Value::as_str).is_some() {
                        continue;
                    }
                    let Some(lease_ref) = payload.get("leaseRef").and_then(Value::as_str) else { continue; };
                    let Some(session_id) = connection
                        .attached
                        .iter()
                        .find_map(|(session_id, lease)| (lease.lease_ref == lease_ref).then(|| session_id.clone()))
                    else { continue; };
                    let Some(method) = payload.get("method").and_then(Value::as_str) else { continue; };
                    let notification = json!({
                        "method": method,
                        "params": payload.get("params").cloned().unwrap_or_else(|| json!({})),
                        "sessionId": session_id,
                    });
                    if outbound.try_send(Message::Text(notification.to_string().into())).is_err() {
                        break;
                    }
                    continue;
                }
                prune_stale_browser_attachments(&state, &mut connection, &outbound);
                for notification in auto_attach_new_targets(&state, &mut connection).await {
                    if outbound.try_send(Message::Text(notification.to_string().into())).is_err() {
                        break;
                    }
                }
                if connection.discover {
                    emit_discovery_changes(&state, &mut connection, &outbound);
                }
            }
        }
    }

    drop(outbound);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
    cleanup_browser_attachments(&state, &mut connection).await;
    tracing::debug!("CDP browser websocket closed");
}

async fn dispatch_browser_command(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
    outbound: &mpsc::Sender<Message>,
    bytes: &[u8],
) {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => {
            let _ = outbound.try_send(Message::Text(
                cdp_error_value(Value::Null, -32700, "Parse error", None)
                    .to_string()
                    .into(),
            ));
            return;
        }
    };
    let Some(object) = value.as_object() else {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(Value::Null, -32600, "Invalid request", None)
                .to_string()
                .into(),
        ));
        return;
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    if id.is_null() {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(id, -32600, "A CDP command id is required.", None)
                .to_string()
                .into(),
        ));
        return;
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(id, -32600, "A CDP method is required.", None)
                .to_string()
                .into(),
        ));
        return;
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (mut response, notifications) = if let Some(session_id) = session_id {
        dispatch_browser_session_command(state, connection, &id, session_id, method, params).await
    } else {
        dispatch_browser_target_command(state, connection, &id, method, params).await
    };
    if let Some(session_id) = session_id {
        if let Some(object) = response.as_object_mut() {
            object
                .entry("sessionId".to_string())
                .or_insert_with(|| Value::String(session_id.to_string()));
        }
    }
    let _ = outbound.try_send(Message::Text(response.to_string().into()));
    for notification in notifications {
        let _ = outbound.try_send(Message::Text(notification.to_string().into()));
    }
    prune_stale_browser_attachments(state, connection, outbound);
    if connection.discover {
        emit_discovery_changes(state, connection, outbound);
    }
}

async fn dispatch_browser_session_command(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
    id: &Value,
    session_id: &str,
    method: &str,
    params: Value,
) -> (Value, Vec<Value>) {
    if method.starts_with("Target.") {
        return (
            unsupported_browser_method(
                id,
                "Target methods cannot be nested inside a target session.",
            ),
            Vec::new(),
        );
    }
    if assert_embedded_browser_cdp_method(method).is_err() {
        return (
            unsupported_browser_method(id, "The CDP method is outside the embedded page profile."),
            Vec::new(),
        );
    }
    if method == "Runtime.runIfWaitingForDebugger" {
        return (json!({ "id": id, "result": {} }), Vec::new());
    }
    let Some(lease) = connection.attached.get(session_id).cloned() else {
        return (
            cdp_error_value(
                id.clone(),
                -32000,
                "The browser target session is stale.",
                Some("BROWSER_LEASE_STALE"),
            ),
            Vec::new(),
        );
    };
    if state
        .browser_control
        .lease_command_target(&connection.session_ref, &lease.lease_ref)
        .is_err()
    {
        connection.attached.remove(session_id);
        return (
            cdp_error_value(
                id.clone(),
                -32000,
                "The browser target session is stale.",
                Some("BROWSER_LEASE_STALE"),
            ),
            vec![detached_notification(session_id, &lease.tab_ref)],
        );
    }
    let request_id = format!("cdpws_{}_{}", lease.lease_ref, uuid::Uuid::new_v4());
    let command = EmbeddedBrowserCdpCommand {
        lease_ref: lease.lease_ref.clone(),
        method: method.to_string(),
        params: Some(params),
        frame_session_ref: None,
        request_id,
        timeout_ms: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    };
    match state
        .browser_control_relay
        .cdp_send(
            &lease.source_ref,
            lease.generation,
            command,
            Duration::from_millis(EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS),
        )
        .await
    {
        Ok(result) => (json!({ "id": id, "result": result }), Vec::new()),
        Err(error) => (browser_error_value(id.clone(), &error), Vec::new()),
    }
}

async fn dispatch_browser_target_command(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
    id: &Value,
    method: &str,
    params: Value,
) -> (Value, Vec<Value>) {
    match method {
        "Browser.getVersion" => {
            let result = state
                .browser_control
                .browser_cdp_identity(Some(&connection.session_ref))
                .map(|identity| {
                    json!({
                        "protocolVersion": EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION,
                        "product": format!("Chrome/{}", identity.chrome_version),
                        "revision": format!("@{}", identity.chrome_version),
                        "userAgent": identity.user_agent,
                        "jsVersion": identity.v8_version,
                    })
                })
                .unwrap_or_else(|| {
                    json!({
                        "protocolVersion": EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION,
                        "product": "TaskHandoff/EmbeddedBrowser",
                        "revision": "@embedded",
                        "userAgent": "TaskHandoff embedded Chromium",
                        "jsVersion": "electron",
                    })
                });
            (json!({ "id": id, "result": result }), Vec::new())
        }
        "Target.getTargets" => {
            let attached: HashSet<String> = connection
                .attached
                .values()
                .map(|lease| lease.tab_ref.clone())
                .collect();
            let result = EmbeddedBrowserTargetGetTargetsResult {
                target_infos: state.browser_control.target_infos_with_attached(&attached),
            };
            (json!({ "id": id, "result": result }), Vec::new())
        }
        "Target.getTargetInfo" => {
            let params: EmbeddedBrowserTargetGetTargetInfoParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            let attached = connection
                .attached
                .values()
                .any(|lease| lease.tab_ref == params.target_id);
            match state
                .browser_control
                .target_info_with_attached(&params.target_id, attached)
            {
                Ok(target_info) => (
                    json!({
                        "id": id,
                        "result": EmbeddedBrowserTargetGetTargetInfoResult { target_info },
                    }),
                    Vec::new(),
                ),
                Err(error) => (browser_error_value(id.clone(), &error), Vec::new()),
            }
        }
        "Target.getBrowserContexts" => {
            let result = EmbeddedBrowserTargetGetBrowserContextsResult {
                browser_context_ids: state.browser_control.browser_context_ids(),
                default_browser_context_id: state.browser_control.default_browser_context_id(),
            };
            (json!({ "id": id, "result": result }), Vec::new())
        }
        "Target.setAutoAttach" => {
            let params: EmbeddedBrowserTargetSetAutoAttachParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            if params.validate().is_err() {
                return (invalid_browser_params(id), Vec::new());
            }
            connection.auto_attach = params.auto_attach.then(|| BrowserAutoAttach {
                wait_for_debugger_on_start: params.wait_for_debugger_on_start,
                filter: params.filter,
            });
            let notifications = auto_attach_new_targets(state, connection).await;
            (
                json!({
                    "id": id,
                    "result": EmbeddedBrowserTargetSetAutoAttachResult {},
                }),
                notifications,
            )
        }
        "Target.attachToTarget" => {
            let params: EmbeddedBrowserTargetAttachToTargetParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            if !params.flatten {
                return (
                    unsupported_browser_method(
                        id,
                        "Target.attachToTarget only supports flatten=true.",
                    ),
                    Vec::new(),
                );
            }
            let session_id = match ensure_target_session(state, connection, &params.target_id).await
            {
                Ok(session_id) => session_id,
                Err(error) => return (browser_error_value(id.clone(), &error), Vec::new()),
            };
            (
                json!({
                    "id": id,
                    "result": EmbeddedBrowserTargetAttachToTargetResult {
                        session_id,
                    },
                }),
                Vec::new(),
            )
        }
        "Target.detachFromTarget" => {
            let params: EmbeddedBrowserTargetDetachFromTargetParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            if params.validate().is_err() {
                return (invalid_browser_params(id), Vec::new());
            }
            let selected_session = if let Some(session_id) = params.session_id.as_deref() {
                connection
                    .attached
                    .remove(session_id)
                    .map(|lease| (session_id.to_string(), lease))
            } else {
                let target_id = params.target_id.as_deref().unwrap_or_default();
                let session_id = connection.attached.iter().find_map(|(session_id, lease)| {
                    (lease.tab_ref == target_id).then(|| session_id.clone())
                });
                session_id.and_then(|session_id| {
                    connection
                        .attached
                        .remove(&session_id)
                        .map(|lease| (session_id, lease))
                })
            };
            let Some((session_id, lease)) = selected_session else {
                return (
                    json!({
                        "id": id,
                        "result": EmbeddedBrowserTargetDetachFromTargetResult {},
                    }),
                    Vec::new(),
                );
            };
            if params
                .target_id
                .as_deref()
                .is_some_and(|target_id| target_id != lease.tab_ref)
            {
                connection.attached.insert(session_id, lease);
                return (
                    json!({
                        "id": id,
                        "result": EmbeddedBrowserTargetDetachFromTargetResult {},
                    }),
                    Vec::new(),
                );
            }
            if connection.target_sessions.get(&lease.tab_ref) == Some(&session_id) {
                connection.target_sessions.remove(&lease.tab_ref);
            }
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                state
                    .browser_control_relay
                    .target_detach(EmbeddedBrowserTargetDetachParams {
                        lease_ref: lease.lease_ref.clone(),
                        tab_ref: lease.tab_ref.clone(),
                        source_ref: lease.source_ref.clone(),
                        generation: lease.generation,
                        reason: "target-detached".to_string(),
                    }),
            )
            .await;
            state
                .browser_control
                .detach_lease(&connection.session_ref, &lease.lease_ref);
            crate::browser_control_routes::publish_browser_events(state);
            let notification = connection
                .discover
                .then(|| detached_notification(&session_id, &lease.tab_ref));
            (
                json!({
                    "id": id,
                    "result": EmbeddedBrowserTargetDetachFromTargetResult {},
                }),
                notification.into_iter().collect(),
            )
        }
        "Target.closeTarget" => {
            let params: EmbeddedBrowserTargetCloseTargetParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            let page = match state.browser_control.page(&params.target_id) {
                Ok(page) => page,
                Err(error) => return (browser_error_value(id.clone(), &error), Vec::new()),
            };
            if let Err(error) = state
                .browser_control_relay
                .tabs_close(EmbeddedBrowserTabsCloseParams {
                    source_ref: page.source_ref.clone(),
                    generation: page.generation,
                    tab_ref: page.tab_ref.clone(),
                })
                .await
            {
                return (browser_error_value(id.clone(), &error), Vec::new());
            }
            state
                .browser_control
                .invalidate_leases_for_tab(&page.tab_ref);
            let mut notifications = Vec::new();
            let detached = connection
                .attached
                .iter()
                .filter(|(_, lease)| lease.tab_ref == page.tab_ref)
                .map(|(session_id, lease)| (session_id.clone(), lease.clone()))
                .collect::<Vec<_>>();
            for (session_id, lease) in detached {
                connection.attached.remove(&session_id);
                if connection.target_sessions.get(&lease.tab_ref) == Some(&session_id) {
                    connection.target_sessions.remove(&lease.tab_ref);
                }
                state
                    .browser_control
                    .detach_lease(&connection.session_ref, &lease.lease_ref);
                if connection.discover {
                    notifications.push(detached_notification(&session_id, &lease.tab_ref));
                }
            }
            crate::browser_control_routes::publish_browser_events(state);
            (
                json!({
                    "id": id,
                    "result": EmbeddedBrowserTargetCloseTargetResult { success: true },
                }),
                notifications,
            )
        }
        "Target.createTarget" => {
            let params: EmbeddedBrowserTargetCreateTargetParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            if !browser_url_allowed(&params.url) {
                return (
                    unsupported_browser_method(
                        id,
                        "Only http, https, and about:blank browser URLs are supported.",
                    ),
                    Vec::new(),
                );
            }
            let creation = match state.browser_control.request_creation_with_context(
                &connection.session_ref,
                &params.url,
                None,
                params.browser_context_id.as_deref(),
            ) {
                Ok(creation) => creation,
                Err(error) => return (browser_error_value(id.clone(), &error), Vec::new()),
            };
            crate::browser_control_routes::publish_browser_events(state);
            if let Err(error) = crate::browser_control_routes::dispatch_claimed_creations(
                state,
                &creation.creation_ref,
            )
            .await
            {
                return (browser_error_value(id.clone(), &error), Vec::new());
            }
            let creation = match state
                .browser_control
                .wait_for_creation(
                    &connection.session_ref,
                    &creation.creation_ref,
                    CREATION_WAIT,
                )
                .await
            {
                Ok(creation) => creation,
                Err(error) => return (browser_error_value(id.clone(), &error), Vec::new()),
            };
            match creation.state {
                EmbeddedBrowserCreationStatus::Ready => {
                    let Some(target_id) = creation.tab_ref.clone() else {
                        return (
                            cdp_error_value(
                                id.clone(),
                                -32000,
                                "The created browser target is no longer available.",
                                Some("BROWSER_TAB_NOT_FOUND"),
                            ),
                            Vec::new(),
                        );
                    };
                    (
                        json!({
                            "id": id,
                            "result": EmbeddedBrowserTargetCreateTargetResult { target_id },
                        }),
                        Vec::new(),
                    )
                }
                EmbeddedBrowserCreationStatus::Pending => {
                    let data = json!({
                        "code": "BROWSER_CREATION_CONTEXT_REQUIRED",
                        "execution": "not-started",
                        "creationRef": creation.creation_ref,
                        "expiresAt": creation.expires_at,
                    });
                    (
                        cdp_error_value_with_data(
                            id.clone(),
                            -32000,
                            "No default browser creation context has been selected.",
                            Some("BROWSER_CREATION_CONTEXT_REQUIRED"),
                            Some(data),
                        ),
                        Vec::new(),
                    )
                }
                EmbeddedBrowserCreationStatus::Claimed
                | EmbeddedBrowserCreationStatus::Creating => {
                    let data = json!({
                        "code": "BROWSER_TIMEOUT",
                        "execution": "not-started",
                        "creationRef": creation.creation_ref,
                        "expiresAt": creation.expires_at,
                    });
                    (
                        cdp_error_value_with_data(
                            id.clone(),
                            -32000,
                            "The browser page is still being created.",
                            Some("BROWSER_TIMEOUT"),
                            Some(data),
                        ),
                        Vec::new(),
                    )
                }
                EmbeddedBrowserCreationStatus::Expired => (
                    cdp_error_value_with_data(
                        id.clone(),
                        -32000,
                        "The browser creation request expired.",
                        Some("BROWSER_CREATION_EXPIRED"),
                        Some(json!({
                            "code": "BROWSER_CREATION_EXPIRED",
                            "execution": "not-started",
                            "creationRef": creation.creation_ref,
                            "expiresAt": creation.expires_at,
                        })),
                    ),
                    Vec::new(),
                ),
                EmbeddedBrowserCreationStatus::Declined => (
                    cdp_error_value_with_data(
                        id.clone(),
                        -32000,
                        "The browser creation request was declined.",
                        Some("BROWSER_CREATION_DECLINED"),
                        Some(json!({
                            "code": "BROWSER_CREATION_DECLINED",
                            "execution": "not-started",
                            "creationRef": creation.creation_ref,
                            "expiresAt": creation.expires_at,
                        })),
                    ),
                    Vec::new(),
                ),
                EmbeddedBrowserCreationStatus::Failed => (
                    cdp_error_value_with_data(
                        id.clone(),
                        -32000,
                        "The browser page creation request failed.",
                        Some("BROWSER_CDP_ERROR"),
                        Some(json!({
                            "code": "BROWSER_CDP_ERROR",
                            "execution": "not-started",
                            "creationRef": creation.creation_ref,
                            "expiresAt": creation.expires_at,
                        })),
                    ),
                    Vec::new(),
                ),
            }
        }
        "Target.setDiscoverTargets" => {
            let params: EmbeddedBrowserTargetSetDiscoverTargetsParams =
                match serde_json::from_value(params) {
                    Ok(params) => params,
                    Err(_) => return (invalid_browser_params(id), Vec::new()),
                };
            connection.discover = params.discover;
            connection.known_targets.clear();
            (
                json!({
                    "id": id,
                    "result": EmbeddedBrowserTargetSetDiscoverTargetsResult {},
                }),
                Vec::new(),
            )
        }
        _ => (
            unsupported_browser_method(id, "The Target method is not supported."),
            Vec::new(),
        ),
    }
}

async fn ensure_target_session(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
    target_id: &str,
) -> Result<String, BrowserControlError> {
    if let Some(existing_session_id) = connection.target_sessions.get(target_id).cloned() {
        if let Some(existing_lease) = connection.attached.get(&existing_session_id) {
            if state
                .browser_control
                .lease_command_target(&connection.session_ref, &existing_lease.lease_ref)
                .is_ok()
            {
                return Ok(existing_session_id);
            }
        }
        connection.attached.remove(&existing_session_id);
        connection.target_sessions.remove(target_id);
    }

    let page = state.browser_control.page(target_id)?;
    let existing_lease = state
        .browser_control
        .lease_for_session_tab(&connection.session_ref, &page.tab_ref);
    let lease = state
        .browser_control
        .attach_tab(&connection.session_ref, &page.tab_ref)?;
    let target = match state
        .browser_control
        .lease_command_target(&connection.session_ref, &lease.lease_ref)
    {
        Ok(target) => target,
        Err(error) => {
            state
                .browser_control
                .detach_lease(&connection.session_ref, &lease.lease_ref);
            return Err(error);
        }
    };
    if existing_lease.is_none() {
        let attach = EmbeddedBrowserTargetAttachParams {
            lease_ref: lease.lease_ref.clone(),
            tab_ref: lease.tab_ref.clone(),
            source_ref: lease.source_ref.clone(),
            generation: lease.generation,
            page_host: target.page.page_host,
            profile: state.browser_control.page_profile().to_string(),
        };
        if let Err(error) = state.browser_control_relay.target_attach(attach).await {
            state
                .browser_control
                .detach_lease(&connection.session_ref, &lease.lease_ref);
            crate::browser_control_routes::publish_browser_events(state);
            return Err(error);
        }
    }
    let session_id = mint_entity_id("tbs");
    connection
        .attached
        .insert(session_id.clone(), lease.clone());
    connection
        .target_sessions
        .insert(lease.tab_ref.clone(), session_id.clone());
    crate::browser_control_routes::publish_browser_events(state);
    Ok(session_id)
}

async fn auto_attach_new_targets(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
) -> Vec<Value> {
    let Some(auto_attach) = connection.auto_attach.clone() else {
        return Vec::new();
    };
    let mut notifications = Vec::new();
    for page in state.browser_control.all_pages() {
        if connection.target_sessions.contains_key(&page.tab_ref) {
            continue;
        }
        let target_info = EmbeddedBrowserTargetInfo::from_page(&page, false);
        if !target_matches_auto_attach_filter(&target_info, auto_attach.filter.as_deref()) {
            continue;
        }
        let Ok(session_id) = ensure_target_session(state, connection, &page.tab_ref).await else {
            continue;
        };
        notifications.push(attached_notification(
            &session_id,
            &EmbeddedBrowserTargetInfo::from_page(&page, true),
            auto_attach.wait_for_debugger_on_start,
        ));
    }
    notifications
}

fn target_matches_auto_attach_filter(
    target: &EmbeddedBrowserTargetInfo,
    filter: Option<&[EmbeddedBrowserTargetFilter]>,
) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    if filter.is_empty() {
        return true;
    }
    for entry in filter {
        if entry
            .target_type
            .as_deref()
            .is_some_and(|target_type| target_type != target.target_type)
        {
            continue;
        }
        return entry.exclude != Some(true);
    }
    false
}

fn attached_notification(
    session_id: &str,
    target_info: &EmbeddedBrowserTargetInfo,
    waiting_for_debugger: bool,
) -> Value {
    json!({
        "method": "Target.attachedToTarget",
        "params": {
            "sessionId": session_id,
            "targetInfo": target_info,
            "waitingForDebugger": waiting_for_debugger,
        },
    })
}

fn emit_discovery_changes(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
    outbound: &mpsc::Sender<Message>,
) {
    if !connection.discover {
        return;
    }
    let attached: HashSet<String> = connection
        .attached
        .values()
        .map(|lease| lease.tab_ref.clone())
        .collect();
    let current = state
        .browser_control
        .target_infos_with_attached(&attached)
        .into_iter()
        .map(|target| (target.target_id.clone(), target))
        .collect::<BTreeMap<_, _>>();
    let mut notifications = Vec::new();
    for (target_id, target_info) in &current {
        match connection.known_targets.get(target_id) {
            None => notifications.push(json!({
                "method": "Target.targetCreated",
                "params": { "targetInfo": target_info },
            })),
            Some(previous) if previous != target_info => notifications.push(json!({
                "method": "Target.targetInfoChanged",
                "params": { "targetInfo": target_info },
            })),
            Some(_) => {}
        }
    }
    for target_id in connection.known_targets.keys() {
        if !current.contains_key(target_id) {
            notifications.push(json!({
                "method": "Target.targetDestroyed",
                "params": { "targetId": target_id },
            }));
        }
    }
    connection.known_targets = current;
    for notification in notifications {
        let _ = outbound.try_send(Message::Text(notification.to_string().into()));
    }
}

async fn handle_page_socket(
    state: AppState,
    socket: WebSocket,
    session_ref: String,
    lease: controlled_instance_protocol::EmbeddedBrowserLease,
    tab_ref: String,
) {
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<Message>(WS_OUTBOUND_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut events = state.events.subscribe();

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Text(text) => dispatch_command(&state, &session_ref, &lease, &outbound, text.as_bytes()).await,
                    Message::Binary(bytes) => dispatch_command(&state, &session_ref, &lease, &outbound, &bytes).await,
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
            }
            event = events.recv() => {
                let Ok(event) = event else { break; };
                if event.r#type != "browser.control.cdp-event" { continue; }
                let Some(payload) = event.payload.as_object() else { continue; };
                if payload.get("leaseRef").and_then(Value::as_str) != Some(lease.lease_ref.as_str()) {
                    continue;
                }
                let Some(method) = payload.get("method").and_then(Value::as_str) else { continue; };
                let mut notification = json!({
                    "method": method,
                    "params": payload.get("params").cloned().unwrap_or_else(|| json!({})),
                });
                if let Some(frame_session_ref) = payload.get("frameSessionRef").and_then(Value::as_str) {
                    notification["sessionId"] = Value::String(frame_session_ref.to_string());
                }
                if outbound.try_send(Message::Text(notification.to_string().into())).is_err() {
                    break;
                }
            }
        }
    }

    drop(outbound);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
    if let Ok(target) = state
        .browser_control
        .lease_command_target(&session_ref, &lease.lease_ref)
    {
        let _ = state
            .browser_control_relay
            .target_detach(EmbeddedBrowserTargetDetachParams {
                lease_ref: target.lease.lease_ref,
                tab_ref: target.lease.tab_ref,
                source_ref: target.lease.source_ref,
                generation: target.lease.generation,
                reason: "cdp-websocket-closed".to_string(),
            })
            .await;
    }
    if state
        .browser_control
        .detach_lease(&session_ref, &lease.lease_ref)
    {
        crate::browser_control_routes::publish_browser_events(&state);
    }
    tracing::debug!(tab_ref, "CDP page websocket closed");
}

async fn dispatch_command(
    state: &AppState,
    session_ref: &str,
    lease: &controlled_instance_protocol::EmbeddedBrowserLease,
    outbound: &mpsc::Sender<Message>,
    bytes: &[u8],
) {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => {
            let _ = outbound.try_send(Message::Text(
                cdp_error_value(Value::Null, -32700, "Parse error", None)
                    .to_string()
                    .into(),
            ));
            return;
        }
    };
    let Some(object) = value.as_object() else {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(Value::Null, -32600, "Invalid request", None)
                .to_string()
                .into(),
        ));
        return;
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    if id.is_null() {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(id, -32600, "A CDP command id is required.", None)
                .to_string()
                .into(),
        ));
        return;
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(id, -32600, "A CDP method is required.", None)
                .to_string()
                .into(),
        ));
        return;
    };
    if object
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(
                id,
                -32000,
                "Descendant CDP sessions are not supported yet.",
                Some("BROWSER_OPERATION_UNSUPPORTED"),
            )
            .to_string()
            .into(),
        ));
        return;
    }
    if assert_embedded_browser_cdp_method(method).is_err() {
        let _ = outbound.try_send(Message::Text(
            cdp_error_value(
                id,
                -32601,
                "The CDP method is outside the embedded page profile.",
                Some("BROWSER_OPERATION_UNSUPPORTED"),
            )
            .to_string()
            .into(),
        ));
        return;
    }
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    let request_id = format!("cdpws_{}_{}", lease.lease_ref, uuid::Uuid::new_v4());
    let command = EmbeddedBrowserCdpCommand {
        lease_ref: lease.lease_ref.clone(),
        method: method.to_string(),
        params: Some(params),
        frame_session_ref: None,
        request_id,
        timeout_ms: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    };
    let result = state
        .browser_control
        .lease_command_target(session_ref, &lease.lease_ref);
    let response = match result {
        Ok(target) => state
            .browser_control_relay
            .cdp_send(
                &target.lease.source_ref,
                target.lease.generation,
                command,
                Duration::from_millis(EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS),
            )
            .await
            .map(|result| json!({ "id": id, "result": result }))
            .unwrap_or_else(|error| cdp_error_value(id, -32000, &error.message, Some(error.code))),
        Err(error) => cdp_error_value(id, -32000, &error.message, Some(error.code)),
    };
    let _ = outbound.try_send(Message::Text(response.to_string().into()));
}

fn prune_stale_browser_attachments(
    state: &AppState,
    connection: &mut BrowserCdpConnection,
    outbound: &mpsc::Sender<Message>,
) {
    let stale = connection
        .attached
        .iter()
        .filter(|(_, lease)| {
            state
                .browser_control
                .lease_command_target(&connection.session_ref, &lease.lease_ref)
                .is_err()
        })
        .map(|(session_id, lease)| (session_id.clone(), lease.clone()))
        .collect::<Vec<_>>();
    for (session_id, lease) in stale {
        connection.attached.remove(&session_id);
        if connection.target_sessions.get(&lease.tab_ref) == Some(&session_id) {
            connection.target_sessions.remove(&lease.tab_ref);
        }
        if connection.discover || connection.auto_attach.is_some() {
            let _ = outbound.try_send(Message::Text(
                detached_notification(&session_id, &lease.tab_ref)
                    .to_string()
                    .into(),
            ));
        }
    }
}

async fn cleanup_browser_attachments(state: &AppState, connection: &mut BrowserCdpConnection) {
    let leases = connection
        .attached
        .drain()
        .map(|(_, lease)| lease)
        .collect::<Vec<_>>();
    connection.target_sessions.clear();
    let mut changed = false;
    for lease in leases {
        let _ = state
            .browser_control_relay
            .target_detach(EmbeddedBrowserTargetDetachParams {
                lease_ref: lease.lease_ref.clone(),
                tab_ref: lease.tab_ref.clone(),
                source_ref: lease.source_ref.clone(),
                generation: lease.generation,
                reason: "cdp-browser-websocket-closed".to_string(),
            })
            .await;
        changed |= state
            .browser_control
            .detach_lease(&connection.session_ref, &lease.lease_ref);
    }
    if changed {
        crate::browser_control_routes::publish_browser_events(state);
    }
}

fn detached_notification(session_id: &str, target_id: &str) -> Value {
    json!({
        "method": "Target.detachedFromTarget",
        "params": { "sessionId": session_id, "targetId": target_id },
    })
}

fn unsupported_browser_method(id: &Value, message: &str) -> Value {
    cdp_error_value(
        id.clone(),
        -32601,
        message,
        Some("BROWSER_OPERATION_UNSUPPORTED"),
    )
}

fn invalid_browser_params(id: &Value) -> Value {
    cdp_error_value(id.clone(), -32602, "Invalid CDP params.", None)
}

fn browser_error_value(id: Value, error: &BrowserControlError) -> Value {
    let mut data = json!({
        "code": error.code,
        "execution": "not-started",
    });
    if let Some(creation_ref) = &error.creation_ref {
        data["creationRef"] = Value::String(creation_ref.clone());
    }
    if let Some(expires_at) = &error.expires_at {
        data["expiresAt"] = Value::String(expires_at.clone());
    }
    if let Some(revision) = error.revision {
        data["revision"] = Value::from(revision);
    }
    if let Some(default_browser_context_id) = &error.default_browser_context_id {
        data["defaultBrowserContextId"] = Value::String(default_browser_context_id.clone());
    }
    cdp_error_value_with_data(id, -32000, &error.message, Some(error.code), Some(data))
}

fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<CdpRequestAuth, Response> {
    let token = crate::server::bearer_token(headers).or_else(|| {
        url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.is_empty())
    });
    let token = token.ok_or_else(|| {
        cdp_error(
            StatusCode::UNAUTHORIZED,
            "BROWSER_AUTHORIZATION_REQUIRED",
            "A browser CDP access token is required.",
        )
    })?;
    let session_ref = state
        .browser_control
        .validate_cdp_token(&token)
        .ok_or_else(|| {
            cdp_error(
                StatusCode::UNAUTHORIZED,
                "BROWSER_AUTHORIZATION_REVOKED",
                "The browser CDP access token is invalid, expired, or revoked.",
            )
        })?;
    if state.ai_sessions.get(&session_ref).is_none() {
        return Err(cdp_error(
            StatusCode::UNAUTHORIZED,
            "BROWSER_AUTHORIZATION_REVOKED",
            "The AI Session bound to this browser CDP token is closed.",
        ));
    }
    Ok(CdpRequestAuth { token, session_ref })
}

fn target_object(
    state: &AppState,
    page: &controlled_instance_protocol::EmbeddedBrowserPage,
    token: &str,
) -> Value {
    json!({
        "id": page.tab_ref,
        "type": "page",
        "title": page.title,
        "url": page.url,
        "browserContextId": page.source_ref,
        "description": "",
        "webSocketDebuggerUrl": format!(
            "{}/devtools/page/{}?token={}",
            websocket_origin(state),
            percent_encoding::utf8_percent_encode(&page.tab_ref, percent_encoding::NON_ALPHANUMERIC),
            percent_encoding::utf8_percent_encode(token, percent_encoding::NON_ALPHANUMERIC),
        ),
    })
}

fn websocket_origin(state: &AppState) -> String {
    state
        .browser_cdp_http_endpoint()
        .replacen("http://", "ws://", 1)
}

fn browser_url_allowed(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value == "about:blank" || value.starts_with("http://") || value.starts_with("https://")
}

fn cdp_error_value(id: Value, code: i64, message: &str, browser_code: Option<&str>) -> Value {
    cdp_error_value_with_data(
        id,
        code,
        message,
        browser_code,
        browser_code.map(|code| json!({ "code": code, "execution": "not-started" })),
    )
}

fn cdp_error_value_with_data(
    id: Value,
    code: i64,
    message: &str,
    browser_code: Option<&str>,
    data: Option<Value>,
) -> Value {
    json!({
        "id": id,
        "error": {
            "code": code,
            "message": message,
            "data": data.or_else(|| browser_code.map(|code| json!({ "code": code, "execution": "not-started" }))),
        },
    })
}

fn browser_error(error: BrowserControlError) -> Response {
    cdp_error(
        StatusCode::from_u16(error.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        error.code,
        &error.message,
    )
}

fn cdp_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}
