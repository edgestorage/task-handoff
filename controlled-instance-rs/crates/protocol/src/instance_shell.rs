use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const INSTANCE_SHELL_PROTOCOL_VERSION: &str = "2026-10-31";
pub const INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL: &str = "task-handoff.instance-shell.2026-10-31";
pub const INSTANCE_SHELL_CONTROL_FRAME_MAX_BYTES: usize = 16 * 1024;
pub const INSTANCE_SHELL_DATA_FRAME_MAX_BYTES: usize = 1024 * 1024;
pub const INSTANCE_SHELL_ARGV_MAX_ITEMS: usize = 1_024;
pub const INSTANCE_SHELL_ARGV_ITEM_MAX_BYTES: usize = 64 * 1024;
pub const INSTANCE_SHELL_ARGV_TOTAL_MAX_BYTES: usize = 256 * 1024;
pub const INSTANCE_SHELL_ACTIVITY_LIMIT: usize = 8;
pub const INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const INSTANCE_SHELL_TERMINAL_DIMENSION_MAX: u16 = 10_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum InstanceShellDataChannel {
    Input = 0x01,
    Output = 0x02,
    Stderr = 0x03,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceShellDataDirection {
    ClientToInstance,
    InstanceToClient,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstanceShellMode {
    Interactive,
    Exec,
}

impl InstanceShellMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Exec => "exec",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceShellCapabilities {
    pub protocol_version: String,
    pub interactive: bool,
    pub exec: bool,
    pub exec_tty: bool,
}

impl Default for InstanceShellCapabilities {
    fn default() -> Self {
        Self {
            protocol_version: INSTANCE_SHELL_PROTOCOL_VERSION.to_string(),
            interactive: false,
            exec: false,
            exec_tty: false,
        }
    }
}

impl InstanceShellCapabilities {
    pub fn supported() -> Self {
        Self {
            protocol_version: INSTANCE_SHELL_PROTOCOL_VERSION.to_string(),
            interactive: true,
            exec: true,
            exec_tty: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceShellStartFrame {
    pub mode: InstanceShellMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    pub tty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstanceShellSignal {
    Sigint,
    Sigterm,
}

impl InstanceShellSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sigint => "SIGINT",
            Self::Sigterm => "SIGTERM",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceShellClientControlFrame {
    Start(InstanceShellStartFrame),
    StdinClose,
    Resize { cols: u16, rows: u16 },
    Signal(InstanceShellSignal),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceShellStartedFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub protocol_version: String,
    pub mode: InstanceShellMode,
    pub tty: bool,
}

impl InstanceShellStartedFrame {
    pub fn new(mode: InstanceShellMode, tty: bool) -> Self {
        Self {
            frame_type: "started".to_string(),
            protocol_version: INSTANCE_SHELL_PROTOCOL_VERSION.to_string(),
            mode,
            tty,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceShellExitFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

impl InstanceShellExitFrame {
    pub fn from_status(code: Option<i32>, signal: Option<String>) -> Self {
        if signal.is_some() {
            Self {
                frame_type: "exit".to_string(),
                code: None,
                signal,
            }
        } else {
            Self {
                frame_type: "exit".to_string(),
                code: Some(code.unwrap_or(1).max(0)),
                signal: None,
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceShellErrorFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub code: String,
    pub message: String,
}

impl InstanceShellErrorFrame {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            frame_type: "error".to_string(),
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct InstanceShellProtocolError {
    pub code: String,
    pub message: String,
}

impl InstanceShellProtocolError {
    pub fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: "INSTANCE_SHELL_PROTOCOL_ERROR".to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ClientControlEnvelope {
    #[serde(rename = "type")]
    frame_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartWire {
    #[serde(rename = "type")]
    frame_type: String,
    mode: InstanceShellMode,
    #[serde(default, deserialize_with = "deserialize_present_option")]
    command: Option<Vec<String>>,
    tty: bool,
    #[serde(default, deserialize_with = "deserialize_present_option")]
    cols: Option<u16>,
    #[serde(default, deserialize_with = "deserialize_present_option")]
    rows: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TypeWire {
    #[serde(rename = "type")]
    frame_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeWire {
    #[serde(rename = "type")]
    frame_type: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalWire {
    #[serde(rename = "type")]
    frame_type: String,
    signal: String,
}

pub fn parse_instance_shell_client_control_frame(
    text: &str,
) -> Result<InstanceShellClientControlFrame, InstanceShellProtocolError> {
    if text.len() > INSTANCE_SHELL_CONTROL_FRAME_MAX_BYTES {
        return Err(InstanceShellProtocolError::protocol(
            "Instance shell control frame is too large.",
        ));
    }
    let value: Value = serde_json::from_str(text).map_err(|_| {
        InstanceShellProtocolError::protocol("Instance shell control frame is not valid JSON.")
    })?;
    if !value.is_object() {
        return Err(InstanceShellProtocolError::protocol(
            "Instance shell control frame must be a JSON object.",
        ));
    }
    let envelope: ClientControlEnvelope = serde_json::from_value(value.clone()).map_err(|_| {
        InstanceShellProtocolError::protocol("Instance shell client control frame is invalid.")
    })?;
    match envelope.frame_type.as_str() {
        "start" => {
            let wire: StartWire = serde_json::from_value(value).map_err(|_| {
                InstanceShellProtocolError::protocol(
                    "Instance shell client control frame is invalid.",
                )
            })?;
            validate_start(&wire)?;
            Ok(InstanceShellClientControlFrame::Start(
                InstanceShellStartFrame {
                    mode: wire.mode,
                    command: wire.command,
                    tty: wire.tty,
                    cols: wire.cols,
                    rows: wire.rows,
                },
            ))
        }
        "stdin-close" => {
            let wire: TypeWire = serde_json::from_value(value).map_err(|_| {
                InstanceShellProtocolError::protocol(
                    "Instance shell client control frame is invalid.",
                )
            })?;
            if wire.frame_type != "stdin-close" {
                return Err(invalid_control_frame());
            }
            Ok(InstanceShellClientControlFrame::StdinClose)
        }
        "resize" => {
            let wire: ResizeWire = serde_json::from_value(value).map_err(|_| {
                InstanceShellProtocolError::protocol(
                    "Instance shell client control frame is invalid.",
                )
            })?;
            if wire.frame_type != "resize" {
                return Err(invalid_control_frame());
            }
            validate_dimensions(wire.cols, wire.rows)?;
            Ok(InstanceShellClientControlFrame::Resize {
                cols: wire.cols,
                rows: wire.rows,
            })
        }
        "signal" => {
            let wire: SignalWire = serde_json::from_value(value).map_err(|_| {
                InstanceShellProtocolError::protocol(
                    "Instance shell client control frame is invalid.",
                )
            })?;
            if wire.frame_type != "signal" {
                return Err(invalid_control_frame());
            }
            let signal = match wire.signal.as_str() {
                "SIGINT" => InstanceShellSignal::Sigint,
                "SIGTERM" => InstanceShellSignal::Sigterm,
                _ => return Err(invalid_control_frame()),
            };
            Ok(InstanceShellClientControlFrame::Signal(signal))
        }
        _ => Err(invalid_control_frame()),
    }
}

fn validate_start(wire: &StartWire) -> Result<(), InstanceShellProtocolError> {
    if wire.frame_type != "start" {
        return Err(invalid_control_frame());
    }
    if wire.mode == InstanceShellMode::Interactive {
        if !wire.tty || wire.command.is_some() {
            return Err(invalid_control_frame());
        }
    } else {
        let Some(command) = wire.command.as_ref() else {
            return Err(invalid_control_frame());
        };
        if command.is_empty() || command.len() > INSTANCE_SHELL_ARGV_MAX_ITEMS {
            return Err(invalid_control_frame());
        }
        let mut total = 0usize;
        for item in command {
            if item.chars().count() > INSTANCE_SHELL_ARGV_ITEM_MAX_BYTES {
                return Err(invalid_control_frame());
            }
            total = total.saturating_add(item.len());
            if total > INSTANCE_SHELL_ARGV_TOTAL_MAX_BYTES {
                return Err(invalid_control_frame());
            }
        }
    }
    match (wire.cols, wire.rows) {
        (Some(cols), Some(rows)) => validate_dimensions(cols, rows)?,
        (None, None) => {}
        _ => return Err(invalid_control_frame()),
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), InstanceShellProtocolError> {
    if cols == 0
        || rows == 0
        || cols > INSTANCE_SHELL_TERMINAL_DIMENSION_MAX
        || rows > INSTANCE_SHELL_TERMINAL_DIMENSION_MAX
    {
        return Err(invalid_control_frame());
    }
    Ok(())
}

fn invalid_control_frame() -> InstanceShellProtocolError {
    InstanceShellProtocolError::protocol("Instance shell client control frame is invalid.")
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("expected a value, not null"));
    }
    T::deserialize(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

pub fn encode_instance_shell_binary_frame(
    channel: InstanceShellDataChannel,
    payload: &[u8],
) -> Result<Vec<u8>, InstanceShellProtocolError> {
    if payload.is_empty() || payload.len() > INSTANCE_SHELL_DATA_FRAME_MAX_BYTES {
        return Err(InstanceShellProtocolError::protocol(
            "Instance shell data payload is invalid.",
        ));
    }
    let mut frame = Vec::with_capacity(payload.len() + 1);
    frame.push(channel as u8);
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_instance_shell_binary_frame(
    bytes: &[u8],
    direction: InstanceShellDataDirection,
) -> Result<(InstanceShellDataChannel, &[u8]), InstanceShellProtocolError> {
    if bytes.len() <= 1 {
        return Err(InstanceShellProtocolError::protocol(
            "Instance shell data payload must not be empty.",
        ));
    }
    if bytes.len() - 1 > INSTANCE_SHELL_DATA_FRAME_MAX_BYTES {
        return Err(InstanceShellProtocolError::protocol(
            "Instance shell data payload is too large.",
        ));
    }
    let channel = match bytes[0] {
        0x01 => InstanceShellDataChannel::Input,
        0x02 => InstanceShellDataChannel::Output,
        0x03 => InstanceShellDataChannel::Stderr,
        _ => {
            return Err(InstanceShellProtocolError::protocol(
                "Instance shell binary frame uses an invalid channel for its direction.",
            ));
        }
    };
    let allowed = match direction {
        InstanceShellDataDirection::ClientToInstance => channel == InstanceShellDataChannel::Input,
        InstanceShellDataDirection::InstanceToClient => {
            matches!(
                channel,
                InstanceShellDataChannel::Output | InstanceShellDataChannel::Stderr
            )
        }
    };
    if !allowed {
        return Err(InstanceShellProtocolError::protocol(
            "Instance shell binary frame uses an invalid channel for its direction.",
        ));
    }
    Ok((channel, &bytes[1..]))
}

pub fn encode_instance_shell_started_frame(mode: InstanceShellMode, tty: bool) -> String {
    serde_json::to_string(&InstanceShellStartedFrame::new(mode, tty))
        .expect("instance shell started frame is serializable")
}

pub fn encode_instance_shell_exit_frame(code: Option<i32>, signal: Option<String>) -> String {
    serde_json::to_string(&InstanceShellExitFrame::from_status(code, signal))
        .expect("instance shell exit frame is serializable")
}

pub fn encode_instance_shell_error_frame(code: &str, message: &str) -> String {
    serde_json::to_string(&InstanceShellErrorFrame::new(code, message))
        .expect("instance shell error frame is serializable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_frames_enforce_mode_specific_fields() {
        let interactive = parse_instance_shell_client_control_frame(
            r#"{"type":"start","mode":"interactive","tty":true,"cols":120,"rows":40}"#,
        )
        .expect("interactive start");
        assert_eq!(
            interactive,
            InstanceShellClientControlFrame::Start(InstanceShellStartFrame {
                mode: InstanceShellMode::Interactive,
                command: None,
                tty: true,
                cols: Some(120),
                rows: Some(40),
            })
        );
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"start","mode":"interactive","tty":false}"#
        )
        .is_err());
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"start","mode":"exec","tty":false}"#
        )
        .is_err());
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"start","mode":"exec","tty":false,"command":["sh"],"unknown":true}"#
        )
        .is_ok());
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"start","mode":"exec","tty":false,"command":null}"#
        )
        .is_err());
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"start","mode":"interactive","tty":true,"cols":null,"rows":40}"#
        )
        .is_err());
    }

    #[test]
    fn control_frames_reject_unknown_fields_and_invalid_signals() {
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"resize","cols":80,"rows":24,"extra":1}"#
        )
        .is_err());
        assert!(parse_instance_shell_client_control_frame(
            r#"{"type":"signal","signal":"SIGKILL"}"#
        )
        .is_err());
        assert!(parse_instance_shell_client_control_frame(r#"{"type":"stdin-close"}"#).is_ok());
    }

    #[test]
    fn binary_frames_are_bounded_and_directional() {
        let frame = encode_instance_shell_binary_frame(InstanceShellDataChannel::Output, b"hello")
            .expect("frame");
        assert_eq!(frame, b"\x02hello");
        assert_eq!(
            decode_instance_shell_binary_frame(
                &frame,
                InstanceShellDataDirection::InstanceToClient
            )
            .expect("decode")
            .1,
            b"hello"
        );
        assert!(decode_instance_shell_binary_frame(
            &frame,
            InstanceShellDataDirection::ClientToInstance
        )
        .is_err());
        assert!(encode_instance_shell_binary_frame(InstanceShellDataChannel::Input, &[]).is_err());
    }

    #[test]
    fn server_control_frames_use_the_frozen_wire_shape() {
        let started = encode_instance_shell_started_frame(InstanceShellMode::Exec, false);
        assert_eq!(
            started,
            r#"{"type":"started","protocolVersion":"2026-10-31","mode":"exec","tty":false}"#
        );
        let exit = encode_instance_shell_exit_frame(None, Some("SIGTERM".to_string()));
        assert_eq!(exit, r#"{"type":"exit","signal":"SIGTERM"}"#);
    }
}
