//! Dedicated trusted endpoint family. Generic proxy transports reject it; G4
//! supplies resolved principals. Media and credentials stay in the component.
use controlled_instance_app_runtime::{AppPackageLifecycle, AppRecipeExecutionError};
use controlled_instance_protocol::AppManagementOperation;
use desktop_component_host::service::DesktopService;
use std::path::PathBuf;
pub struct DesktopLifecycle {
    pub service: DesktopService,
    install_base_dir: PathBuf,
    state_dir: PathBuf,
}

impl DesktopLifecycle {
    pub fn new(service: DesktopService, install_base_dir: PathBuf, state_dir: PathBuf) -> Self {
        Self {
            service,
            install_base_dir,
            state_dir,
        }
    }
}
#[async_trait::async_trait]
impl AppPackageLifecycle for DesktopLifecycle {
    async fn before_change(
        &self,
        _operation: AppManagementOperation,
    ) -> Result<(), AppRecipeExecutionError> {
        self.service.before_package_change().await.map_err(|_| {
            AppRecipeExecutionError::new(
                "app_drain_failed",
                "Desktop component cleanup failed.",
                true,
            )
        })
    }
    async fn changed(
        &self,
        operation: AppManagementOperation,
        succeeded: bool,
    ) -> Result<(), AppRecipeExecutionError> {
        if operation != AppManagementOperation::Uninstall && succeeded {
            let _ = controlled_instance_app_runtime::remote_desktop::remove_legacy_managed_package(
                &self.install_base_dir,
                &self.state_dir,
            );
        }
        self.service
            .package_changed(operation, succeeded)
            .await
            .map_err(|_| {
                AppRecipeExecutionError::new(
                    "app_lifecycle_failed",
                    "Desktop component configuration could not be updated.",
                    true,
                )
            })
    }
}
use crate::{config::ControlMode, state::AppState};
use axum::http::{header, StatusCode};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Request, State,
    },
    http::HeaderMap,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use desktop_component_host::{
    contract::{Command, Reply},
    model::Owner,
    service::DesktopEvent,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as UpstreamMessage};
fn response(status: StatusCode, value: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn failed(code: &str) -> Response {
    response(
        StatusCode::CONFLICT,
        json!({"error":{"code":code,"message":"Remote desktop operation failed."}}),
    )
}
fn error_code(error: &anyhow::Error) -> String {
    let message = error.to_string();
    if message.starts_with("REMOTE_DESKTOP_")
        && message.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
    {
        message
    } else {
        "REMOTE_DESKTOP_COMPONENT_UNAVAILABLE".into()
    }
}
fn invalid() -> Response {
    response(
        StatusCode::BAD_REQUEST,
        json!({"error":{"code":"REMOTE_DESKTOP_INVALID_REQUEST","message":"Invalid remote desktop request."}}),
    )
}
async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let expected = if state.config.control_mode == ControlMode::Controlled {
        state.config.registration_token.as_deref()
    } else {
        // Browser/web tokens cannot impersonate the trusted session owner.
        // Standalone public access requires the resolved-principal transport (G4).
        None
    };
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if !expected
        .zip(token)
        .is_some_and(|(a, b)| !a.is_empty() && bool::from(a.as_bytes().ct_eq(b.as_bytes())))
    {
        return response(
            StatusCode::FORBIDDEN,
            json!({"error":{"code":"REMOTE_DESKTOP_UNAUTHORIZED","message":"A trusted instance credential is required."}}),
        );
    }
    let mut result = next.run(request).await;
    result.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    result
}
pub fn routes(state: AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/api/internal/remote-desktop/settings",
            get(settings).put(update_settings),
        )
        .route("/api/internal/remote-desktop/permissions", get(permissions))
        .route(
            "/api/internal/remote-desktop/permissions/request",
            post(request_permission),
        )
        .route("/api/internal/remote-desktop/preflight", post(preflight))
        .route("/api/internal/remote-desktop/sources", post(sources))
        .route("/api/internal/remote-desktop/reserve", post(reserve))
        .route("/api/internal/remote-desktop/snapshot", post(snapshot))
        .route("/api/internal/remote-desktop/stop", post(stop))
        .route("/api/internal/remote-desktop/takeover", post(takeover))
        .route("/api/internal/remote-desktop/force-stop", post(force_stop))
        .route("/api/internal/remote-desktop/attach", get(attach))
        .route(
            "/api/internal/remote-desktop/fallback/{role}",
            get(fallback),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .route_layer(middleware::from_fn_with_state(state, authorize))
}
async fn preflight(State(state): State<AppState>) -> Response {
    response(
        StatusCode::OK,
        json!({"data":state.desktop_service.reconcile().await}),
    )
}
async fn settings(State(state): State<AppState>) -> Response {
    response(
        StatusCode::OK,
        json!({"data":{"enabled":state.desktop_service.settings.enabled()}}),
    )
}
async fn permissions(State(state): State<AppState>) -> Response {
    match state.desktop_service.permissions().await {
        Ok(data) => response(StatusCode::OK, json!({"data":data})),
        Err(error) => failed(&error_code(&error)),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionInput {
    kind: String,
}
async fn request_permission(
    State(state): State<AppState>,
    body: Result<Json<PermissionInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(input)) = body else {
        return invalid();
    };
    match state.desktop_service.request_permission(&input.kind).await {
        Ok(data) => response(StatusCode::OK, json!({"data":data})),
        Err(error) => failed(&error_code(&error)),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsInput {
    enabled: bool,
}
async fn update_settings(
    State(state): State<AppState>,
    body: Result<Json<SettingsInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(input)) = body else {
        return invalid();
    };
    match state.desktop_service.set_enabled(input.enabled).await {
        Ok(()) => response(
            StatusCode::OK,
            json!({"data":{"enabled":state.desktop_service.settings.enabled()}}),
        ),
        Err(error) => failed(&error_code(&error)),
    }
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().map(char::len_utf16).sum::<usize>() <= 4096
}
fn valid_source_ref(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096
}
fn valid_region(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 4 {
        return false;
    }
    let values = ["x", "y", "width", "height"].map(|key| {
        object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
    });
    let [Some(x), Some(y), Some(width), Some(height)] = values else {
        return false;
    };
    x >= 0.0 && y >= 0.0 && width > 0.0 && height > 0.0 && x + width <= 1.0 && y + height <= 1.0
}
fn command(value: Value, kind: &str, fields: &[&str]) -> Result<(String, Command), ()> {
    let Value::Object(mut input) = value else {
        return Err(());
    };
    if input.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(());
    }
    let id = input
        .remove("requestId")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or(())?;
    if let Some(owner) = input.get("owner") {
        let object = owner.as_object().ok_or(())?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "actorId" | "deviceSessionId"))
        {
            return Err(());
        }
        let owner: Owner = serde_json::from_value(owner.clone()).map_err(|_| ())?;
        if !valid_identifier(&owner.actor_id) || !valid_identifier(&owner.device_session_id) {
            return Err(());
        }
    }
    for field in ["viewerSessionId", "attachToken"] {
        if let Some(value) = input.get(field) {
            if !value.as_str().is_some_and(valid_identifier) {
                return Err(());
            }
        }
    }
    if let Some(selection) = input.get("captureSelection") {
        let object = selection.as_object().ok_or(())?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "sourceRef" | "streamRegion" | "controlRegion"))
            || !object
                .get("sourceRef")
                .and_then(Value::as_str)
                .is_some_and(valid_source_ref)
            || ["streamRegion", "controlRegion"]
                .iter()
                .any(|key| object.get(*key).is_some_and(|value| !valid_region(value)))
        {
            return Err(());
        }
    }
    input.insert("type".into(), json!(kind));
    let command = serde_json::from_value(Value::Object(input)).map_err(|_| ())?;
    Ok((id, command))
}
async fn execute(
    state: AppState,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
    kind: &str,
    fields: &[&str],
) -> Response {
    let Ok(Json(value)) = body else {
        return invalid();
    };
    let Ok((id, command)) = command(value, kind, fields) else {
        return invalid();
    };
    match state.desktop_service.request(&id, command).await {
        Ok(Reply::Error { code }) => failed(&code),
        Ok(result) => response(StatusCode::OK, json!({"data":result})),
        Err(error) => failed(&error_code(&error)),
    }
}
async fn sources(
    State(state): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    execute(state, body, "listSources", &["requestId", "owner"]).await
}
async fn reserve(
    State(state): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    execute(
        state,
        body,
        "reserve",
        &["requestId", "owner", "captureSelection"],
    )
    .await
}
async fn snapshot(
    State(state): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    execute(
        state,
        body,
        "snapshot",
        &["requestId", "owner", "viewerSessionId"],
    )
    .await
}
async fn stop(
    State(state): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    execute(
        state,
        body,
        "stop",
        &["requestId", "owner", "viewerSessionId"],
    )
    .await
}
async fn takeover(
    State(state): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    execute(
        state,
        body,
        "takeover",
        &["requestId", "owner", "viewerSessionId", "captureSelection"],
    )
    .await
}
async fn force_stop(
    State(state): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    execute(state, body, "forceStop", &["requestId", "viewerSessionId"]).await
}
async fn attach(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(1024 * 1024)
        .on_upgrade(move |socket| signaling(state.desktop_service, socket))
        .into_response()
}
async fn fallback(
    State(state): State<AppState>,
    Path(role): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(role) = remote_desktop_protocol::fallback::Role::parse(&role) else {
        return invalid();
    };
    let protocol = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !protocol
        .split(',')
        .any(|value| value.trim() == role.subprotocol())
    {
        return response(
            StatusCode::BAD_REQUEST,
            json!({"error":{"code":"REMOTE_DESKTOP_FALLBACK_PROTOCOL","message":"Fallback subprotocol is required."}}),
        );
    }
    let endpoint = match state.desktop_service.fallback_endpoint().await {
        Ok(Some(endpoint)) => endpoint,
        Ok(None) => return failed("REMOTE_DESKTOP_FALLBACK_UNAVAILABLE"),
        Err(_) => return failed("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"),
    };
    ws.max_message_size(128 * 1024)
        .protocols([role.subprotocol().to_string()])
        .on_upgrade(move |socket| proxy_fallback(socket, endpoint, role))
        .into_response()
}
async fn proxy_fallback(
    mut socket: WebSocket,
    (base, token): (String, String),
    role: remote_desktop_protocol::fallback::Role,
) {
    let url = format!("{base}/fallback/{}?token={token}", role.as_str());
    let Ok(mut request) = url.into_client_request() else {
        let _ = socket.close().await;
        return;
    };
    if let Ok(value) = role.subprotocol().parse() {
        request
            .headers_mut()
            .insert("sec-websocket-protocol", value);
    }
    let Ok((mut upstream, _)) = tokio_tungstenite::connect_async(request).await else {
        let _ = socket.close().await;
        return;
    };
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if upstream.send(UpstreamMessage::Text(text.to_string().into())).await.is_err() { break; }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if upstream.send(UpstreamMessage::Binary(data.into())).await.is_err() { break; }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if upstream.send(UpstreamMessage::Ping(data.into())).await.is_err() { break; }
                    }
                    Some(Ok(Message::Pong(data))) => {
                        if upstream.send(UpstreamMessage::Pong(data.into())).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                }
            }
            outgoing = upstream.next() => {
                match outgoing {
                    Some(Ok(UpstreamMessage::Text(text))) => {
                        if socket.send(Message::Text(text.to_string().into())).await.is_err() { break; }
                    }
                    Some(Ok(UpstreamMessage::Binary(data))) => {
                        if socket.send(Message::Binary(data.into())).await.is_err() { break; }
                    }
                    Some(Ok(UpstreamMessage::Ping(data))) => {
                        if socket.send(Message::Ping(data.into())).await.is_err() { break; }
                    }
                    Some(Ok(UpstreamMessage::Pong(data))) => {
                        if socket.send(Message::Pong(data.into())).await.is_err() { break; }
                    }
                    Some(Ok(UpstreamMessage::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
    let _ = upstream.close(None).await;
    let _ = socket.close().await;
}
async fn send(socket: &mut WebSocket, value: impl Serialize) -> Result<(), ()> {
    let value = serde_json::to_string(&value).map_err(|_| ())?;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        socket.send(Message::Text(value.into())),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
async fn signaling(service: DesktopService, mut socket: WebSocket) {
    let mut events = service.subscribe();
    let attached = async {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.recv())
            .await
            .map_err(|_| ())?
            .ok_or(())?
            .map_err(|_| ())?;
        let Message::Text(text) = message else {
            return Err(());
        };
        let value: Value = serde_json::from_str(&text).map_err(|_| ())?;
        let (id, command) = command(
            value,
            "attach",
            &[
                "requestId",
                "owner",
                "viewerSessionId",
                "captureSelection",
                "attachToken",
            ],
        )?;
        let Command::Attach {
            ref owner,
            ref viewer_session_id,
            ..
        } = command
        else {
            return Err(());
        };
        let (owner, viewer) = (owner.clone(), viewer_session_id.clone());
        let (boot, reply) = service
            .request_bound(&id, command, None)
            .await
            .map_err(|_| ())?;
        let Reply::Snapshot { snapshot } = reply else {
            return Err(());
        };
        // Once attach is consumed, even a failure to write its first snapshot must
        // close the binding. Keep the successful binding outside send handling.
        Ok::<_, ()>((boot, owner, viewer, snapshot))
    }
    .await;
    let Ok((boot, owner, viewer, snapshot)) = attached else {
        let _ = socket.close().await;
        return;
    };
    let mut revision = snapshot.session_revision;
    let initial = send(&mut socket, json!({"type":"snapshot","snapshot":snapshot})).await;
    let _:Result<(),()>=async{
        initial?;
        let mut rate_start=std::time::Instant::now();let mut count=0;
        loop{tokio::select!{
            message=socket.recv()=>{
                let text=match message{
                    Some(Ok(Message::Text(text)))=>text,
                    Some(Ok(Message::Ping(_)|Message::Pong(_)))=>continue,
                    _=>return Err(()),
                };
                if rate_start.elapsed()>=std::time::Duration::from_secs(1){rate_start=std::time::Instant::now();count=0;}
                count+=1;if count>64{return Err(());}
                let value:Value=serde_json::from_str(&text).map_err(|_|())?;
                let kind=value.get("type").and_then(Value::as_str).ok_or(())?;
                if !matches!(kind,"offer"|"signalAlive"|"configureIce"|"candidate"){return Err(());}
                let allowed=match kind {"offer"=>vec!["requestId","type","sdp"],"configureIce"=>vec!["requestId","type","iceServers","iceCredentialsExpiresAt"],"candidate"=>vec!["requestId","type","candidate"],_=>vec!["requestId","type"]};
                let Value::Object(mut input)=value.clone()else{return Err(());};
                if input.keys().any(|key|!allowed.contains(&key.as_str())){return Err(());}
                if kind=="offer" && input.get("sdp").and_then(Value::as_str).is_none_or(|s|s.len()>512*1024){return Err(());}
                if kind=="candidate" && input.get("candidate").and_then(Value::as_object).is_none_or(|c| c.get("candidate").and_then(Value::as_str).is_none_or(|v| v.len()>4096)){return Err(());}
                input.remove("type");input.insert("owner".into(),json!(owner));input.insert("viewerSessionId".into(),json!(viewer));
                let fields=match kind {"offer"=>&["requestId","owner","viewerSessionId","sdp"][..],"configureIce"=>&["requestId","owner","viewerSessionId","iceServers","iceCredentialsExpiresAt"][..],"candidate"=>&["requestId","owner","viewerSessionId","candidate"][..],_=>&["requestId","owner","viewerSessionId"][..]};
                let(id,command)=command(Value::Object(input),kind,fields)?;
                let(_,result)=service.request_bound(&id,command,Some(&boot)).await.map_err(|_|())?;
                let mut reply=serde_json::to_value(result).map_err(|_|())?;
                reply.as_object_mut().ok_or(())?.insert("requestId".into(),json!(id));send(&mut socket,reply).await?;
            }
            event=events.recv()=>match event{
                Ok(DesktopEvent::Session(event)) if event.boot_id==boot && event.snapshot.viewer_session_id==viewer && event.snapshot.session_revision>revision=>{
                    revision=event.snapshot.session_revision;
                    let terminal=matches!(event.snapshot.phase, desktop_component_host::model::Phase::Stopped | desktop_component_host::model::Phase::Failed);
                    send(&mut socket,json!({"type":"snapshot","snapshot":event.snapshot})).await?;
                    if terminal {return Ok::<(),()>(());}
                }
                Ok(DesktopEvent::Changed)=>{if !service.is_current_boot(&boot).await{return Err(());}},
                Ok(DesktopEvent::ResnapshotRequired)|Err(_)=>return Err(()),
                _=>{}
            }
        }}
    }.await;
    let _ = service
        .request_bound(
            "signal-close",
            Command::SignalClosed {
                owner,
                viewer_session_id: viewer,
            },
            Some(&boot),
        )
        .await;
    let _ = socket.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trusted_boundary_rejects_extra_nested_fields_and_invalid_identifiers() {
        let owner = json!({"actorId":"actor","deviceSessionId":"device"});
        let allowed = ["requestId", "owner", "captureSelection"];
        assert!(command(
            json!({"requestId":"r","owner":owner,"captureSelection":{"sourceRef":"display-primary"}}),
            "reserve",
            &allowed
        )
        .is_ok());
        for value in [
            json!({"requestId":"r","owner":{"actorId":"actor","deviceSessionId":"device","extra":true},"captureSelection":{"sourceRef":"display-primary"}}),
            json!({"requestId":"r","owner":owner,"captureSelection":{"sourceRef":"display-primary","windowRef":"forged"}}),
            json!({"requestId":"r","owner":owner,"captureSelection":{"sourceRef":""}}),
            json!({"requestId":"r","owner":{"actorId":"","deviceSessionId":"device"},"captureSelection":{"sourceRef":"display-primary"}}),
            json!({"requestId":"x".repeat(4097),"owner":owner,"captureSelection":{"sourceRef":"display-primary"}}),
        ] {
            assert!(command(value, "reserve", &allowed).is_err());
        }
        let session = ["requestId", "owner", "viewerSessionId"];
        assert!(command(
            json!({"requestId":"r","owner":owner,"viewerSessionId":""}),
            "stop",
            &session
        )
        .is_err());
    }
    #[test]
    fn component_errors_do_not_leak_paths_or_credentials() {
        assert_eq!(
            error_code(&anyhow::anyhow!("REMOTE_DESKTOP_DISABLED")),
            "REMOTE_DESKTOP_DISABLED"
        );
        assert_eq!(
            error_code(&anyhow::anyhow!("REMOTE_DESKTOP_FAILED: /private/token")),
            "REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"
        );
        assert_eq!(
            error_code(&anyhow::anyhow!("read /private/component")),
            "REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"
        );
    }
}
