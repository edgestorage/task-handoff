//! Browser DataChannel boundary. No media, host credentials or OS handles.
use crate::contract::CHANNEL_VERSION;
use crate::traits::CapturePrecision;
use serde::{Deserialize, Serialize};

pub const MAX_MESSAGE: usize = 16 * 1024;
pub const MAX_CLIPBOARD_TEXT: usize = 32 * 1024;
pub const MAX_CLIPBOARD_WIRE: usize = 64 * 1024;
pub const MAX_SAFE_SEQUENCE: u64 = (1u64 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Control,
    Input,
    Pointer,
    Clipboard,
}
impl Channel {
    pub fn id(self) -> u16 {
        self.index() as u16
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Input => "input",
            Self::Pointer => "pointer",
            Self::Clipboard => "clipboard",
        }
    }
    pub fn ordered(self) -> bool {
        self != Self::Pointer
    }
    pub fn max_retransmits(self) -> Option<u16> {
        if self == Self::Pointer {
            Some(0)
        } else {
            None
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Control => 0,
            Self::Input => 1,
            Self::Pointer => 2,
            Self::Clipboard => 3,
        }
    }
}
#[derive(Serialize, Deserialize)]
pub struct Envelope<T> {
    pub v: String,
    pub seq: u64,
    #[serde(flatten)]
    pub message: T,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Control {
    #[serde(rename = "control.request")]
    RequestControl,
    #[serde(rename = "input.resume")]
    Resume(#[serde(default)] Resume),
    #[serde(rename = "input.suspend")]
    Suspend,
    #[serde(rename = "input.alive")]
    Alive(Epoch),
    #[serde(rename = "visibility")]
    Visibility { hidden: bool },
    #[serde(rename = "stream.keyframe")]
    Keyframe,
    #[serde(rename = "stream.resolution")]
    StreamResolution {
        #[serde(default, rename = "maxWidth")]
        max_width: Option<u32>,
        #[serde(default, rename = "maxHeight")]
        max_height: Option<u32>,
        #[serde(rename = "maxFrameRate")]
        max_frame_rate: Option<u32>,
        /// Additive to the existing resolution message. Older components ignore
        /// it; readers default it to Auto when a client predates the preference.
        #[serde(default, rename = "capturePrecision")]
        capture_precision: CapturePrecision,
    },
    #[serde(rename = "session.stop")]
    Stop,
    #[serde(rename = "clipboard.enable")]
    Clipboard { enabled: bool },
    /// Private progressive-transport acknowledgement path. It is accepted on
    /// the fallback control socket so WebRTC can be promoted without creating
    /// a second viewer session or control lease.
    #[serde(rename = "transport.upgrade")]
    TransportUpgrade,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    #[serde(default)]
    pub session_revision: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Epoch {
    pub input_epoch: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Input {
    #[serde(rename = "key")]
    Key(Key),
    #[serde(rename = "button")]
    Button(Button),
    #[serde(rename = "wheel")]
    Wheel(Wheel),
    #[serde(rename = "text.commit")]
    Text(Text),
}
impl Input {
    pub fn epoch(&self) -> u64 {
        match self {
            Self::Key(v) => v.input_epoch,
            Self::Button(v) => v.input_epoch,
            Self::Wheel(v) => v.input_epoch,
            Self::Text(v) => v.input_epoch,
        }
    }
    fn valid(&self) -> bool {
        match self {
            Self::Key(k) => {
                !k.code.is_empty()
                    && k.code.len() <= 64
                    && k.code.bytes().all(|b| b.is_ascii_alphanumeric())
                    && k.modifiers <= 15
            }
            Self::Button(b) => b.button <= 4 && coordinates(b.x, b.y),
            Self::Wheel(w) => {
                coordinates(w.x, w.y)
                    && w.delta_x.is_finite()
                    && w.delta_y.is_finite()
                    && w.delta_x.abs() <= 10000.0
                    && w.delta_y.abs() <= 10000.0
            }
            Self::Text(t) => !t.text.is_empty(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub input_epoch: u64,
    pub code: String,
    pub down: bool,
    pub modifiers: u8,
    #[serde(default)]
    pub repeat: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Button {
    pub input_epoch: u64,
    pub x: f64,
    pub y: f64,
    pub button: u8,
    pub down: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wheel {
    pub input_epoch: u64,
    pub x: f64,
    pub y: f64,
    pub delta_x: f64,
    pub delta_y: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub input_epoch: u64,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pointer {
    pub input_epoch: u64,
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum PointerMessage {
    #[serde(rename = "pointer")]
    Move(Pointer),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Clipboard {
    #[serde(rename = "clipboard.write")]
    Write { text: String },
    #[serde(rename = "clipboard.read")]
    Read,
}

fn coordinates(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)
}

pub enum Message {
    Control(Control),
    Input(Input),
    Pointer(Pointer),
    Clipboard(Clipboard),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("REMOTE_DESKTOP_INVALID_CHANNEL_MESSAGE")]
pub struct InvalidMessage;
#[derive(Default)]
pub struct Decoder {
    sequences: [Option<u64>; 4],
}
/// Adjacently tagged enums encode unit variants without content. A generic
/// client envelope can still emit `payload: {}`; only that empty object is
/// normalized away so a harmless shape difference cannot invalidate the
/// session. Non-empty content remains a protocol error.
fn decode_adjacent<T: serde::de::DeserializeOwned>(
    mut value: serde_json::Value,
) -> Result<T, InvalidMessage> {
    match serde_json::from_value(value.clone()) {
        Ok(message) => Ok(message),
        Err(_)
            if value
                .get("payload")
                .and_then(serde_json::Value::as_object)
                .is_some_and(serde_json::Map::is_empty) =>
        {
            if let Some(object) = value.as_object_mut() {
                object.remove("payload");
            }
            serde_json::from_value(value).map_err(|_| InvalidMessage)
        }
        Err(_) => Err(InvalidMessage),
    }
}
impl Decoder {
    /// Call only after verifying channel label/order/retransmit settings. Binary
    /// messages are rejected by the transport before this JSON decoder.
    pub fn decode(
        &mut self,
        channel: Channel,
        bytes: &[u8],
    ) -> Result<(Message, bool), InvalidMessage> {
        let limit = if channel == Channel::Clipboard {
            MAX_CLIPBOARD_WIRE
        } else {
            MAX_MESSAGE
        };
        if bytes.len() > limit {
            return Err(InvalidMessage);
        }
        let raw: Envelope<serde_json::Value> =
            serde_json::from_slice(bytes).map_err(|_| InvalidMessage)?;
        let i = channel.index();
        if raw.seq > MAX_SAFE_SEQUENCE || self.sequences[i].is_some_and(|last| raw.seq <= last) {
            return Err(InvalidMessage);
        }
        let value = raw.message;
        let message = match channel {
            Channel::Control => {
                let mut value = value;
                if value.get("type").and_then(|v| v.as_str()) == Some("input.resume")
                    && value.get("payload").is_none()
                {
                    value["payload"] = serde_json::json!({});
                }
                Message::Control(decode_adjacent(value)?)
            }
            Channel::Input => {
                let input: Input = serde_json::from_value(value).map_err(|_| InvalidMessage)?;
                if !input.valid() {
                    return Err(InvalidMessage);
                }
                Message::Input(input)
            }
            Channel::Pointer => {
                let PointerMessage::Move(pointer) =
                    serde_json::from_value(value).map_err(|_| InvalidMessage)?;
                if !coordinates(pointer.x, pointer.y) {
                    return Err(InvalidMessage);
                }
                Message::Pointer(pointer)
            }
            Channel::Clipboard => {
                let clipboard: Clipboard = decode_adjacent(value)?;
                if let Clipboard::Write { text } = &clipboard {
                    if text.len() > MAX_CLIPBOARD_TEXT {
                        return Err(InvalidMessage);
                    }
                }
                Message::Clipboard(clipboard)
            }
        };
        self.sequences[i] = Some(raw.seq);
        Ok((message, raw.v != CHANNEL_VERSION))
    }
}
