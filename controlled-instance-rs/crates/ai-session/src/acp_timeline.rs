use agent_client_protocol::v1::schema::{
    ToolCallContent, ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use controlled_instance_protocol::{AiSessionTimelineActivityStatus, AiSessionTimelineItem};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

const MAX_TITLE: usize = 240;
const MAX_SUMMARY: usize = 4_000;
const MAX_INPUT: usize = 100_000;
const MAX_OUTPUT: usize = 1_000_000;
const MAX_PATHS: usize = 500;
const MAX_PATH: usize = 4_096;
const DIFF_CONTEXT: usize = 3;

const DIRECTORY_KEYS: &[&str] = &[
    "targetDirectory",
    "target_directory",
    "directory",
    "directoryPath",
    "directory_path",
    "dir",
];
const FILE_KEYS: &[&str] = &[
    "path",
    "filePath",
    "file_path",
    "file",
    "targetFile",
    "target_file",
    "filename",
];
const SEARCH_PATH_KEYS: &[&str] = &["path", "directory", "dir", "cwd", "root"];
const SOURCE_KEYS: &[&str] = &[
    "source",
    "from",
    "oldPath",
    "old_path",
    "path",
    "filePath",
    "file_path",
];
const DESTINATION_KEYS: &[&str] = &[
    "destination",
    "destinationPath",
    "destination_path",
    "to",
    "newPath",
    "new_path",
    "movePath",
    "move_path",
];
const OLD_TEXT_KEYS: &[&str] = &["oldText", "old_text", "oldString", "old_string", "before"];
const NEW_TEXT_KEYS: &[&str] = &["newText", "new_text", "newString", "new_string", "after"];

#[derive(Debug, Clone)]
pub(crate) struct AcpToolSnapshot {
    id: String,
    turn_id: String,
    title: String,
    name: Option<String>,
    kind: ToolKind,
    status: Option<ToolCallStatus>,
    content: Vec<ToolCallContent>,
    locations: Vec<ToolCallLocation>,
    raw_input: Option<Value>,
    raw_output: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpFileChange {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    move_path: Option<String>,
    diff: String,
}

impl AcpToolSnapshot {
    pub(crate) fn new(id: String, turn_id: String) -> Self {
        Self {
            id,
            turn_id,
            title: "Tool call".into(),
            name: None,
            kind: ToolKind::Other,
            status: None,
            content: Vec::new(),
            locations: Vec::new(),
            raw_input: None,
            raw_output: None,
        }
    }

    pub(crate) fn apply(&mut self, update: ToolCallUpdate) {
        let fields = update.fields;
        if let Some(title) = fields.title.and_then(|title| clean_text(&title, MAX_TITLE)) {
            self.title = title;
        }
        if let Some(name) = fields.name.and_then(|name| clean_text(&name, MAX_TITLE)) {
            self.name = Some(name);
        }
        if let Some(kind) = fields.kind {
            self.kind = kind;
        }
        if let Some(status) = fields.status {
            self.status = Some(status);
        }
        if let Some(content) = fields.content {
            self.content = content;
        }
        if let Some(locations) = fields.locations {
            self.locations = locations;
        }
        if let Some(raw_input) = fields.raw_input {
            self.raw_input = Some(raw_input);
        }
        if let Some(raw_output) = fields.raw_output {
            self.raw_output = Some(raw_output);
        }
    }

    pub(crate) fn activity(&self) -> AiSessionTimelineItem {
        let paths = self.activity_paths();
        let text = self.output_text(matches!(self.kind, ToolKind::Other | ToolKind::SwitchMode));
        if is_list_tool(self, self.kind) {
            return self.file_list_activity(paths, text);
        }
        match self.kind {
            ToolKind::Read => {
                let path = self.file_path().or_else(|| paths.first().cloned());
                self.activity_item(
                    "fileRead",
                    "Read",
                    path.as_deref().map(runtime_path_basename),
                    text,
                    path.map(|path| vec![path]).unwrap_or(paths),
                    None,
                )
            }
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move => {
                self.file_change_activity(paths, text)
            }
            ToolKind::Search => {
                let query = raw_string(
                    self.raw_input.as_ref(),
                    &["query", "pattern", "regex", "search"],
                );
                let path = raw_string(self.raw_input.as_ref(), SEARCH_PATH_KEYS)
                    .or_else(|| paths.first().cloned());
                let summary = match (query, path) {
                    (Some(query), Some(path)) => Some(format!("{query} in {path}")),
                    (Some(query), None) => Some(query),
                    (None, Some(path)) => Some(path),
                    (None, None) => clean_text(&self.title, MAX_SUMMARY),
                };
                self.activity_item("fileSearch", "Search", summary, text, paths, None)
            }
            ToolKind::Execute => self.activity_item(
                "commandExecution",
                "Command",
                None,
                text,
                Vec::new(),
                Some(command_text(self)),
            ),
            ToolKind::Fetch => {
                let url = raw_string(self.raw_input.as_ref(), &["url", "href"])
                    .or_else(|| clean_text(&self.title, MAX_SUMMARY));
                self.activity_item("webFetch", "Fetch URL", url, text, Vec::new(), None)
            }
            ToolKind::Think => {
                self.activity_item("reasoning", "Reasoning", None, text, Vec::new(), None)
            }
            _ => self.activity_item(
                "dynamicToolCall",
                clean_text(&self.title, MAX_TITLE)
                    .or_else(|| {
                        self.name
                            .as_deref()
                            .and_then(|name| clean_text(name, MAX_TITLE))
                    })
                    .as_deref()
                    .unwrap_or("Tool"),
                None,
                text,
                paths,
                raw_input_text(self.raw_input.as_ref()),
            ),
        }
    }

    fn file_list_activity(
        &self,
        paths: Vec<String>,
        output: Option<String>,
    ) -> AiSessionTimelineItem {
        let path = list_path(self).or_else(|| paths.first().cloned());
        let list_paths = path.map(|path| vec![path]).unwrap_or(paths);
        let summary = if list_paths.is_empty() {
            clean_text(&self.title, MAX_SUMMARY)
        } else {
            Some(list_paths.join(", "))
        };
        self.activity_item("fileList", "List", summary, output, list_paths, None)
    }

    fn file_change_activity(
        &self,
        paths: Vec<String>,
        text: Option<String>,
    ) -> AiSessionTimelineItem {
        let changes = file_changes(self);
        let change_paths = unique_strings(
            changes
                .iter()
                .map(|change| change.path.clone())
                .chain(paths)
                .collect(),
        );
        let summary = if change_paths.is_empty() {
            clean_text(&self.title, MAX_SUMMARY)
        } else {
            Some(
                change_paths
                    .iter()
                    .map(|path| runtime_path_basename(path))
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        };
        let output = if changes.is_empty() {
            text
        } else {
            serde_json::to_string(&changes).ok()
        };
        self.activity_item(
            "fileChange",
            "File change",
            summary,
            output,
            change_paths,
            None,
        )
    }

    fn activity_item(
        &self,
        activity_kind: &str,
        title: &str,
        summary: Option<String>,
        output: Option<String>,
        paths: Vec<String>,
        command: Option<String>,
    ) -> AiSessionTimelineItem {
        let paths = normalize_paths(paths);
        AiSessionTimelineItem::Activity {
            id: self.id.clone(),
            turn_id: self.turn_id.clone(),
            activity_kind: activity_kind.into(),
            title: clean_text(title, MAX_TITLE).unwrap_or_else(|| "Tool call".into()),
            status: Some(activity_status(self.status)),
            summary: summary.and_then(|summary| clean_text(&summary, MAX_SUMMARY)),
            input: command.and_then(|command| non_empty_text(&command, MAX_INPUT)),
            output: output.and_then(|output| non_empty_text(&output, MAX_OUTPUT)),
            paths: (!paths.is_empty()).then_some(paths),
            exit_code: output_exit_code(self.raw_output.as_ref()),
            duration_ms: None,
        }
    }

    fn output_text(&self, allow_json_fallback: bool) -> Option<String> {
        content_text(&self.content)
            .or_else(|| unknown_text(self.raw_output.as_ref(), allow_json_fallback, 0))
    }

    fn activity_paths(&self) -> Vec<String> {
        let mut paths = location_paths(&self.locations);
        paths.extend(
            FILE_KEYS
                .iter()
                .filter_map(|key| raw_string(self.raw_input.as_ref(), &[*key])),
        );
        normalize_paths(paths)
    }

    fn file_path(&self) -> Option<String> {
        raw_string(self.raw_input.as_ref(), FILE_KEYS)
            .or_else(|| location_paths(&self.locations).into_iter().next())
    }
}

fn is_list_tool(snapshot: &AcpToolSnapshot, kind: ToolKind) -> bool {
    if !matches!(kind, ToolKind::Read | ToolKind::Other) {
        return false;
    }
    let name = normalize_tool_name(snapshot.name.as_deref());
    if name == "ls"
        || name == "dir"
        || name == "directory"
        || name == "readdir"
        || name == "list"
        || name.contains("list")
    {
        return true;
    }
    if DIRECTORY_KEYS
        .iter()
        .any(|key| raw_string(snapshot.raw_input.as_ref(), &[*key]).is_some())
    {
        return true;
    }
    list_title_path(&snapshot.title).is_some()
}

fn list_path(snapshot: &AcpToolSnapshot) -> Option<String> {
    raw_string(snapshot.raw_input.as_ref(), DIRECTORY_KEYS)
        .or_else(|| raw_string(snapshot.raw_input.as_ref(), FILE_KEYS))
        .or_else(|| location_paths(&snapshot.locations).into_iter().next())
        .or_else(|| list_title_path(&snapshot.title))
}

fn list_title_path(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["list", "ls", "dir", "directory"] {
        let Some(rest) = lower.strip_prefix(prefix) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let separator = rest.chars().next()?;
        if separator != ':' && !separator.is_whitespace() {
            continue;
        }
        let value = trimmed[prefix.len()..]
            .trim_start_matches(|character: char| character == ':' || character.is_whitespace());
        if let Some(path) = clean_path(value) {
            return Some(path);
        }
    }
    None
}

fn command_text(snapshot: &AcpToolSnapshot) -> String {
    let command = raw_string(snapshot.raw_input.as_ref(), &["command", "cmd"]);
    let Some(command) = command else {
        return clean_text(&snapshot.title, MAX_INPUT).unwrap_or_else(|| "Command".into());
    };
    let args = snapshot
        .raw_input
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|record| record_value(record, &["args", "arguments"]))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if args.is_empty() {
        command
    } else {
        format!("{command} {}", args.join(" "))
    }
}

fn content_text(content: &[ToolCallContent]) -> Option<String> {
    let text = content
        .iter()
        .filter_map(|entry| match entry {
            ToolCallContent::Content(content) => match &content.content {
                agent_client_protocol::v1::schema::ContentBlock::Text(text) => {
                    Some(text.text.as_str())
                }
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    non_empty_text(&text, MAX_OUTPUT)
}

fn file_changes(snapshot: &AcpToolSnapshot) -> Vec<AcpFileChange> {
    let mut changes = Vec::new();
    for entry in &snapshot.content {
        let ToolCallContent::Diff(diff) = entry else {
            continue;
        };
        let Some(path) = clean_path(&diff.path.to_string_lossy()) else {
            continue;
        };
        let kind = if diff.old_text.is_none() {
            "add"
        } else if diff.new_text.is_empty() {
            "delete"
        } else {
            "update"
        };
        changes.push(AcpFileChange {
            path,
            kind: Some(kind.into()),
            move_path: None,
            diff: unified_diff(diff.old_text.as_deref(), &diff.new_text),
        });
    }
    if !changes.is_empty() {
        return unique_changes(changes);
    }

    let paths = snapshot.activity_paths();
    match snapshot.kind {
        ToolKind::Delete => {
            let path = raw_string(snapshot.raw_input.as_ref(), FILE_KEYS)
                .or_else(|| paths.first().cloned());
            path.into_iter()
                .map(|path| AcpFileChange {
                    path,
                    kind: Some("delete".into()),
                    move_path: None,
                    diff: String::new(),
                })
                .collect()
        }
        ToolKind::Move => {
            let Some(path) = raw_string(snapshot.raw_input.as_ref(), SOURCE_KEYS)
                .or_else(|| paths.first().cloned())
            else {
                return Vec::new();
            };
            let move_path = raw_string(snapshot.raw_input.as_ref(), DESTINATION_KEYS)
                .or_else(|| paths.iter().find(|candidate| **candidate != path).cloned());
            vec![AcpFileChange {
                path,
                kind: Some("move".into()),
                move_path,
                diff: String::new(),
            }]
        }
        ToolKind::Edit => {
            let path = raw_string(snapshot.raw_input.as_ref(), FILE_KEYS)
                .or_else(|| paths.first().cloned());
            let old_text = raw_string(snapshot.raw_input.as_ref(), OLD_TEXT_KEYS);
            let new_text = raw_string(snapshot.raw_input.as_ref(), NEW_TEXT_KEYS);
            match (path, old_text, new_text) {
                (Some(path), Some(old_text), Some(new_text)) => vec![AcpFileChange {
                    path,
                    kind: Some("update".into()),
                    move_path: None,
                    diff: unified_diff(Some(&old_text), &new_text),
                }],
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

fn unique_changes(changes: Vec<AcpFileChange>) -> Vec<AcpFileChange> {
    let mut seen = HashSet::new();
    changes
        .into_iter()
        .filter(|change| {
            seen.insert(format!(
                "{}\0{}",
                change.path,
                change.move_path.as_deref().unwrap_or_default()
            ))
        })
        .collect()
}

fn unified_diff(old_text: Option<&str>, new_text: &str) -> String {
    let old_lines = split_lines(old_text.unwrap_or_default());
    let new_lines = split_lines(new_text);
    if old_text.is_some() && old_lines == new_lines {
        return String::new();
    }
    if old_text.is_none() && new_lines.is_empty() {
        return String::new();
    }

    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_lines.len().saturating_sub(prefix)
        && suffix < new_lines.len().saturating_sub(prefix)
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let old_start = prefix.saturating_sub(DIFF_CONTEXT);
    let new_start = old_start;
    let old_end = old_lines
        .len()
        .saturating_sub(suffix)
        .saturating_add(DIFF_CONTEXT)
        .min(old_lines.len());
    let new_end = new_lines
        .len()
        .saturating_sub(suffix)
        .saturating_add(DIFF_CONTEXT)
        .min(new_lines.len());
    let old_count = old_end - old_start;
    let new_count = new_end - new_start;
    let header = if old_lines.is_empty() {
        format!("@@ -0,0 +1,{} @@", new_lines.len())
    } else if new_lines.is_empty() {
        format!("@@ -1,{} +0,0 @@", old_lines.len())
    } else {
        format!(
            "@@ -{},{} +{},{} @@",
            old_start + 1,
            old_count,
            new_start + 1,
            new_count
        )
    };
    let mut body = Vec::new();
    for line in &old_lines[old_start..prefix] {
        body.push(format!(" {line}"));
    }
    for line in &old_lines[prefix..old_end - suffix] {
        body.push(format!("-{line}"));
    }
    for line in &new_lines[prefix..new_end - suffix] {
        body.push(format!("+{line}"));
    }
    for line in &old_lines[old_end - suffix..old_end] {
        body.push(format!(" {line}"));
    }
    std::iter::once(header)
        .chain(body)
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_lines(value: &str) -> Vec<&str> {
    let mut lines = value.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

fn activity_status(status: Option<ToolCallStatus>) -> AiSessionTimelineActivityStatus {
    match status {
        Some(ToolCallStatus::InProgress) => AiSessionTimelineActivityStatus::Running,
        Some(ToolCallStatus::Completed) => AiSessionTimelineActivityStatus::Completed,
        Some(ToolCallStatus::Failed) => AiSessionTimelineActivityStatus::Failed,
        _ => AiSessionTimelineActivityStatus::Waiting,
    }
}

fn location_paths(locations: &[ToolCallLocation]) -> Vec<String> {
    locations
        .iter()
        .filter_map(|location| clean_path(&location.path.to_string_lossy()))
        .collect()
}

fn normalize_paths(paths: Vec<String>) -> Vec<String> {
    unique_strings(
        paths
            .into_iter()
            .filter_map(|path| clean_path(&path))
            .collect(),
    )
    .into_iter()
    .take(MAX_PATHS)
    .map(|path| take_chars(&path, MAX_PATH))
    .collect()
}

fn clean_path(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_matches('`').trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn raw_string(value: Option<&Value>, keys: &[&str]) -> Option<String> {
    match value? {
        Value::String(value) => clean_text(value, MAX_SUMMARY),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Object(record) => record_value(record, keys).and_then(|value| match value {
            Value::String(value) => clean_text(value, MAX_SUMMARY),
            Value::Number(value) => Some(value.to_string()),
            Value::Bool(value) => Some(value.to_string()),
            _ => None,
        }),
        _ => None,
    }
}

fn raw_input_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => non_empty_text(value, MAX_INPUT),
        value => non_empty_text(&serde_json::to_string(value).ok()?, MAX_INPUT),
    }
}

fn unknown_text(value: Option<&Value>, allow_json_fallback: bool, depth: usize) -> Option<String> {
    let value = value?;
    if depth > 4 {
        return None;
    }
    match value {
        Value::String(value) => non_empty_text(value, MAX_OUTPUT),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(values) => {
            let text = values
                .iter()
                .filter_map(|value| unknown_text(Some(value), false, depth + 1))
                .collect::<Vec<_>>()
                .join("\n");
            non_empty_text(&text, MAX_OUTPUT).or_else(|| {
                allow_json_fallback
                    .then(|| serde_json::to_string(value).ok())
                    .flatten()
                    .and_then(|value| non_empty_text(&value, MAX_OUTPUT))
            })
        }
        Value::Object(record) => {
            let stdout = record_string(record, &["stdout"]);
            let stderr = record_string(record, &["stderr"]);
            if stdout.is_some() || stderr.is_some() {
                let text = [stdout, stderr]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("\n");
                return non_empty_text(&text, MAX_OUTPUT);
            }
            for key in [
                "output", "text", "content", "result", "message", "error", "value",
            ] {
                if let Some(nested) = record_value(record, &[key]) {
                    if let Some(text) = unknown_text(Some(nested), false, depth + 1) {
                        return Some(text);
                    }
                }
            }
            if allow_json_fallback {
                return serde_json::to_string(value)
                    .ok()
                    .and_then(|value| non_empty_text(&value, MAX_OUTPUT));
            }
            None
        }
        _ => None,
    }
}

fn record_string(record: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    record_value(record, keys).and_then(|value| match value {
        Value::String(value) => non_empty_text(value, MAX_OUTPUT),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    })
}

fn output_exit_code(value: Option<&Value>) -> Option<i64> {
    fn find(value: &Value, depth: usize) -> Option<i64> {
        if depth > 4 {
            return None;
        }
        match value {
            Value::Array(values) => values.iter().find_map(|value| find(value, depth + 1)),
            Value::Object(record) => {
                if let Some(value) = record_value(
                    record,
                    &["exitCode", "exit_code", "code", "statusCode", "status_code"],
                ) {
                    match value {
                        Value::Number(value) => {
                            if let Some(value) = value.as_i64() {
                                return Some(value);
                            }
                            if let Ok(value) = i64::try_from(value.as_u64()?) {
                                return Some(value);
                            }
                        }
                        Value::String(value) => {
                            if let Ok(value) = value.trim().parse::<i64>() {
                                return Some(value);
                            }
                        }
                        _ => {}
                    }
                }
                record.values().find_map(|value| find(value, depth + 1))
            }
            _ => None,
        }
    }
    value.and_then(|value| find(value, 0))
}

fn record_value<'a>(record: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| {
        let key = normalize_key(key);
        record
            .iter()
            .find(|(candidate, _)| normalize_key(candidate) == key)
            .map(|(_, value)| value)
    })
}

fn normalize_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn normalize_tool_name(value: Option<&str>) -> String {
    value.map(normalize_key).unwrap_or_default()
}

fn runtime_path_basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn clean_text(value: &str, limit: usize) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| take_chars(trimmed, limit))
}

fn non_empty_text(value: &str, limit: usize) -> Option<String> {
    (!value.trim().is_empty()).then(|| take_chars(value, limit))
}

fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
