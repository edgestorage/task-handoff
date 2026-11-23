use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use thiserror::Error;

/// Control protocol version negotiated in control.hello/ready. It may grow
/// optional fields, so peers must gate features by this version.
pub const EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION: &str = "2026-11-23";
/// Wire framing version carried by OPEN_OK. It is frozen because older
/// desktops decode OPEN_OK with a literal schema before control.hello.
pub const EMBEDDED_BROWSER_CHANNEL_FRAMING_PROTOCOL_VERSION: &str = "2026-11-22";
pub const EMBEDDED_BROWSER_TAB_ORIGIN_MIN_PROTOCOL_VERSION: &str = "2026-11-23";

pub fn supports_embedded_browser_tab_origin(protocol_version: &str) -> bool {
    protocol_version.len() == 10
        && protocol_version.as_bytes().get(4) == Some(&b'-')
        && protocol_version.as_bytes().get(7) == Some(&b'-')
        && protocol_version >= EMBEDDED_BROWSER_TAB_ORIGIN_MIN_PROTOCOL_VERSION
}
/// Browser-level Target CDP sub-protocol; independent from channel framing and
/// from the electron-page-cdp page profile.
pub const EMBEDDED_BROWSER_TARGET_CDP_PROFILE: &str = "embedded-browser-target-cdp";
pub const EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION: &str = "1.3";
pub const EMBEDDED_BROWSER_FRAME_HEADER_BYTES: usize = 9;
/// Maximum payload carried by one binary frame. Logical control messages may be
/// larger and are split into these frames.
pub const EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES: usize = 256 * 1024;
pub const EMBEDDED_BROWSER_CONTROL_MESSAGE_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
pub const EMBEDDED_BROWSER_INITIAL_WINDOW_BYTES: u32 = 256 * 1024;
pub const EMBEDDED_BROWSER_MAX_IN_FLIGHT_REQUESTS: usize = 32;
pub const EMBEDDED_BROWSER_MAX_SIDE_EFFECT_QUEUE: usize = 16;
pub const EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS: u64 = 10_000;
pub const EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS: u64 = 60_000;
pub const EMBEDDED_BROWSER_CREATION_TTL_MS: u64 = 120_000;
pub const EMBEDDED_BROWSER_ACCESS_REQUEST_TTL_MS: u64 = 300_000;
pub const EMBEDDED_BROWSER_ACCESS_WAIT_MS: u64 = 10_000;
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

pub const EMBEDDED_BROWSER_TARGET_CDP_METHODS: &[&str] = &[
    "Browser.getVersion",
    "Browser.setDownloadBehavior",
    "Browser.cancelDownload",
    "Storage.getCookies",
    "Storage.setCookies",
    "Storage.clearCookies",
    "Target.getTargets",
    "Target.getTargetInfo",
    "Target.getBrowserContexts",
    "Target.attachToBrowserTarget",
    "Target.attachToTarget",
    "Target.detachFromTarget",
    "Target.closeTarget",
    "Target.createTarget",
    "Target.setDiscoverTargets",
    "Target.setAutoAttach",
    "Schema.getDomains",
];

pub const EMBEDDED_BROWSER_TARGET_CDP_EVENTS: &[&str] = &[
    "Target.attachedToTarget",
    "Target.targetCreated",
    "Target.targetDestroyed",
    "Target.targetInfoChanged",
    "Target.detachedFromTarget",
];

pub const EMBEDDED_BROWSER_DOWNLOAD_CDP_EVENTS: &[&str] =
    &["Browser.downloadWillBegin", "Browser.downloadProgress"];

pub fn supports_embedded_browser_target_cdp_method(method: &str) -> bool {
    EMBEDDED_BROWSER_TARGET_CDP_METHODS.contains(&method)
}

pub fn assert_embedded_browser_target_cdp_method(
    method: &str,
) -> Result<(), EmbeddedBrowserProtocolError> {
    if supports_embedded_browser_target_cdp_method(method) {
        Ok(())
    } else {
        Err(EmbeddedBrowserProtocolError::protocol(
            "CDP method is outside the browser-level Target profile.",
        ))
    }
}

pub fn supports_embedded_browser_target_cdp_event(method: &str) -> bool {
    EMBEDDED_BROWSER_TARGET_CDP_EVENTS.contains(&method)
}

pub fn supports_embedded_browser_target_cdp(
    capabilities: &EmbeddedBrowserChannelCapabilities,
) -> bool {
    capabilities.supported && capabilities.target_cdp
}

/// Stable browser-control error strings. `EmbeddedBrowserControlError.code`
/// remains a string on the wire so additive codes stay readable by old clients.
pub mod embedded_browser_error_code {
    pub const CREATION_NO_CANDIDATE: &str = "BROWSER_CREATION_NO_CANDIDATE";
    pub const CREATION_CONTEXT_REQUIRED: &str = "BROWSER_CREATION_CONTEXT_REQUIRED";
    pub const CREATION_CONTEXT_UNAVAILABLE: &str = "BROWSER_CREATION_CONTEXT_UNAVAILABLE";
    pub const CREATION_CONTEXT_NOT_SELECTED: &str = "BROWSER_CREATION_CONTEXT_NOT_SELECTED";
    pub const CREATION_CONTEXT_NOT_OWNED: &str = "BROWSER_CREATION_CONTEXT_NOT_OWNED";
    pub const CREATION_CONTEXT_FORBIDDEN: &str = "BROWSER_CREATION_CONTEXT_FORBIDDEN";
    pub const DEFAULT_CONTEXT_CONFLICT: &str = "BROWSER_DEFAULT_CONTEXT_CONFLICT";
}

pub type EmbeddedBrowserCdpBrowserContextId = String;
pub type EmbeddedBrowserCdpTargetId = String;
pub type EmbeddedBrowserCdpSessionId = String;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_browser_context_id: Option<String>,
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
pub struct EmbeddedBrowserCdpIdentity {
    pub chrome_version: String,
    pub user_agent: String,
    pub v8_version: String,
    pub webkit_version: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_identity: Option<EmbeddedBrowserCdpIdentity>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetInfo {
    pub target_id: EmbeddedBrowserCdpTargetId,
    #[serde(rename = "type")]
    pub target_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_about_blank")]
    pub url: String,
    #[serde(default)]
    pub attached: bool,
    pub browser_context_id: EmbeddedBrowserCdpBrowserContextId,
}

impl EmbeddedBrowserTargetInfo {
    pub fn from_page(page: &EmbeddedBrowserPage, attached: bool) -> Self {
        Self {
            target_id: page.tab_ref.clone(),
            target_type: "page".to_string(),
            title: page.title.clone(),
            url: page.url.clone(),
            attached,
            browser_context_id: page.source_ref.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserBrowserTargetInfo {
    pub target_id: EmbeddedBrowserCdpTargetId,
    #[serde(rename = "type")]
    pub target_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_true")]
    pub attached: bool,
}

impl EmbeddedBrowserBrowserTargetInfo {
    pub fn from_browser_ref(browser_ref: &str) -> Self {
        Self {
            target_id: browser_ref.to_string(),
            target_type: "browser".to_string(),
            title: String::new(),
            url: String::new(),
            attached: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum EmbeddedBrowserCdpTargetInfo {
    Page(EmbeddedBrowserTargetInfo),
    Browser(EmbeddedBrowserBrowserTargetInfo),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetGetTargetsParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetGetTargetsResult {
    pub target_infos: Vec<EmbeddedBrowserTargetInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetGetTargetInfoParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<EmbeddedBrowserCdpTargetId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetGetTargetInfoResult {
    pub target_info: EmbeddedBrowserCdpTargetInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserBrowserSetDownloadBehaviorParams {
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<EmbeddedBrowserCdpBrowserContextId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserBrowserCancelDownloadParams {
    pub guid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<EmbeddedBrowserCdpBrowserContextId>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserBrowserSetDownloadBehaviorResult {}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetGetBrowserContextsParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetGetBrowserContextsResult {
    pub browser_context_ids: Vec<EmbeddedBrowserCdpBrowserContextId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_browser_context_id: Option<EmbeddedBrowserCdpBrowserContextId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetAttachToTargetParams {
    pub target_id: EmbeddedBrowserCdpTargetId,
    pub flatten: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetAttachToTargetResult {
    pub session_id: EmbeddedBrowserCdpSessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetDetachFromTargetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<EmbeddedBrowserCdpSessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<EmbeddedBrowserCdpTargetId>,
}

impl EmbeddedBrowserTargetDetachFromTargetParams {
    pub fn validate(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if self.session_id.is_none() && self.target_id.is_none() {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "Target.detachFromTarget requires sessionId or targetId.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetDetachFromTargetResult {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetCloseTargetParams {
    pub target_id: EmbeddedBrowserCdpTargetId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetCloseTargetResult {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetCreateTargetParams {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<EmbeddedBrowserCdpBrowserContextId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetCreateTargetResult {
    pub target_id: EmbeddedBrowserCdpTargetId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetSetDiscoverTargetsParams {
    pub discover: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetSetDiscoverTargetsResult {}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetFilter {
    #[serde(rename = "type")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetSetAutoAttachParams {
    pub auto_attach: bool,
    #[serde(default)]
    pub wait_for_debugger_on_start: bool,
    #[serde(default = "default_true")]
    pub flatten: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Vec<EmbeddedBrowserTargetFilter>>,
}

impl EmbeddedBrowserTargetSetAutoAttachParams {
    pub fn validate(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if self.auto_attach && !self.flatten {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "Target.setAutoAttach only supports flatten=true.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetSetAutoAttachResult {}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetCreatedParams {
    pub target_info: EmbeddedBrowserTargetInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetAttachedToTargetParams {
    pub session_id: EmbeddedBrowserCdpSessionId,
    pub target_info: EmbeddedBrowserTargetInfo,
    #[serde(default)]
    pub waiting_for_debugger: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetInfoChangedParams {
    pub target_info: EmbeddedBrowserTargetInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetDestroyedParams {
    pub target_id: EmbeddedBrowserCdpTargetId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserTargetDetachedFromTargetParams {
    pub session_id: EmbeddedBrowserCdpSessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<EmbeddedBrowserCdpTargetId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "method", content = "params")]
pub enum EmbeddedBrowserTargetCdpEvent {
    #[serde(rename = "Target.attachedToTarget")]
    AttachedToTarget(EmbeddedBrowserTargetAttachedToTargetParams),
    #[serde(rename = "Target.targetCreated")]
    TargetCreated(EmbeddedBrowserTargetCreatedParams),
    #[serde(rename = "Target.targetInfoChanged")]
    TargetInfoChanged(EmbeddedBrowserTargetInfoChangedParams),
    #[serde(rename = "Target.targetDestroyed")]
    TargetDestroyed(EmbeddedBrowserTargetDestroyedParams),
    #[serde(rename = "Target.detachedFromTarget")]
    DetachedFromTarget(EmbeddedBrowserTargetDetachedFromTargetParams),
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
pub struct EmbeddedBrowserAccessRequestView {
    pub request_ref: String,
    pub requester_session_ref: String,
    pub revision: u64,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserAccessView {
    pub active: bool,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_request: Option<EmbeddedBrowserAccessRequestView>,
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
pub struct EmbeddedBrowserBrowserContext {
    pub source_ref: String,
    pub browser_context_id: EmbeddedBrowserCdpBrowserContextId,
}

impl EmbeddedBrowserBrowserContext {
    pub fn validate(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if self.source_ref != self.browser_context_id {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "browserContextId must equal sourceRef.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationPanel {
    pub source_ref: String,
    pub panel_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    pub page_host: EmbeddedBrowserPageHost,
    pub can_create: bool,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub can_claim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationPending {
    pub creation_ref: String,
    pub url: String,
    #[serde(default = "default_pending_creation_state")]
    pub state: String,
    pub expires_at: String,
}

fn default_pending_creation_state() -> String {
    "pending".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationContextSnapshot {
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_context: Option<EmbeddedBrowserBrowserContext>,
    #[serde(default)]
    pub panels: Vec<EmbeddedBrowserCreationPanel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_creation: Option<EmbeddedBrowserCreationPending>,
}

impl EmbeddedBrowserCreationContextSnapshot {
    pub fn validate(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if let Some(context) = &self.default_context {
            context.validate()?;
        }
        let defaults: Vec<_> = self
            .panels
            .iter()
            .filter(|panel| panel.is_default)
            .collect();
        if defaults.len() > 1 {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "At most one panel can be the default creation context.",
            ));
        }
        if let (Some(context), Some(panel)) = (&self.default_context, defaults.first()) {
            if panel.source_ref != context.source_ref {
                return Err(EmbeddedBrowserProtocolError::protocol(
                    "The default panel must match defaultContext.",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedBrowserDefaultContextClaimRequest {
    pub source_ref: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserDefaultContextClaimResult {
    pub source_ref: String,
    pub browser_context_id: EmbeddedBrowserCdpBrowserContextId,
    pub revision: u64,
}

impl EmbeddedBrowserDefaultContextClaimResult {
    pub fn validate(&self) -> Result<(), EmbeddedBrowserProtocolError> {
        if self.source_ref != self.browser_context_id {
            return Err(EmbeddedBrowserProtocolError::protocol(
                "browserContextId must equal sourceRef.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCreationContextChangedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_browser_context_id: Option<EmbeddedBrowserCdpBrowserContextId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_browser_context_id: Option<EmbeddedBrowserCdpBrowserContextId>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_session_ref: Option<String>,
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
pub struct EmbeddedBrowserDownloadsConfigureParams {
    pub source_ref: String,
    pub generation: u64,
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserDownloadsCancelParams {
    pub source_ref: String,
    pub generation: u64,
    pub guid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserDownloadEvent {
    pub source_ref: String,
    pub generation: u64,
    pub tab_ref: String,
    pub method: String,
    pub params: Value,
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
    #[serde(default)]
    pub target_cdp: bool,
}

impl EmbeddedBrowserChannelCapabilities {
    pub fn unsupported() -> Self {
        Self {
            supported: false,
            transports: Vec::new(),
            stream_kinds: Vec::new(),
            drivers: Vec::new(),
            page_hosts: Vec::new(),
            target_cdp: false,
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
            // Protocol exposes the optional flag; the actual instance advertises
            // it only after the browser-level bridge is implemented.
            target_cdp: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EmbeddedBrowserCdpMethodKind {
    Read,
    PageWrite,
    Session,
}

pub const EMBEDDED_BROWSER_CDP_METHODS: &[(&str, EmbeddedBrowserCdpMethodKind)] = &[
    (
        "Accessibility.enable",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Accessibility.disable",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Accessibility.getFullAXTree",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    (
        "Accessibility.getPartialAXTree",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    (
        "Accessibility.getRootAXNode",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    ("Console.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Console.disable", EmbeddedBrowserCdpMethodKind::Session),
    ("DOM.getDocument", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.describeNode", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.resolveNode", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.getBoxModel", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.getContentQuads", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.getNodeForLocation", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.querySelector", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.querySelectorAll", EmbeddedBrowserCdpMethodKind::Read),
    (
        "DOM.scrollIntoViewIfNeeded",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("DOM.getAttributes", EmbeddedBrowserCdpMethodKind::Read),
    ("DOM.getOuterHTML", EmbeddedBrowserCdpMethodKind::Read),
    ("DOMSnapshot.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("DOMSnapshot.disable", EmbeddedBrowserCdpMethodKind::Session),
    (
        "DOMSnapshot.captureSnapshot",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    ("Inspector.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Inspector.disable", EmbeddedBrowserCdpMethodKind::Session),
    (
        "Input.dispatchMouseEvent",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    (
        "Input.dispatchKeyEvent",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    (
        "Input.dispatchTouchEvent",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("Input.insertText", EmbeddedBrowserCdpMethodKind::PageWrite),
    ("Log.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Log.disable", EmbeddedBrowserCdpMethodKind::Session),
    ("Network.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Network.disable", EmbeddedBrowserCdpMethodKind::Session),
    (
        "Network.clearBrowserCache",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Network.emulateNetworkConditions",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Network.getResponseBody",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    (
        "Network.getRequestPostData",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    (
        "Network.setCacheDisabled",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Network.setExtraHTTPHeaders",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    ("Network.getCookies", EmbeddedBrowserCdpMethodKind::Read),
    ("Network.setCookie", EmbeddedBrowserCdpMethodKind::Session),
    (
        "Network.clearBrowserCookies",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    ("Fetch.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Fetch.disable", EmbeddedBrowserCdpMethodKind::Session),
    (
        "Fetch.continueRequest",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    (
        "Fetch.continueResponse",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    (
        "Fetch.continueWithAuth",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("Fetch.failRequest", EmbeddedBrowserCdpMethodKind::PageWrite),
    (
        "Fetch.fulfillRequest",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("Page.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Page.disable", EmbeddedBrowserCdpMethodKind::Session),
    (
        "Page.getNavigationHistory",
        EmbeddedBrowserCdpMethodKind::Read,
    ),
    ("Page.getFrameTree", EmbeddedBrowserCdpMethodKind::Read),
    ("Page.getLayoutMetrics", EmbeddedBrowserCdpMethodKind::Read),
    ("Page.bringToFront", EmbeddedBrowserCdpMethodKind::PageWrite),
    (
        "Page.handleJavaScriptDialog",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("Page.navigate", EmbeddedBrowserCdpMethodKind::PageWrite),
    (
        "Page.navigateToHistoryEntry",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("Page.reload", EmbeddedBrowserCdpMethodKind::PageWrite),
    ("Page.stopLoading", EmbeddedBrowserCdpMethodKind::PageWrite),
    ("Page.captureScreenshot", EmbeddedBrowserCdpMethodKind::Read),
    (
        "Page.setInterceptFileChooserDialog",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    (
        "Page.setLifecycleEventsEnabled",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Page.addScriptToEvaluateOnNewDocument",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    (
        "Page.removeScriptToEvaluateOnNewDocument",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Page.createIsolatedWorld",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    ("Runtime.addBinding", EmbeddedBrowserCdpMethodKind::Session),
    (
        "Runtime.removeBinding",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    ("Runtime.enable", EmbeddedBrowserCdpMethodKind::Session),
    ("Runtime.disable", EmbeddedBrowserCdpMethodKind::Session),
    ("Runtime.evaluate", EmbeddedBrowserCdpMethodKind::PageWrite),
    (
        "Runtime.callFunctionOn",
        EmbeddedBrowserCdpMethodKind::PageWrite,
    ),
    ("Runtime.getProperties", EmbeddedBrowserCdpMethodKind::Read),
    (
        "Runtime.releaseObject",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    (
        "Runtime.runIfWaitingForDebugger",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
    ("Schema.getDomains", EmbeddedBrowserCdpMethodKind::Read),
    (
        "Target.setAutoAttach",
        EmbeddedBrowserCdpMethodKind::Session,
    ),
];

pub fn embedded_browser_cdp_method_kind(method: &str) -> Option<EmbeddedBrowserCdpMethodKind> {
    if method.starts_with("Emulation.") {
        return Some(EmbeddedBrowserCdpMethodKind::PageWrite);
    }
    EMBEDDED_BROWSER_CDP_METHODS
        .iter()
        .find_map(|(name, kind)| (*name == method).then_some(*kind))
}

pub fn assert_embedded_browser_cdp_method(
    method: &str,
) -> Result<(), EmbeddedBrowserProtocolError> {
    embedded_browser_cdp_method_kind(method)
        .map(|_| ())
        .ok_or_else(|| {
            EmbeddedBrowserProtocolError::protocol(
                "CDP method is outside the electron-page-cdp profile.",
            )
        })
}

pub const EMBEDDED_BROWSER_CDP_EVENTS: &[&str] = &[
    "Console.messageAdded",
    "Fetch.authRequired",
    "Fetch.requestPaused",
    "Inspector.detached",
    "Inspector.targetCrashed",
    "Log.entryAdded",
    "Network.loadingFailed",
    "Network.loadingFinished",
    "Network.requestServedFromCache",
    "Network.requestWillBeSentExtraInfo",
    "Network.responseReceivedExtraInfo",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Page.domContentEventFired",
    "Page.fileChooserOpened",
    "Page.frameAttached",
    "Page.frameDetached",
    "Page.frameNavigated",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
    "Page.javascriptDialogClosed",
    "Page.javascriptDialogOpening",
    "Page.lifecycleEvent",
    "Page.loadEventFired",
    "Page.navigatedWithinDocument",
    "Runtime.consoleAPICalled",
    "Runtime.bindingCalled",
    "Runtime.exceptionThrown",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
];

pub fn supports_embedded_browser_cdp_event(method: &str) -> bool {
    EMBEDDED_BROWSER_CDP_EVENTS.contains(&method)
}

const EMBEDDED_BROWSER_EMULATION_PROTOCOL_COMMANDS: &[&str] = &[
    "clearDeviceMetricsOverride",
    "setDeviceMetricsOverride",
    "setEmulatedMedia",
    "setEmulatedVisionDeficiency",
    "setFocusEmulationEnabled",
    "setScriptExecutionDisabled",
    "setTouchEmulationEnabled",
    "setUserAgentOverride",
];

pub fn embedded_browser_cdp_protocol_document() -> Value {
    fn add(target: &mut BTreeMap<String, BTreeSet<String>>, method: &str) {
        let Some((domain, name)) = method.split_once('.') else {
            return;
        };
        if domain.is_empty() || name.is_empty() {
            return;
        }
        target
            .entry(domain.to_string())
            .or_default()
            .insert(name.to_string());
    }

    let mut commands = BTreeMap::<String, BTreeSet<String>>::new();
    let mut events = BTreeMap::<String, BTreeSet<String>>::new();
    for (method, _) in EMBEDDED_BROWSER_CDP_METHODS {
        add(&mut commands, method);
    }
    for command in EMBEDDED_BROWSER_EMULATION_PROTOCOL_COMMANDS {
        add(&mut commands, &format!("Emulation.{command}"));
    }
    for method in EMBEDDED_BROWSER_TARGET_CDP_METHODS {
        add(&mut commands, method);
    }
    for method in EMBEDDED_BROWSER_CDP_EVENTS {
        add(&mut events, method);
    }
    for method in EMBEDDED_BROWSER_TARGET_CDP_EVENTS {
        add(&mut events, method);
    }
    for method in EMBEDDED_BROWSER_DOWNLOAD_CDP_EVENTS {
        add(&mut events, method);
    }
    let domains = commands
        .keys()
        .chain(events.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|domain| {
            let mut entry = serde_json::Map::new();
            entry.insert("domain".to_string(), json!(domain));
            if let Some(names) = commands.get(&domain) {
                entry.insert(
                    "commands".to_string(),
                    json!(names
                        .iter()
                        .map(|name| json!({ "name": name }))
                        .collect::<Vec<_>>()),
                );
            }
            if let Some(names) = events.get(&domain) {
                entry.insert(
                    "events".to_string(),
                    json!(names
                        .iter()
                        .map(|name| json!({ "name": name }))
                        .collect::<Vec<_>>()),
                );
            }
            Value::Object(entry)
        })
        .collect::<Vec<_>>();
    json!({
        "version": { "major": "1", "minor": "3" },
        "domains": domains,
    })
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
        protocol_version: EMBEDDED_BROWSER_CHANNEL_FRAMING_PROTOCOL_VERSION.to_string(),
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
        || value.protocol_version != EMBEDDED_BROWSER_CHANNEL_FRAMING_PROTOCOL_VERSION
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
    if json.is_empty() || json.len() > EMBEDDED_BROWSER_CONTROL_MESSAGE_MAX_BYTES {
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
        if self.pending.len() + chunk.len() > EMBEDDED_BROWSER_CONTROL_MESSAGE_MAX_BYTES {
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
            if length == 0 || length > EMBEDDED_BROWSER_CONTROL_MESSAGE_MAX_BYTES {
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
        target_cdp: record.get("targetCdp").and_then(Value::as_bool) == Some(true),
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
                "session" => EmbeddedBrowserCdpMethodKind::Session,
                other => panic!("unexpected method kind {other}"),
            };
            assert_eq!(embedded_browser_cdp_method_kind(method), Some(expected));
        }
        for event in fixture["cdp"]["events"].as_array().unwrap() {
            assert!(supports_embedded_browser_cdp_event(event.as_str().unwrap()));
        }
        assert!(assert_embedded_browser_cdp_method("Network.enable").is_ok());
        assert!(assert_embedded_browser_cdp_method("Runtime.releaseObject").is_ok());
        assert!(assert_embedded_browser_cdp_method("Emulation.setDeviceMetricsOverride").is_ok());
        assert!(assert_embedded_browser_cdp_method("Target.attachToTarget").is_err());
    }

    #[test]
    fn browser_target_cdp_contract_matches_the_shared_fixture() {
        let fixture = fixture();
        assert_eq!(
            fixture["cdp"]["targetCdp"]["profile"],
            EMBEDDED_BROWSER_TARGET_CDP_PROFILE
        );
        let target: EmbeddedBrowserTargetInfo =
            serde_json::from_value(fixture["messages"]["targetInfo"].clone()).unwrap();
        assert_eq!(target.target_id, "browser_tab_1");
        assert_eq!(target.browser_context_id, "source_main_pool");
        assert_eq!(target.target_type, "page");

        let targets: EmbeddedBrowserTargetGetTargetsResult =
            serde_json::from_value(fixture["messages"]["targetGetTargets"].clone()).unwrap();
        assert_eq!(targets.target_infos.len(), 2);
        let page_info: EmbeddedBrowserTargetGetTargetInfoResult =
            serde_json::from_value(fixture["messages"]["targetGetTargetInfo"].clone()).unwrap();
        assert!(matches!(
            page_info.target_info,
            EmbeddedBrowserCdpTargetInfo::Page(_)
        ));
        let browser_info: EmbeddedBrowserTargetGetTargetInfoResult =
            serde_json::from_value(fixture["messages"]["targetGetBrowserTargetInfo"].clone())
                .unwrap();
        match browser_info.target_info {
            EmbeddedBrowserCdpTargetInfo::Browser(info) => {
                assert_eq!(info.target_type, "browser");
                assert!(info.attached);
            }
            EmbeddedBrowserCdpTargetInfo::Page(_) => panic!("expected browser target info"),
        }
        let downloads: EmbeddedBrowserBrowserSetDownloadBehaviorParams =
            serde_json::from_value(fixture["messages"]["browserSetDownloadBehaviorParams"].clone())
                .unwrap();
        assert_eq!(downloads.behavior, "allowAndName");
        assert!(downloads.events_enabled.unwrap_or(false));
        let contexts: EmbeddedBrowserTargetGetBrowserContextsResult =
            serde_json::from_value(fixture["messages"]["targetGetBrowserContexts"].clone())
                .unwrap();
        assert_eq!(contexts.browser_context_ids.len(), 2);
        assert_eq!(
            contexts.default_browser_context_id.as_deref(),
            Some("source_main_pool")
        );

        let attach: EmbeddedBrowserTargetAttachToTargetParams =
            serde_json::from_value(fixture["messages"]["targetAttachParams"].clone()).unwrap();
        assert!(attach.flatten);
        let detach: EmbeddedBrowserTargetDetachFromTargetParams =
            serde_json::from_value(fixture["messages"]["targetDetachParams"].clone()).unwrap();
        detach.validate().unwrap();
        assert!(EmbeddedBrowserTargetDetachFromTargetParams {
            session_id: None,
            target_id: None,
        }
        .validate()
        .is_err());

        let created: EmbeddedBrowserTargetCdpEvent =
            serde_json::from_value(fixture["messages"]["targetCreatedEvent"].clone()).unwrap();
        assert!(matches!(
            created,
            EmbeddedBrowserTargetCdpEvent::TargetCreated(_)
        ));
        let attached: EmbeddedBrowserTargetCdpEvent =
            serde_json::from_value(fixture["messages"]["targetAttachedEvent"].clone()).unwrap();
        assert!(matches!(
            attached,
            EmbeddedBrowserTargetCdpEvent::AttachedToTarget(_)
        ));
        let detached: EmbeddedBrowserTargetCdpEvent =
            serde_json::from_value(fixture["messages"]["targetDetachedEvent"].clone()).unwrap();
        assert!(matches!(
            detached,
            EmbeddedBrowserTargetCdpEvent::DetachedFromTarget(_)
        ));
        assert!(supports_embedded_browser_target_cdp_method(
            "Target.createTarget"
        ));
        assert!(supports_embedded_browser_target_cdp_method(
            "Browser.getVersion"
        ));
        assert!(supports_embedded_browser_target_cdp_method(
            "Target.setAutoAttach"
        ));
        assert!(!supports_embedded_browser_target_cdp_method(
            "Target.createBrowserContext"
        ));
        assert!(supports_embedded_browser_target_cdp_event(
            "Target.targetInfoChanged"
        ));
        assert!(supports_embedded_browser_target_cdp_event(
            "Target.attachedToTarget"
        ));
        assert!(!supports_embedded_browser_target_cdp_event(
            "Target.setAutoAttach"
        ));
        assert!(!supports_embedded_browser_target_cdp_method(
            fixture["messages"]["targetUnsupportedMethod"]
                .as_str()
                .unwrap()
        ));
        assert!(assert_embedded_browser_target_cdp_method("Target.getBrowserContexts").is_ok());
        assert!(assert_embedded_browser_target_cdp_method("Target.createBrowserContext").is_err());
        let auto_attach: EmbeddedBrowserTargetSetAutoAttachParams =
            serde_json::from_value(fixture["messages"]["targetSetAutoAttachParams"].clone())
                .unwrap();
        auto_attach.validate().unwrap();
        assert!(auto_attach.flatten);
        assert_eq!(
            fixture["cdp"]["targetCdp"]["protocolDocument"],
            embedded_browser_cdp_protocol_document()
        );
    }

    #[test]
    fn creation_context_claim_and_pending_errors_match_the_shared_fixture() {
        let fixture = fixture();
        let snapshot: EmbeddedBrowserCreationContextSnapshot =
            serde_json::from_value(fixture["messages"]["creationContext"].clone()).unwrap();
        snapshot.validate().unwrap();
        assert_eq!(
            snapshot
                .panels
                .iter()
                .filter(|panel| panel.is_default)
                .count(),
            1
        );
        assert_eq!(
            snapshot
                .pending_creation
                .as_ref()
                .map(|creation| creation.state.as_str()),
            Some("pending")
        );

        let claim: EmbeddedBrowserDefaultContextClaimRequest =
            serde_json::from_value(fixture["messages"]["creationContextClaimRequest"].clone())
                .unwrap();
        assert_eq!(claim.source_ref, "source_renderer");
        let result: EmbeddedBrowserDefaultContextClaimResult =
            serde_json::from_value(fixture["messages"]["creationContextClaimResult"].clone())
                .unwrap();
        result.validate().unwrap();
        assert_eq!(result.revision, snapshot.revision + 1);
        let changed: EmbeddedBrowserCreationContextChangedEvent =
            serde_json::from_value(fixture["messages"]["creationContextChanged"].clone()).unwrap();
        assert_eq!(changed.event_type, "browser.creation-context.changed");

        let required: EmbeddedBrowserControlError =
            serde_json::from_value(fixture["messages"]["creationContextRequiredError"].clone())
                .unwrap();
        assert_eq!(
            required.code,
            embedded_browser_error_code::CREATION_CONTEXT_REQUIRED
        );
        assert_eq!(required.creation_ref.as_deref(), Some("creation_pending"));
        let conflict: EmbeddedBrowserControlError =
            serde_json::from_value(fixture["messages"]["creationContextConflictError"].clone())
                .unwrap();
        assert_eq!(
            conflict.code,
            embedded_browser_error_code::DEFAULT_CONTEXT_CONFLICT
        );
        assert_eq!(conflict.revision, Some(3));
        let not_owned: EmbeddedBrowserControlError =
            serde_json::from_value(fixture["messages"]["creationContextNotOwnedError"].clone())
                .unwrap();
        assert_eq!(
            not_owned.code,
            embedded_browser_error_code::CREATION_CONTEXT_NOT_OWNED
        );

        assert!(EmbeddedBrowserBrowserContext {
            source_ref: "source_a".to_string(),
            browser_context_id: "source_b".to_string(),
        }
        .validate()
        .is_err());
        assert!(EmbeddedBrowserDefaultContextClaimResult {
            source_ref: "source_a".to_string(),
            browser_context_id: "source_b".to_string(),
            revision: 4,
        }
        .validate()
        .is_err());
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
        assert!(normalized.target_cdp);
        let legacy = normalize_embedded_browser_channel_capabilities(
            &fixture["capabilities"]["legacyWithoutTargetCdp"],
        );
        assert!(legacy.supported);
        assert!(!legacy.target_cdp);
        let unsupported = normalize_embedded_browser_channel_capabilities(&json!({
            "supported": true,
            "transports": ["future"],
            "streamKinds": ["control"],
            "drivers": ["electron-page-cdp"]
        }));
        assert!(!unsupported.supported);
    }
}
