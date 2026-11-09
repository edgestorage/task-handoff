//! Instance-private desktop adapter. No capture, codec or WebRTC dependencies.
pub use remote_desktop_protocol::{contract, framing, model};
pub mod host;
pub mod service;
pub mod settings;
