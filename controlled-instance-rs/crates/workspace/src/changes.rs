use crate::{
    context::{
        display_path, hash_id, now_iso, require_operation_repository as require_repository,
        scope_wire,
    },
    error::RepositoryOperationError,
    files::validate_repository_relative_path,
    git::{GitError, GitProcess, GitProcessOptions},
    ResolvedRepository,
};
use controlled_instance_protocol::{
    RepositoryChangeScope, RepositoryDiff, RepositoryDiffContextGap, RepositoryDiffLine,
    RepositoryDiffLineKind, RepositoryMutationResult, RepositoryVersionedPath,
};
use regex::Regex;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
    sync::OnceLock,
};

const DEFAULT_DIFF_BYTES: u64 = 512 * 1024;
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;

pub async fn repository_diff(
    resolved: &ResolvedRepository,
    scope: RepositoryChangeScope,
    relative_path: &str,
    byte_limit: u64,
    include_context: bool,
    context_lines: usize,
) -> Result<RepositoryDiff, RepositoryOperationError> {
    if byte_limit == 0 || byte_limit > MAX_DIFF_BYTES {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_INVALID",
            "Diff byte limit is invalid.",
        ));
    }
    if context_lines == 0 || context_lines > 3_000 {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_INVALID",
            "Diff context line limit is invalid.",
        ));
    }
    validate_repository_relative_path(relative_path)?;
    let state = require_repository(resolved.clone())?;
    let changes = state.changes.as_ref().expect("required changes");
    let entry = changes
        .entries
        .iter()
        .find(|entry| entry.scope == scope && entry.path == relative_path)
        .ok_or_else(|| {
            RepositoryOperationError::with_current(
                "REPOSITORY_FILE_NOT_FOUND",
                "Change entry no longer exists.",
                &state,
            )
        })?;
    let root = state.worktree_root.as_ref().expect("required root");
    let (raw, binary) = if scope == RepositoryChangeScope::Untracked {
        untracked_unified_diff(root, relative_path, byte_limit)?
    } else {
        let git = GitProcess::new(root);
        let args = match scope {
            RepositoryChangeScope::Staged => vec![
                "--cached".to_string(),
                "--unified=3".to_string(),
                "--".to_string(),
                relative_path.to_string(),
            ],
            RepositoryChangeScope::Conflict => vec![
                "--base".to_string(),
                "--unified=3".to_string(),
                "--".to_string(),
                relative_path.to_string(),
            ],
            _ => vec![
                "--unified=3".to_string(),
                "--".to_string(),
                relative_path.to_string(),
            ],
        };
        let result = git
            .run_with_options(
                "diff",
                &args,
                GitProcessOptions {
                    output_limit_bytes: (byte_limit * 8).max(8 * 1024 * 1024) as usize,
                    ..GitProcessOptions::default()
                },
            )
            .await
            .map_err(|error| repository_git_error(error, &state))?;
        (
            result.stdout.clone(),
            result.stdout.contains("Binary files ")
                || result.stdout.contains("GIT binary patch")
                || result.stdout.contains("Binary files differ"),
        )
    };
    let truncated = truncate_utf8(&raw, byte_limit);
    let lines = if binary {
        Vec::new()
    } else {
        structured_diff_lines(&truncated.content)
    };
    let mut context_gaps = Vec::new();
    if include_context
        && !binary
        && !truncated.truncated
        && scope != RepositoryChangeScope::Untracked
        && lines
            .iter()
            .any(|line| line.kind == RepositoryDiffLineKind::Hunk && line.hunk_id.is_some())
    {
        let git = GitProcess::new(root);
        let expanded_context = context_lines + 4;
        let args = match scope {
            RepositoryChangeScope::Staged => vec![
                "--cached".to_string(),
                format!("--unified={expanded_context}"),
                "--".to_string(),
                relative_path.to_string(),
            ],
            RepositoryChangeScope::Conflict => vec![
                "--base".to_string(),
                format!("--unified={expanded_context}"),
                "--".to_string(),
                relative_path.to_string(),
            ],
            _ => vec![
                format!("--unified={expanded_context}"),
                "--".to_string(),
                relative_path.to_string(),
            ],
        };
        let expanded = git
            .run_with_options(
                "diff",
                &args,
                GitProcessOptions {
                    output_limit_bytes: (byte_limit * 8).max(8 * 1024 * 1024) as usize,
                    ..GitProcessOptions::default()
                },
            )
            .await
            .map_err(|error| repository_git_error(error, &state))?;
        context_gaps = build_context_gaps(
            &lines,
            &structured_diff_lines(&expanded.stdout),
            context_lines,
        );
    }
    Ok(RepositoryDiff {
        path: entry.path.clone(),
        old_path: entry.old_path.clone(),
        scope,
        binary,
        complete: !binary && !truncated.truncated,
        truncated: truncated.truncated,
        byte_limit,
        content: if binary {
            String::new()
        } else {
            truncated.content
        },
        lines,
        context_gaps,
        version: entry.version.clone(),
        snapshot_id: changes.snapshot_id.clone(),
    })
}

pub async fn stage_paths(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    paths: &[RepositoryVersionedPath],
) -> Result<Vec<String>, RepositoryOperationError> {
    let state = mutate_prepare(
        resolved,
        expected_snapshot_id,
        paths,
        &[
            RepositoryChangeScope::Unstaged,
            RepositoryChangeScope::Untracked,
            RepositoryChangeScope::Conflict,
        ],
        &[],
    )?;
    let root = state.worktree_root.as_ref().expect("required root");
    let mut args = vec!["--".to_string()];
    args.extend(paths.iter().map(|path| path.path.clone()));
    GitProcess::new(root)
        .run("add", &args)
        .await
        .map_err(|error| repository_git_error(error, &state))?;
    Ok(paths.iter().map(|path| path.path.clone()).collect())
}

pub async fn unstage_paths(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    paths: &[RepositoryVersionedPath],
) -> Result<Vec<String>, RepositoryOperationError> {
    let state = mutate_prepare(
        resolved,
        expected_snapshot_id,
        paths,
        &[RepositoryChangeScope::Staged],
        &[],
    )?;
    let root = state.worktree_root.as_ref().expect("required root");
    let mut args =
        if state.context.head.as_ref().is_some_and(|head| {
            head.state == controlled_instance_protocol::RepositoryHeadState::Unborn
        }) {
            vec!["--".to_string()]
        } else {
            vec!["--staged".to_string(), "--".to_string()]
        };
    args.extend(paths.iter().map(|path| path.path.clone()));
    let subcommand = if args.first().is_some_and(|value| value == "--") {
        "reset"
    } else {
        "restore"
    };
    GitProcess::new(root)
        .run(subcommand, &args)
        .await
        .map_err(|error| repository_git_error(error, &state))?;
    Ok(paths.iter().map(|path| path.path.clone()).collect())
}

pub async fn discard_worktree_paths(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    paths: &[RepositoryVersionedPath],
) -> Result<Vec<String>, RepositoryOperationError> {
    let state = mutate_prepare(
        resolved,
        expected_snapshot_id,
        paths,
        &[RepositoryChangeScope::Unstaged],
        &[
            RepositoryChangeScope::Untracked,
            RepositoryChangeScope::Conflict,
        ],
    )?;
    let root = state.worktree_root.as_ref().expect("required root");
    let mut args = vec!["--worktree".to_string(), "--".to_string()];
    args.extend(paths.iter().map(|path| path.path.clone()));
    GitProcess::new(root)
        .run("restore", &args)
        .await
        .map_err(|error| repository_git_error(error, &state))?;
    Ok(paths.iter().map(|path| path.path.clone()).collect())
}

pub async fn discard_all_tracked_paths(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    paths: &[RepositoryVersionedPath],
) -> Result<Vec<String>, RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    let changes = state.changes.as_ref().expect("required changes");
    if state
        .context
        .head
        .as_ref()
        .is_none_or(|head| head.state == controlled_instance_protocol::RepositoryHeadState::Unborn)
    {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_OPERATION_FAILED",
            "Discarding all tracked changes requires an existing HEAD.",
            &state,
        ));
    }
    for selected in paths {
        if changes.entries.iter().any(|entry| {
            entry.path == selected.path
                && matches!(
                    entry.scope,
                    RepositoryChangeScope::Untracked | RepositoryChangeScope::Conflict
                )
        }) {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_CONFLICT",
                "Untracked and conflicted paths cannot be discarded by this action.",
                &state,
            ));
        }
    }
    let state = mutate_prepare(
        &state,
        expected_snapshot_id,
        paths,
        &[
            RepositoryChangeScope::Staged,
            RepositoryChangeScope::Unstaged,
        ],
        &[
            RepositoryChangeScope::Untracked,
            RepositoryChangeScope::Conflict,
        ],
    )?;
    let root = state.worktree_root.as_ref().expect("required root");
    let mut args = vec![
        "--source=HEAD".to_string(),
        "--staged".to_string(),
        "--worktree".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| path.path.clone()));
    GitProcess::new(root)
        .run("restore", &args)
        .await
        .map_err(|error| repository_git_error(error, &state))?;
    Ok(paths.iter().map(|path| path.path.clone()).collect())
}

pub async fn commit_repository(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    message: &str,
) -> Result<RepositoryMutationResult, RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    if message.trim().is_empty() {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_NOTHING_TO_COMMIT",
            "Commit message is required.",
            &state,
        ));
    }
    if !state
        .changes
        .as_ref()
        .expect("required changes")
        .entries
        .iter()
        .any(|entry| entry.scope == RepositoryChangeScope::Staged)
    {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_NOTHING_TO_COMMIT",
            "The index has no staged changes.",
            &state,
        ));
    }
    let root = state.worktree_root.as_ref().expect("required root");
    let git = GitProcess::new(root);
    git.run("commit", &["-m".to_string(), message.to_string()])
        .await
        .map_err(|error| structured_git_error(error, &state))?;
    let commit_oid = git
        .run("rev-parse", &["HEAD".to_string()])
        .await
        .map_err(|error| structured_git_error(error, &state))?
        .stdout
        .trim()
        .to_string();
    Ok(RepositoryMutationResult {
        ok: true,
        snapshot_id: state.context.snapshot_id.clone().unwrap_or_default(),
        context: state.context.clone(),
        changes: state.changes.clone(),
        commit_oid: Some(commit_oid),
    })
}

pub fn mutation_result(
    state: &ResolvedRepository,
    commit_oid: Option<String>,
) -> RepositoryMutationResult {
    RepositoryMutationResult {
        ok: true,
        snapshot_id: state.context.snapshot_id.clone().unwrap_or_default(),
        context: state.context.clone(),
        changes: state.changes.clone(),
        commit_oid,
    }
}

fn mutate_prepare(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    paths: &[RepositoryVersionedPath],
    allowed_scopes: &[RepositoryChangeScope],
    rejected_scopes: &[RepositoryChangeScope],
) -> Result<ResolvedRepository, RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    let changes = state.changes.as_ref().expect("required changes");
    for item in paths {
        if changes.entries.iter().any(|entry| {
            entry.path == item.path
                && entry.version == item.expected_version
                && rejected_scopes.contains(&entry.scope)
        }) {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_CONFLICT",
                "The selected change scope is not supported by this action.",
                &state,
            ));
        }
    }
    if paths.is_empty() {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_PATH_INVALID",
            "At least one path is required.",
            &state,
        ));
    }
    let mut unique = HashSet::new();
    for item in paths {
        validate_repository_relative_path(&item.path)?;
        if !unique.insert(item.path.clone()) {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_PATH_INVALID",
                "Duplicate paths are not allowed.",
                &state,
            ));
        }
        let matching = changes
            .entries
            .iter()
            .find(|entry| entry.path == item.path && allowed_scopes.contains(&entry.scope));
        if matching.is_none_or(|entry| entry.version != item.expected_version) {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_STATE_STALE",
                format!("Change version is stale: {}.", item.path),
                &state,
            ));
        }
    }
    Ok(state)
}

fn assert_snapshot(
    state: &ResolvedRepository,
    expected_snapshot_id: &str,
) -> Result<(), RepositoryOperationError> {
    if state.context.snapshot_id.as_deref() != Some(expected_snapshot_id) {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_STATE_STALE",
            "Repository state changed after it was loaded.",
            state,
        ));
    }
    Ok(())
}

pub fn structured_diff_lines(raw: &str) -> Vec<RepositoryDiffLine> {
    let mut lines = Vec::new();
    let mut old_line: Option<u64> = None;
    let mut new_line: Option<u64> = None;
    let mut raw_lines = if raw.is_empty() {
        Vec::new()
    } else {
        raw.split('\n').collect::<Vec<_>>()
    };
    if raw.ends_with('\n') {
        raw_lines.pop();
    }
    for raw_line in raw_lines {
        if let Some(captures) = hunk_pattern().captures(raw_line) {
            let old_start = captures
                .name("old_start")
                .and_then(|value| value.as_str().parse().ok())
                .unwrap_or(0);
            let old_count = captures
                .name("old_count")
                .and_then(|value| value.as_str().parse().ok())
                .unwrap_or(1);
            let new_start = captures
                .name("new_start")
                .and_then(|value| value.as_str().parse().ok())
                .unwrap_or(0);
            let new_count = captures
                .name("new_count")
                .and_then(|value| value.as_str().parse().ok())
                .unwrap_or(1);
            let heading = captures
                .name("heading")
                .map(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let hunk_id = format!("hunk:{old_start}:{old_count}:{new_start}:{new_count}");
            old_line = Some(old_start);
            new_line = Some(new_start);
            lines.push(RepositoryDiffLine {
                kind: RepositoryDiffLineKind::Hunk,
                content: raw_line.to_string(),
                old_line: None,
                new_line: None,
                old_start: Some(old_start),
                old_count: Some(old_count),
                new_start: Some(new_start),
                new_count: Some(new_count),
                heading,
                hunk_id: Some(hunk_id),
            });
            continue;
        }
        if raw_line.starts_with("@@@") {
            old_line = None;
            new_line = None;
            lines.push(RepositoryDiffLine {
                kind: RepositoryDiffLineKind::Hunk,
                content: raw_line.to_string(),
                old_line: None,
                new_line: None,
                old_start: None,
                old_count: None,
                new_start: None,
                new_count: None,
                heading: None,
                hunk_id: None,
            });
            continue;
        }
        if old_line.is_none()
            || new_line.is_none()
            || raw_line.starts_with("diff --git ")
            || raw_line.starts_with("index ")
            || raw_line.starts_with("--- ")
            || raw_line.starts_with("+++ ")
            || raw_line.starts_with("\\ No newline")
        {
            lines.push(RepositoryDiffLine {
                kind: RepositoryDiffLineKind::Metadata,
                content: raw_line.to_string(),
                old_line: None,
                new_line: None,
                old_start: None,
                old_count: None,
                new_start: None,
                new_count: None,
                heading: None,
                hunk_id: None,
            });
            continue;
        }
        if let Some(content) = raw_line.strip_prefix('+') {
            lines.push(RepositoryDiffLine {
                kind: RepositoryDiffLineKind::Addition,
                content: content.to_string(),
                old_line: None,
                new_line,
                old_start: None,
                old_count: None,
                new_start: None,
                new_count: None,
                heading: None,
                hunk_id: None,
            });
            new_line = new_line.map(|line| line + 1);
            continue;
        }
        if let Some(content) = raw_line.strip_prefix('-') {
            lines.push(RepositoryDiffLine {
                kind: RepositoryDiffLineKind::Deletion,
                content: content.to_string(),
                old_line,
                new_line: None,
                old_start: None,
                old_count: None,
                new_start: None,
                new_count: None,
                heading: None,
                hunk_id: None,
            });
            old_line = old_line.map(|line| line + 1);
            continue;
        }
        lines.push(RepositoryDiffLine {
            kind: RepositoryDiffLineKind::Context,
            content: raw_line.strip_prefix(' ').unwrap_or(raw_line).to_string(),
            old_line,
            new_line,
            old_start: None,
            old_count: None,
            new_start: None,
            new_count: None,
            heading: None,
            hunk_id: None,
        });
        old_line = old_line.map(|line| line + 1);
        new_line = new_line.map(|line| line + 1);
    }
    lines
}

pub fn build_context_gaps(
    base_lines: &[RepositoryDiffLine],
    expanded_lines: &[RepositoryDiffLine],
    line_limit: usize,
) -> Vec<RepositoryDiffContextGap> {
    let hunks = base_lines
        .iter()
        .filter(|line| {
            line.kind == RepositoryDiffLineKind::Hunk
                && line.hunk_id.is_some()
                && line.new_start.is_some()
                && line.new_count.is_some()
        })
        .collect::<Vec<_>>();
    if hunks.is_empty() {
        return Vec::new();
    }
    let visible_context = base_lines
        .iter()
        .filter(|line| line.kind == RepositoryDiffLineKind::Context)
        .map(context_line_key)
        .collect::<HashSet<_>>();
    let mut directional_segments: BTreeMap<String, (usize, bool, Vec<RepositoryDiffLine>)> =
        BTreeMap::new();
    for line in expanded_lines {
        if line.kind != RepositoryDiffLineKind::Context || line.new_line.is_none() {
            continue;
        }
        if visible_context.contains(&context_line_key(line)) {
            continue;
        }
        let new_line = line.new_line.unwrap_or(0);
        let mut nearest_index = 0usize;
        let mut nearest_distance = u64::MAX;
        for (index, hunk) in hunks.iter().enumerate() {
            let start = hunk.new_start.unwrap_or(0);
            let end = start + hunk.new_count.unwrap_or(1).saturating_sub(1);
            let distance = if new_line < start {
                start - new_line
            } else {
                new_line.saturating_sub(end)
            };
            if distance < nearest_distance {
                nearest_index = index;
                nearest_distance = distance;
            }
        }
        let nearest = hunks[nearest_index];
        let before = new_line < nearest.new_start.unwrap_or(0);
        let key = format!(
            "{}:{}",
            nearest.hunk_id.as_deref().unwrap_or_default(),
            if before { "before" } else { "after" }
        );
        directional_segments
            .entry(key)
            .or_insert_with(|| (nearest_index, before, Vec::new()))
            .2
            .push(line.clone());
    }
    let mut gaps: BTreeMap<String, RepositoryDiffContextGap> = BTreeMap::new();
    let mut start_line_keys: HashMap<String, HashSet<String>> = HashMap::new();
    for (_, (hunk_index, position, mut segment_lines)) in directional_segments {
        segment_lines.sort_by_key(|line| line.new_line.unwrap_or(0));
        let has_more = line_limit < 3_000 && segment_lines.len() > line_limit;
        let lines = if position {
            segment_lines
                .into_iter()
                .rev()
                .take(line_limit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
        } else {
            segment_lines
                .into_iter()
                .take(line_limit)
                .collect::<Vec<_>>()
        };
        let before_hunk_id = if position {
            hunk_index
                .checked_sub(1)
                .and_then(|index| hunks.get(index))
                .and_then(|hunk| hunk.hunk_id.clone())
        } else {
            hunks.get(hunk_index).and_then(|hunk| hunk.hunk_id.clone())
        };
        let after_hunk_id = if position {
            hunks.get(hunk_index).and_then(|hunk| hunk.hunk_id.clone())
        } else {
            hunks
                .get(hunk_index + 1)
                .and_then(|hunk| hunk.hunk_id.clone())
        };
        let gap_id = format!(
            "gap:{}:{}",
            before_hunk_id.as_deref().unwrap_or("start"),
            after_hunk_id.as_deref().unwrap_or("end")
        );
        let gap = gaps
            .entry(gap_id.clone())
            .or_insert_with(|| RepositoryDiffContextGap {
                gap_id: gap_id.clone(),
                before_hunk_id: before_hunk_id.clone(),
                after_hunk_id: after_hunk_id.clone(),
                lines: Vec::new(),
                start_line_count: 0,
                has_more: false,
            });
        if !position {
            let keys = start_line_keys.entry(gap_id).or_default();
            for line in &lines {
                keys.insert(context_line_key(line));
            }
        }
        gap.lines.extend(lines);
        gap.has_more |= has_more;
    }
    gaps.into_values()
        .map(|mut gap| {
            gap.lines.sort_by_key(|line| line.new_line.unwrap_or(0));
            gap.lines.dedup_by_key(|line| context_line_key(line));
            gap.start_line_count = start_line_keys
                .get(&gap.gap_id)
                .map(|keys| {
                    gap.lines
                        .iter()
                        .filter(|line| keys.contains(&context_line_key(line)))
                        .count() as u64
                })
                .unwrap_or(0);
            gap
        })
        .collect()
}

fn hunk_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? \+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@(?: ?(?P<heading>.*))?$",
        )
        .expect("hunk pattern")
    })
}

fn context_line_key(line: &RepositoryDiffLine) -> String {
    format!(
        "{}:{}",
        line.old_line.unwrap_or(0),
        line.new_line.unwrap_or(0)
    )
}

fn untracked_unified_diff(
    root: &Path,
    relative_path: &str,
    byte_limit: u64,
) -> Result<(String, bool), RepositoryOperationError> {
    let segments = validate_repository_relative_path(relative_path)?;
    let absolute_path = segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    let parent = absolute_path.parent().ok_or_else(|| {
        RepositoryOperationError::new("REPOSITORY_PATH_INVALID", "Path has no parent.")
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|_| {
        RepositoryOperationError::new(
            "REPOSITORY_PATH_FORBIDDEN",
            "Untracked path crosses the repository boundary.",
        )
    })?;
    let canonical_root = fs::canonicalize(root).map_err(|_| {
        RepositoryOperationError::new(
            "REPOSITORY_OPERATION_FAILED",
            "Repository root is unavailable.",
        )
    })?;
    if !crate::files::within_root(&canonical_parent, &canonical_root) {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_PATH_FORBIDDEN",
            "Untracked path crosses the repository boundary.",
        ));
    }
    let metadata = fs::symlink_metadata(&absolute_path).map_err(|_| {
        RepositoryOperationError::new(
            "REPOSITORY_FILE_NOT_FOUND",
            "Repository path does not exist.",
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok((String::new(), true));
    }
    let read_limit = (byte_limit.saturating_mul(4)).max(64 * 1024);
    let mut file = fs::File::open(&absolute_path).map_err(|error| {
        RepositoryOperationError::new("REPOSITORY_OPERATION_FAILED", error.to_string())
    })?;
    let mut buffer = vec![0; metadata.len().min(read_limit) as usize];
    file.read_exact(&mut buffer).map_err(|error| {
        RepositoryOperationError::new("REPOSITORY_OPERATION_FAILED", error.to_string())
    })?;
    if buffer.contains(&0) {
        return Ok((String::new(), true));
    }
    let Ok(text) = String::from_utf8(buffer) else {
        return Ok((String::new(), true));
    };
    let lines = text.split('\n').collect::<Vec<_>>();
    let body = lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if index == lines.len() - 1 && line.is_empty() {
                String::new()
            } else {
                format!("+{line}")
            }
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let count = lines
        .len()
        .saturating_sub(usize::from(text.ends_with('\n')));
    let header = format!(
        "diff --git a/{relative_path} b/{relative_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative_path}\n@@ -0,0 +1,{count} @@"
    );
    Ok((
        format!(
            "{header}\n{body}{}",
            if body.is_empty() { "" } else { "\n" }
        ),
        false,
    ))
}

fn truncate_utf8(value: &str, byte_limit: u64) -> TruncatedText {
    let bytes = value.as_bytes();
    if bytes.len() as u64 <= byte_limit {
        return TruncatedText {
            content: value.to_string(),
            truncated: false,
        };
    }
    let mut end = byte_limit as usize;
    while end > 0 && bytes[end] & 0b1100_0000 == 0b1000_0000 {
        end -= 1;
    }
    TruncatedText {
        content: String::from_utf8_lossy(&bytes[..end]).into_owned(),
        truncated: true,
    }
}

struct TruncatedText {
    content: String,
    truncated: bool,
}

fn structured_git_error(error: GitError, current: &ResolvedRepository) -> RepositoryOperationError {
    repository_git_error(error, current)
}

fn repository_git_error(error: GitError, current: &ResolvedRepository) -> RepositoryOperationError {
    let (code, message) = match &error {
        GitError::Timeout(_) => (
            "REPOSITORY_COMMAND_TIMEOUT",
            "Git operation timed out.".to_string(),
        ),
        GitError::OutputLimit(_) => (
            "REPOSITORY_OUTPUT_LIMIT",
            "Git operation exceeded its output limit.".to_string(),
        ),
        GitError::Aborted => (
            "REPOSITORY_OPERATION_ABORTED",
            "Git operation was aborted.".to_string(),
        ),
        GitError::NotFound => (
            "REPOSITORY_GIT_UNAVAILABLE",
            "Git executable is unavailable.".to_string(),
        ),
        GitError::Exit {
            message, stderr, ..
        } => {
            let diagnostic = format!("{message}\n{stderr}").to_lowercase();
            if diagnostic.contains("author identity unknown")
                || diagnostic.contains("unable to auto-detect email address")
                || diagnostic.contains("please tell me who you are")
            {
                (
                    "REPOSITORY_IDENTITY_MISSING",
                    "Git user identity is not configured for this repository.".to_string(),
                )
            } else if diagnostic.contains("gpg failed to sign")
                || diagnostic.contains("failed to write commit object")
                || diagnostic.contains("signing failed")
            {
                (
                    "REPOSITORY_SIGNING_FAILED",
                    "Git could not sign the commit.".to_string(),
                )
            } else if diagnostic.contains("hook declined")
                || (diagnostic.contains("hook") && diagnostic.contains("failed"))
                || diagnostic.contains("pre-commit")
                || diagnostic.contains("commit-msg")
            {
                (
                    "REPOSITORY_HOOK_FAILED",
                    "A Git commit hook rejected the commit.".to_string(),
                )
            } else {
                (
                    "REPOSITORY_OPERATION_FAILED",
                    "Git rejected the repository operation.".to_string(),
                )
            }
        }
        _ => (
            "REPOSITORY_OPERATION_FAILED",
            "Repository operation failed.".to_string(),
        ),
    };
    RepositoryOperationError::with_current(code, message, current)
}

pub fn default_diff_bytes() -> u64 {
    DEFAULT_DIFF_BYTES
}

pub fn change_entry_snapshot_version(
    scope: RepositoryChangeScope,
    path: &str,
    version: &str,
) -> String {
    hash_id(
        "version",
        &[
            version.to_string(),
            scope_wire(scope).to_string(),
            path.to_string(),
        ],
    )
}

pub fn repository_root_label(root: &Path) -> String {
    display_path(root)
}

pub fn empty_mutation_result(state: &ResolvedRepository) -> RepositoryMutationResult {
    RepositoryMutationResult {
        ok: true,
        snapshot_id: state.context.snapshot_id.clone().unwrap_or_default(),
        context: state.context.clone(),
        changes: state.changes.clone(),
        commit_oid: None,
    }
}

pub fn observed_at_now() -> String {
    now_iso()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unavailable_repository;
    use controlled_instance_protocol::{RepositoryAvailability, RepositorySessionKind};

    fn repository_state() -> ResolvedRepository {
        unavailable_repository(
            &crate::RepositorySessionTarget {
                kind: RepositorySessionKind::AiSession,
                id: "session-test".to_string(),
                session_found: true,
                cwd: None,
                status: None,
            },
            "2026-11-02T00:00:00.000Z".to_string(),
            RepositoryAvailability::NotWorktree,
        )
    }

    fn git_exit(stderr: &str) -> GitError {
        GitError::Exit {
            message: String::new(),
            exit_code: Some(1),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn diff_parser_tracks_old_and_new_lines_and_hunk_ids() {
        let lines = structured_diff_lines(
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@ heading\n old\n-removed\n+added\n tail\n",
        );
        assert_eq!(lines[0].kind, RepositoryDiffLineKind::Metadata);
        let hunk = lines
            .iter()
            .find(|line| line.kind == RepositoryDiffLineKind::Hunk)
            .expect("hunk");
        assert_eq!(hunk.hunk_id.as_deref(), Some("hunk:1:2:1:3"));
        assert_eq!(hunk.heading.as_deref(), Some("heading"));
        assert!(lines.iter().any(|line| {
            line.kind == RepositoryDiffLineKind::Deletion
                && line.content == "removed"
                && line.old_line == Some(2)
        }));
        assert!(lines.iter().any(|line| {
            line.kind == RepositoryDiffLineKind::Addition
                && line.content == "added"
                && line.new_line == Some(2)
        }));
    }

    #[test]
    fn git_diagnostics_are_classified_case_insensitively() {
        let state = repository_state();
        let hook = repository_git_error(git_exit("COMMIT HOOK FAILED"), &state);
        assert_eq!(hook.code, "REPOSITORY_HOOK_FAILED");

        let identity = repository_git_error(git_exit("AUTHOR IDENTITY UNKNOWN"), &state);
        assert_eq!(identity.code, "REPOSITORY_IDENTITY_MISSING");

        let signing = repository_git_error(git_exit("GPG FAILED TO SIGN"), &state);
        assert_eq!(signing.code, "REPOSITORY_SIGNING_FAILED");
    }
}
