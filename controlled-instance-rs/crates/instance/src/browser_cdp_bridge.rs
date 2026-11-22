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
    assert_embedded_browser_cdp_method, EmbeddedBrowserCdpCommand, EmbeddedBrowserCreationStatus,
    EmbeddedBrowserTabsCloseParams, EmbeddedBrowserTargetAttachParams,
    EmbeddedBrowserTargetDetachParams, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
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

pub(crate) fn is_path(path: &str) -> bool {
    path == "/json/version"
        || path == "/json/list"
        || path == "/json/new"
        || path.starts_with("/json/close/")
        || path.starts_with("/devtools/page/")
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/json/version", get(json_version))
        .route("/json/list", get(json_list))
        .route("/json/new", get(json_new).put(json_new))
        .route("/json/close/{tab_ref}", get(json_close))
        .route("/devtools/page/{tab_ref}", get(devtools_page))
}

async fn json_version(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    if let Err(response) = authenticate(&state, &headers, &uri) {
        return response;
    }
    Json(json!({
        "Browser": "TaskHandoff/EmbeddedBrowser",
        "Protocol-Version": "1.3",
        "User-Agent": "TaskHandoff embedded Chromium",
        "V8-Version": "electron",
        "WebKit-Version": "electron",
    }))
    .into_response()
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
    let _ = state.browser_control.destroy_tab(
        &page.source_ref,
        page.generation,
        &page.tab_ref,
        "closed",
    );
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
    if assert_embedded_browser_cdp_method(method, false).is_err() {
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
    json!({
        "id": id,
        "error": {
            "code": code,
            "message": message,
            "data": browser_code.map(|code| json!({ "code": code, "execution": "not-started" })),
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
