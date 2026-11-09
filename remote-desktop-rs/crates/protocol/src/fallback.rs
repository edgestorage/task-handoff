//! Component private fallback media framing. This is not a public protocol
//! module and is never persisted; the browser mirror lives in the inspected
//! Control Plane protocol package.
use serde::{Deserialize, Serialize};

pub const VERSION: u8 = 1;
pub const FRAME_VIDEO: u8 = 1;
pub const FLAG_KEYFRAME: u8 = 1;
pub const HEADER_BYTES: usize = 25;
pub const MAX_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Media,
    Control,
}
impl Role {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "media" => Some(Self::Media),
            "control" => Some(Self::Control),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Media => "media",
            Self::Control => "control",
        }
    }
    pub fn subprotocol(self) -> &'static str {
        match self {
            Self::Media => controlled_instance_protocol::REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL,
            Self::Control => {
                controlled_instance_protocol::REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attach {
    #[serde(rename = "type")]
    pub kind: String,
    pub role: String,
    pub fallback_generation: String,
    pub viewer_session_id: String,
    pub actor_id: String,
    pub device_session_id: String,
    pub capture_target: crate::model::CaptureTarget,
}

#[derive(Clone)]
pub struct EncodedFrame {
    pub frame_id: u32,
    pub timestamp_us: u64,
    pub keyframe: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub data: Vec<u8>,
}

pub fn encode_chunk(
    frame: &EncodedFrame,
    chunk_index: u16,
    chunk_count: u16,
    payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
    out.extend_from_slice(b"RD");
    out.push(VERSION);
    out.push(FRAME_VIDEO);
    out.push(if frame.keyframe { FLAG_KEYFRAME } else { 0 });
    out.extend_from_slice(&frame.frame_id.to_be_bytes());
    out.extend_from_slice(&frame.timestamp_us.to_be_bytes());
    out.extend_from_slice(&chunk_index.to_be_bytes());
    out.extend_from_slice(&chunk_count.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Test/diagnostic decoder. Invalid headers are rejected before allocation.
pub fn decode_chunk(input: &[u8]) -> Option<(EncodedFrame, u16, u16, &[u8])> {
    if input.len() < HEADER_BYTES
        || &input[..2] != b"RD"
        || input[2] != VERSION
        || input[3] != FRAME_VIDEO
    {
        return None;
    }
    let flags = input[4];
    let frame_id = u32::from_be_bytes(input[5..9].try_into().ok()?);
    let timestamp_us = u64::from_be_bytes(input[9..17].try_into().ok()?);
    let chunk_index = u16::from_be_bytes(input[17..19].try_into().ok()?);
    let chunk_count = u16::from_be_bytes(input[19..21].try_into().ok()?);
    let payload_len = u32::from_be_bytes(input[21..25].try_into().ok()?) as usize;
    if chunk_count == 0 || chunk_index >= chunk_count || payload_len != input.len() - HEADER_BYTES {
        return None;
    }
    Some((
        EncodedFrame {
            frame_id,
            timestamp_us,
            keyframe: flags & FLAG_KEYFRAME != 0,
            width: 0,
            height: 0,
            fps: 0,
            bitrate: 0,
            data: Vec::new(),
        },
        chunk_index,
        chunk_count,
        &input[HEADER_BYTES..],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_header_round_trip_and_bounds() {
        let frame = EncodedFrame {
            frame_id: 7,
            timestamp_us: 99,
            keyframe: true,
            width: 1280,
            height: 720,
            fps: 30,
            bitrate: 4_000_000,
            data: vec![],
        };
        let encoded = encode_chunk(&frame, 1, 2, b"abc");
        let (decoded, index, count, payload) = decode_chunk(&encoded).unwrap();
        assert_eq!(
            (decoded.frame_id, decoded.timestamp_us, decoded.keyframe),
            (7, 99, true)
        );
        assert_eq!((index, count, payload), (1, 2, &b"abc"[..]));
        assert!(decode_chunk(&encoded[..HEADER_BYTES - 1]).is_none());
        let mut bad = encoded.clone();
        bad[19..21].copy_from_slice(&0u16.to_be_bytes());
        assert!(decode_chunk(&bad).is_none());
    }
}
