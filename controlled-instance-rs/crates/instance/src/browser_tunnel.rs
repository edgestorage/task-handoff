use axum::extract::ws::{CloseFrame, Message, WebSocket};
use controlled_instance_protocol::{
    browser_tunnel_ready_json, decode_browser_tunnel_frame, decode_browser_tunnel_open,
    decode_browser_tunnel_window_update, encode_browser_tunnel_error, encode_browser_tunnel_frame,
    encode_browser_tunnel_window_update, parse_browser_tunnel_hello, BrowserTunnelErrorCode,
    BrowserTunnelErrorPayload, BrowserTunnelFrame, BrowserTunnelFrameType,
    BROWSER_TUNNEL_CONNECT_TIMEOUT_MS, BROWSER_TUNNEL_FRAME_HEADER_BYTES,
    BROWSER_TUNNEL_IDLE_TIMEOUT_MS, BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
    BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES, BROWSER_TUNNEL_MAX_DATA_BYTES,
    BROWSER_TUNNEL_MAX_QUEUED_BYTES_PER_STREAM, BROWSER_TUNNEL_MAX_STREAMS,
    BROWSER_TUNNEL_MAX_WINDOW_BYTES,
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc::{self, UnboundedSender},
    task::JoinHandle,
    time::{interval, timeout},
};

const BROWSER_TUNNEL_CONNECT_TIMEOUT: Duration =
    Duration::from_millis(BROWSER_TUNNEL_CONNECT_TIMEOUT_MS);
const BROWSER_TUNNEL_IDLE_TIMEOUT: Duration = Duration::from_millis(BROWSER_TUNNEL_IDLE_TIMEOUT_MS);

enum StreamCommand {
    Data(Vec<u8>),
    HalfClose,
    Close,
}

enum TunnelEvent {
    Connected { id: u32, stream: TcpStream },
    ConnectFailed { id: u32, timed_out: bool },
    Data { id: u32, data: Vec<u8> },
    ReadEnd { id: u32 },
    Written { id: u32, bytes: u32 },
    WriteEnded { id: u32 },
    StreamFailed { id: u32 },
    Closed { id: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamState {
    Connecting,
    Open,
}

struct TunnelStream {
    state: StreamState,
    receive_credit: u32,
    send_credit: u32,
    queued: VecDeque<Vec<u8>>,
    queued_bytes: usize,
    last_activity: Instant,
    commands: Option<mpsc::Sender<StreamCommand>>,
    task: Option<JoinHandle<()>>,
}

impl Drop for TunnelStream {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if let Some(commands) = self.commands.take() {
            let _ = commands.try_send(StreamCommand::Close);
        }
    }
}

struct OutgoingFrame {
    message: Message,
    accounted_bytes: usize,
    closes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TunnelSendFailure {
    Closed,
    SlowConsumer,
}

struct TunnelWriter {
    frames: UnboundedSender<OutgoingFrame>,
    pending_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    max_pending_bytes: usize,
}

impl TunnelWriter {
    fn new(
        frames: UnboundedSender<OutgoingFrame>,
        pending_bytes: Arc<AtomicUsize>,
        closed: Arc<AtomicBool>,
    ) -> Self {
        Self::with_limit(
            frames,
            pending_bytes,
            closed,
            BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES,
        )
    }

    fn with_limit(
        frames: UnboundedSender<OutgoingFrame>,
        pending_bytes: Arc<AtomicUsize>,
        closed: Arc<AtomicBool>,
        max_pending_bytes: usize,
    ) -> Self {
        Self {
            frames,
            pending_bytes,
            closed,
            max_pending_bytes,
        }
    }

    fn send_binary(&self, frame: Vec<u8>) -> Result<(), TunnelSendFailure> {
        self.enqueue(Message::Binary(frame.into()), false)
    }

    fn send_text(&self, text: String) -> Result<(), TunnelSendFailure> {
        self.enqueue(Message::Text(text.into()), false)
    }

    fn close(&self, code: u16, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.frames.send(OutgoingFrame {
            message: Message::Close(Some(CloseFrame {
                code,
                reason: reason.chars().take(123).collect::<String>().into(),
            })),
            accounted_bytes: 0,
            closes: true,
        });
    }

    fn enqueue(&self, message: Message, closes: bool) -> Result<(), TunnelSendFailure> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(TunnelSendFailure::Closed);
        }
        let bytes = match &message {
            Message::Binary(bytes) => bytes.len(),
            Message::Text(text) => text.len(),
            _ => 0,
        };
        if bytes > 0
            && self
                .pending_bytes
                .load(Ordering::SeqCst)
                .saturating_add(bytes)
                > self.max_pending_bytes
        {
            self.close(1013, "Browser tunnel consumer is too slow.");
            return Err(TunnelSendFailure::SlowConsumer);
        }
        self.pending_bytes.fetch_add(bytes, Ordering::SeqCst);
        if self
            .frames
            .send(OutgoingFrame {
                message,
                accounted_bytes: bytes,
                closes,
            })
            .is_err()
        {
            self.pending_bytes.fetch_sub(bytes, Ordering::SeqCst);
            return Err(TunnelSendFailure::Closed);
        }
        Ok(())
    }
}

pub async fn handle_browser_tunnel(socket: WebSocket) {
    let (mut sink, mut receiver) = socket.split();
    let (frames_tx, mut frames_rx) = mpsc::unbounded_channel::<OutgoingFrame>();
    let pending_bytes = Arc::new(AtomicUsize::new(0));
    let writer_closed = Arc::new(AtomicBool::new(false));
    let writer = TunnelWriter::new(frames_tx, pending_bytes.clone(), writer_closed);
    let mut writer_task = tokio::spawn(async move {
        while let Some(frame) = frames_rx.recv().await {
            let closes = frame.closes;
            let accounted_bytes = frame.accounted_bytes;
            let sent = sink.send(frame.message).await;
            pending_bytes.fetch_sub(accounted_bytes, Ordering::SeqCst);
            if sent.is_err() || closes {
                break;
            }
        }
    });
    let (events_tx, mut events_rx) = mpsc::channel::<TunnelEvent>(64);
    let mut streams = HashMap::<u32, TunnelStream>::new();
    let mut ready = false;
    let mut peer_initial_window = BROWSER_TUNNEL_INITIAL_WINDOW_BYTES;
    let mut idle = interval(Duration::from_secs(30));

    loop {
        let event = tokio::select! {
            message = receiver.next() => {
                let Some(message) = message else { break; };
                let message = match message {
                    Ok(message) => message,
                    Err(_) => {
                        writer.close(1011, "Browser tunnel transport failed.");
                        break;
                    }
                };
                if !ready {
                    let bytes = match message {
                        Message::Text(text) => text.as_str().as_bytes().to_vec(),
                        Message::Binary(bytes) => bytes.to_vec(),
                        Message::Close(_) => break,
                        Message::Ping(_) | Message::Pong(_) => continue,
                    };
                    let Ok(hello) = parse_browser_tunnel_hello(&bytes) else {
                        writer.close(1002, "Browser tunnel protocol error.");
                        break;
                    };
                    peer_initial_window = hello.initial_window_bytes;
                    ready = true;
                    if writer.send_text(browser_tunnel_ready_json()).is_err() {
                        break;
                    }
                    continue;
                }
                let bytes = match message {
                    Message::Binary(bytes) => bytes,
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Text(_) => {
                        writer.close(1002, "Browser tunnel protocol error.");
                        break;
                    }
                };
                let frame = match decode_browser_tunnel_frame(&bytes) {
                    Ok(frame) => frame,
                    Err(_) => {
                        writer.close(1002, "Browser tunnel protocol error.");
                        break;
                    }
                };
                if handle_client_frame(
                    &writer,
                    &mut streams,
                    frame,
                    peer_initial_window,
                    events_tx.clone(),
                )
                .await
                .is_err()
                {
                    writer.close(1002, "Browser tunnel protocol error.");
                    break;
                }
                continue;
            }
            Some(event) = events_rx.recv() => event,
            _ = idle.tick() => {
                let now = Instant::now();
                let expired = streams
                    .iter()
                    .filter(|(_, stream)| {
                        now.duration_since(stream.last_activity) >= BROWSER_TUNNEL_IDLE_TIMEOUT
                    })
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>();
                for id in expired {
                    if send_error(
                        &writer,
                        id,
                        BrowserTunnelErrorCode::IdleTimeout,
                        "Browser tunnel stream was idle for too long.",
                    )
                    .is_err()
                    {
                        break;
                    }
                    streams.remove(&id);
                }
                continue;
            }
        };

        match event {
            TunnelEvent::Connected { id, stream } => {
                let Some(entry) = streams.get_mut(&id) else {
                    continue;
                };
                if entry.state != StreamState::Connecting {
                    continue;
                }
                entry.state = StreamState::Open;
                entry.last_activity = Instant::now();
                let (commands, command_rx) = mpsc::channel(64);
                entry.commands = Some(commands);
                entry.task = Some(spawn_tunnel_stream(
                    id,
                    stream,
                    command_rx,
                    events_tx.clone(),
                ));
                if send_frame(
                    &writer,
                    BrowserTunnelFrame {
                        frame_type: BrowserTunnelFrameType::OpenOk,
                        stream_id: id,
                        payload: Vec::new(),
                    },
                )
                .is_err()
                {
                    break;
                }
            }
            TunnelEvent::ConnectFailed { id, timed_out } => {
                if !streams.contains_key(&id) {
                    continue;
                }
                let (code, message) = if timed_out {
                    (
                        BrowserTunnelErrorCode::ConnectTimeout,
                        "Target connection timed out.",
                    )
                } else {
                    (
                        BrowserTunnelErrorCode::ConnectFailed,
                        "Target connection failed.",
                    )
                };
                if send_error(&writer, id, code, message).is_err() {
                    break;
                }
                streams.remove(&id);
            }
            TunnelEvent::Data { id, data } => {
                let Some(stream) = streams.get_mut(&id) else {
                    continue;
                };
                if stream.state != StreamState::Open {
                    continue;
                }
                stream.last_activity = Instant::now();
                stream.queued_bytes = stream.queued_bytes.saturating_add(data.len());
                if stream.queued_bytes > BROWSER_TUNNEL_MAX_QUEUED_BYTES_PER_STREAM {
                    if send_error(
                        &writer,
                        id,
                        BrowserTunnelErrorCode::FlowControl,
                        "Target produced data faster than the browser consumed it.",
                    )
                    .is_err()
                    {
                        break;
                    }
                    streams.remove(&id);
                    continue;
                }
                stream.queued.push_back(data);
                if flush_target_data(&writer, id, stream).is_err() {
                    break;
                }
            }
            TunnelEvent::ReadEnd { id } => {
                let Some(stream) = streams.get_mut(&id) else {
                    continue;
                };
                stream.last_activity = Instant::now();
                if send_frame(
                    &writer,
                    BrowserTunnelFrame {
                        frame_type: BrowserTunnelFrameType::HalfClose,
                        stream_id: id,
                        payload: Vec::new(),
                    },
                )
                .is_err()
                {
                    break;
                }
            }
            TunnelEvent::Written { id, bytes } => {
                let Some(stream) = streams.get_mut(&id) else {
                    continue;
                };
                stream.receive_credit = stream
                    .receive_credit
                    .saturating_add(bytes)
                    .min(BROWSER_TUNNEL_INITIAL_WINDOW_BYTES);
                let Ok(frame) = encode_browser_tunnel_window_update(id, bytes) else {
                    break;
                };
                if writer.send_binary(frame).is_err() {
                    break;
                }
            }
            TunnelEvent::WriteEnded { id } => {
                if let Some(stream) = streams.get_mut(&id) {
                    stream.last_activity = Instant::now();
                }
            }
            TunnelEvent::StreamFailed { id } => {
                if !streams.contains_key(&id) {
                    continue;
                }
                if send_error(
                    &writer,
                    id,
                    BrowserTunnelErrorCode::ConnectFailed,
                    "Target connection failed.",
                )
                .is_err()
                {
                    break;
                }
                streams.remove(&id);
            }
            TunnelEvent::Closed { id } => {
                if !streams.contains_key(&id) {
                    continue;
                }
                if send_frame(
                    &writer,
                    BrowserTunnelFrame {
                        frame_type: BrowserTunnelFrameType::Close,
                        stream_id: id,
                        payload: Vec::new(),
                    },
                )
                .is_err()
                {
                    break;
                }
                streams.remove(&id);
            }
        }
    }

    streams.clear();
    writer.close(1000, "Browser tunnel closed.");
    drop(writer);
    if timeout(Duration::from_secs(1), &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
}

async fn handle_client_frame(
    writer: &TunnelWriter,
    streams: &mut HashMap<u32, TunnelStream>,
    frame: BrowserTunnelFrame,
    peer_initial_window: u32,
    events: mpsc::Sender<TunnelEvent>,
) -> Result<(), ()> {
    if frame.frame_type != BrowserTunnelFrameType::Open
        && frame.frame_type != BrowserTunnelFrameType::Close
        && !streams.contains_key(&frame.stream_id)
    {
        return send_error(
            writer,
            frame.stream_id,
            BrowserTunnelErrorCode::Closed,
            "Browser tunnel stream is closed.",
        );
    }
    match frame.frame_type {
        BrowserTunnelFrameType::Open => {
            let payload = match decode_browser_tunnel_open(&frame) {
                Ok(payload) => payload,
                Err(_) => return Err(()),
            };
            if streams.contains_key(&frame.stream_id) {
                return send_error(
                    writer,
                    frame.stream_id,
                    BrowserTunnelErrorCode::ProtocolError,
                    "Stream id is already open.",
                );
            }
            if streams.len() >= BROWSER_TUNNEL_MAX_STREAMS {
                return send_error(
                    writer,
                    frame.stream_id,
                    BrowserTunnelErrorCode::StreamLimit,
                    "Browser tunnel stream limit reached.",
                );
            }
            streams.insert(
                frame.stream_id,
                TunnelStream {
                    state: StreamState::Connecting,
                    receive_credit: BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
                    send_credit: peer_initial_window,
                    queued: VecDeque::new(),
                    queued_bytes: 0,
                    last_activity: Instant::now(),
                    commands: None,
                    task: None,
                },
            );
            let id = frame.stream_id;
            let host = loopback_alias(&payload.host);
            let port = payload.port;
            tokio::spawn(async move {
                match timeout(
                    BROWSER_TUNNEL_CONNECT_TIMEOUT,
                    TcpStream::connect((host, port)),
                )
                .await
                {
                    Ok(Ok(stream)) => {
                        let _ = events.send(TunnelEvent::Connected { id, stream }).await;
                    }
                    Ok(Err(_)) => {
                        let _ = events
                            .send(TunnelEvent::ConnectFailed {
                                id,
                                timed_out: false,
                            })
                            .await;
                    }
                    Err(_) => {
                        let _ = events
                            .send(TunnelEvent::ConnectFailed {
                                id,
                                timed_out: true,
                            })
                            .await;
                    }
                }
            });
            Ok(())
        }
        BrowserTunnelFrameType::Data => {
            let Some(stream) = streams.get_mut(&frame.stream_id) else {
                return send_error(
                    writer,
                    frame.stream_id,
                    BrowserTunnelErrorCode::Closed,
                    "Browser tunnel stream is closed.",
                );
            };
            stream.last_activity = Instant::now();
            if stream.state != StreamState::Open
                || frame.payload.len() > stream.receive_credit as usize
            {
                let id = frame.stream_id;
                if send_error(
                    writer,
                    id,
                    BrowserTunnelErrorCode::FlowControl,
                    "Browser tunnel receive window exceeded.",
                )
                .is_err()
                {
                    return Err(());
                }
                streams.remove(&id);
                return Ok(());
            }
            stream.receive_credit -= frame.payload.len() as u32;
            if let Some(commands) = stream.commands.as_ref() {
                if commands
                    .send(StreamCommand::Data(frame.payload))
                    .await
                    .is_err()
                {
                    return Err(());
                }
            }
            Ok(())
        }
        BrowserTunnelFrameType::WindowUpdate => {
            let Some(stream) = streams.get_mut(&frame.stream_id) else {
                return send_error(
                    writer,
                    frame.stream_id,
                    BrowserTunnelErrorCode::Closed,
                    "Browser tunnel stream is closed.",
                );
            };
            stream.last_activity = Instant::now();
            let bytes = match decode_browser_tunnel_window_update(&frame) {
                Ok(bytes) => bytes,
                Err(_) => return Err(()),
            };
            if stream.send_credit.saturating_add(bytes) > BROWSER_TUNNEL_MAX_WINDOW_BYTES {
                let id = frame.stream_id;
                if send_error(
                    writer,
                    id,
                    BrowserTunnelErrorCode::FlowControl,
                    "Browser tunnel send window exceeded.",
                )
                .is_err()
                {
                    return Err(());
                }
                streams.remove(&id);
                return Ok(());
            }
            stream.send_credit += bytes;
            flush_target_data(writer, frame.stream_id, stream)
        }
        BrowserTunnelFrameType::HalfClose => {
            let Some(stream) = streams.get_mut(&frame.stream_id) else {
                return Ok(());
            };
            stream.last_activity = Instant::now();
            if let Some(commands) = stream.commands.as_ref() {
                let _ = commands.send(StreamCommand::HalfClose).await;
            }
            Ok(())
        }
        BrowserTunnelFrameType::Close | BrowserTunnelFrameType::Error => {
            streams.remove(&frame.stream_id);
            Ok(())
        }
        BrowserTunnelFrameType::OpenOk => {
            if let Some(stream) = streams.get_mut(&frame.stream_id) {
                stream.last_activity = Instant::now();
            }
            Ok(())
        }
    }
}

fn flush_target_data(writer: &TunnelWriter, id: u32, stream: &mut TunnelStream) -> Result<(), ()> {
    while stream.state == StreamState::Open && stream.send_credit > 0 {
        let Some(front) = stream.queued.front() else {
            break;
        };
        let bytes = front
            .len()
            .min(stream.send_credit as usize)
            .min(BROWSER_TUNNEL_MAX_DATA_BYTES);
        if bytes == 0 {
            break;
        }
        let chunk = front[..bytes].to_vec();
        send_frame(
            writer,
            BrowserTunnelFrame {
                frame_type: BrowserTunnelFrameType::Data,
                stream_id: id,
                payload: chunk,
            },
        )?;
        stream.send_credit -= bytes as u32;
        stream.queued_bytes = stream.queued_bytes.saturating_sub(bytes);
        stream.last_activity = Instant::now();
        if bytes == front.len() {
            stream.queued.pop_front();
        } else if let Some(front) = stream.queued.front_mut() {
            front.drain(..bytes);
        }
    }
    Ok(())
}

fn spawn_tunnel_stream(
    id: u32,
    stream: TcpStream,
    mut commands: mpsc::Receiver<StreamCommand>,
    events: mpsc::Sender<TunnelEvent>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let (mut reader, mut writer) = stream.into_split();
        let mut read_done = false;
        let mut write_done = false;
        let mut buffer = vec![0u8; BROWSER_TUNNEL_MAX_DATA_BYTES];
        while !(read_done && write_done) {
            tokio::select! {
                command = commands.recv(), if !write_done => {
                    match command {
                        Some(StreamCommand::Data(data)) => {
                            if writer.write_all(&data).await.is_err() {
                                let _ = events.send(TunnelEvent::StreamFailed { id }).await;
                                return;
                            }
                            if events
                                .send(TunnelEvent::Written { id, bytes: data.len() as u32 })
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        Some(StreamCommand::HalfClose) => {
                            let _ = writer.shutdown().await;
                            write_done = true;
                            if events.send(TunnelEvent::WriteEnded { id }).await.is_err() {
                                return;
                            }
                        }
                        Some(StreamCommand::Close) | None => return,
                    }
                }
                read = reader.read(&mut buffer), if !read_done => {
                    match read {
                        Ok(0) => {
                            read_done = true;
                            if events.send(TunnelEvent::ReadEnd { id }).await.is_err() {
                                return;
                            }
                        }
                        Ok(size) => {
                            if events
                                .send(TunnelEvent::Data { id, data: buffer[..size].to_vec() })
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = events.send(TunnelEvent::StreamFailed { id }).await;
                            return;
                        }
                    }
                }
            }
        }
        let _ = events.send(TunnelEvent::Closed { id }).await;
    })
}

fn loopback_alias(host: &str) -> String {
    let Some(rest) = host
        .strip_prefix("127-")
        .and_then(|value| value.strip_suffix(".internal"))
    else {
        return host.to_string();
    };
    let parts = rest.split('-').collect::<Vec<_>>();
    if parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u16>().is_ok_and(|value| value <= 255))
    {
        format!("127.{}.{}.{}", parts[0], parts[1], parts[2])
    } else {
        host.to_string()
    }
}

fn send_error(
    writer: &TunnelWriter,
    id: u32,
    code: BrowserTunnelErrorCode,
    message: &str,
) -> Result<(), ()> {
    let frame = encode_browser_tunnel_error(id, &BrowserTunnelErrorPayload::new(code, message))
        .map_err(|_| ())?;
    writer.send_binary(frame).map_err(|_| ())
}

fn send_frame(writer: &TunnelWriter, frame: BrowserTunnelFrame) -> Result<(), ()> {
    writer
        .send_binary(encode_browser_tunnel_frame(frame).map_err(|_| ())?)
        .map_err(|_| ())
}

pub fn websocket_upgrade(
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> axum::extract::ws::WebSocketUpgrade {
    upgrade
        .max_message_size(BROWSER_TUNNEL_FRAME_HEADER_BYTES + BROWSER_TUNNEL_MAX_DATA_BYTES)
        .max_frame_size(BROWSER_TUNNEL_FRAME_HEADER_BYTES + BROWSER_TUNNEL_MAX_DATA_BYTES)
        .max_write_buffer_size(BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::ws::WebSocketUpgrade,
        response::{IntoResponse, Response},
        routing::get,
        Router,
    };
    use controlled_instance_protocol::{
        BrowserTunnelOpenPayload, BrowserTunnelReady, BROWSER_TUNNEL_PROTOCOL_VERSION,
    };
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use std::net::SocketAddr;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{protocol::frame::coding::CloseCode, Message as ClientMessage},
        MaybeTlsStream, WebSocketStream,
    };

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    struct Fixture {
        address: SocketAddr,
        task: JoinHandle<()>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn echo_server() -> Fixture {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind echo server");
        let address = listener.local_addr().expect("echo address");
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    loop {
                        let Ok(size) = stream.read(&mut buffer).await else {
                            break;
                        };
                        if size == 0 || stream.write_all(&buffer[..size]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        Fixture { address, task }
    }

    async fn tunnel_server() -> Fixture {
        async fn upgrade(websocket: WebSocketUpgrade) -> Response {
            websocket.on_upgrade(handle_browser_tunnel).into_response()
        }

        let app = Router::new().route("/tunnel", get(upgrade));
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind tunnel server");
        let address = listener.local_addr().expect("tunnel address");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Fixture { address, task }
    }

    async fn connect(address: SocketAddr) -> Client {
        tokio::time::timeout(
            Duration::from_secs(2),
            connect_async(format!("ws://{address}/tunnel")),
        )
        .await
        .expect("tunnel connect timeout")
        .expect("tunnel connect")
        .0
    }

    async fn next(client: &mut Client) -> ClientMessage {
        tokio::time::timeout(Duration::from_secs(5), client.next())
            .await
            .expect("tunnel message timeout")
            .expect("tunnel socket ended")
            .expect("tunnel message")
    }

    async fn send_frame(client: &mut Client, frame: BrowserTunnelFrame) {
        client
            .send(ClientMessage::Binary(
                encode_browser_tunnel_frame(frame)
                    .expect("encode tunnel frame")
                    .into(),
            ))
            .await
            .expect("send tunnel frame");
    }

    async fn next_frame(client: &mut Client) -> BrowserTunnelFrame {
        loop {
            match next(client).await {
                ClientMessage::Binary(bytes) => {
                    return decode_browser_tunnel_frame(&bytes).expect("decode tunnel frame");
                }
                ClientMessage::Ping(_) | ClientMessage::Pong(_) => {}
                other => panic!("expected binary tunnel frame, got {other:?}"),
            }
        }
    }

    #[test]
    fn loopback_aliases_preserve_the_node_wire_contract() {
        assert_eq!(loopback_alias("127-0-0-1.internal"), "127.0.0.1");
        assert_eq!(loopback_alias("127-255-12-9.internal"), "127.255.12.9");
        assert_eq!(
            loopback_alias("127-256-0-1.internal"),
            "127-256-0-1.internal"
        );
        assert_eq!(loopback_alias("localhost"), "localhost");
    }

    #[test]
    fn outbound_budget_closes_a_slow_consumer_before_unbounded_growth() {
        let (frames, mut receiver) = mpsc::unbounded_channel();
        let pending = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let writer = TunnelWriter::with_limit(frames, pending.clone(), closed.clone(), 16);

        assert_eq!(writer.send_binary(vec![0; 16]), Ok(()));
        assert_eq!(
            writer.send_binary(vec![1]),
            Err(TunnelSendFailure::SlowConsumer)
        );
        assert!(closed.load(Ordering::SeqCst));
        assert!(matches!(
            receiver.try_recv().expect("queued binary frame").message,
            Message::Binary(bytes) if bytes.len() == 16
        ));
        assert!(matches!(
            receiver.try_recv().expect("queued close frame").message,
            Message::Close(Some(frame)) if frame.code == 1013
        ));
    }

    #[tokio::test]
    async fn hello_open_alias_echo_flow_control_half_close_and_close_round_trip() {
        let echo = echo_server().await;
        let tunnel = tunnel_server().await;
        let mut client = connect(tunnel.address).await;
        client
            .send(ClientMessage::Text(
                json!({
                    "type": "browser-tunnel.hello",
                    "protocolVersion": BROWSER_TUNNEL_PROTOCOL_VERSION,
                    "initialWindowBytes": BROWSER_TUNNEL_INITIAL_WINDOW_BYTES
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send hello");
        let ClientMessage::Text(ready) = next(&mut client).await else {
            panic!("tunnel did not send ready text");
        };
        let ready: BrowserTunnelReady = serde_json::from_str(ready.as_str()).expect("ready json");
        assert_eq!(ready.frame_type, "browser-tunnel.ready");
        assert_eq!(ready.protocol_version, BROWSER_TUNNEL_PROTOCOL_VERSION);

        let stream_id = 7;
        send_frame(
            &mut client,
            BrowserTunnelFrame {
                frame_type: BrowserTunnelFrameType::Open,
                stream_id,
                payload: serde_json::to_vec(&BrowserTunnelOpenPayload {
                    host: "127-0-0-1.internal".to_string(),
                    port: echo.address.port(),
                })
                .expect("open payload"),
            },
        )
        .await;
        assert_eq!(
            next_frame(&mut client).await.frame_type,
            BrowserTunnelFrameType::OpenOk
        );

        send_frame(
            &mut client,
            BrowserTunnelFrame {
                frame_type: BrowserTunnelFrameType::Data,
                stream_id,
                payload: b"hello tunnel".to_vec(),
            },
        )
        .await;
        let mut echoed = Vec::new();
        let mut saw_window_update = false;
        while echoed != b"hello tunnel" || !saw_window_update {
            let frame = next_frame(&mut client).await;
            assert_eq!(frame.stream_id, stream_id);
            match frame.frame_type {
                BrowserTunnelFrameType::Data => echoed.extend_from_slice(&frame.payload),
                BrowserTunnelFrameType::WindowUpdate => {
                    assert_eq!(
                        decode_browser_tunnel_window_update(&frame).expect("window"),
                        b"hello tunnel".len() as u32
                    );
                    saw_window_update = true;
                }
                other => panic!("unexpected tunnel frame: {other:?}"),
            }
        }

        send_frame(
            &mut client,
            BrowserTunnelFrame {
                frame_type: BrowserTunnelFrameType::HalfClose,
                stream_id,
                payload: Vec::new(),
            },
        )
        .await;
        let mut saw_half_close = false;
        loop {
            let frame = next_frame(&mut client).await;
            match frame.frame_type {
                BrowserTunnelFrameType::HalfClose => saw_half_close = true,
                BrowserTunnelFrameType::Close => {
                    assert!(saw_half_close);
                    break;
                }
                other => panic!("unexpected close sequence frame: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn invalid_handshake_or_text_frames_close_with_1002() {
        let tunnel = tunnel_server().await;
        let mut client = connect(tunnel.address).await;
        client
            .send(ClientMessage::Text(
                json!({
                    "type": "browser-tunnel.hello",
                    "protocolVersion": "wrong",
                    "initialWindowBytes": BROWSER_TUNNEL_INITIAL_WINDOW_BYTES
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send invalid hello");
        match next(&mut client).await {
            ClientMessage::Close(Some(frame)) => {
                assert_eq!(frame.code, CloseCode::Protocol);
            }
            other => panic!("expected protocol close after invalid hello, got {other:?}"),
        }

        let mut client = connect(tunnel.address).await;
        client
            .send(ClientMessage::Text(
                json!({
                    "type": "browser-tunnel.hello",
                    "protocolVersion": BROWSER_TUNNEL_PROTOCOL_VERSION,
                    "initialWindowBytes": BROWSER_TUNNEL_INITIAL_WINDOW_BYTES
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send hello");
        assert!(matches!(next(&mut client).await, ClientMessage::Text(_)));
        client
            .send(ClientMessage::Text("not-binary".into()))
            .await
            .expect("send invalid text");
        match next(&mut client).await {
            ClientMessage::Close(Some(frame)) => {
                assert_eq!(frame.code, CloseCode::Protocol);
            }
            other => panic!("expected protocol close after text frame, got {other:?}"),
        }
    }
}
