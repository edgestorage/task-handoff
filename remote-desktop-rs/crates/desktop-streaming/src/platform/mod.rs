#[cfg(target_os = "windows")]
pub mod apple_windows;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod native_catalog;
#[cfg(target_os = "windows")]
pub mod windows_access;
#[cfg(target_os = "windows")]
pub mod windows_job;
#[cfg(target_os = "windows")]
pub use apple_windows as native_capture;
#[cfg(target_os = "macos")]
pub use macos as native_capture;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod display;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod display_geometry;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod frame_mailbox;

#[cfg(target_os = "macos")]
pub(crate) mod macos_mouse;

#[cfg(target_os = "macos")]
pub mod macos_encoder;

#[cfg(target_os = "macos")]
pub mod macos_window;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod window;

#[cfg(target_os = "linux")]
pub mod linux_encoder;
#[cfg(all(target_os = "linux", feature = "vaapi"))]
pub mod linux_vaapi;
