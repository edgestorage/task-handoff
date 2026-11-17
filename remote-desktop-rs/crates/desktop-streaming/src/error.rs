//! Stable backend failures cross the private IPC boundary as codes. Native
//! library messages stay inside their adapter and must not become API text.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize,
)]
pub enum BackendError {
    #[error("REMOTE_DESKTOP_WINDOW_FOCUS_REQUIRED")]
    WindowFocusRequired,
    #[error("REMOTE_DESKTOP_POINTER_TARGET_MISMATCH")]
    PointerTargetMismatch,
    #[error("REMOTE_DESKTOP_WINDOW_IDENTITY_AMBIGUOUS")]
    WindowIdentityAmbiguous,
    #[error("REMOTE_DESKTOP_PROCESS_OWNERSHIP_UNAVAILABLE")]
    ProcessOwnershipUnavailable,
    #[error("REMOTE_DESKTOP_INPUT_PERMISSION_REQUIRED")]
    InputPermissionRequired,
    #[error("REMOTE_DESKTOP_INPUT_GUARD_FAILED")]
    InputGuardFailed,
    #[error("REMOTE_DESKTOP_INPUT_LEASE_EXPIRED")]
    InputLeaseExpired,
    #[error("REMOTE_DESKTOP_WAYLAND_UNSUPPORTED")]
    WaylandUnsupported,
    #[error("REMOTE_DESKTOP_WSL_UNSUPPORTED")]
    WslUnsupported,
    #[error("REMOTE_DESKTOP_PLATFORM_UNSUPPORTED")]
    PlatformUnsupported,
    #[error("REMOTE_DESKTOP_VIRTUAL_PLATFORM_UNSUPPORTED")]
    VirtualUnsupported,
    #[error("REMOTE_DESKTOP_NO_INTERACTIVE_SESSION")]
    NoInteractiveSession,
    #[error("REMOTE_DESKTOP_DESKTOP_UNAVAILABLE")]
    DesktopUnavailable,
    #[error("REMOTE_DESKTOP_DPI_UNAVAILABLE")]
    DpiUnavailable,
    #[error("REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED")]
    ScreenPermissionRequired,
    #[error("REMOTE_DESKTOP_CAPTURE_UNAVAILABLE")]
    CaptureUnavailable,
    #[error("REMOTE_DESKTOP_CAPTURE_FAILED")]
    CaptureFailed,
    #[error("REMOTE_DESKTOP_CAPTURE_STOP_FAILED")]
    CaptureStopFailed,
    #[error("REMOTE_DESKTOP_CAPTURE_FORMAT_UNSUPPORTED")]
    CaptureFormatUnsupported,
    #[error("REMOTE_DESKTOP_X11_FORMAT_UNSUPPORTED")]
    X11FormatUnsupported,
    #[error("REMOTE_DESKTOP_INVALID_DISPLAY")]
    InvalidDisplay,
    #[error("REMOTE_DESKTOP_INVALID_GEOMETRY")]
    InvalidGeometry,
    #[error("REMOTE_DESKTOP_GEOMETRY_CHANGED")]
    GeometryChanged,
    #[error("REMOTE_DESKTOP_WINDOW_UNAVAILABLE")]
    WindowUnavailable,
    #[error("REMOTE_DESKTOP_WINDOW_CAPTURE_UNSUPPORTED")]
    WindowUnsupported,
    #[error("REMOTE_DESKTOP_WINDOW_RESIZE_UNSUPPORTED")]
    WindowResizeUnsupported,
    #[error("REMOTE_DESKTOP_WINDOW_RESIZE_DENIED")]
    WindowResizeDenied,
    #[error("REMOTE_DESKTOP_WINDOW_RESIZE_FAILED")]
    WindowResizeFailed,
}
impl BackendError {
    pub fn from_error(error: &anyhow::Error) -> Self {
        error
            .downcast_ref::<Self>()
            .copied()
            .unwrap_or(Self::CaptureUnavailable)
    }
    /// Input validity can change while the application remains the selected
    /// capture source. These failures release the current lease and wait for a
    /// new resume instead of terminating the guard or the viewer session.
    pub fn is_recoverable_input_suspension(self) -> bool {
        matches!(
            self,
            Self::WindowFocusRequired | Self::PointerTargetMismatch | Self::GeometryChanged
        )
    }
}
