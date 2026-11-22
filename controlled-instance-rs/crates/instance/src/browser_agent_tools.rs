use crate::{
    browser_control::{BrowserAccessDecision, BrowserControlError},
    state::AppState,
    story_tools::StoryToolError,
};
use controlled_instance_ai_session::AiSession;
use controlled_instance_protocol::{
    AiSessionAgentToolName, EMBEDDED_BROWSER_ACCESS_WAIT_MS,
    EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

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

    if !state.browser_control.access().active {
        if let Some(request) = state.browser_control.request_instance_access(&session.id) {
            let decision = state
                .browser_control
                .wait_for_access_decision(
                    &request.request_ref,
                    Duration::from_millis(EMBEDDED_BROWSER_ACCESS_WAIT_MS),
                )
                .await;
            match decision {
                BrowserAccessDecision::Granted(_) => {}
                BrowserAccessDecision::Pending(view) => {
                    return Ok(json!({
                        "status": "pending",
                        "requestRef": view.request_ref,
                        "expiresAt": view.expires_at,
                        "message": "Approve Agent browser access for this controlled instance in the approval center, then call browser_cdp_access again.",
                    }));
                }
                BrowserAccessDecision::Denied(view) => {
                    return Ok(json!({
                        "status": "denied",
                        "requestRef": view.request_ref,
                        "message": "The user denied Agent browser access for this controlled instance.",
                    }));
                }
                BrowserAccessDecision::Expired(view) => {
                    return Ok(json!({
                        "status": "expired",
                        "requestRef": view.request_ref,
                        "message": "The browser access approval expired. Call browser_cdp_access again to request a new approval.",
                    }));
                }
            }
        }
    }

    let (token, expires_at) = state
        .browser_control
        .issue_cdp_token(&session.id)
        .map_err(browser_error)?;
    Ok(json!({
        "status": "granted",
        "httpEndpoint": state.browser_cdp_http_endpoint(),
        "token": token,
        "expiresAt": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "protocolVersion": EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
    }))
}

fn browser_error(error: BrowserControlError) -> StoryToolError {
    StoryToolError::new(error.code, error.message, error.status_code)
}

fn tool_error(code: impl Into<String>, message: impl Into<String>) -> StoryToolError {
    StoryToolError::new(code, message, 409)
}
