use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use controlled_instance_protocol::{
    decode_embedded_browser_stream_open, encode_embedded_browser_channel_error,
    encode_embedded_browser_control_message, encode_embedded_browser_frame,
    encode_embedded_browser_stream_open_ok, supports_embedded_browser_cdp_event,
    EmbeddedBrowserCdpEvent, EmbeddedBrowserChannelError, EmbeddedBrowserControlHello,
    EmbeddedBrowserControlMessageDecoder, EmbeddedBrowserControlReady,
    EmbeddedBrowserControlSynced, EmbeddedBrowserFrame, EmbeddedBrowserFrameDecoder,
    EmbeddedBrowserFrameType, EmbeddedBrowserProtocolErrorCode, EmbeddedBrowserTabsCloseParams,
    EmbeddedBrowserTabsCreatedParams, EmbeddedBrowserTabsDestroyedParams,
    EmbeddedBrowserTabsOpenParams, EmbeddedBrowserTargetDetachParams,
    EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES, EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
    EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES, EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS,
    EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};

use crate::{browser_control::BrowserControlError, state::AppState};

const CONTROL_STREAM_ID: u32 = 1;
const RELAY_RESPONSE_TIMEOUT: Duration = Duration::from_millis(EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS);

#[derive(Debug, Clone)]
pub(crate) struct BrowserControlRelayContext {
    pub panel_id: String,
    pub user_id: String,
}

#[derive(Debug)]
enum RelayReply {
    Result(Value),
    Error {
        message: String,
        data: Option<Value>,
    },
}

enum RelayOutbound {
    Request {
        id: String,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Close,
}

#[derive(Clone)]
struct RelayConnection {
    connection_id: u64,
    generation: u64,
    ready: Arc<AtomicBool>,
    sender: mpsc::UnboundedSender<RelayOutbound>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<RelayReply>>>>,
}

#[derive(Default)]
struct RelayRegistryInner {
    connections: HashMap<String, RelayConnection>,
}

#[derive(Clone, Default)]
pub struct BrowserControlRelayRegistry {
    inner: Arc<Mutex<RelayRegistryInner>>,
    next_connection: Arc<AtomicU64>,
    next_request: Arc<AtomicU64>,
}

struct RegisteredConnection {
    connection_id: u64,
    ready: Arc<AtomicBool>,
}

impl BrowserControlRelayRegistry {
    fn register(
        &self,
        source_ref: &str,
        generation: u64,
        sender: mpsc::UnboundedSender<RelayOutbound>,
        pending: Arc<Mutex<HashMap<String, oneshot::Sender<RelayReply>>>>,
    ) -> RegisteredConnection {
        let connection_id = self.next_connection.fetch_add(1, Ordering::SeqCst) + 1;
        let ready = Arc::new(AtomicBool::new(false));
        let connection = RelayConnection {
            connection_id,
            generation,
            ready: ready.clone(),
            sender,
            pending,
        };
        let previous = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .connections
            .insert(source_ref.to_string(), connection);
        if let Some(previous) = previous {
            previous.ready.store(false, Ordering::SeqCst);
            previous
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
            let _ = previous.sender.send(RelayOutbound::Notification {
                method: "control.revoke".to_string(),
                params: json!({ "reason": "superseded" }),
            });
            let _ = previous.sender.send(RelayOutbound::Close);
        }
        RegisteredConnection {
            connection_id,
            ready,
        }
    }

    fn unregister(&self, source_ref: &str, connection_id: u64) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner
            .connections
            .get(source_ref)
            .is_none_or(|connection| connection.connection_id != connection_id)
        {
            return false;
        }
        if let Some(connection) = inner.connections.remove(source_ref) {
            connection.ready.store(false, Ordering::SeqCst);
            connection
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
        true
    }

    pub async fn request(
        &self,
        source_ref: &str,
        generation: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BrowserControlError> {
        let connection = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.connections.get(source_ref).cloned()
        }
        .filter(|connection| connection.generation == generation)
        .ok_or_else(|| {
            BrowserControlError::new(
                "BROWSER_SOURCE_UNAVAILABLE",
                "The browser source is not connected.",
                409,
            )
        })?;
        if !connection.ready.load(Ordering::SeqCst) {
            return Err(BrowserControlError::new(
                "BROWSER_SOURCE_UNAVAILABLE",
                "The browser source is still synchronizing.",
                409,
            ));
        }
        let request_id = format!(
            "req_{}",
            self.next_request.fetch_add(1, Ordering::SeqCst) + 1
        );
        let (reply, receiver) = oneshot::channel();
        connection
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id.clone(), reply);
        if connection
            .sender
            .send(RelayOutbound::Request {
                id: request_id.clone(),
                method: method.to_string(),
                params,
            })
            .is_err()
        {
            connection
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            return Err(BrowserControlError::new(
                "BROWSER_SOURCE_UNAVAILABLE",
                "The browser source disconnected before dispatch.",
                409,
            ));
        }
        let timeout = timeout
            .min(Duration::from_millis(
                EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS,
            ))
            .max(Duration::from_millis(1));
        let reply = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => {
                return Err(BrowserControlError::new(
                    "BROWSER_EXECUTION_UNKNOWN",
                    "The browser source disconnected before replying.",
                    502,
                ));
            }
            Err(_) => {
                connection
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&request_id);
                return Err(BrowserControlError::new(
                    "BROWSER_TIMEOUT",
                    "The browser source did not reply in time.",
                    504,
                ));
            }
        };
        match reply {
            RelayReply::Result(value) => Ok(value),
            RelayReply::Error { message, data } => {
                let code = data
                    .as_ref()
                    .and_then(|value| value.get("code"))
                    .and_then(Value::as_str)
                    .map(static_error_code)
                    .unwrap_or("BROWSER_OPERATION_UNSUPPORTED");
                Err(BrowserControlError::new(code, message, 409))
            }
        }
    }

    pub async fn tabs_open(
        &self,
        params: EmbeddedBrowserTabsOpenParams,
    ) -> Result<Value, BrowserControlError> {
        self.request(
            &params.source_ref,
            params.generation,
            "tabs.open",
            serde_json::to_value(&params).unwrap_or(Value::Null),
            RELAY_RESPONSE_TIMEOUT,
        )
        .await
    }

    pub async fn tabs_close(
        &self,
        params: EmbeddedBrowserTabsCloseParams,
    ) -> Result<Value, BrowserControlError> {
        self.request(
            &params.source_ref,
            params.generation,
            "tabs.close",
            serde_json::to_value(&params).unwrap_or(Value::Null),
            RELAY_RESPONSE_TIMEOUT,
        )
        .await
    }

    pub async fn target_attach(
        &self,
        params: controlled_instance_protocol::EmbeddedBrowserTargetAttachParams,
    ) -> Result<Value, BrowserControlError> {
        self.request(
            &params.source_ref,
            params.generation,
            "target.attach",
            serde_json::to_value(&params).unwrap_or(Value::Null),
            RELAY_RESPONSE_TIMEOUT,
        )
        .await
    }

    pub async fn target_detach(
        &self,
        params: EmbeddedBrowserTargetDetachParams,
    ) -> Result<Value, BrowserControlError> {
        self.request(
            &params.source_ref,
            params.generation,
            "target.detach",
            serde_json::to_value(&params).unwrap_or(Value::Null),
            RELAY_RESPONSE_TIMEOUT,
        )
        .await
    }

    pub async fn cdp_send(
        &self,
        source_ref: &str,
        generation: u64,
        params: controlled_instance_protocol::EmbeddedBrowserCdpCommand,
        timeout: Duration,
    ) -> Result<Value, BrowserControlError> {
        self.request(
            source_ref,
            generation,
            "cdp.send",
            serde_json::to_value(params).unwrap_or(Value::Null),
            timeout,
        )
        .await
    }
}

#[derive(Clone)]
struct RelayWriter {
    sender: mpsc::UnboundedSender<Message>,
    pending_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
}

impl RelayWriter {
    fn send(&self, message: Message) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let bytes = match &message {
            Message::Binary(value) => value.len(),
            Message::Text(value) => value.len(),
            _ => 0,
        };
        if bytes > 0
            && self
                .pending_bytes
                .load(Ordering::SeqCst)
                .saturating_add(bytes)
                > EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES
        {
            self.close(1013, "Browser control consumer is too slow.");
            return false;
        }
        self.pending_bytes.fetch_add(bytes, Ordering::SeqCst);
        self.sender.send(message).is_ok()
    }

    fn close(&self, code: u16, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.sender.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.chars().take(123).collect::<String>().into(),
        })));
    }
}

#[derive(Debug, Clone)]
struct ControlBinding {
    source_ref: String,
    generation: u64,
    connection_id: u64,
    ready: Arc<AtomicBool>,
    synchronized: bool,
}

enum ControlFlow {
    Continue,
    Close,
}

pub fn websocket_upgrade(upgrade: WebSocketUpgrade) -> WebSocketUpgrade {
    upgrade
        .max_message_size(crate::WEBSOCKET_MAX_PAYLOAD_BYTES)
        .max_frame_size(crate::WEBSOCKET_MAX_PAYLOAD_BYTES)
        .max_write_buffer_size(EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES)
}

pub async fn handle_control_socket(
    state: AppState,
    socket: WebSocket,
    context: BrowserControlRelayContext,
    shutdown: Option<watch::Receiver<bool>>,
) {
    let (mut sink, mut receiver) = socket.split();
    let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Message>();
    let pending_bytes = Arc::new(AtomicUsize::new(0));
    let writer_closed = Arc::new(AtomicBool::new(false));
    let writer = RelayWriter {
        sender: writer_tx,
        pending_bytes: pending_bytes.clone(),
        closed: writer_closed.clone(),
    };
    let writer_for_shutdown = writer.clone();
    let mut shutdown = shutdown;
    tokio::spawn(async move {
        if let Some(shutdown) = shutdown.as_mut() {
            if shutdown.changed().await.is_ok() && *shutdown.borrow() {
                writer_for_shutdown.close(1001, "Controlled instance is shutting down.");
            }
        }
    });
    let writer_task = tokio::spawn(async move {
        while let Some(message) = writer_rx.recv().await {
            let closes = matches!(message, Message::Close(_));
            let bytes = match &message {
                Message::Binary(value) => value.len(),
                Message::Text(value) => value.len(),
                _ => 0,
            };
            let sent = sink.send(message).await;
            pending_bytes.fetch_sub(bytes, Ordering::SeqCst);
            if sent.is_err() || closes {
                break;
            }
        }
    });

    let pending = Arc::new(Mutex::new(HashMap::new()));
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<RelayOutbound>();
    let mut frame_decoder = EmbeddedBrowserFrameDecoder::default();
    let mut control_decoder = EmbeddedBrowserControlMessageDecoder::default();
    let mut events = state.events.subscribe();
    let mut opened = false;
    let mut binding: Option<ControlBinding> = None;
    let registry = state.browser_control_relay.clone();

    'connection: loop {
        tokio::select! {
            message = receiver.next() => {
                let Some(message) = message else { break; };
                let message = match message {
                    Ok(message) => message,
                    Err(_) => break,
                };
                match message {
                    Message::Binary(bytes) => {
                        let frames = match frame_decoder.push(&bytes) {
                            Ok(frames) => frames,
                            Err(_) => {
                                writer.close(1002, "Browser control protocol error.");
                                break;
                            }
                        };
                        for frame in frames {
                            match handle_frame(
                                &state,
                                &context,
                                &writer,
                                &registry,
                                &pending,
                                &outbound_tx,
                                &mut control_decoder,
                                &mut opened,
                                &mut binding,
                                frame,
                            ) {
                                Ok(ControlFlow::Continue) => {}
                                Ok(ControlFlow::Close) | Err(()) => {
                                    writer.close(1002, "Browser control protocol error.");
                                    break 'connection;
                                }
                            }
                        }
                    }
                    Message::Text(_) => {
                        writer.close(1002, "Browser control requires binary frames.");
                        break;
                    }
                    Message::Ping(payload) => {
                        if !writer.send(Message::Pong(payload)) {
                            break;
                        }
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                }
            }
            outbound = outbound_rx.recv() => {
                let Some(outbound) = outbound else { break; };
                match outbound {
                    RelayOutbound::Request { id, method, params } => {
                        let value = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "method": method,
                            "params": params,
                        });
                        if !send_control_value(&writer, &value) {
                            break;
                        }
                    }
                    RelayOutbound::Notification { method, params } => {
                        let value = json!({
                            "jsonrpc": "2.0",
                            "method": method,
                            "params": params,
                        });
                        if !send_control_value(&writer, &value) {
                            break;
                        }
                    }
                    RelayOutbound::Close => break,
                }
            }
            event = events.recv() => {
                if let Ok(event) = event {
                    if event.r#type == "browser.registry.changed" {
                        if let Some(binding) = binding.as_mut() {
                            try_activate_binding(&state, &writer, binding);
                        }
                    }
                }
            }
        }
    }

    if let Some(binding) = binding {
        if registry.unregister(&binding.source_ref, binding.connection_id) {
            let _ = state
                .browser_control
                .disconnect_source(&binding.source_ref, binding.generation);
            publish_browser_events(&state);
        }
        binding.ready.store(false, Ordering::SeqCst);
    }
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    writer.close(1000, "Browser control connection closed.");
    drop(writer);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer_task).await;
}

#[allow(clippy::too_many_arguments)]
fn handle_frame(
    state: &AppState,
    context: &BrowserControlRelayContext,
    writer: &RelayWriter,
    registry: &BrowserControlRelayRegistry,
    pending: &Arc<Mutex<HashMap<String, oneshot::Sender<RelayReply>>>>,
    outbound: &mpsc::UnboundedSender<RelayOutbound>,
    control_decoder: &mut EmbeddedBrowserControlMessageDecoder,
    opened: &mut bool,
    binding: &mut Option<ControlBinding>,
    frame: EmbeddedBrowserFrame,
) -> Result<ControlFlow, ()> {
    match frame.frame_type {
        EmbeddedBrowserFrameType::Open => {
            if frame.stream_id != CONTROL_STREAM_ID || *opened {
                send_channel_error(
                    writer,
                    frame.stream_id,
                    EmbeddedBrowserProtocolErrorCode::ProtocolError,
                    "The control stream is already open or uses an invalid stream id.",
                )?;
                return Ok(ControlFlow::Continue);
            }
            if decode_embedded_browser_stream_open(&frame.payload).is_err() {
                send_channel_error(
                    writer,
                    frame.stream_id,
                    EmbeddedBrowserProtocolErrorCode::StreamKindUnsupported,
                    "Only the control stream is supported.",
                )?;
                return Ok(ControlFlow::Continue);
            }
            *opened = true;
            let payload = encode_embedded_browser_stream_open_ok().map_err(|_| ())?;
            if !send_frame(
                writer,
                EmbeddedBrowserFrame {
                    frame_type: EmbeddedBrowserFrameType::OpenOk,
                    stream_id: CONTROL_STREAM_ID,
                    payload,
                },
            ) {
                return Err(());
            }
            Ok(ControlFlow::Continue)
        }
        EmbeddedBrowserFrameType::Data => {
            if frame.stream_id != CONTROL_STREAM_ID || !*opened {
                return Err(());
            }
            for value in control_decoder.push(&frame.payload).map_err(|_| ())? {
                match handle_control_value(
                    state, context, writer, registry, pending, outbound, binding, value,
                ) {
                    ControlFlow::Continue => {}
                    ControlFlow::Close => return Ok(ControlFlow::Close),
                }
            }
            Ok(ControlFlow::Continue)
        }
        EmbeddedBrowserFrameType::HalfClose | EmbeddedBrowserFrameType::Close => {
            Ok(ControlFlow::Close)
        }
        EmbeddedBrowserFrameType::Error => Ok(ControlFlow::Close),
        EmbeddedBrowserFrameType::WindowUpdate => Ok(ControlFlow::Continue),
        EmbeddedBrowserFrameType::OpenOk => Err(()),
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_control_value(
    state: &AppState,
    context: &BrowserControlRelayContext,
    writer: &RelayWriter,
    registry: &BrowserControlRelayRegistry,
    pending: &Arc<Mutex<HashMap<String, oneshot::Sender<RelayReply>>>>,
    outbound: &mpsc::UnboundedSender<RelayOutbound>,
    binding: &mut Option<ControlBinding>,
    value: Value,
) -> ControlFlow {
    if value.get("method").is_none() {
        if let Some(id) = value.get("id").and_then(rpc_id) {
            if let Some(sender) = pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id)
            {
                let reply = value
                    .get("error")
                    .map(|error| RelayReply::Error {
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Browser control request failed.")
                            .to_string(),
                        data: error.get("data").cloned(),
                    })
                    .unwrap_or_else(|| {
                        RelayReply::Result(value.get("result").cloned().unwrap_or(Value::Null))
                    });
                let _ = sender.send(reply);
            }
        }
        return ControlFlow::Continue;
    }

    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let request_id = value.get("id").and_then(rpc_id);
    let result = match method {
        "control.hello" => handle_hello(
            state, context, writer, registry, pending, outbound, binding, params,
        ),
        "tabs.created" => {
            if !binding_matches(binding, &params) {
                return send_request_error(
                    writer,
                    request_id.as_deref(),
                    -32000,
                    "Browser source generation is stale.",
                    "BROWSER_LEASE_STALE",
                );
            }
            match serde_json::from_value::<EmbeddedBrowserTabsCreatedParams>(params) {
                Ok(params) => {
                    match state.browser_control.page(&params.tab_ref) {
                        Ok(page)
                            if page.source_ref == params.source_ref
                                && page.generation == params.generation => {}
                        Ok(_) => {
                            return send_request_error(
                                writer,
                                request_id.as_deref(),
                                -32000,
                                "Browser tab does not belong to the bound generation.",
                                "BROWSER_LEASE_STALE",
                            );
                        }
                        Err(error) => {
                            return send_request_error(
                                writer,
                                request_id.as_deref(),
                                -32000,
                                &error.message,
                                error.code,
                            );
                        }
                    }
                    if let Some(creation_ref) = params.creation_ref.as_deref() {
                        if let Err(error) = state.browser_control.complete_creation(
                            &params.source_ref,
                            creation_ref,
                            &params.tab_ref,
                        ) {
                            tracing::warn!(
                                code = error.code,
                                creation_ref,
                                tab_ref = %params.tab_ref,
                                "Browser tab creation completion was rejected"
                            );
                        }
                    }
                    publish_browser_events(state);
                    Ok(())
                }
                Err(_) => Err(BrowserControlError::new(
                    "BROWSER_CHANNEL_PROTOCOL_ERROR",
                    "tabs.created params are invalid.",
                    400,
                )),
            }
        }
        "tabs.destroyed" => {
            if !binding_matches(binding, &params) {
                return send_request_error(
                    writer,
                    request_id.as_deref(),
                    -32000,
                    "Browser source generation is stale.",
                    "BROWSER_LEASE_STALE",
                );
            }
            match serde_json::from_value::<EmbeddedBrowserTabsDestroyedParams>(params) {
                Ok(params) => {
                    if let Some(creation_ref) = params.creation_ref.as_deref() {
                        if let Err(error) = state.browser_control.fail_creation_if_active(
                            &params.source_ref,
                            creation_ref,
                            &params.reason,
                        ) {
                            tracing::warn!(
                                code = error.code,
                                creation_ref,
                                "Browser tab destruction could not fail the creation request"
                            );
                        }
                    }
                    publish_browser_events(state);
                    Ok(())
                }
                Err(_) => Err(BrowserControlError::new(
                    "BROWSER_CHANNEL_PROTOCOL_ERROR",
                    "tabs.destroyed params are invalid.",
                    400,
                )),
            }
        }
        "target.detached" => {
            match serde_json::from_value::<EmbeddedBrowserTargetDetachParams>(params) {
                Ok(params) => {
                    if state.browser_control.invalidate_lease(&params.lease_ref) {
                        publish_browser_events(state);
                    }
                    Ok(())
                }
                Err(_) => Err(BrowserControlError::new(
                    "BROWSER_CHANNEL_PROTOCOL_ERROR",
                    "target.detached params are invalid.",
                    400,
                )),
            }
        }
        "cdp.event" => match serde_json::from_value::<EmbeddedBrowserCdpEvent>(params) {
            Ok(event) if supports_embedded_browser_cdp_event(&event.method) => {
                let session_ref = state.browser_control.lease_session(
                    &event.lease_ref,
                    &event.tab_ref,
                    &best_binding_source(binding),
                    event.generation,
                );
                if let Some(session_ref) = session_ref {
                    state.events.publish(
                        "browser.control.cdp-event",
                        json!({
                            "sessionRef": session_ref,
                            "generation": event.generation,
                            "leaseRef": event.lease_ref,
                            "tabRef": event.tab_ref,
                            "frameSessionRef": event.frame_session_ref,
                            "method": event.method,
                            "params": event.params,
                        }),
                    );
                }
                Ok(())
            }
            Ok(_) => Err(BrowserControlError::new(
                "BROWSER_OPERATION_UNSUPPORTED",
                "CDP event is outside the page profile.",
                409,
            )),
            Err(_) => Err(BrowserControlError::new(
                "BROWSER_CHANNEL_PROTOCOL_ERROR",
                "cdp.event params are invalid.",
                400,
            )),
        },
        "control.revoke" => return ControlFlow::Close,
        _ => {
            return send_request_error(
                writer,
                request_id.as_deref(),
                -32601,
                "Browser control method is not supported.",
                "BROWSER_OPERATION_UNSUPPORTED",
            );
        }
    };
    if let Err(error) = result {
        if request_id.is_some() {
            return send_request_error(
                writer,
                request_id.as_deref(),
                -32000,
                &error.message,
                error.code,
            );
        }
        tracing::warn!(code = error.code, message = %error.message, "Browser control notification failed");
    } else if let Some(id) = request_id {
        let _ = send_control_value(writer, &json!({ "jsonrpc": "2.0", "id": id, "result": {} }));
    }
    ControlFlow::Continue
}

#[allow(clippy::too_many_arguments)]
fn handle_hello(
    state: &AppState,
    context: &BrowserControlRelayContext,
    writer: &RelayWriter,
    registry: &BrowserControlRelayRegistry,
    pending: &Arc<Mutex<HashMap<String, oneshot::Sender<RelayReply>>>>,
    outbound: &mpsc::UnboundedSender<RelayOutbound>,
    binding: &mut Option<ControlBinding>,
    params: Value,
) -> Result<(), BrowserControlError> {
    let hello = serde_json::from_value::<EmbeddedBrowserControlHello>(params).map_err(|_| {
        BrowserControlError::new(
            "BROWSER_CHANNEL_PROTOCOL_ERROR",
            "control.hello params are invalid.",
            400,
        )
    })?;
    if hello.protocol_version != EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION {
        tracing::warn!(
            expected = EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
            received = %hello.protocol_version,
            "Browser control protocol version differs; validating fields"
        );
    }
    match state.browser_control.source_owner(&hello.source_ref) {
        Some((panel_id, owner_ref))
            if panel_id == context.panel_id && owner_ref == context.user_id => {}
        _ => {
            return Err(BrowserControlError::new(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
                404,
            ));
        }
    }
    let source = state
        .browser_control
        .source_binding(&hello.source_ref, hello.generation)?;
    if source.page_host != hello.page_host
        || source.page_host_capabilities != hello.page_host_capabilities
    {
        return Err(BrowserControlError::new(
            "BROWSER_OPERATION_UNSUPPORTED",
            "Browser source capabilities do not match its registration.",
            409,
        ));
    }
    let registered = registry.register(
        &hello.source_ref,
        hello.generation,
        outbound.clone(),
        pending.clone(),
    );
    *binding = Some(ControlBinding {
        source_ref: hello.source_ref.clone(),
        generation: hello.generation,
        connection_id: registered.connection_id,
        ready: registered.ready,
        synchronized: false,
    });
    if let Some(binding) = binding.as_mut() {
        try_activate_binding(state, writer, binding);
    }
    Ok(())
}

fn try_activate_binding(state: &AppState, writer: &RelayWriter, binding: &mut ControlBinding) {
    if binding.synchronized {
        return;
    }
    let Ok(source) = state
        .browser_control
        .source_binding(&binding.source_ref, binding.generation)
    else {
        return;
    };
    if source.state == "syncing" || source.state == "ready" {
        match state.browser_control.sync_source_if_current(
            &binding.source_ref,
            binding.generation,
            &source.registry_epoch,
            source.registry_revision,
        ) {
            Ok(true) => {
                binding.synchronized = true;
                binding.ready.store(true, Ordering::SeqCst);
                let ready = EmbeddedBrowserControlReady {
                    protocol_version: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION.to_string(),
                    source_ref: binding.source_ref.clone(),
                    generation: binding.generation,
                };
                let synced = EmbeddedBrowserControlSynced {
                    source_ref: binding.source_ref.clone(),
                    generation: binding.generation,
                    registry_epoch: source.registry_epoch,
                    registry_revision: source.registry_revision,
                };
                let _ = send_notification(writer, "control.ready", &ready);
                let _ = send_notification(writer, "control.synced", &synced);
                publish_browser_events(state);
                return;
            }
            Ok(false) | Err(_) => {}
        }
    }
    let _ = send_notification(
        writer,
        "source.syncRequired",
        &json!({
            "sourceRef": binding.source_ref,
            "generation": binding.generation,
            "registryEpoch": source.registry_epoch,
            "registryRevision": source.registry_revision,
        }),
    );
}

fn binding_matches(binding: &Option<ControlBinding>, params: &Value) -> bool {
    let Some(binding) = binding.as_ref() else {
        return false;
    };
    params.get("sourceRef").and_then(Value::as_str) == Some(binding.source_ref.as_str())
        && params.get("generation").and_then(Value::as_u64) == Some(binding.generation)
}

fn best_binding_source(binding: &Option<ControlBinding>) -> String {
    binding
        .as_ref()
        .map(|binding| binding.source_ref.clone())
        .unwrap_or_default()
}

fn send_notification<T: serde::Serialize>(writer: &RelayWriter, method: &str, params: &T) -> bool {
    let value = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    send_control_value(writer, &value)
}

fn send_request_error(
    writer: &RelayWriter,
    request_id: Option<&str>,
    code: i64,
    message: &str,
    stable_code: &str,
) -> ControlFlow {
    if let Some(id) = request_id {
        let _ = send_control_value(
            writer,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": code,
                    "message": message,
                    "data": { "code": stable_code, "execution": "not-started" },
                },
            }),
        );
    }
    ControlFlow::Continue
}

fn send_control_value(writer: &RelayWriter, value: &Value) -> bool {
    let Ok(encoded) = encode_embedded_browser_control_message(value) else {
        return false;
    };
    for chunk in encoded.chunks(EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES - 4) {
        if !send_frame(
            writer,
            EmbeddedBrowserFrame {
                frame_type: EmbeddedBrowserFrameType::Data,
                stream_id: CONTROL_STREAM_ID,
                payload: chunk.to_vec(),
            },
        ) {
            return false;
        }
    }
    true
}

fn send_frame(writer: &RelayWriter, frame: EmbeddedBrowserFrame) -> bool {
    let Ok(encoded) = encode_embedded_browser_frame(frame) else {
        return false;
    };
    writer.send(Message::Binary(encoded.into()))
}

fn send_channel_error(
    writer: &RelayWriter,
    stream_id: u32,
    code: EmbeddedBrowserProtocolErrorCode,
    message: &str,
) -> Result<(), ()> {
    let payload = encode_embedded_browser_channel_error(&EmbeddedBrowserChannelError {
        code: code.as_str().to_string(),
        message: message.to_string(),
    })
    .map_err(|_| ())?;
    send_frame(
        writer,
        EmbeddedBrowserFrame {
            frame_type: EmbeddedBrowserFrameType::Error,
            stream_id,
            payload,
        },
    )
    .then_some(())
    .ok_or(())
}

fn rpc_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(ToString::to_string)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
}

fn static_error_code(value: &str) -> &'static str {
    match value {
        "BROWSER_CONTROL_UNSUPPORTED" => "BROWSER_CONTROL_UNSUPPORTED",
        "BROWSER_SOURCE_UNAVAILABLE" => "BROWSER_SOURCE_UNAVAILABLE",
        "BROWSER_SOURCE_NOT_FOUND" => "BROWSER_SOURCE_NOT_FOUND",
        "BROWSER_AUTHORIZATION_REQUIRED" => "BROWSER_AUTHORIZATION_REQUIRED",
        "BROWSER_AUTHORIZATION_REVOKED" => "BROWSER_AUTHORIZATION_REVOKED",
        "BROWSER_PAGE_HOST_UNAVAILABLE" => "BROWSER_PAGE_HOST_UNAVAILABLE",
        "BROWSER_TAB_NOT_FOUND" => "BROWSER_TAB_NOT_FOUND",
        "BROWSER_WINDOW_UNAVAILABLE" => "BROWSER_WINDOW_UNAVAILABLE",
        "BROWSER_TARGET_BUSY" => "BROWSER_TARGET_BUSY",
        "BROWSER_LEASE_STALE" => "BROWSER_LEASE_STALE",
        "BROWSER_CDP_ERROR" => "BROWSER_CDP_ERROR",
        "BROWSER_REQUEST_CONFLICT" => "BROWSER_REQUEST_CONFLICT",
        "BROWSER_TIMEOUT" => "BROWSER_TIMEOUT",
        "BROWSER_CANCELLED" => "BROWSER_CANCELLED",
        "BROWSER_EXECUTION_UNKNOWN" => "BROWSER_EXECUTION_UNKNOWN",
        "BROWSER_SNAPSHOT_REQUIRED" => "BROWSER_SNAPSHOT_REQUIRED",
        "BROWSER_LIMIT_EXCEEDED" => "BROWSER_LIMIT_EXCEEDED",
        "BROWSER_CREATION_NOT_FOUND" => "BROWSER_CREATION_NOT_FOUND",
        "BROWSER_CREATION_CONFLICT" => "BROWSER_CREATION_CONFLICT",
        "BROWSER_CREATION_DECLINED" => "BROWSER_CREATION_DECLINED",
        "BROWSER_CREATION_EXPIRED" => "BROWSER_CREATION_EXPIRED",
        "BROWSER_CREATION_NO_CANDIDATE" => "BROWSER_CREATION_NO_CANDIDATE",
        _ => "BROWSER_OPERATION_UNSUPPORTED",
    }
}

fn publish_browser_events(state: &AppState) {
    for event in state.browser_control.take_events() {
        let _ = state.events.publish(event.event_type, event.payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_request_ids_are_normalized() {
        assert_eq!(rpc_id(&json!("req_1")), Some("req_1".to_string()));
        assert_eq!(rpc_id(&json!(7)), Some("7".to_string()));
        assert_eq!(rpc_id(&Value::Null), None);
    }

    #[test]
    fn unknown_relay_error_codes_close_the_browser_domain() {
        assert_eq!(static_error_code("BROWSER_CDP_ERROR"), "BROWSER_CDP_ERROR");
        assert_eq!(
            static_error_code("UNTRUSTED_REMOTE_CODE"),
            "BROWSER_OPERATION_UNSUPPORTED"
        );
    }
}
