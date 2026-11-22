use crate::{browser_control::BrowserControlError, state::AppState, story_tools::StoryToolError};
use controlled_instance_ai_session::AiSession;
use controlled_instance_protocol::{
    AiSessionAgentToolName, EmbeddedBrowserCdpAccess, EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyInput {}

pub async fn invoke(
    state: &AppState,
    session: &AiSession,
    tool: AiSessionAgentToolName,
    arguments: Value,
    _request_id: &str,
) -> Result<Value, StoryToolError> {
    if tool != AiSessionAgentToolName::BrowserCdpAccess {
        return Err(tool_error(
            "BROWSER_TOOL_UNSUPPORTED",
            "The requested tool is not a browser tool.",
        ));
    }
    let arguments = if arguments.is_null() {
        Value::Object(Default::default())
    } else {
        arguments
    };
    serde_json::from_value::<EmptyInput>(arguments).map_err(|_| {
        tool_error(
            "BROWSER_TOOL_ARGUMENTS_INVALID",
            "browser_cdp_access does not accept arguments.",
        )
    })?;

    let (token, expires_at) = state
        .browser_control
        .issue_cdp_token(&session.id)
        .map_err(browser_error)?;
    serde_json::to_value(EmbeddedBrowserCdpAccess {
        http_endpoint: state.browser_cdp_http_endpoint(),
        token,
        expires_at: expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        protocol_version: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION.to_string(),
    })
    .map_err(|error| tool_error("BROWSER_CDP_ACCESS_SERIALIZATION_FAILED", error.to_string()))
}

fn browser_error(error: BrowserControlError) -> StoryToolError {
    StoryToolError::new(error.code, error.message, error.status_code)
}

fn tool_error(code: impl Into<String>, message: impl Into<String>) -> StoryToolError {
    StoryToolError::new(code, message, 409)
}
