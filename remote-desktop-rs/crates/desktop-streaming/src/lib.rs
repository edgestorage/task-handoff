//! Independent optional desktop component. No instance core links this crate.
//! Private host IPC, session state and browser channels have separate models.
pub mod browser_host;
pub mod capture;
pub mod catalog;
pub mod channel;
pub mod clipboard;
pub mod codec;
pub mod contract;
mod dynamic_track;
pub mod error;
pub mod fallback_server;
pub mod framing;
pub mod host;
pub mod input_driver;
pub mod input_guard;
#[cfg(target_os = "linux")]
pub(crate) mod linux_desktop;
pub mod media;
pub mod pacing;
pub mod platform;
pub mod service;
pub mod session;
pub mod surface;
pub mod synthetic;
pub mod traits;
pub mod video;

pub mod annexb;

pub mod encoder;

pub mod preflight;
