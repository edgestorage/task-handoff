use serde_json::{Map, Value};

const MAX_ATTACHMENTS: usize = 6;
const MAX_REFERENCES: usize = 20;
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_INLINE_FILE_BYTES: u64 = 500 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES: u64 = 40 * 1024 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_QUEUE_ATTACHMENTS: usize = 6;
const MAX_QUEUE_ITEMS: usize = 100;
const MAX_TIMELINE_ITEMS: usize = 10_000;
const REASONING_EFFORTS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

#[derive(Debug, Clone)]
struct Issue {
    path: Vec<String>,
    message: String,
}

impl Issue {
    fn new(path: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            path,
            message: message.into(),
        }
    }

    fn rendered(&self) -> String {
        let path = if self.path.is_empty() {
            "body".to_string()
        } else {
            self.path.join(".")
        };
        format!("{path}: {}", self.message)
    }
}

pub fn normalize_ai_session_create_body(body: &Value) -> Result<Value, Vec<String>> {
    // The Node route first tries the upload-reference input and then falls back
    // to the regular attachment schema. Preserve the same precedence so inline
    // and draft uploads retain their distinct strict contracts.
    if let Ok(value) = validate_create(body, true) {
        return Ok(value);
    }
    validate_create(body, false).map_err(|issues| issues.iter().map(Issue::rendered).collect())
}

pub fn normalize_ai_session_message_body(body: &Value) -> Result<Value, Vec<String>> {
    if let Ok(value) = validate_message(body, true) {
        return Ok(value);
    }
    validate_message(body, false).map_err(render_issues)
}

pub fn normalize_ai_session_command_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_command(body).map_err(render_issues)
}

pub fn normalize_ai_session_fork_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_fork(body).map_err(render_issues)
}

pub fn normalize_ai_session_rename_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_rename(body).map_err(render_issues)
}

pub fn normalize_ai_session_resume_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_resume(body).map_err(render_issues)
}

pub fn normalize_ai_session_model_selection_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_model_selection_input(body).map_err(render_issues)
}

pub fn normalize_ai_session_reasoning_effort_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_reasoning_effort_input(body).map_err(render_issues)
}

pub fn normalize_ai_session_queue_edit_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_queue_edit(body).map_err(render_issues)
}

pub fn normalize_ai_session_queue_reorder_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_queue_reorder(body).map_err(render_issues)
}

pub fn normalize_ai_session_timeline_sync_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_timeline_sync(body).map_err(render_issues)
}

pub fn normalize_empty_object_body(body: &Value) -> Result<Value, Vec<String>> {
    let Some(object) = body.as_object() else {
        return Err(render_issues(vec![invalid_type(
            Vec::new(),
            "object",
            received_type(body),
        )]));
    };
    let mut issues = Vec::new();
    unsupported_keys(object, &[], &mut issues, &[] as &[String]);
    if issues.is_empty() {
        Ok(Value::Object(Map::new()))
    } else {
        Err(render_issues(issues))
    }
}

pub fn normalize_story_automation_create_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_story_automation_create(body).map_err(render_issues)
}

pub fn normalize_agent_run_member_create_body(body: &Value) -> Result<Value, Vec<String>> {
    validate_agent_run_member_create(body).map_err(render_issues)
}

fn validate_story_automation_create(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();

    if let Some(value) = required_text(object, "agent", &["agent"], 1, 80, &mut issues) {
        normalized.insert("agent".to_string(), Value::String(value));
    }
    if let Some(value) = cwd(object.get("cwd"), &mut issues) {
        normalized.insert("cwd".to_string(), value);
    }
    if let Some(value) = optional_text(object, "cwdFolderId", &["cwdFolderId"], 1, 120, &mut issues)
    {
        normalized.insert("cwdFolderId".to_string(), Value::String(value));
    }
    if let Some(value) = git_selection(object.get("gitSelection"), &mut issues) {
        normalized.insert("gitSelection".to_string(), value);
    }
    if let Some(value) = workspace_selection(object.get("workspaceSelection"), &mut issues) {
        normalized.insert("workspaceSelection".to_string(), value);
    }
    if let Some(value) = required_text(object, "message", &["message"], 1, 32_000, &mut issues) {
        normalized.insert("message".to_string(), Value::String(value));
    }
    if let Some(value) = optional_enum(
        object,
        "permissionMode",
        &["permissionMode"],
        &["ask", "auto-review", "full-access"],
        &mut issues,
    ) {
        normalized.insert("permissionMode".to_string(), Value::String(value));
    }
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    if let Some(value) = model_selection(object.get("modelSelection"), &mut issues) {
        normalized.insert("modelSelection".to_string(), value);
    }
    if let Some(value) = optional_enum(
        object,
        "reasoningEffort",
        &["reasoningEffort"],
        REASONING_EFFORTS,
        &mut issues,
    ) {
        normalized.insert("reasoningEffort".to_string(), Value::String(value));
    }
    if let Some(value) = required_text(object, "storyId", &["storyId"], 1, 120, &mut issues) {
        normalized.insert("storyId".to_string(), Value::String(value));
    }
    unsupported_keys(
        object,
        &[
            "agent",
            "cwd",
            "cwdFolderId",
            "gitSelection",
            "workspaceSelection",
            "message",
            "permissionMode",
            "clientRequestId",
            "modelSelection",
            "reasoningEffort",
            "storyId",
        ],
        &mut issues,
        &[] as &[&str],
    );
    if issues.is_empty()
        && normalized.contains_key("gitSelection")
        && normalized.contains_key("workspaceSelection")
    {
        issues.push(Issue::new(
            path(&["workspaceSelection"]),
            "gitSelection and workspaceSelection are mutually exclusive.",
        ));
    }
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_agent_run_member_create(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();

    for key in ["runId", "memberId"] {
        if let Some(value) = stable_agent_run_id(object, key, &[key], &mut issues) {
            normalized.insert(key.to_string(), Value::String(value));
        }
    }
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    if let Some(value) = required_text(object, "providerId", &["providerId"], 1, 80, &mut issues) {
        normalized.insert("providerId".to_string(), Value::String(value));
    }
    if let Some(value) = runtime_root(
        object.get("cwd"),
        &path(&["cwd"]),
        "Agent Run runtime paths must be absolute POSIX paths.",
        &mut issues,
    ) {
        normalized.insert("cwd".to_string(), value);
    }
    if let Some(value) = writable_roots(object.get("writableRoots"), &mut issues) {
        normalized.insert("writableRoots".to_string(), value);
    }
    if let Some(value) = required_text(object, "prompt", &["prompt"], 1, 128_000, &mut issues) {
        normalized.insert("prompt".to_string(), Value::String(value));
    }
    if let Some(value) = required_text_without_trim(
        object,
        "appendedPrompt",
        &["appendedPrompt"],
        32_000,
        &mut issues,
    ) {
        normalized.insert("appendedPrompt".to_string(), Value::String(value));
    }
    if let Some(value) = optional_enum(
        object,
        "permissionMode",
        &["permissionMode"],
        &["ask", "auto-review", "full-access"],
        &mut issues,
    ) {
        normalized.insert("permissionMode".to_string(), Value::String(value));
    }
    if let Some(value) = model_selection(object.get("modelSelection"), &mut issues) {
        normalized.insert("modelSelection".to_string(), value);
    }
    if let Some(value) = optional_enum(
        object,
        "reasoningEffort",
        &["reasoningEffort"],
        REASONING_EFFORTS,
        &mut issues,
    ) {
        normalized.insert("reasoningEffort".to_string(), Value::String(value));
    }
    if let Some(value) = enabled_tools(object.get("enabledTools"), &mut issues) {
        normalized.insert("enabledTools".to_string(), Value::Array(value));
    }
    unsupported_keys(
        object,
        &[
            "runId",
            "memberId",
            "clientRequestId",
            "providerId",
            "cwd",
            "writableRoots",
            "prompt",
            "appendedPrompt",
            "permissionMode",
            "modelSelection",
            "reasoningEffort",
            "enabledTools",
        ],
        &mut issues,
        &[] as &[&str],
    );
    if issues.is_empty() {
        let cwd_path = normalized
            .get("cwd")
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str);
        let workspace_path = normalized
            .get("writableRoots")
            .and_then(|value| value.get("workspace"))
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str);
        let shared_path = normalized
            .get("writableRoots")
            .and_then(|value| value.get("shared"))
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str);
        if cwd_path != workspace_path {
            issues.push(Issue::new(
                path(&["writableRoots", "workspace"]),
                "The workspace writable root must be the member cwd.",
            ));
        }
        if workspace_path == shared_path {
            issues.push(Issue::new(
                path(&["writableRoots"]),
                "Workspace and shared roots must be distinct.",
            ));
        }
    }
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn render_issues(issues: Vec<Issue>) -> Vec<String> {
    issues.iter().map(Issue::rendered).collect()
}

fn validate_create(body: &Value, reference_variant: bool) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();

    if let Some(value) = required_text(object, "message", &["message"], 1, 20_000, &mut issues) {
        normalized.insert("message".to_string(), Value::String(value));
    }
    if let Some(value) = optional_enum(
        object,
        "mode",
        &["mode"],
        &["auto", "queue", "steer", "immediate"],
        &mut issues,
    ) {
        normalized.insert("mode".to_string(), Value::String(value));
    }
    if let Some(value) = optional_enum(
        object,
        "permissionMode",
        &["permissionMode"],
        &["ask", "auto-review", "full-access"],
        &mut issues,
    ) {
        normalized.insert("permissionMode".to_string(), Value::String(value));
    }
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }

    let (attachments, inline_bytes) =
        attachments(object.get("attachments"), reference_variant, &mut issues);
    if let Some(attachments) = attachments {
        if !reference_variant && inline_bytes > MAX_MESSAGE_ATTACHMENT_BYTES {
            issues.push(Issue::new(
                path(&["attachments"]),
                format!(
                    "Inline attachments must be {MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total."
                ),
            ));
        }
        normalized.insert("attachments".to_string(), Value::Array(attachments));
    }
    if let Some(references) = references(object.get("references"), &mut issues) {
        normalized.insert("references".to_string(), Value::Array(references));
    }

    if let Some(value) = required_text(object, "agent", &["agent"], 1, 80, &mut issues) {
        normalized.insert("agent".to_string(), Value::String(value));
    }
    if let Some(cwd) = cwd(object.get("cwd"), &mut issues) {
        normalized.insert("cwd".to_string(), cwd);
    }
    if let Some(value) = optional_text(object, "cwdFolderId", &["cwdFolderId"], 1, 120, &mut issues)
    {
        normalized.insert("cwdFolderId".to_string(), Value::String(value));
    }
    if let Some(git) = git_selection(object.get("gitSelection"), &mut issues) {
        normalized.insert("gitSelection".to_string(), git);
    }
    if let Some(workspace) = workspace_selection(object.get("workspaceSelection"), &mut issues) {
        normalized.insert("workspaceSelection".to_string(), workspace);
    }
    if let Some(model) = model_selection(object.get("modelSelection"), &mut issues) {
        normalized.insert("modelSelection".to_string(), model);
    }
    if let Some(value) = optional_enum(
        object,
        "reasoningEffort",
        &["reasoningEffort"],
        &[
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ],
        &mut issues,
    ) {
        normalized.insert("reasoningEffort".to_string(), Value::String(value));
    }
    if let Some(value) = optional_text(object, "storyId", &["storyId"], 1, 120, &mut issues) {
        normalized.insert("storyId".to_string(), Value::String(value));
    }

    unsupported_keys(
        object,
        &[
            "message",
            "mode",
            "permissionMode",
            "clientRequestId",
            "attachments",
            "references",
            "agent",
            "cwd",
            "cwdFolderId",
            "gitSelection",
            "workspaceSelection",
            "modelSelection",
            "reasoningEffort",
            "storyId",
        ],
        &mut issues,
        &[] as &[&str],
    );

    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn cwd(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Value> {
    let value = required_object(value, &["cwd"], issues)?;
    let mut local = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_literal(
        value.get("type"),
        &["cwd", "type"],
        "runtime-path",
        &mut local,
    ) {
        normalized.insert("type".to_string(), Value::String(value));
    }
    if let Some(path) = required_text(value, "path", &["cwd", "path"], 1, 4096, &mut local) {
        if !is_absolute_runtime_path(&path) {
            local.push(Issue::new(
                path_parts(&["cwd", "path"]),
                "Runtime paths must be absolute in the target controlled instance.",
            ));
        } else {
            normalized.insert("path".to_string(), Value::String(path));
        }
    }
    unsupported_keys(value, &["type", "path"], &mut local, &["cwd"]);
    extend_nested(issues, local, Some(normalized))
}

fn validate_message(body: &Value, reference_variant: bool) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();

    if let Some(value) = required_text(object, "message", &["message"], 1, 20_000, &mut issues) {
        normalized.insert("message".to_string(), Value::String(value));
    }
    if let Some(value) = optional_enum(
        object,
        "mode",
        &["mode"],
        &["auto", "queue", "steer", "immediate"],
        &mut issues,
    ) {
        normalized.insert("mode".to_string(), Value::String(value));
    }
    if let Some(value) = optional_enum(
        object,
        "permissionMode",
        &["permissionMode"],
        &["ask", "auto-review", "full-access"],
        &mut issues,
    ) {
        normalized.insert("permissionMode".to_string(), Value::String(value));
    }
    if let Some(value) = optional_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    let (attachments, inline_bytes) =
        attachments(object.get("attachments"), reference_variant, &mut issues);
    if let Some(attachments) = attachments {
        if !reference_variant && inline_bytes > MAX_MESSAGE_ATTACHMENT_BYTES {
            issues.push(Issue::new(
                path(&["attachments"]),
                format!(
                    "Inline attachments must be {MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total."
                ),
            ));
        }
        normalized.insert("attachments".to_string(), Value::Array(attachments));
    }
    if let Some(references) = references(object.get("references"), &mut issues) {
        normalized.insert("references".to_string(), Value::Array(references));
    }
    unsupported_keys(
        object,
        &[
            "message",
            "mode",
            "permissionMode",
            "clientRequestId",
            "attachments",
            "references",
        ],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_command(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    let command = required_enum(
        object,
        "command",
        &["command"],
        &["review", "rename", "goal", "compact"],
        &mut issues,
    );
    let argument = optional_text(object, "argument", &["argument"], 0, 4_000, &mut issues);
    if let Some(command) = command.as_deref() {
        normalized.insert("command".to_string(), Value::String(command.to_string()));
    }
    if let Some(argument) = argument.as_deref() {
        normalized.insert("argument".to_string(), Value::String(argument.to_string()));
    }
    unsupported_keys(
        object,
        &["command", "argument"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        match command.as_deref() {
            Some("rename") if argument.as_deref().is_none_or(str::is_empty) => issues.push(
                Issue::new(path(&["argument"]), "Rename requires a thread name."),
            ),
            Some(command @ ("review" | "compact"))
                if argument.as_deref().is_some_and(|value| !value.is_empty()) =>
            {
                issues.push(Issue::new(
                    path(&["argument"]),
                    format!("{command} does not accept an argument."),
                ));
            }
            _ => {}
        }
    }
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_fork(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    if let Some(value) = optional_text(
        object,
        "throughTurnId",
        &["throughTurnId"],
        1,
        240,
        &mut issues,
    ) {
        normalized.insert("throughTurnId".to_string(), Value::String(value));
    }
    if let Some(value) = object.get("workspace") {
        let base = path(&["workspace"]);
        if let Some(workspace) = required_object(Some(value), &base, &mut issues) {
            let mut local = Vec::new();
            let mut workspace_value = Map::new();
            let mode = optional_enum(
                workspace,
                "mode",
                &append_path(&base, "mode"),
                &["current", "managed-worktree"],
                &mut local,
            )
            .unwrap_or_else(|| "current".to_string());
            workspace_value.insert("mode".to_string(), Value::String(mode));
            unsupported_keys(workspace, &["mode"], &mut local, &base);
            if local.is_empty() {
                normalized.insert("workspace".to_string(), Value::Object(workspace_value));
            } else {
                issues.extend(local);
            }
        }
    }
    unsupported_keys(
        object,
        &["clientRequestId", "throughTurnId", "workspace"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_rename(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_text(object, "title", &["title"], 0, 120, &mut issues) {
        normalized.insert("title".to_string(), Value::String(value));
    }
    if let Some(value) = optional_text(
        object,
        "expectedTitle",
        &["expectedTitle"],
        0,
        240,
        &mut issues,
    ) {
        normalized.insert("expectedTitle".to_string(), Value::String(value));
    }
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    unsupported_keys(
        object,
        &["title", "expectedTitle", "clientRequestId"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_resume(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = model_selection_at(
        object.get("modelSelection"),
        &path(&["modelSelection"]),
        false,
        &mut issues,
    ) {
        normalized.insert("modelSelection".to_string(), value);
    }
    if let Some(value) = optional_enum(
        object,
        "reasoningEffort",
        &["reasoningEffort"],
        REASONING_EFFORTS,
        &mut issues,
    ) {
        normalized.insert("reasoningEffort".to_string(), Value::String(value));
    }
    unsupported_keys(
        object,
        &["modelSelection", "reasoningEffort"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_model_selection_input(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    if let Some(value) = model_selection_at(
        object.get("modelSelection"),
        &path(&["modelSelection"]),
        true,
        &mut issues,
    ) {
        normalized.insert("modelSelection".to_string(), value);
    }
    unsupported_keys(
        object,
        &["clientRequestId", "modelSelection"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_reasoning_effort_input(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_text(
        object,
        "clientRequestId",
        &["clientRequestId"],
        1,
        160,
        &mut issues,
    ) {
        normalized.insert("clientRequestId".to_string(), Value::String(value));
    }
    if let Some(value) = required_enum(
        object,
        "reasoningEffort",
        &["reasoningEffort"],
        REASONING_EFFORTS,
        &mut issues,
    ) {
        normalized.insert("reasoningEffort".to_string(), Value::String(value));
    }
    unsupported_keys(
        object,
        &["clientRequestId", "reasoningEffort"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_queue_edit(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_revision(
        object.get("expectedRevision"),
        &["expectedRevision"],
        &mut issues,
    ) {
        normalized.insert("expectedRevision".to_string(), Value::from(value));
    }
    if let Some(value) = required_text(object, "message", &["message"], 1, 20_000, &mut issues) {
        normalized.insert("message".to_string(), Value::String(value));
    }
    if let Some(attachments) = queue_attachments(object.get("attachments"), &mut issues) {
        normalized.insert("attachments".to_string(), Value::Array(attachments));
    }
    unsupported_keys(
        object,
        &["expectedRevision", "message", "attachments"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn queue_attachments(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Vec<Value>> {
    let value = value?;
    let Some(values) = value.as_array() else {
        issues.push(invalid_type(
            path(&["attachments"]),
            "array",
            received_type(value),
        ));
        return None;
    };
    if values.len() > MAX_QUEUE_ATTACHMENTS {
        issues.push(too_big(
            path(&["attachments"]),
            "array",
            MAX_QUEUE_ATTACHMENTS,
            format!("Too big: expected array to have <={MAX_QUEUE_ATTACHMENTS} items"),
        ));
        return None;
    }
    let mut normalized = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let item_path = indexed_path(&["attachments"], index);
        if let Some(value) = queue_attachment(value, &item_path, issues) {
            normalized.push(value);
        }
    }
    Some(normalized)
}

fn queue_attachment(value: &Value, path: &[String], issues: &mut Vec<Issue>) -> Option<Value> {
    let Some(object) = value.as_object() else {
        issues.push(Issue::new(path.to_vec(), "Invalid input"));
        return None;
    };
    match object
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("type"))
        .and_then(Value::as_str)
    {
        Some("retained") => {
            let mut local = Vec::new();
            let mut normalized = Map::new();
            if let Some(id) =
                required_text(object, "id", &append_path(path, "id"), 1, 120, &mut local)
            {
                normalized.insert("id".to_string(), Value::String(id));
            }
            if let Some(source) = required_object(
                object.get("source"),
                &append_path(path, "source"),
                &mut local,
            ) {
                let mut source_normalized = Map::new();
                if required_literal(
                    source.get("type"),
                    &append_path(&append_path(path, "source"), "type"),
                    "retained",
                    &mut local,
                )
                .is_some()
                {
                    source_normalized
                        .insert("type".to_string(), Value::String("retained".to_string()));
                }
                unsupported_keys(source, &["type"], &mut local, &append_path(path, "source"));
                if local.is_empty() {
                    normalized.insert("source".to_string(), Value::Object(source_normalized));
                }
            }
            unsupported_keys(object, &["id", "source"], &mut local, path);
            if local.is_empty() {
                Some(Value::Object(normalized))
            } else {
                issues.extend(local);
                None
            }
        }
        Some(source_type @ ("upload-ref" | "runtime-path")) => {
            match attachment_branch(value, path, source_type) {
                Ok((value, _)) => Some(value),
                Err(()) => {
                    issues.push(Issue::new(path.to_vec(), "Invalid input"));
                    None
                }
            }
        }
        _ => {
            issues.push(Issue::new(path.to_vec(), "Invalid input"));
            None
        }
    }
}

fn validate_queue_reorder(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    if let Some(value) = required_revision(
        object.get("expectedRevision"),
        &["expectedRevision"],
        &mut issues,
    ) {
        normalized.insert("expectedRevision".to_string(), Value::from(value));
    }
    if let Some(queue_ids) = required_string_array(
        object.get("queueIds"),
        &["queueIds"],
        MAX_QUEUE_ITEMS,
        120,
        &mut issues,
    ) {
        normalized.insert("queueIds".to_string(), Value::Array(queue_ids));
    }
    unsupported_keys(
        object,
        &["expectedRevision", "queueIds"],
        &mut issues,
        &[] as &[String],
    );
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn validate_timeline_sync(body: &Value) -> Result<Value, Vec<Issue>> {
    let Some(object) = body.as_object() else {
        return Err(vec![invalid_type(vec![], "object", received_type(body))]);
    };
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    let known_items = match object.get("knownItems") {
        None => Some(Vec::new()),
        Some(value) => match value.as_array() {
            Some(values) => {
                if values.len() > MAX_TIMELINE_ITEMS {
                    issues.push(too_big(
                        path(&["knownItems"]),
                        "array",
                        MAX_TIMELINE_ITEMS,
                        format!("Too big: expected array to have <={MAX_TIMELINE_ITEMS} items"),
                    ));
                    return Err(issues);
                }
                let mut normalized = Vec::with_capacity(values.len());
                for (index, value) in values.iter().enumerate() {
                    let base = indexed_path(&["knownItems"], index);
                    let issue_count = issues.len();
                    let Some(item) = required_object(Some(value), &base, &mut issues) else {
                        continue;
                    };
                    let mut item_normalized = Map::new();
                    if let Some(id) =
                        required_text(item, "id", &append_path(&base, "id"), 1, 240, &mut issues)
                    {
                        item_normalized.insert("id".to_string(), Value::String(id));
                    }
                    if let Some(revision) = required_text(
                        item,
                        "revision",
                        &append_path(&base, "revision"),
                        1,
                        64,
                        &mut issues,
                    ) {
                        item_normalized.insert("revision".to_string(), Value::String(revision));
                    }
                    unsupported_keys(item, &["id", "revision"], &mut issues, &base);
                    if issues.len() == issue_count {
                        normalized.push(Value::Object(item_normalized));
                    }
                }
                Some(normalized)
            }
            None => {
                issues.push(invalid_type(
                    path(&["knownItems"]),
                    "array",
                    received_type(value),
                ));
                None
            }
        },
    };
    if let Some(known_items) = known_items {
        normalized.insert("knownItems".to_string(), Value::Array(known_items));
    }
    unsupported_keys(object, &["knownItems"], &mut issues, &[] as &[String]);
    if issues.is_empty() {
        Ok(Value::Object(normalized))
    } else {
        Err(issues)
    }
}

fn attachments(
    value: Option<&Value>,
    reference_variant: bool,
    issues: &mut Vec<Issue>,
) -> (Option<Vec<Value>>, u64) {
    let Some(value) = value else {
        return (Some(Vec::new()), 0);
    };
    let Some(values) = value.as_array() else {
        issues.push(invalid_type(
            path(&["attachments"]),
            "array",
            received_type(value),
        ));
        return (None, 0);
    };
    if values.len() > MAX_ATTACHMENTS {
        issues.push(too_big(
            path(&["attachments"]),
            "array",
            MAX_ATTACHMENTS,
            format!("Too big: expected array to have <={MAX_ATTACHMENTS} items"),
        ));
        return (None, 0);
    }
    let mut normalized = Vec::with_capacity(values.len());
    let mut inline_bytes = 0;
    for (index, value) in values.iter().enumerate() {
        let item_path = indexed_path(&["attachments"], index);
        match attachment(value, &item_path, reference_variant) {
            Ok((value, bytes)) => {
                normalized.push(value);
                inline_bytes += bytes;
            }
            Err(()) => issues.push(Issue::new(item_path, "Invalid input")),
        }
    }
    (Some(normalized), inline_bytes)
}

fn attachment(value: &Value, path: &[String], reference_variant: bool) -> Result<(Value, u64), ()> {
    let sources: &[&str] = if reference_variant {
        &["upload-ref", "runtime-path"]
    } else {
        &["inline", "runtime-path"]
    };
    for source_type in sources {
        if let Ok(value) = attachment_branch(value, path, source_type) {
            return Ok(value);
        }
    }
    Err(())
}

fn attachment_branch(
    value: &Value,
    path: &[String],
    source_type: &str,
) -> Result<(Value, u64), ()> {
    let object = value.as_object().ok_or(())?;
    let mut issues = Vec::new();
    let mut normalized = Map::new();
    let id = required_text(object, "id", &append_path(path, "id"), 1, 120, &mut issues).ok_or(())?;
    normalized.insert("id".to_string(), Value::String(id));
    if source_type == "upload-ref" {
        if let Some(kind) = optional_enum(
            object,
            "kind",
            &append_path(path, "kind"),
            &["image", "file"],
            &mut issues,
        ) {
            normalized.insert("kind".to_string(), Value::String(kind));
        }
    } else {
        let kind = required_enum(
            object,
            "kind",
            &append_path(path, "kind"),
            &["image", "file"],
            &mut issues,
        )
        .ok_or(())?;
        let name = required_text(
            object,
            "name",
            &append_path(path, "name"),
            1,
            240,
            &mut issues,
        )
        .ok_or(())?;
        let mime = required_text(
            object,
            "mime",
            &append_path(path, "mime"),
            1,
            120,
            &mut issues,
        )
        .ok_or(())?;
        let size =
            required_safe_integer(object.get("size"), &append_path(path, "size"), &mut issues)
                .ok_or(())?;
        normalized.insert("kind".to_string(), Value::String(kind.clone()));
        normalized.insert("name".to_string(), Value::String(name));
        normalized.insert("mime".to_string(), Value::String(mime));
        normalized.insert("size".to_string(), Value::from(size));
        if source_type == "inline" {
            let maximum = if kind == "image" {
                MAX_ATTACHMENT_BYTES
            } else {
                MAX_INLINE_FILE_BYTES
            };
            if size == 0
                || (kind == "file" && size >= maximum)
                || (kind == "image" && size > maximum)
            {
                issues.push(Issue::new(
                    append_path(path, "size"),
                    format!("Inline {kind} must be between 1 byte and {maximum} bytes."),
                ));
            }
        }
    }
    let mut normalized_source = Map::new();
    let source = if source_type == "upload-ref" && object.get("source").is_none() {
        None
    } else {
        let source = required_object(
            object.get("source"),
            &append_path(path, "source"),
            &mut issues,
        )
        .ok_or(())?;
        required_literal(
            source.get("type"),
            &append_path(path, "source.type"),
            source_type,
            &mut issues,
        )
        .ok_or(())?;
        Some(source)
    };
    normalized_source.insert("type".to_string(), Value::String(source_type.to_string()));
    let mut inline_bytes = 0;
    match source_type {
        "upload-ref" => {
            if let Some(source) = source {
                unsupported_keys(source, &["type"], &mut issues, &append_path(path, "source"));
            }
        }
        "runtime-path" => {
            let source = source.expect("runtime-path source");
            let source_path = required_text(
                source,
                "path",
                &append_path(path, "source.path"),
                1,
                4096,
                &mut issues,
            )
            .ok_or(())?;
            normalized_source.insert("path".to_string(), Value::String(source_path));
            unsupported_keys(
                source,
                &["type", "path"],
                &mut issues,
                &append_path(path, "source"),
            );
        }
        "inline" => {
            let source = source.expect("inline source");
            let encoding = required_literal(
                source.get("encoding"),
                &append_path(path, "source.encoding"),
                "base64",
                &mut issues,
            )
            .ok_or(())?;
            let data = required_text(
                source,
                "data",
                &append_path(path, "source.data"),
                1,
                30 * 1024 * 1024,
                &mut issues,
            )
            .ok_or(())?;
            normalized_source.insert("encoding".to_string(), Value::String(encoding));
            normalized_source.insert("data".to_string(), Value::String(data));
            unsupported_keys(
                source,
                &["type", "encoding", "data"],
                &mut issues,
                &append_path(path, "source"),
            );
            inline_bytes = normalized
                .get("size")
                .and_then(Value::as_u64)
                .unwrap_or_default();
        }
        _ => return Err(()),
    }
    normalized.insert("source".to_string(), Value::Object(normalized_source));
    unsupported_keys(
        object,
        if source_type == "upload-ref" {
            &["id", "kind", "source"]
        } else {
            &["id", "kind", "name", "mime", "size", "source"]
        },
        &mut issues,
        path,
    );
    if issues.is_empty() {
        Ok((Value::Object(normalized), inline_bytes))
    } else {
        Err(())
    }
}

fn references(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Vec<Value>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let Some(values) = value.as_array() else {
        issues.push(invalid_type(
            path(&["references"]),
            "array",
            received_type(value),
        ));
        return None;
    };
    if values.len() > MAX_REFERENCES {
        issues.push(too_big(
            path(&["references"]),
            "array",
            MAX_REFERENCES,
            format!("Too big: expected array to have <={MAX_REFERENCES} items"),
        ));
        return None;
    }
    let mut normalized = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let mut reference_issues = Vec::new();
        if let Some(value) = reference(
            value,
            &indexed_path(&["references"], index),
            &mut reference_issues,
        ) {
            normalized.push(value);
        } else {
            issues.extend(reference_issues);
        }
    }
    Some(normalized)
}

fn reference(value: &Value, path: &[String], issues: &mut Vec<Issue>) -> Option<Value> {
    let Some(object) = value.as_object() else {
        issues.push(Issue::new(path.to_vec(), "Invalid input"));
        return None;
    };
    let kind = object.get("kind").and_then(Value::as_str);
    let Some(kind @ ("skill" | "app" | "plugin")) = kind else {
        issues.push(Issue::new(
            append_path(path, "kind"),
            "Invalid discriminator value. Expected 'skill' | 'app' | 'plugin'",
        ));
        return None;
    };
    let mut normalized = Map::new();
    let name = required_text(object, "name", &append_path(path, "name"), 1, 240, issues)?;
    let path_value = required_text(object, "path", &append_path(path, "path"), 1, 4096, issues)?;
    let valid_path = match kind {
        "skill" => {
            if !path_value.starts_with('/') {
                issues.push(Issue::new(
                    append_path(path, "path"),
                    "Skill paths must be absolute.",
                ));
                false
            } else {
                true
            }
        }
        "app" => {
            if !prefixed_identifier(&path_value, "app://") {
                issues.push(Issue::new(
                    append_path(path, "path"),
                    "App paths must use app://<id>.",
                ));
                false
            } else {
                true
            }
        }
        "plugin" => {
            if !prefixed_identifier(&path_value, "plugin://") {
                issues.push(Issue::new(
                    append_path(path, "path"),
                    "Plugin paths must use plugin://<id>.",
                ));
                false
            } else {
                true
            }
        }
        _ => false,
    };
    normalized.insert("kind".to_string(), Value::String(kind.to_string()));
    normalized.insert("name".to_string(), Value::String(name));
    normalized.insert("path".to_string(), Value::String(path_value));
    unsupported_keys(object, &["kind", "name", "path"], issues, path);
    if valid_path && issues.is_empty() {
        Some(Value::Object(normalized))
    } else {
        None
    }
}

fn workspace_selection(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Value> {
    let value = value?;
    let Some(object) = value.as_object() else {
        issues.push(invalid_type(
            path(&["workspaceSelection"]),
            "object",
            received_type(value),
        ));
        return None;
    };
    let Some(kind @ ("current-folder" | "existing-worktree" | "new-worktree")) =
        object.get("type").and_then(Value::as_str)
    else {
        issues.push(Issue::new(
            path_parts(&["workspaceSelection", "type"]),
            "Invalid discriminator value. Expected 'current-folder' | 'existing-worktree' | 'new-worktree'",
        ));
        return None;
    };
    let base = path(&["workspaceSelection"]);
    let mut local = Vec::new();
    let mut normalized = Map::new();
    normalized.insert("type".to_string(), Value::String(kind.to_string()));
    match kind {
        "current-folder" => {
            if let Some(branch) = required_text(
                object,
                "branch",
                &append_path(&base, "branch"),
                1,
                1024,
                &mut local,
            ) {
                normalized.insert("branch".to_string(), Value::String(branch));
            }
            unsupported_keys(object, &["type", "branch"], &mut local, &base);
        }
        "existing-worktree" => {
            for (key, maximum) in [("repositoryContextId", 160), ("worktreeId", 160)] {
                if let Some(value) = required_text(
                    object,
                    key,
                    &append_path(&base, key),
                    1,
                    maximum,
                    &mut local,
                ) {
                    normalized.insert(key.to_string(), Value::String(value));
                }
            }
            unsupported_keys(
                object,
                &["type", "repositoryContextId", "worktreeId"],
                &mut local,
                &base,
            );
        }
        "new-worktree" => {
            for (key, maximum) in [
                ("branchName", 255),
                ("startRef", 2048),
                ("expectedSnapshotId", 160),
            ] {
                if let Some(value) = required_text(
                    object,
                    key,
                    &append_path(&base, key),
                    1,
                    maximum,
                    &mut local,
                ) {
                    normalized.insert(key.to_string(), Value::String(value));
                }
            }
            unsupported_keys(
                object,
                &["type", "branchName", "startRef", "expectedSnapshotId"],
                &mut local,
                &base,
            );
        }
        _ => unreachable!(),
    }
    extend_nested(issues, local, Some(normalized))
}

fn git_selection(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Value> {
    let value = value?;
    let Some(object) = value.as_object() else {
        issues.push(invalid_type(
            path(&["gitSelection"]),
            "object",
            received_type(value),
        ));
        return None;
    };
    let base = path(&["gitSelection"]);
    let mut local = Vec::new();
    let mut normalized = Map::new();
    if let Some(mode) = required_enum(
        object,
        "mode",
        &append_path(&base, "mode"),
        &["current-folder", "worktree"],
        &mut local,
    ) {
        normalized.insert("mode".to_string(), Value::String(mode));
    }
    if let Some(branch) = required_text(
        object,
        "branch",
        &append_path(&base, "branch"),
        1,
        1024,
        &mut local,
    ) {
        normalized.insert("branch".to_string(), Value::String(branch));
    }
    unsupported_keys(object, &["mode", "branch"], &mut local, &base);
    extend_nested(issues, local, Some(normalized))
}

fn model_selection(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Value> {
    model_selection_at(value, &path(&["modelSelection"]), false, issues)
}

fn model_selection_at(
    value: Option<&Value>,
    base: &[String],
    required: bool,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let Some(value) = value else {
        if required {
            issues.push(invalid_type(base.to_vec(), "object", "undefined"));
        }
        return None;
    };
    let Some(object) = value.as_object() else {
        issues.push(invalid_type(base.to_vec(), "object", received_type(value)));
        return None;
    };
    let mut local = Vec::new();
    let mut normalized = Map::new();
    for (key, maximum, required) in [
        ("modelEntityId", 120, true),
        ("modelName", 240, true),
        ("modelUpstreamName", 240, false),
    ] {
        let value = if required {
            required_text(object, key, &append_path(base, key), 1, maximum, &mut local)
        } else {
            optional_text(object, key, &append_path(base, key), 1, maximum, &mut local)
        };
        if let Some(value) = value {
            normalized.insert(key.to_string(), Value::String(value));
        }
    }
    unsupported_keys(
        object,
        &["modelEntityId", "modelName", "modelUpstreamName"],
        &mut local,
        base,
    );
    extend_nested(issues, local, Some(normalized))
}

fn required_revision<P: AsRef<str>>(
    value: Option<&Value>,
    path: &[P],
    issues: &mut Vec<Issue>,
) -> Option<u64> {
    required_safe_integer(value, path, issues)
}

fn required_string_array<P: AsRef<str>>(
    value: Option<&Value>,
    path: &[P],
    maximum_items: usize,
    maximum_string: usize,
    issues: &mut Vec<Issue>,
) -> Option<Vec<Value>> {
    let Some(value) = value else {
        issues.push(invalid_type(owned_path(path), "array", "undefined"));
        return None;
    };
    let Some(values) = value.as_array() else {
        issues.push(invalid_type(
            owned_path(path),
            "array",
            received_type(value),
        ));
        return None;
    };
    if values.len() > maximum_items {
        issues.push(too_big(
            owned_path(path),
            "array",
            maximum_items,
            format!("Too big: expected array to have <={maximum_items} items"),
        ));
        return None;
    }
    let mut normalized = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let item_path = {
            let mut item_path = owned_path(path);
            item_path.push(index.to_string());
            item_path
        };
        if let Some(value) = text(value, &item_path, 1, maximum_string, issues) {
            normalized.push(Value::String(value));
        }
    }
    Some(normalized)
}

fn required_text<P: AsRef<str>>(
    object: &Map<String, Value>,
    key: &str,
    path: &[P],
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match object.get(key) {
        Some(value) => text(value, path, minimum, maximum, issues),
        None => {
            issues.push(invalid_type(owned_path(path), "string", "undefined"));
            None
        }
    }
}

fn required_text_without_trim<P: AsRef<str>>(
    object: &Map<String, Value>,
    key: &str,
    path: &[P],
    maximum: usize,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let Some(value) = object.get(key) else {
        issues.push(invalid_type(owned_path(path), "string", "undefined"));
        return None;
    };
    let Some(value) = value.as_str() else {
        issues.push(invalid_type(
            owned_path(path),
            "string",
            received_type(value),
        ));
        return None;
    };
    let length = zod_string_len(value);
    if length > maximum {
        issues.push(too_big(
            owned_path(path),
            "string",
            maximum,
            format!("Too big: expected string to have <={maximum} characters"),
        ));
        return None;
    }
    Some(value.to_string())
}

fn stable_agent_run_id<P: AsRef<str>>(
    object: &Map<String, Value>,
    key: &str,
    path: &[P],
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let value = required_text(object, key, path, 1, 120, issues)?;
    let mut bytes = value.bytes();
    let valid = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'));
    if !valid {
        issues.push(Issue::new(
            owned_path(path),
            "Invalid string: must match pattern /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/",
        ));
        return None;
    }
    Some(value)
}

fn runtime_root(
    value: Option<&Value>,
    base: &[String],
    absolute_message: &str,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let value = match value {
        Some(value) => required_object(Some(value), base, issues)?,
        None => {
            issues.push(invalid_type(base.to_vec(), "object", "undefined"));
            return None;
        }
    };
    let mut local = Vec::new();
    let mut normalized = Map::new();
    if let Some(kind) = required_literal(
        value.get("type"),
        &append_path(base, "type"),
        "runtime-path",
        &mut local,
    ) {
        normalized.insert("type".to_string(), Value::String(kind));
    }
    if let Some(path) = required_text(
        value,
        "path",
        &append_path(base, "path"),
        1,
        4096,
        &mut local,
    ) {
        if !path.starts_with('/') {
            local.push(Issue::new(append_path(base, "path"), absolute_message));
        } else {
            normalized.insert("path".to_string(), Value::String(path));
        }
    }
    unsupported_keys(value, &["type", "path"], &mut local, base);
    extend_nested(issues, local, Some(normalized))
}

fn writable_roots(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Value> {
    let base = path(&["writableRoots"]);
    let value = runtime_roots_object(value, &base, issues)?;
    let mut local = Vec::new();
    let mut normalized = Map::new();
    for key in ["workspace", "shared"] {
        if let Some(root) = runtime_root(
            value.get(key),
            &append_path(&base, key),
            "Agent Run runtime paths must be absolute POSIX paths.",
            &mut local,
        ) {
            normalized.insert(key.to_string(), root);
        }
    }
    unsupported_keys(value, &["workspace", "shared"], &mut local, &base);
    extend_nested(issues, local, Some(normalized))
}

fn runtime_roots_object<'a>(
    value: Option<&'a Value>,
    base: &[String],
    issues: &mut Vec<Issue>,
) -> Option<&'a Map<String, Value>> {
    match value {
        Some(value) => match value.as_object() {
            Some(value) => Some(value),
            None => {
                issues.push(invalid_type(base.to_vec(), "object", received_type(value)));
                None
            }
        },
        None => {
            issues.push(invalid_type(base.to_vec(), "object", "undefined"));
            None
        }
    }
}

fn enabled_tools(value: Option<&Value>, issues: &mut Vec<Issue>) -> Option<Vec<Value>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    let Some(values) = value.as_array() else {
        issues.push(invalid_type(
            path(&["enabledTools"]),
            "array",
            received_type(value),
        ));
        return None;
    };
    if values.len() > 100 {
        issues.push(too_big(
            path(&["enabledTools"]),
            "array",
            100,
            "Too big: expected array to have <=100 items".to_string(),
        ));
        return None;
    }
    let mut normalized = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let item_path = indexed_path(&["enabledTools"], index);
        let Some(tool) = value.as_str() else {
            issues.push(invalid_type(item_path, "string", received_type(value)));
            continue;
        };
        if !controlled_instance_protocol::AI_SESSION_AGENT_TOOL_NAMES.contains(&tool) {
            issues.push(invalid_value(item_path, &["agent_run"]));
            continue;
        }
        normalized.push(Value::String(tool.to_string()));
    }
    Some(normalized)
}

fn optional_text<P: AsRef<str>>(
    object: &Map<String, Value>,
    key: &str,
    path: &[P],
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    object
        .get(key)
        .and_then(|value| text(value, path, minimum, maximum, issues))
}

fn text<P: AsRef<str>>(
    value: &Value,
    path: &[P],
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let Some(value) = value.as_str() else {
        issues.push(invalid_type(
            owned_path(path),
            "string",
            received_type(value),
        ));
        return None;
    };
    let value = trim_js_whitespace(value);
    let length = zod_string_len(value);
    if length < minimum {
        issues.push(too_small(
            owned_path(path),
            "string",
            minimum,
            format!("Too small: expected string to have >={minimum} characters"),
        ));
        return None;
    }
    if length > maximum {
        issues.push(too_big(
            owned_path(path),
            "string",
            maximum,
            format!("Too big: expected string to have <={maximum} characters"),
        ));
        return None;
    }
    Some(value.to_string())
}

fn required_literal<P: AsRef<str>>(
    value: Option<&Value>,
    path: &[P],
    expected: &str,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(value) if value == expected => Some(value.to_string()),
        _ => {
            issues.push(Issue::new(
                owned_path(path),
                format!("Invalid input: expected \"{expected}\""),
            ));
            None
        }
    }
}

fn required_enum<P: AsRef<str>>(
    object: &Map<String, Value>,
    key: &str,
    path: &[P],
    values: &[&str],
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match object.get(key) {
        Some(value) => enum_value(value, path, values, issues),
        None => {
            issues.push(invalid_value(owned_path(path), values));
            None
        }
    }
}

fn optional_enum<P: AsRef<str>>(
    object: &Map<String, Value>,
    key: &str,
    path: &[P],
    values: &[&str],
    issues: &mut Vec<Issue>,
) -> Option<String> {
    object
        .get(key)
        .and_then(|value| enum_value(value, path, values, issues))
}

fn enum_value<P: AsRef<str>>(
    value: &Value,
    path: &[P],
    values: &[&str],
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match value.as_str() {
        Some(value) if values.contains(&value) => Some(value.to_string()),
        _ => {
            issues.push(invalid_value(owned_path(path), values));
            None
        }
    }
}

fn required_safe_integer<P: AsRef<str>>(
    value: Option<&Value>,
    path: &[P],
    issues: &mut Vec<Issue>,
) -> Option<u64> {
    let Some(value) = value else {
        issues.push(invalid_type(owned_path(path), "number", "undefined"));
        return None;
    };
    let Some(number) = value.as_f64() else {
        issues.push(invalid_type(
            owned_path(path),
            "number",
            received_type(value),
        ));
        return None;
    };
    if !number.is_finite() || number.fract() != 0.0 || !(0.0..=MAX_SAFE_INTEGER).contains(&number) {
        let message = if number < 0.0 {
            "Too small: expected number to be >=0".to_string()
        } else if number > MAX_SAFE_INTEGER {
            "Too big: expected number to be <=9007199254740991".to_string()
        } else {
            "Invalid input: expected int, received number".to_string()
        };
        issues.push(Issue::new(owned_path(path), message));
        return None;
    }
    Some(number as u64)
}

fn required_object<'a, P: AsRef<str>>(
    value: Option<&'a Value>,
    path: &[P],
    issues: &mut Vec<Issue>,
) -> Option<&'a Map<String, Value>> {
    match value {
        Some(value) => match value.as_object() {
            Some(value) => Some(value),
            None => {
                issues.push(invalid_type(
                    owned_path(path),
                    "object",
                    received_type(value),
                ));
                None
            }
        },
        None => {
            issues.push(invalid_type(owned_path(path), "object", "undefined"));
            None
        }
    }
}

fn unsupported_keys<P: AsRef<str>>(
    object: &Map<String, Value>,
    allowed: &[&str],
    issues: &mut Vec<Issue>,
    path: &[P],
) {
    let keys = object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return;
    }
    let listed = keys
        .iter()
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>()
        .join(", ");
    issues.push(Issue::new(
        owned_path(path),
        format!(
            "Unrecognized key{}: {listed}",
            if keys.len() == 1 { "" } else { "s" }
        ),
    ));
}

fn extend_nested(
    issues: &mut Vec<Issue>,
    nested: Vec<Issue>,
    normalized: Option<Map<String, Value>>,
) -> Option<Value> {
    if nested.is_empty() {
        normalized.map(Value::Object)
    } else {
        issues.extend(nested);
        None
    }
}

fn invalid_type(path: Vec<String>, expected: &str, received: &str) -> Issue {
    Issue::new(
        path,
        format!("Invalid input: expected {expected}, received {received}"),
    )
}

fn invalid_value(path: Vec<String>, values: &[&str]) -> Issue {
    let listed = values
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join("|");
    Issue::new(path, format!("Invalid option: expected one of {listed}"))
}

fn too_small(path: Vec<String>, origin: &str, minimum: usize, message: String) -> Issue {
    let _ = (origin, minimum);
    Issue::new(path, message)
}

fn too_big(path: Vec<String>, origin: &str, maximum: usize, message: String) -> Issue {
    let _ = (origin, maximum);
    Issue::new(path, message)
}

fn received_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn path(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_string()).collect()
}

fn path_parts(parts: &[&str]) -> Vec<String> {
    path(parts)
}

fn indexed_path(parts: &[&str], index: usize) -> Vec<String> {
    let mut path = path(parts);
    path.push(index.to_string());
    path
}

fn append_path(path: &[String], key: &str) -> Vec<String> {
    let mut result = path.to_vec();
    result.push(key.to_string());
    result
}

fn owned_path<P: AsRef<str>>(path: &[P]) -> Vec<String> {
    path.iter().map(|part| part.as_ref().to_string()).collect()
}

fn trim_js_whitespace(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

fn zod_string_len(value: &str) -> usize {
    value.chars().count()
}

fn is_absolute_runtime_path(value: &str) -> bool {
    if value.starts_with('/') {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn prefixed_identifier(value: &str, prefix: &str) -> bool {
    let Some(identifier) = value.strip_prefix(prefix) else {
        return false;
    };
    !identifier.is_empty()
        && !identifier
            .chars()
            .any(|character| character.is_whitespace() || character == '/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn errors(value: Value) -> Vec<String> {
        normalize_ai_session_create_body(&value).expect_err("request should be rejected")
    }

    #[test]
    fn validation_matches_top_level_zod_order_and_paths() {
        assert_eq!(
            errors(json!({})),
            vec![
                "message: Invalid input: expected string, received undefined",
                "clientRequestId: Invalid input: expected string, received undefined",
                "agent: Invalid input: expected string, received undefined",
                "cwd: Invalid input: expected object, received undefined",
            ]
        );
        assert_eq!(
            errors(json!({
                "agent": "codex",
                "cwd": { "type": "runtime-path", "path": "/tmp" },
                "clientRequestId": "request",
                "message": "hello",
                "extra": true
            })),
            vec!["body: Unrecognized key: \"extra\""]
        );
    }

    #[test]
    fn validation_tracks_nested_zod_paths() {
        assert_eq!(
            errors(json!({
                "agent": "codex",
                "cwd": { "type": "runtime-path", "path": "relative" },
                "clientRequestId": "request",
                "message": "hello",
                "workspaceSelection": { "type": "new-worktree" }
            })),
            vec![
                "cwd.path: Runtime paths must be absolute in the target controlled instance.",
                "workspaceSelection.branchName: Invalid input: expected string, received undefined",
                "workspaceSelection.startRef: Invalid input: expected string, received undefined",
                "workspaceSelection.expectedSnapshotId: Invalid input: expected string, received undefined",
            ]
        );
    }

    #[test]
    fn validation_normalizes_trimmed_values_and_attachment_defaults() {
        let value = normalize_ai_session_create_body(&json!({
            "agent": " codex ",
            "cwd": { "type": "runtime-path", "path": " /tmp " },
            "clientRequestId": " request ",
            "message": " hello ",
            "attachments": [{
                "id": " draft ",
                "source": { "type": "upload-ref" }
            }]
        }))
        .expect("valid request");
        assert_eq!(value["agent"], "codex");
        assert_eq!(value["cwd"]["path"], "/tmp");
        assert_eq!(value["clientRequestId"], "request");
        assert_eq!(value["message"], "hello");
        assert_eq!(value["attachments"][0]["id"], "draft");
    }

    #[test]
    fn message_validation_matches_request_limits_and_strict_nested_objects() {
        let attachments = (0..7)
            .map(|_| json!({ "id": "att_x", "source": { "type": "upload-ref" } }))
            .collect::<Vec<_>>();
        assert_eq!(
            normalize_ai_session_message_body(&json!({
                "message": "hello",
                "attachments": attachments
            }))
            .expect_err("seven attachments should fail"),
            vec!["attachments: Too big: expected array to have <=6 items"]
        );

        let references = (0..21)
            .map(|_| json!({ "kind": "skill", "name": "s", "path": "/tmp/s" }))
            .collect::<Vec<_>>();
        assert_eq!(
            normalize_ai_session_message_body(&json!({
                "message": "hello",
                "references": references
            }))
            .expect_err("twenty-one references should fail"),
            vec!["references: Too big: expected array to have <=20 items"]
        );

        assert_eq!(
            normalize_ai_session_message_body(&json!({
                "message": "hello",
                "attachments": [{
                    "id": "att_x",
                    "source": { "type": "upload-ref" },
                    "extra": true
                }]
            }))
            .expect_err("unknown attachment keys should fail"),
            vec!["attachments.0: Invalid input"]
        );
        assert_eq!(
            normalize_ai_session_message_body(&json!({
                "message": "hello",
                "references": [{
                    "kind": "skill",
                    "name": "s",
                    "path": "/tmp/s",
                    "extra": true
                }]
            }))
            .expect_err("unknown reference keys should fail"),
            vec!["references.0: Unrecognized key: \"extra\""]
        );
    }

    #[test]
    fn command_validation_rejects_null_and_uses_zod_codepoint_lengths() {
        assert_eq!(
            normalize_ai_session_command_body(&json!({
                "command": "goal",
                "argument": null
            }))
            .expect_err("null argument should fail"),
            vec!["argument: Invalid input: expected string, received null"]
        );
        assert!(normalize_ai_session_command_body(&json!({
            "command": "goal",
            "argument": "😀".repeat(4_000)
        }))
        .is_ok());
        assert_eq!(
            normalize_ai_session_command_body(&json!({
                "command": "goal",
                "argument": "😀".repeat(4_001)
            }))
            .expect_err("oversized argument should fail"),
            vec!["argument: Too big: expected string to have <=4000 characters"]
        );
    }

    #[test]
    fn model_selection_and_reasoning_validation_are_strict_and_trimmed() {
        assert_eq!(
            normalize_ai_session_resume_body(&json!({
                "modelSelection": { "modelEntityId": "m1", "modelName": "" }
            }))
            .expect_err("empty model name should fail"),
            vec!["modelSelection.modelName: Too small: expected string to have >=1 characters"]
        );
        assert_eq!(
            normalize_ai_session_resume_body(&json!({
                "modelSelection": { "modelEntityId": "m1", "modelName": "m", "extra": true }
            }))
            .expect_err("unknown model keys should fail"),
            vec!["modelSelection: Unrecognized key: \"extra\""]
        );
        assert_eq!(
            normalize_ai_session_resume_body(&json!({ "reasoningEffort": "bogus" }))
                .expect_err("invalid reasoning effort should fail"),
            vec!["reasoningEffort: Invalid option: expected one of \"none\"|\"minimal\"|\"low\"|\"medium\"|\"high\"|\"xhigh\"|\"max\"|\"ultra\""]
        );
        let normalized = normalize_ai_session_model_selection_body(&json!({
            "clientRequestId": " request ",
            "modelSelection": {
                "modelEntityId": " model ",
                "modelName": " display ",
                "modelUpstreamName": " upstream "
            }
        }))
        .expect("valid selection");
        assert_eq!(normalized["clientRequestId"], "request");
        assert_eq!(normalized["modelSelection"]["modelEntityId"], "model");
        assert_eq!(normalized["modelSelection"]["modelName"], "display");
        assert_eq!(
            normalized["modelSelection"]["modelUpstreamName"],
            "upstream"
        );
    }

    #[test]
    fn fork_queue_timeline_and_rename_validation_matches_zod_contracts() {
        assert_eq!(
            normalize_ai_session_fork_body(&json!({
                "clientRequestId": "req-1",
                "workspace": { "mode": "bogus" }
            }))
            .expect_err("invalid fork mode should fail"),
            vec![
                "workspace.mode: Invalid option: expected one of \"current\"|\"managed-worktree\""
            ]
        );
        assert_eq!(
            normalize_ai_session_queue_edit_body(&json!({
                "expectedRevision": 0,
                "message": "edit",
                "attachments": [{
                    "id": "att_x",
                    "kind": "file",
                    "source": { "type": "retained" }
                }]
            }))
            .expect_err("retained attachments should only contain id and source"),
            vec!["attachments.0: Unrecognized key: \"kind\""]
        );
        assert_eq!(
            normalize_ai_session_queue_reorder_body(&json!({
                "expectedRevision": 0,
                "queueIds": [""]
            }))
            .expect_err("blank queue id should fail"),
            vec!["queueIds.0: Too small: expected string to have >=1 characters"]
        );
        assert_eq!(
            normalize_ai_session_timeline_sync_body(&json!({
                "knownItems": [{ "id": "x", "revision": "r", "extra": true }]
            }))
            .expect_err("unknown timeline keys should fail"),
            vec!["knownItems.0: Unrecognized key: \"extra\""]
        );
        assert_eq!(
            normalize_ai_session_rename_body(&json!({
                "title": "ok",
                "expectedTitle": "x".repeat(241),
                "clientRequestId": "req-1"
            }))
            .expect_err("oversized expected title should fail"),
            vec!["expectedTitle: Too big: expected string to have <=240 characters"]
        );
        assert_eq!(
            normalize_ai_session_queue_edit_body(&json!({
                "expectedRevision": 0,
                "message": "😀".repeat(20_001)
            }))
            .expect_err("oversized queue edit should fail"),
            vec!["message: Too big: expected string to have <=20000 characters"]
        );
        assert_eq!(
            normalize_ai_session_rename_body(&json!({
                "title": "😀".repeat(121),
                "clientRequestId": "req-1"
            }))
            .expect_err("oversized rename should fail"),
            vec!["title: Too big: expected string to have <=120 characters"]
        );
        assert!(normalize_ai_session_rename_body(&json!({
            "title": format!("{} ", "a".repeat(120)),
            "clientRequestId": "req-1"
        }))
        .is_ok());
    }

    #[test]
    fn internal_story_and_agent_run_bodies_follow_their_protocol_zod_contracts() {
        let story = json!({
            "agent": "codex",
            "cwd": { "type": "runtime-path", "path": " /workspace " },
            "cwdFolderId": " folder ",
            "message": " run ",
            "clientRequestId": "😀".repeat(160),
            "storyId": "😀".repeat(120),
            "gitSelection": { "mode": "current-folder", "branch": " main " }
        });
        let normalized = normalize_story_automation_create_body(&story).expect("story body");
        assert_eq!(normalized["cwd"]["path"], "/workspace");
        assert_eq!(normalized["cwdFolderId"], "folder");
        assert_eq!(normalized["message"], "run");
        assert_eq!(normalized["gitSelection"]["branch"], "main");

        let mut oversized_story = story.clone();
        oversized_story["storyId"] = json!("😀".repeat(121));
        assert_eq!(
            normalize_story_automation_create_body(&oversized_story)
                .expect_err("storyId must use the Node 120 character limit"),
            vec!["storyId: Too big: expected string to have <=120 characters"]
        );
        let mut exclusive = story;
        exclusive["workspaceSelection"] = json!({ "type": "current-folder", "branch": "main" });
        assert_eq!(
            normalize_story_automation_create_body(&exclusive).expect_err("exclusive selections"),
            vec!["workspaceSelection: gitSelection and workspaceSelection are mutually exclusive."]
        );

        let agent_run = json!({
            "runId": "run_1",
            "memberId": "member_1",
            "clientRequestId": "😀".repeat(160),
            "providerId": "codex",
            "cwd": { "type": "runtime-path", "path": "/workspace" },
            "writableRoots": {
                "workspace": { "type": "runtime-path", "path": "/workspace" },
                "shared": { "type": "runtime-path", "path": "/shared" }
            },
            "prompt": "  do work  ",
            "appendedPrompt": "  preserve spaces  "
        });
        let normalized =
            normalize_agent_run_member_create_body(&agent_run).expect("agent run body");
        assert_eq!(normalized["prompt"], "do work");
        assert_eq!(normalized["appendedPrompt"], "  preserve spaces  ");
        assert_eq!(normalized["enabledTools"], json!([]));

        let mut invalid = agent_run;
        invalid["runId"] = json!("🦀");
        assert_eq!(
            normalize_agent_run_member_create_body(&invalid).expect_err("stable id"),
            vec!["runId: Invalid string: must match pattern /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/"]
        );
    }

    #[test]
    fn message_boundaries_follow_zod_v4_codepoint_counting() {
        assert!(normalize_ai_session_message_body(&json!({
            "message": "😀".repeat(20_000)
        }))
        .is_ok());
        assert_eq!(
            normalize_ai_session_message_body(&json!({
                "message": "😀".repeat(20_001)
            }))
            .expect_err("oversized message should fail"),
            vec!["message: Too big: expected string to have <=20000 characters"]
        );
        assert_eq!(
            normalize_empty_object_body(&json!({ "extra": true }))
                .expect_err("complete body must be empty"),
            vec!["body: Unrecognized key: \"extra\""]
        );
    }
}
