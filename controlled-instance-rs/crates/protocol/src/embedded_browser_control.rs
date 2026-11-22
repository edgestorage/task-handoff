use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use thiserror::Error;

pub const EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION: &str = "2026-11-22";
pub const EMBEDDED_BROWSER_FRAME_HEADER_BYTES: usize = 9;
pub const EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES: usize = 256 * 1024;
pub const EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES: usize = 2 * 1024 * 1024;
pub const EMBEDDED_BROWSER_INITIAL_WINDOW_BYTES: u32 = 256 * 1024;
pub const EMBEDDED_BROWSER_MAX_IN_FLIGHT_REQUESTS: usize = 32;
pub const EMBEDDED_BROWSER_MAX_SIDE_EFFECT_QUEUE: usize = 16;
pub const EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS: u64 = 10_000;
pub const EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS: u64 = 60_000;
pub const EMBEDDED_BROWSER_CREATION_TTL_MS: u64 = 120_000;
pub const EMBEDDED_BROWSER_DEDUPE_WINDOW_MS: u64 = 120_000;
pub const EMBEDDED_BROWSER_MAX_DEDUPE_ENTRIES: usize = 1_024;
pub const EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK: usize = 100;
pub const EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE: usize = 256;
pub const EMBEDDED_BROWSER_MAX_SOURCES: usize = 32;
pub const EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const EMBEDDED_BROWSER_HTTP_RESULT_TOTAL_BYTES: usize = 64 * 1024 * 1024;
pub const EMBEDDED_BROWSER_RESULT_TTL_MS: u64 = 120_000;
pub const EMBEDDED_BROWSER_SCREENSHOT_MAX_DIMENSION: u32 = 4_096;
pub const EMBEDDED_BROWSER_CDP_PROFILE: &str = "electron-page-cdp";
pub const EMBEDDED_BROWSER_CDP_ACCESS_TTL_MS: u64 = 8 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum EmbeddedBrowserFrameType {
    Open = 1,
    OpenOk = 2,
    Data = 3,
    HalfClose = 4,
    Close = 5,
    Error = 6,
    WindowUpdate = 7,
}

impl TryFrom<u8> for EmbeddedBrowserFrameType {
    type Error = EmbeddedBrowserProtocolError;

    fn try_from(value: u8) -> Result<Self, EmbeddedBrowserProtocolError> {
        match value {
            1 => Ok(Self::Open),
            2 => Ok(Self::OpenOk),
            3 => Ok(Self::Data),
            4 => Ok(Self::HalfClose),
            5 => Ok(Self::Close),
            6 => Ok(Self::Error),
            7 => Ok(Self::WindowUpdate),
            _ => Err(EmbeddedBrowserProtocolError::protocol(
                "Embedded browser frame type is unknown.",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedBrowserFrame {
    pub frame_type: EmbeddedBrowserFrameType,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddedBrowserProtocolErrorCode {
    ProtocolError,
    StreamKindUnsupported,
}

impl EmbeddedBrowserProtocolErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProtocolError => "BROWSER_CHANNEL_PROTOCOL_ERROR",
            Self::StreamKindUnsupported => "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED",
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct EmbeddedBrowserProtocolError {
    pub code: EmbeddedBrowserProtocolErrorCode,
    pub message: String,
}

impl EmbeddedBrowserProtocolError {
    pub fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: EmbeddedBrowserProtocolErrorCode::ProtocolError,
            message: message.into(),
        }
    }

    pub fn stream_kind_unsupported() -> Self {
        Self {
            code: EmbeddedBrowserProtocolErrorCode::StreamKindUnsupported,
            message: "Embedded browser stream kind is unsupported.".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedBrowserStreamOpen {
    pub stream_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedBrowserStreamOpenOk {
    pub stream_kind: String,
    pub protocol_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserChannelError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserRpcErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserControlError {
    pub code: String,
    pub message: String,
    #[serde(default = "default_not_started_execution")]
    pub execution: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_message: Option<String>,
}

fn default_not_started_execution() -> String {
    "not-started".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum EmbeddedBrowserPageHost {
    RendererWebview,
    MainPagePool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserPageHostCapabilities {
    #[serde(default)]
    pub background_creation: bool,
    #[serde(default)]
    pub survive_host_window_close: bool,
    #[serde(default)]
    pub cross_window_adopt: bool,
}

impl EmbeddedBrowserPageHostCapabilities {
    pub fn for_page_host(page_host: EmbeddedBrowserPageHost) -> Self {
        match page_host {
            EmbeddedBrowserPageHost::RendererWebview => Self::default(),
            EmbeddedBrowserPageHost::MainPagePool => Self {
                background_creation: true,
                survive_host_window_close: true,
                cross_window_adopt: true,
            },
        }
    }

    pub fn validate_for(
        self,
        page_host: EmbeddedBrowserPageHost,
    ) -> Result<(), EmbeddedBrowserProtocolError> {
        if page_host == EmbeddedBrowserPageHost::RendererWebview
            && (self.background_creation
                || self.survive_host_window_close
                || self.cross_window_adopt)
        {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "renderer-webview cannot advertise background or cross-window capabilities.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserSource {
    pub source_ref: String,
    pub generation: u64,
    pub panel_id: String,
    pub display_name: String,
    pub page_host: EmbeddedBrowserPageHost,
    #[serde(default)]
    pub page_host_capabilities: EmbeddedBrowserPageHostCapabilities,
    pub revision: u64,
}

/// Desktop-main private registration input. Control-plane identity is supplied
/// by the authenticated proxy context, not accepted from this body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserSourceRegistrationRequest {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    pub publisher_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer_host_binding: Option<String>,
    pub page_host: EmbeddedBrowserPageHost,
    #[serde(default)]
    pub page_host_capabilities: EmbeddedBrowserPageHostCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserSourceRegistrationView {
    pub source: EmbeddedBrowserSource,
    pub registry_epoch: String,
    pub registry_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserPage {
    pub source_ref: String,
    pub generation: u64,
    pub tab_ref: String,
    pub instance_id: String,
    pub page_host: EmbeddedBrowserPageHost,
    #[serde(default)]
    pub page_host_capabilities: EmbeddedBrowserPageHostCapabilities,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_about_blank")]
    pub url: String,
    #[serde(default = "default_ready_state")]
    pub state: String,
    pub revision: u64,
}

fn default_about_blank() -> String {
    "about:blank".to_string()
}

fn default_ready_state() -> String {
    "ready".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddedBrowserCreationStatus {
    Pending,
    Claimed,
    Creating,
    Ready,
    Failed,
    Declined,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreation {
    pub creation_ref: String,
    pub status: EmbeddedBrowserCreationStatus,
    #[serde(default = "default_about_blank")]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_host: Option<EmbeddedBrowserPageHost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_host_capabilities: Option<EmbeddedBrowserPageHostCapabilities>,
    pub created_at: String,
    pub expires_at: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserLease {
    pub lease_ref: String,
    pub tab_ref: String,
    pub source_ref: String,
    pub generation: u64,
    pub expires_at: String,
}

// Browser control access belongs to the whole controlled instance. AI Session
// identity scopes short-lived CDP tokens and writer leases, not page visibility.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserAccessView {
    pub active: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCdpAccess {
    pub http_endpoint: String,
    pub token: String,
    pub expires_at: String,
    pub protocol_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserLeaseRefRequest {
    pub lease_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserPageListResponse {
    pub registry_epoch: String,
    pub registry_revision: u64,
    pub items: Vec<EmbeddedBrowserPage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserSourceSnapshot {
    pub source_ref: String,
    pub generation: u64,
    pub source_revision: u64,
    pub registry_epoch: String,
    pub snapshot_ref: String,
    pub chunk_index: u32,
    pub chunk_count: u32,
    pub complete: bool,
    pub pages: Vec<EmbeddedBrowserPage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserSourceSnapshotCommit {
    pub registry_epoch: String,
    pub registry_revision: u64,
    pub source_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserSourceDelta {
    pub source_ref: String,
    pub generation: u64,
    pub base_revision: u64,
    pub revision: u64,
    #[serde(default)]
    pub upserts: Vec<EmbeddedBrowserPage>,
    #[serde(default)]
    pub removes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserRegistryDelta {
    pub registry_epoch: String,
    pub base_revision: u64,
    pub revision: u64,
    #[serde(default)]
    pub upserts: Vec<EmbeddedBrowserPage>,
    #[serde(default)]
    pub removes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationRequest {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationClaim {
    pub source_ref: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationDecline {
    pub source_ref: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationCandidate {
    pub source_ref: String,
    pub panel_label: String,
    pub desktop_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    pub page_host: EmbeddedBrowserPageHost,
    pub state: String,
    pub can_create: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationView {
    pub creation_ref: String,
    pub requested_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub state: EmbeddedBrowserCreationStatus,
    pub expires_at: String,
    #[serde(default)]
    pub candidates: Vec<EmbeddedBrowserCreationCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_ref: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationApprovalView {
    pub request: EmbeddedBrowserCreationView,
    pub requester_session_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationApprovalListResponse {
    pub creation_revision: u64,
    pub items: Vec<EmbeddedBrowserCreationApprovalView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserControlHello {
    pub protocol_version: String,
    pub source_ref: String,
    pub generation: u64,
    pub page_host: EmbeddedBrowserPageHost,
    #[serde(default)]
    pub page_host_capabilities: EmbeddedBrowserPageHostCapabilities,
    pub registry_epoch: String,
    pub registry_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserControlReady {
    pub protocol_version: String,
    pub source_ref: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserControlSynced {
    pub source_ref: String,
    pub generation: u64,
    pub registry_epoch: String,
    pub registry_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTabsOpenParams {
    pub creation_ref: String,
    pub source_ref: String,
    pub generation: u64,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTabsCreatedParams {
    pub source_ref: String,
    pub generation: u64,
    pub tab_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_ref: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_about_blank")]
    pub url: String,
    #[serde(default = "default_ready_state")]
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTabsDestroyedParams {
    pub source_ref: String,
    pub generation: u64,
    pub tab_ref: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTabsCloseParams {
    pub source_ref: String,
    pub generation: u64,
    pub tab_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetAttachParams {
    pub lease_ref: String,
    pub tab_ref: String,
    pub source_ref: String,
    pub generation: u64,
    pub page_host: EmbeddedBrowserPageHost,
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetDetachParams {
    pub lease_ref: String,
    pub tab_ref: String,
    pub source_ref: String,
    pub generation: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCdpCommand {
    pub lease_ref: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_session_ref: Option<String>,
    pub request_id: String,
    #[serde(default = "default_request_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_request_timeout_ms() -> u64 {
    EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCdpEvent {
    pub generation: u64,
    pub lease_ref: String,
    pub tab_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_session_ref: Option<String>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserExternalResult {
    pub delivery: String,
    pub result_ref: String,
    pub media_type: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserChannelCapabilities {
    pub supported: bool,
    pub transports: Vec<String>,
    pub stream_kinds: Vec<String>,
    pub drivers: Vec<String>,
    pub page_hosts: Vec<EmbeddedBrowserPageHost>,
}

impl EmbeddedBrowserChannelCapabilities {
    pub fn unsupported() -> Self {
        Self {
            supported: false,
            transports: Vec::new(),
            stream_kinds: Vec::new(),
            drivers: Vec::new(),
            page_hosts: Vec::new(),
        }
    }

    pub fn supported() -> Self {
        Self {
            supported: true,
            transports: vec!["reverse-websocket".to_string()],
            stream_kinds: vec!["control".to_string()],
            drivers: vec!["electron-page-cdp".to_string()],
            page_hosts: vec![
                EmbeddedBrowserPageHost::RendererWebview,
                EmbeddedBrowserPageHost::MainPagePool,
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EmbeddedBrowserCdpMethodKind {
    Read,
    PageWrite,
    AdapterOnly,
}

pub fn embedded_browser_cdp_method_kind(method: &str) -> Option<EmbeddedBrowserCdpMethodKind> {
    let kind = match method {
        "Accessibility.enable"
        | "Accessibility.disable"
        | "Console.enable"
        | "Console.disable"
        | "DOMSnapshot.enable"
        | "DOMSnapshot.disable"
        | "Log.enable"
        | "Log.disable"
        | "Network.enable"
        | "Network.disable"
        | "Page.enable"
        | "Page.disable"
        | "Runtime.enable"
        | "Runtime.disable"
        | "Runtime.releaseObject" => EmbeddedBrowserCdpMethodKind::AdapterOnly,
        "Accessibility.getFullAXTree"
        | "Accessibility.getPartialAXTree"
        | "Accessibility.getRootAXNode"
        | "DOM.getDocument"
        | "DOM.describeNode"
        | "DOM.resolveNode"
        | "DOM.getBoxModel"
        | "DOM.getContentQuads"
        | "DOM.getNodeForLocation"
        | "DOM.querySelector"
        | "DOM.querySelectorAll"
        | "DOM.getAttributes"
        | "DOM.getOuterHTML"
        | "DOMSnapshot.captureSnapshot"
        | "Network.getResponseBody"
        | "Network.getRequestPostData"
        | "Page.getNavigationHistory"
        | "Page.getFrameTree"
        | "Page.getLayoutMetrics"
        | "Page.captureScreenshot"
        | "Runtime.getProperties"
        | "Schema.getDomains" => EmbeddedBrowserCdpMethodKind::Read,
        "Input.dispatchMouseEvent"
        | "Input.dispatchKeyEvent"
        | "Input.dispatchTouchEvent"
        | "Input.insertText"
        | "Page.navigate"
        | "Page.reload"
        | "Page.stopLoading"
        | "Runtime.evaluate"
        | "Runtime.callFunctionOn" => EmbeddedBrowserCdpMethodKind::PageWrite,
        _ => return None,
    };
    Some(kind)
}

pub fn assert_embedded_browser_cdp_method(
    method: &str,
    adapter_only: bool,
) -> Result<(), EmbeddedBrowserProtocolError> {
    match embedded_browser_cdp_method_kind(method) {
        Some(EmbeddedBrowserCdpMethodKind::AdapterOnly) if !adapter_only => Err(
            EmbeddedBrowserProtocolError::protocol("CDP method is adapter-only."),
        ),
        Some(_) => Ok(()),
        None => Err(EmbeddedBrowserProtocolError::protocol(
            "CDP method is outside the electron-page-cdp profile.",
        )),
    }
}

pub fn supports_embedded_browser_cdp_event(method: &str) -> bool {
    matches!(
        method,
        "Console.messageAdded"
            | "Log.entryAdded"
            | "Network.loadingFailed"
            | "Network.loadingFinished"
            | "Network.requestServedFromCache"
            | "Network.requestWillBeSent"
            | "Network.responseReceived"
            | "Page.domContentEventFired"
            | "Page.frameNavigated"
            | "Page.frameStartedLoading"
            | "Page.frameStoppedLoading"
            | "Page.javascriptDialogClosed"
            | "Page.javascriptDialogOpening"
            | "Page.lifecycleEvent"
            | "Page.loadEventFired"
            | "Runtime.consoleAPICalled"
            | "Runtime.exceptionThrown"
            | "Runtime.executionContextCreated"
            | "Runtime.executionContextDestroyed"
            | "Runtime.executionContextsCleared"
    )
}

pub fn encode_embedded_browser_frame(
    frame: EmbeddedBrowserFrame,
) -> Result<Vec<u8>, EmbeddedBrowserProtocolError> {
    validate_frame(&frame)?;
    let payload_len = u32::try_from(frame.payload.len()).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser frame payload exceeds the limit.")
    })?;
    let mut output = Vec::with_capacity(EMBEDDED_BROWSER_FRAME_HEADER_BYTES + frame.payload.len());
    output.push(frame.frame_type as u8);
    output.extend_from_slice(&frame.stream_id.to_be_bytes());
    output.extend_from_slice(&payload_len.to_be_bytes());
    output.extend_from_slice(&frame.payload);
    Ok(output)
}

pub fn decode_embedded_browser_frame(
    input: &[u8],
) -> Result<EmbeddedBrowserFrame, EmbeddedBrowserProtocolError> {
    if input.len() < EMBEDDED_BROWSER_FRAME_HEADER_BYTES {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser frame header is truncated.",
        ));
    }
    let frame_type = EmbeddedBrowserFrameType::try_from(input[0])?;
    let stream_id = u32::from_be_bytes([input[1], input[2], input[3], input[4]]);
    let payload_len = u32::from_be_bytes([input[5], input[6], input[7], input[8]]) as usize;
    if stream_id == 0 {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser stream id must be positive.",
        ));
    }
    if payload_len != input.len() - EMBEDDED_BROWSER_FRAME_HEADER_BYTES {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser frame length is invalid.",
        ));
    }
    let frame = EmbeddedBrowserFrame {
        frame_type,
        stream_id,
        payload: input[EMBEDDED_BROWSER_FRAME_HEADER_BYTES..].to_vec(),
    };
    validate_frame(&frame)?;
    Ok(frame)
}

fn validate_frame(frame: &EmbeddedBrowserFrame) -> Result<(), EmbeddedBrowserProtocolError> {
    if frame.stream_id == 0 {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser stream id must be positive.",
        ));
    }
    if frame.payload.len() > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser frame payload exceeds the limit.",
        ));
    }
    Ok(())
}

#[derive(Debug, Default)]
pub struct EmbeddedBrowserFrameDecoder {
    pending: Vec<u8>,
}

impl EmbeddedBrowserFrameDecoder {
    pub fn push(
        &mut self,
        chunk: &[u8],
    ) -> Result<Vec<EmbeddedBrowserFrame>, EmbeddedBrowserProtocolError> {
        if self.pending.len() + chunk.len()
            > EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES + EMBEDDED_BROWSER_FRAME_HEADER_BYTES
        {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "Embedded browser frame buffer exceeds the limit.",
            ));
        }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut offset = 0;
        while self.pending.len() - offset >= EMBEDDED_BROWSER_FRAME_HEADER_BYTES {
            let payload_len = u32::from_be_bytes([
                self.pending[offset + 5],
                self.pending[offset + 6],
                self.pending[offset + 7],
                self.pending[offset + 8],
            ]) as usize;
            if payload_len > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES {
                return Err(EmbeddedBrowserProtocolError::protocol(
                    "Embedded browser frame payload exceeds the limit.",
                ));
            }
            let frame_len = EMBEDDED_BROWSER_FRAME_HEADER_BYTES + payload_len;
            if self.pending.len() - offset < frame_len {
                break;
            }
            frames.push(decode_embedded_browser_frame(
                &self.pending[offset..offset + frame_len],
            )?);
            offset += frame_len;
        }
        if offset > 0 {
            self.pending.drain(..offset);
        }
        Ok(frames)
    }

    pub fn finish(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(EmbeddedBrowserProtocolError::protocol(
                "Embedded browser frame stream ended with a partial frame.",
            ))
        }
    }
}

pub fn encode_embedded_browser_stream_open() -> Result<Vec<u8>, EmbeddedBrowserProtocolError> {
    serde_json::to_vec(&EmbeddedBrowserStreamOpen {
        stream_kind: "control".to_string(),
    })
    .map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser OPEN payload is invalid.")
    })
}

pub fn decode_embedded_browser_stream_open(
    payload: &[u8],
) -> Result<EmbeddedBrowserStreamOpen, EmbeddedBrowserProtocolError> {
    let value: Value = serde_json::from_slice(payload).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser OPEN payload is invalid.")
    })?;
    let stream_kind = value.get("streamKind").and_then(Value::as_str);
    if stream_kind != Some("control") {
        return Err(EmbeddedBrowserProtocolError::stream_kind_unsupported());
    }
    serde_json::from_value(value).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser OPEN payload is invalid.")
    })
}

pub fn encode_embedded_browser_stream_open_ok() -> Result<Vec<u8>, EmbeddedBrowserProtocolError> {
    serde_json::to_vec(&EmbeddedBrowserStreamOpenOk {
        stream_kind: "control".to_string(),
        protocol_version: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION.to_string(),
    })
    .map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser OPEN_OK payload is invalid.")
    })
}

pub fn decode_embedded_browser_stream_open_ok(
    payload: &[u8],
) -> Result<EmbeddedBrowserStreamOpenOk, EmbeddedBrowserProtocolError> {
    let value: EmbeddedBrowserStreamOpenOk = serde_json::from_slice(payload).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser OPEN_OK payload is invalid.")
    })?;
    if value.stream_kind != "control"
        || value.protocol_version != EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION
    {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser OPEN_OK payload is invalid.",
        ));
    }
    Ok(value)
}

pub fn encode_embedded_browser_channel_error(
    value: &EmbeddedBrowserChannelError,
) -> Result<Vec<u8>, EmbeddedBrowserProtocolError> {
    serde_json::to_vec(value).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser channel error payload is invalid.")
    })
}

pub fn decode_embedded_browser_channel_error(
    payload: &[u8],
) -> Result<EmbeddedBrowserChannelError, EmbeddedBrowserProtocolError> {
    let value: EmbeddedBrowserChannelError = serde_json::from_slice(payload).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser channel error payload is invalid.")
    })?;
    if value.message.trim().is_empty() || value.message.chars().count() > 500 {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser channel error payload is invalid.",
        ));
    }
    Ok(value)
}

pub fn encode_embedded_browser_control_message(
    value: &Value,
) -> Result<Vec<u8>, EmbeddedBrowserProtocolError> {
    let json = serde_json::to_vec(value).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol("Embedded browser control message is invalid.")
    })?;
    if json.is_empty() || json.len() > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES {
        return Err(EmbeddedBrowserProtocolError::protocol(
            "Embedded browser control message exceeds the limit.",
        ));
    }
    let length = u32::try_from(json.len()).map_err(|_| {
        EmbeddedBrowserProtocolError::protocol(
            "Embedded browser control message exceeds the limit.",
        )
    })?;
    let mut output = Vec::with_capacity(4 + json.len());
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(&json);
    Ok(output)
}

#[derive(Debug, Default)]
pub struct EmbeddedBrowserControlMessageDecoder {
    pending: Vec<u8>,
}

impl EmbeddedBrowserControlMessageDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, EmbeddedBrowserProtocolError> {
        if self.pending.len() + chunk.len() > EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "Embedded browser control buffer exceeds the limit.",
            ));
        }
        self.pending.extend_from_slice(chunk);
        let mut values = Vec::new();
        let mut offset = 0;
        while self.pending.len() - offset >= 4 {
            let length = u32::from_be_bytes([
                self.pending[offset],
                self.pending[offset + 1],
                self.pending[offset + 2],
                self.pending[offset + 3],
            ]) as usize;
            if length == 0 || length > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES {
                return Err(EmbeddedBrowserProtocolError::protocol(
                    "Embedded browser control message length is invalid.",
                ));
            }
            if self.pending.len() - offset < 4 + length {
                break;
            }
            let value = serde_json::from_slice(&self.pending[offset + 4..offset + 4 + length])
                .map_err(|_| {
                    EmbeddedBrowserProtocolError::protocol(
                        "Embedded browser control message is not valid JSON.",
                    )
                })?;
            values.push(value);
            offset += 4 + length;
        }
        if offset > 0 {
            self.pending.drain(..offset);
        }
        Ok(values)
    }

    pub fn finish(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(EmbeddedBrowserProtocolError::protocol(
                "Embedded browser control stream ended with a partial message.",
            ))
        }
    }
}

pub fn normalize_embedded_browser_channel_capabilities(
    value: &Value,
) -> EmbeddedBrowserChannelCapabilities {
    let Some(record) = value.as_object() else {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    };
    if record.get("supported").and_then(Value::as_bool) != Some(true) {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    }
    let Some(transports) = normalized_strings(record.get("transports"), &["reverse-websocket"])
    else {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    };
    let Some(stream_kinds) = normalized_strings(record.get("streamKinds"), &["control"]) else {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    };
    let Some(drivers) = normalized_strings(record.get("drivers"), &["electron-page-cdp"]) else {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    };
    let Some(page_hosts) = normalized_page_hosts(record.get("pageHosts")) else {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    };
    if !transports.iter().any(|value| value == "reverse-websocket")
        || !stream_kinds.iter().any(|value| value == "control")
        || !drivers.iter().any(|value| value == "electron-page-cdp")
    {
        return EmbeddedBrowserChannelCapabilities::unsupported();
    }
    EmbeddedBrowserChannelCapabilities {
        supported: true,
        transports,
        stream_kinds,
        drivers,
        page_hosts,
    }
}

/// Additive capability parsing must not invalidate the surrounding instance
/// document. Missing, unsupported or malformed values disable only this domain.
pub fn deserialize_embedded_browser_channel<'de, D>(
    deserializer: D,
) -> Result<Option<EmbeddedBrowserChannelCapabilities>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    let normalized = normalize_embedded_browser_channel_capabilities(&value);
    Ok(normalized.supported.then_some(normalized))
}

fn normalized_strings(value: Option<&Value>, allowed: &[&str]) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let values = value.as_array()?;
    if values.iter().any(|entry| !entry.is_string()) {
        return None;
    }
    let mut seen = HashSet::new();
    Some(
        values
            .iter()
            .filter_map(Value::as_str)
            .filter(|entry| allowed.contains(entry))
            .filter(|entry| seen.insert((*entry).to_string()))
            .map(ToString::to_string)
            .collect(),
    )
}

fn normalized_page_hosts(value: Option<&Value>) -> Option<Vec<EmbeddedBrowserPageHost>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let values = value.as_array()?;
    if values.iter().any(|entry| !entry.is_string()) {
        return None;
    }
    let mut seen = HashSet::new();
    Some(
        values
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|entry| match entry {
                "renderer-webview" => Some(EmbeddedBrowserPageHost::RendererWebview),
                "main-page-pool" => Some(EmbeddedBrowserPageHost::MainPagePool),
                _ => None,
            })
            .filter(|entry| seen.insert(*entry))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/embedded-browser-control.json"
        ))
        .expect("the embedded browser fixture is valid JSON")
    }

    fn fixture_hex(value: &Value) -> Vec<u8> {
        let value = value.as_str().expect("fixture bytes are a hex string");
        assert_eq!(value.len() % 2, 0);
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
            .collect()
    }

    #[test]
    fn frame_vectors_match_the_shared_typescript_fixture() {
        let fixture = fixture();
        let open = fixture_hex(&fixture["frames"]["openControlStream"]);
        let frame = decode_embedded_browser_frame(&open).expect("open frame decodes");
        assert_eq!(frame.frame_type, EmbeddedBrowserFrameType::Open);
        assert_eq!(frame.stream_id, 1);
        assert_eq!(
            decode_embedded_browser_stream_open(&frame.payload)
                .expect("OPEN payload")
                .stream_kind,
            "control"
        );

        let data = decode_embedded_browser_frame(&fixture_hex(&fixture["frames"]["dataStream3"]))
            .expect("data frame decodes");
        assert_eq!(data.frame_type, EmbeddedBrowserFrameType::Data);
        assert_eq!(data.stream_id, 3);
        assert_eq!(data.payload, vec![0, 1, 255]);

        let mut decoder = EmbeddedBrowserFrameDecoder::default();
        let coalesced = fixture_hex(&fixture["frames"]["coalesced"]);
        assert!(decoder.push(&coalesced[..5]).unwrap().is_empty());
        let frames = decoder.push(&coalesced[5..]).unwrap();
        assert_eq!(frames.len(), 2);
        decoder.finish().unwrap();
    }

    #[test]
    fn stream_open_and_control_framing_use_the_shared_contract() {
        let fixture = fixture();
        assert_eq!(
            encode_embedded_browser_stream_open().unwrap(),
            fixture_hex(&fixture["frames"]["openControlStream"])
                [EMBEDDED_BROWSER_FRAME_HEADER_BYTES..]
        );
        assert!(decode_embedded_browser_stream_open(
            br#"{"streamKind":"tcp","host":"example.com","port":443}"#
        )
        .is_err());
        let error_frame = decode_embedded_browser_frame(&fixture_hex(
            &fixture["frames"]["errorUnsupportedStreamKind"],
        ))
        .expect("error frame decodes");
        let error = decode_embedded_browser_channel_error(&error_frame.payload)
            .expect("error payload decodes");
        assert_eq!(error.code, "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED");

        let mut decoder = EmbeddedBrowserControlMessageDecoder::default();
        let control_frame =
            decode_embedded_browser_frame(&fixture_hex(&fixture["frames"]["controlRequest"]))
                .expect("control frame decodes");
        let encoded = control_frame.payload;
        assert!(decoder.push(&encoded[..2]).unwrap().is_empty());
        let messages = decoder.push(&encoded[2..]).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["jsonrpc"], "2.0");
        assert_eq!(messages[0]["method"], "tabs.list");
    }

    #[test]
    fn public_dtos_ignore_private_fields_and_validate_page_host_capabilities() {
        let fixture = fixture();
        let page: EmbeddedBrowserPage = serde_json::from_value(fixture["messages"]["page"].clone())
            .expect("page fixture parses");
        assert_eq!(page.page_host, EmbeddedBrowserPageHost::MainPagePool);
        let serialized = serde_json::to_value(page).unwrap();
        assert!(serialized.get("sessionKey").is_none());
        assert!(serialized.get("webContentsId").is_none());
        assert!(serialized.get("partition").is_none());

        let source: EmbeddedBrowserSource =
            serde_json::from_value(fixture["messages"]["source"].clone()).unwrap();
        assert_eq!(source.page_host, EmbeddedBrowserPageHost::RendererWebview);

        let invalid = json!({
            "sourceRef": "source_1",
            "generation": 1,
            "panelId": "control_plane_1",
            "displayName": "Desktop A",
            "pageHost": "renderer-webview",
            "pageHostCapabilities": { "backgroundCreation": true },
            "revision": 1
        });
        let source: EmbeddedBrowserSource = serde_json::from_value(invalid).unwrap();
        assert!(source
            .page_host_capabilities
            .validate_for(source.page_host)
            .is_err());
    }

    #[test]
    fn snapshot_delta_and_creation_contracts_match_the_shared_fixture() {
        let fixture = fixture();
        let snapshot: EmbeddedBrowserSourceSnapshot =
            serde_json::from_value(fixture["messages"]["snapshot"].clone()).unwrap();
        assert_eq!(snapshot.pages.len(), 1);
        let delta: EmbeddedBrowserSourceDelta =
            serde_json::from_value(fixture["messages"]["delta"].clone()).unwrap();
        assert_eq!(delta.revision, delta.base_revision + 1);
        let creation: EmbeddedBrowserCreationView =
            serde_json::from_value(fixture["messages"]["creationView"].clone()).unwrap();
        assert_eq!(creation.state, EmbeddedBrowserCreationStatus::Pending);
        assert_eq!(
            creation.candidates[0].page_host,
            EmbeddedBrowserPageHost::RendererWebview
        );
        let access: EmbeddedBrowserAccessView =
            serde_json::from_value(fixture["messages"]["access"].clone()).unwrap();
        assert!(access.active);
        let cdp_access: EmbeddedBrowserCdpAccess =
            serde_json::from_value(fixture["messages"]["cdpAccess"].clone()).unwrap();
        assert_eq!(
            cdp_access.protocol_version,
            EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION
        );
        assert!(cdp_access.http_endpoint.starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn cdp_profile_matches_the_typescript_allowlist() {
        let fixture = fixture();
        let methods = fixture["cdp"]["methods"].as_object().unwrap();
        for (method, kind) in methods {
            let kind = kind.as_str().unwrap();
            let expected = match kind {
                "read" => EmbeddedBrowserCdpMethodKind::Read,
                "page-write" => EmbeddedBrowserCdpMethodKind::PageWrite,
                "adapter-only" => EmbeddedBrowserCdpMethodKind::AdapterOnly,
                other => panic!("unexpected method kind {other}"),
            };
            assert_eq!(embedded_browser_cdp_method_kind(method), Some(expected));
        }
        for event in fixture["cdp"]["events"].as_array().unwrap() {
            assert!(supports_embedded_browser_cdp_event(event.as_str().unwrap()));
        }
        assert!(assert_embedded_browser_cdp_method("Network.enable", false).is_err());
        assert!(assert_embedded_browser_cdp_method("Network.enable", true).is_ok());
        assert!(assert_embedded_browser_cdp_method("Target.attachToTarget", true).is_err());
    }

    #[test]
    fn capability_normalization_ignores_unknown_extensions_without_losing_known_hosts() {
        let fixture = fixture();
        let normalized = normalize_embedded_browser_channel_capabilities(
            &fixture["capabilities"]["withUnknownExtensions"],
        );
        assert!(normalized.supported);
        assert_eq!(normalized.transports, vec!["reverse-websocket"]);
        assert_eq!(normalized.stream_kinds, vec!["control"]);
        assert_eq!(normalized.drivers, vec!["electron-page-cdp"]);
        assert_eq!(
            normalized.page_hosts,
            vec![
                EmbeddedBrowserPageHost::RendererWebview,
                EmbeddedBrowserPageHost::MainPagePool
            ]
        );
        let unsupported = normalize_embedded_browser_channel_capabilities(&json!({
            "supported": true,
            "transports": ["future"],
            "streamKinds": ["control"],
            "drivers": ["electron-page-cdp"]
        }));
        assert!(!unsupported.supported);
    }
}
