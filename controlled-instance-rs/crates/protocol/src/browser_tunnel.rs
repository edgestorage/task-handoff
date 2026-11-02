use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const BROWSER_TUNNEL_PROTOCOL_VERSION: &str = "2026-08-29";
pub const BROWSER_TUNNEL_FRAME_HEADER_BYTES: usize = 9;
pub const BROWSER_TUNNEL_INITIAL_WINDOW_BYTES: u32 = 256 * 1024;
pub const BROWSER_TUNNEL_MAX_DATA_BYTES: usize = 64 * 1024;
pub const BROWSER_TUNNEL_MAX_CONTROL_BYTES: usize = 4 * 1024;
pub const BROWSER_TUNNEL_MAX_WINDOW_BYTES: u32 = 16 * 1024 * 1024;
pub const BROWSER_TUNNEL_MAX_STREAMS: usize = 128;
pub const BROWSER_TUNNEL_MAX_QUEUED_BYTES_PER_STREAM: usize = 1024 * 1024;
pub const BROWSER_TUNNEL_MAX_CHANNEL_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
pub const BROWSER_TUNNEL_CONNECT_TIMEOUT_MS: u64 = 10_000;
pub const BROWSER_TUNNEL_IDLE_TIMEOUT_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum BrowserTunnelFrameType {
    Open = 1,
    OpenOk = 2,
    Data = 3,
    HalfClose = 4,
    Close = 5,
    Error = 6,
    WindowUpdate = 7,
}

impl TryFrom<u8> for BrowserTunnelFrameType {
    type Error = BrowserTunnelProtocolError;

    fn try_from(value: u8) -> Result<Self, BrowserTunnelProtocolError> {
        match value {
            1 => Ok(Self::Open),
            2 => Ok(Self::OpenOk),
            3 => Ok(Self::Data),
            4 => Ok(Self::HalfClose),
            5 => Ok(Self::Close),
            6 => Ok(Self::Error),
            7 => Ok(Self::WindowUpdate),
            _ => Err(BrowserTunnelProtocolError::new(
                "Browser tunnel frame type is unknown.",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrowserTunnelHello {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub protocol_version: String,
    pub initial_window_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrowserTunnelReady {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub protocol_version: String,
    pub initial_window_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserTunnelOpenPayload {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BrowserTunnelErrorCode {
    #[serde(rename = "BROWSER_TUNNEL_PROTOCOL_ERROR")]
    ProtocolError,
    #[serde(rename = "BROWSER_TUNNEL_STREAM_LIMIT")]
    StreamLimit,
    #[serde(rename = "BROWSER_TUNNEL_CONNECT_FAILED")]
    ConnectFailed,
    #[serde(rename = "BROWSER_TUNNEL_CONNECT_TIMEOUT")]
    ConnectTimeout,
    #[serde(rename = "BROWSER_TUNNEL_FLOW_CONTROL")]
    FlowControl,
    #[serde(rename = "BROWSER_TUNNEL_IDLE_TIMEOUT")]
    IdleTimeout,
    #[serde(rename = "BROWSER_TUNNEL_CLOSED")]
    Closed,
}

impl BrowserTunnelErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProtocolError => "BROWSER_TUNNEL_PROTOCOL_ERROR",
            Self::StreamLimit => "BROWSER_TUNNEL_STREAM_LIMIT",
            Self::ConnectFailed => "BROWSER_TUNNEL_CONNECT_FAILED",
            Self::ConnectTimeout => "BROWSER_TUNNEL_CONNECT_TIMEOUT",
            Self::FlowControl => "BROWSER_TUNNEL_FLOW_CONTROL",
            Self::IdleTimeout => "BROWSER_TUNNEL_IDLE_TIMEOUT",
            Self::Closed => "BROWSER_TUNNEL_CLOSED",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserTunnelErrorPayload {
    pub code: BrowserTunnelErrorCode,
    pub message: String,
}

impl BrowserTunnelErrorPayload {
    pub fn new(code: BrowserTunnelErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserTunnelFrame {
    pub frame_type: BrowserTunnelFrameType,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct BrowserTunnelProtocolError {
    pub message: String,
}

impl BrowserTunnelProtocolError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn parse_browser_tunnel_hello(
    bytes: &[u8],
) -> Result<BrowserTunnelHello, BrowserTunnelProtocolError> {
    let hello: BrowserTunnelHello = serde_json::from_slice(bytes)
        .map_err(|_| BrowserTunnelProtocolError::new("Browser tunnel hello is invalid."))?;
    if hello.frame_type != "browser-tunnel.hello"
        || hello.protocol_version != BROWSER_TUNNEL_PROTOCOL_VERSION
        || hello.initial_window_bytes == 0
        || hello.initial_window_bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES
    {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel hello is invalid.",
        ));
    }
    Ok(hello)
}

pub fn browser_tunnel_ready_json() -> String {
    serde_json::to_string(&BrowserTunnelReady {
        frame_type: "browser-tunnel.ready".to_string(),
        protocol_version: BROWSER_TUNNEL_PROTOCOL_VERSION.to_string(),
        initial_window_bytes: BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
    })
    .expect("browser tunnel ready frame is serializable")
}

pub fn encode_browser_tunnel_frame(
    frame: BrowserTunnelFrame,
) -> Result<Vec<u8>, BrowserTunnelProtocolError> {
    validate_frame(&frame)?;
    let payload_len = u32::try_from(frame.payload.len()).map_err(|_| {
        BrowserTunnelProtocolError::new("Browser tunnel frame payload exceeds the allowed size.")
    })?;
    let mut output = Vec::with_capacity(BROWSER_TUNNEL_FRAME_HEADER_BYTES + frame.payload.len());
    output.push(frame.frame_type as u8);
    output.extend_from_slice(&frame.stream_id.to_be_bytes());
    output.extend_from_slice(&payload_len.to_be_bytes());
    output.extend_from_slice(&frame.payload);
    Ok(output)
}

pub fn decode_browser_tunnel_frame(
    input: &[u8],
) -> Result<BrowserTunnelFrame, BrowserTunnelProtocolError> {
    if input.len() < BROWSER_TUNNEL_FRAME_HEADER_BYTES {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel frame header is truncated.",
        ));
    }
    let frame_type = BrowserTunnelFrameType::try_from(input[0])?;
    let stream_id = u32::from_be_bytes([input[1], input[2], input[3], input[4]]);
    let payload_len = u32::from_be_bytes([input[5], input[6], input[7], input[8]]) as usize;
    if stream_id == 0 {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel stream id must be positive.",
        ));
    }
    if payload_len != input.len() - BROWSER_TUNNEL_FRAME_HEADER_BYTES {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel frame length is invalid.",
        ));
    }
    let frame = BrowserTunnelFrame {
        frame_type,
        stream_id,
        payload: input[BROWSER_TUNNEL_FRAME_HEADER_BYTES..].to_vec(),
    };
    validate_frame(&frame)?;
    Ok(frame)
}

pub fn encode_browser_tunnel_open(
    stream_id: u32,
    payload: &BrowserTunnelOpenPayload,
) -> Result<Vec<u8>, BrowserTunnelProtocolError> {
    validate_open_payload(payload)?;
    let bytes = serde_json::to_vec(payload)
        .map_err(|_| BrowserTunnelProtocolError::new("Browser tunnel open payload is invalid."))?;
    encode_browser_tunnel_frame(BrowserTunnelFrame {
        frame_type: BrowserTunnelFrameType::Open,
        stream_id,
        payload: bytes,
    })
}

pub fn decode_browser_tunnel_open(
    frame: &BrowserTunnelFrame,
) -> Result<BrowserTunnelOpenPayload, BrowserTunnelProtocolError> {
    require_frame_type(frame, BrowserTunnelFrameType::Open)?;
    let payload: BrowserTunnelOpenPayload = serde_json::from_slice(&frame.payload)
        .map_err(|_| BrowserTunnelProtocolError::new("Browser tunnel open payload is invalid."))?;
    validate_open_payload(&payload)?;
    Ok(payload)
}

pub fn parse_browser_tunnel_error_payload(
    frame: &BrowserTunnelFrame,
) -> Result<BrowserTunnelErrorPayload, BrowserTunnelProtocolError> {
    require_frame_type(frame, BrowserTunnelFrameType::Error)?;
    let payload: BrowserTunnelErrorPayload = serde_json::from_slice(&frame.payload)
        .map_err(|_| BrowserTunnelProtocolError::new("Browser tunnel error payload is invalid."))?;
    validate_error_payload(&payload)?;
    Ok(payload)
}

pub fn encode_browser_tunnel_error(
    stream_id: u32,
    payload: &BrowserTunnelErrorPayload,
) -> Result<Vec<u8>, BrowserTunnelProtocolError> {
    validate_error_payload(payload)?;
    let bytes = serde_json::to_vec(payload)
        .map_err(|_| BrowserTunnelProtocolError::new("Browser tunnel error payload is invalid."))?;
    encode_browser_tunnel_frame(BrowserTunnelFrame {
        frame_type: BrowserTunnelFrameType::Error,
        stream_id,
        payload: bytes,
    })
}

pub fn encode_browser_tunnel_window_update(
    stream_id: u32,
    bytes: u32,
) -> Result<Vec<u8>, BrowserTunnelProtocolError> {
    if bytes == 0 || bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel window update is invalid.",
        ));
    }
    encode_browser_tunnel_frame(BrowserTunnelFrame {
        frame_type: BrowserTunnelFrameType::WindowUpdate,
        stream_id,
        payload: bytes.to_be_bytes().to_vec(),
    })
}

pub fn decode_browser_tunnel_window_update(
    frame: &BrowserTunnelFrame,
) -> Result<u32, BrowserTunnelProtocolError> {
    require_frame_type(frame, BrowserTunnelFrameType::WindowUpdate)?;
    if frame.payload.len() != 4 {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel window update payload is invalid.",
        ));
    }
    let bytes = u32::from_be_bytes([
        frame.payload[0],
        frame.payload[1],
        frame.payload[2],
        frame.payload[3],
    ]);
    if bytes == 0 || bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel window update is outside the allowed range.",
        ));
    }
    Ok(bytes)
}

fn validate_frame(frame: &BrowserTunnelFrame) -> Result<(), BrowserTunnelProtocolError> {
    if frame.stream_id == 0 {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel stream id is invalid.",
        ));
    }
    let control = frame.frame_type != BrowserTunnelFrameType::Data;
    let max_bytes = if control {
        BROWSER_TUNNEL_MAX_CONTROL_BYTES
    } else {
        BROWSER_TUNNEL_MAX_DATA_BYTES
    };
    if frame.payload.len() > max_bytes {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel frame payload exceeds the allowed size.",
        ));
    }
    if matches!(
        frame.frame_type,
        BrowserTunnelFrameType::OpenOk
            | BrowserTunnelFrameType::HalfClose
            | BrowserTunnelFrameType::Close
    ) && !frame.payload.is_empty()
    {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel control frame payload must be empty.",
        ));
    }
    Ok(())
}

fn validate_open_payload(
    payload: &BrowserTunnelOpenPayload,
) -> Result<(), BrowserTunnelProtocolError> {
    let host = payload.host.trim();
    if host.is_empty()
        || host.len() > 255
        || host.chars().any(|character| {
            character.is_whitespace() || "/?#@\\[]".contains(character) || character == '\0'
        })
        || payload.port == 0
    {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel open payload is invalid.",
        ));
    }
    Ok(())
}

fn validate_error_payload(
    payload: &BrowserTunnelErrorPayload,
) -> Result<(), BrowserTunnelProtocolError> {
    let message = payload.message.trim();
    if message.is_empty() || message.len() > 2048 {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel error payload is invalid.",
        ));
    }
    Ok(())
}

fn require_frame_type(
    frame: &BrowserTunnelFrame,
    expected: BrowserTunnelFrameType,
) -> Result<(), BrowserTunnelProtocolError> {
    if frame.frame_type != expected {
        return Err(BrowserTunnelProtocolError::new(
            "Browser tunnel frame has an unexpected type.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_matches_the_wire_header() {
        let frame = BrowserTunnelFrame {
            frame_type: BrowserTunnelFrameType::Data,
            stream_id: 7,
            payload: b"hello".to_vec(),
        };
        let encoded = encode_browser_tunnel_frame(frame.clone()).expect("encode");
        assert_eq!(&encoded[..9], &[3, 0, 0, 0, 7, 0, 0, 0, 5]);
        assert_eq!(
            decode_browser_tunnel_frame(&encoded).expect("decode"),
            frame
        );
    }

    #[test]
    fn frame_validation_preserves_control_and_data_limits() {
        let oversized_data = BrowserTunnelFrame {
            frame_type: BrowserTunnelFrameType::Data,
            stream_id: 1,
            payload: vec![0; BROWSER_TUNNEL_MAX_DATA_BYTES + 1],
        };
        assert!(encode_browser_tunnel_frame(oversized_data).is_err());
        let non_empty_close = BrowserTunnelFrame {
            frame_type: BrowserTunnelFrameType::Close,
            stream_id: 1,
            payload: vec![1],
        };
        assert!(encode_browser_tunnel_frame(non_empty_close).is_err());
    }

    #[test]
    fn hello_and_open_payloads_are_strict() {
        let hello = parse_browser_tunnel_hello(
            br#"{"type":"browser-tunnel.hello","protocolVersion":"2026-08-29","initialWindowBytes":262144}"#,
        )
        .expect("hello");
        assert_eq!(
            hello.initial_window_bytes,
            BROWSER_TUNNEL_INITIAL_WINDOW_BYTES
        );
        assert!(parse_browser_tunnel_hello(
            br#"{"type":"browser-tunnel.hello","protocolVersion":"2026-08-29","initialWindowBytes":1,"extra":true}"#,
        )
        .is_err());

        let frame = BrowserTunnelFrame {
            frame_type: BrowserTunnelFrameType::Open,
            stream_id: 1,
            payload: br#"{"host":"127.0.0.1","port":8080}"#.to_vec(),
        };
        assert_eq!(
            decode_browser_tunnel_open(&frame).expect("open").host,
            "127.0.0.1"
        );
        let invalid = BrowserTunnelFrame {
            payload: br#"{"host":"http://bad","port":8080}"#.to_vec(),
            ..frame
        };
        assert!(decode_browser_tunnel_open(&invalid).is_err());
    }
}
