use crate::{
    error::RepositoryOperationError,
    git::{redact_remote_url, GitError, GitProcess},
};
use chrono::{SecondsFormat, Utc};
use controlled_instance_protocol::{
    RepositoryAvailability, RepositoryChangeEntry, RepositoryChangeScope, RepositoryChangeSummary,
    RepositoryChanges, RepositoryContext, RepositoryFileStatus, RepositoryHead,
    RepositoryHeadState, RepositoryPrimaryAction, RepositoryRemote, RepositorySessionKind,
    RepositoryUpstream, RepositoryWorktreeSummary,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug, Clone)]
pub struct RepositorySessionTarget {
    pub kind: RepositorySessionKind,
    pub id: String,
    pub cwd: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedRepository {
    pub context: RepositoryContext,
    pub changes: Option<RepositoryChanges>,
    pub worktree_root: Option<PathBuf>,
    pub git_dir: Option<PathBuf>,
    pub git_common_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct ParsedStatus {
    head_oid: Option<String>,
    branch: Option<String>,
    upstream_ref: Option<String>,
    ahead: u64,
    behind: u64,
    records: Vec<ParsedStatusRecord>,
}

#[derive(Debug, Clone)]
struct ParsedStatusRecord {
    path: String,
    old_path: Option<String>,
    xy: String,
    kind: StatusRecordKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusRecordKind {
    Ordinary,
    Renamed,
    Unmerged,
    Untracked,
}

pub async fn resolve_repository(target: &RepositorySessionTarget) -> ResolvedRepository {
    let observed_at = now_iso();
    let unavailable =
        |availability| unavailable_repository(target, observed_at.clone(), availability);
    if target
        .status
        .as_deref()
        .is_some_and(|status| matches!(status, "closed" | "terminated"))
        || (target.kind == RepositorySessionKind::AiSession
            && target.status.as_deref() == Some("stopped"))
    {
        return unavailable(RepositoryAvailability::SessionInactive);
    }
    let Some(cwd) = target
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
    else {
        return unavailable(RepositoryAvailability::CwdMissing);
    };
    let cwd = match fs::canonicalize(cwd) {
        Ok(path) if path.is_dir() => path,
        _ => return unavailable(RepositoryAvailability::CwdInaccessible),
    };

    let git = GitProcess::new(&cwd);
    let locations = match git
        .run(
            "rev-parse",
            &[
                "--show-toplevel".to_string(),
                "--absolute-git-dir".to_string(),
                "--git-common-dir".to_string(),
                "--show-prefix".to_string(),
            ],
        )
        .await
    {
        Ok(result) => result,
        Err(GitError::NotFound) => {
            return directory_workspace(
                RepositoryAvailability::GitUnavailable,
                target,
                observed_at,
                cwd,
            )
        }
        Err(_) => {
            return directory_workspace(
                RepositoryAvailability::NotWorktree,
                target,
                observed_at,
                cwd,
            )
        }
    };
    let mut lines = locations.stdout.split('\n');
    let root_output = lines.next().unwrap_or_default();
    let git_dir_output = lines.next().unwrap_or_default();
    let common_dir_output = lines.next().unwrap_or_default();
    let prefix_output = lines.next().unwrap_or_default();
    let worktree_root = match fs::canonicalize(root_output) {
        Ok(path) => path,
        Err(_) => {
            return directory_workspace(
                RepositoryAvailability::NotWorktree,
                target,
                observed_at,
                cwd,
            )
        }
    };
    let git_dir = canonical_git_path(git_dir_output, &cwd);
    let git_common_dir = canonical_git_path(common_dir_output, &cwd);

    let Ok(status_result) = git
        .run(
            "status",
            &[
                "--porcelain=v2".to_string(),
                "--branch".to_string(),
                "-z".to_string(),
                "--untracked-files=all".to_string(),
            ],
        )
        .await
    else {
        return directory_workspace(
            RepositoryAvailability::NotWorktree,
            target,
            observed_at,
            cwd,
        );
    };
    let parsed = parse_porcelain_v2(&status_result.stdout);
    let index = git
        .run("ls-files", &["--stage".to_string(), "-z".to_string()])
        .await
        .unwrap_or_else(|_| crate::git::GitProcessResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        });
    let refs = git
        .run(
            "for-each-ref",
            &[
                "--format=%(refname)%00%(objectname)".to_string(),
                "refs/heads".to_string(),
                "refs/remotes".to_string(),
            ],
        )
        .await
        .unwrap_or_else(|_| crate::git::GitProcessResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        });
    let versions = changed_path_versions(&worktree_root, &parsed.records, &index.stdout);
    let head = match parsed.branch.as_deref() {
        Some("(detached)") => RepositoryHead {
            state: RepositoryHeadState::Detached,
            oid: parsed.head_oid.clone(),
            branch: None,
        },
        Some(branch) if parsed.head_oid.is_some() => RepositoryHead {
            state: RepositoryHeadState::Branch,
            oid: parsed.head_oid.clone(),
            branch: Some(branch.to_string()),
        },
        branch => RepositoryHead {
            state: RepositoryHeadState::Unborn,
            oid: None,
            branch: branch.map(ToString::to_string),
        },
    };
    let mut snapshot_parts = vec![
        parsed
            .head_oid
            .clone()
            .unwrap_or_else(|| "unborn".to_string()),
        refs.stdout.clone(),
        index.stdout.clone(),
    ];
    for (path, version) in &versions {
        snapshot_parts.push(path.clone());
        snapshot_parts.push(version.clone());
    }
    let snapshot_id = hash_id("snapshot", &snapshot_parts);
    let changes = repository_changes(&parsed, &versions, snapshot_id.clone());
    let remotes = repository_remotes(&git).await;
    let upstream = parsed.upstream_ref.as_deref().map(|reference| {
        let separator = reference.find('/');
        RepositoryUpstream {
            ref_name: reference.to_string(),
            remote: separator
                .filter(|index| *index > 0)
                .map(|index| &reference[..index])
                .unwrap_or(".")
                .to_string(),
            branch: separator
                .filter(|index| *index > 0)
                .map(|index| &reference[index + 1..])
                .unwrap_or(reference)
                .to_string(),
            ahead: parsed.ahead,
            behind: parsed.behind,
        }
    });
    let repository_id = hash_id("repo", &[display_path(&git_common_dir)]);
    let worktree_id = repository_worktree_id(&repository_id, &worktree_root);
    let repository_context_id = hash_id(
        "context",
        &[
            session_kind_wire(target.kind).to_string(),
            target.id.clone(),
            repository_id.clone(),
            worktree_id.clone(),
        ],
    );
    let dirty = changes.summary.conflicts
        + changes.summary.staged
        + changes.summary.unstaged
        + changes.summary.untracked
        > 0;
    let context = RepositoryContext {
        availability: RepositoryAvailability::Available,
        session_kind: target.kind,
        session_id: target.id.clone(),
        observed_at,
        snapshot_id: Some(snapshot_id),
        repository_id: Some(repository_id),
        repository_context_id: Some(repository_context_id),
        repository_root: Some(display_path(&worktree_root)),
        display_name: worktree_root
            .file_name()
            .and_then(|name| name.to_str())
            .map(ToString::to_string),
        cwd_relative_path: Some(prefix_output.trim_end_matches('/').to_string()),
        head: Some(head.clone()),
        upstream: upstream.clone(),
        current_worktree: Some(RepositoryWorktreeSummary {
            id: worktree_id,
            is_current: true,
            is_main: git_dir == git_common_dir,
            managed: false,
            head,
            dirty,
            locked: false,
            lock_reason: None,
            prunable: false,
            active_ai_session_ids: if target.kind == RepositorySessionKind::AiSession {
                vec![target.id.clone()]
            } else {
                Vec::new()
            },
            active_app_session_ids: if target.kind == RepositorySessionKind::AppSession {
                vec![target.id.clone()]
            } else {
                Vec::new()
            },
        }),
        changes: Some(changes.summary.clone()),
        remotes: Some(remotes),
        primary_action: Some(primary_repository_action(
            &changes.summary,
            upstream.as_ref(),
        )),
    };
    ResolvedRepository {
        context,
        changes: Some(changes),
        worktree_root: Some(worktree_root),
        git_dir: Some(git_dir),
        git_common_dir: Some(git_common_dir),
    }
}

pub fn unavailable_repository(
    target: &RepositorySessionTarget,
    observed_at: String,
    availability: RepositoryAvailability,
) -> ResolvedRepository {
    ResolvedRepository {
        context: RepositoryContext {
            availability,
            session_kind: target.kind,
            session_id: target.id.clone(),
            observed_at,
            snapshot_id: None,
            repository_id: None,
            repository_context_id: None,
            repository_root: None,
            display_name: None,
            cwd_relative_path: None,
            head: None,
            upstream: None,
            current_worktree: None,
            changes: None,
            remotes: None,
            primary_action: None,
        },
        changes: None,
        worktree_root: None,
        git_dir: None,
        git_common_dir: None,
    }
}

pub fn repository_availability_code(availability: RepositoryAvailability) -> &'static str {
    match availability {
        RepositoryAvailability::Available => "REPOSITORY_OPERATION_FAILED",
        RepositoryAvailability::SessionNotFound => "REPOSITORY_SESSION_NOT_FOUND",
        RepositoryAvailability::SessionInactive => "REPOSITORY_SESSION_INACTIVE",
        RepositoryAvailability::CwdMissing => "REPOSITORY_CWD_MISSING",
        RepositoryAvailability::CwdInaccessible => "REPOSITORY_CWD_INACCESSIBLE",
        RepositoryAvailability::GitUnavailable => "REPOSITORY_GIT_UNAVAILABLE",
        RepositoryAvailability::NotWorktree => "REPOSITORY_NOT_WORKTREE",
    }
}

pub fn require_repository(
    resolved: ResolvedRepository,
) -> Result<ResolvedRepository, RepositoryOperationError> {
    if resolved.context.availability != RepositoryAvailability::Available
        || resolved.worktree_root.is_none()
        || resolved.git_common_dir.is_none()
        || resolved.changes.is_none()
    {
        return Err(RepositoryOperationError::with_current(
            repository_availability_code(resolved.context.availability),
            "Repository is unavailable for this session.",
            &resolved,
        ));
    }
    Ok(resolved)
}

pub fn require_workspace(
    resolved: ResolvedRepository,
) -> Result<ResolvedRepository, RepositoryOperationError> {
    if resolved.worktree_root.is_none() || resolved.changes.is_none() {
        return Err(RepositoryOperationError::with_current(
            repository_availability_code(resolved.context.availability),
            "Workspace is unavailable for this session.",
            &resolved,
        ));
    }
    Ok(resolved)
}

fn directory_workspace(
    availability: RepositoryAvailability,
    target: &RepositorySessionTarget,
    observed_at: String,
    cwd: PathBuf,
) -> ResolvedRepository {
    let root = match fs::canonicalize(cwd) {
        Ok(path) => path,
        Err(_) => return unavailable_repository(target, observed_at, availability),
    };
    let snapshot_id = hash_id("snapshot", &["directory".to_string(), display_path(&root)]);
    let changes = RepositoryChanges {
        snapshot_id: snapshot_id.clone(),
        summary: RepositoryChangeSummary::default(),
        entries: Vec::new(),
    };
    ResolvedRepository {
        context: RepositoryContext {
            availability,
            session_kind: target.kind,
            session_id: target.id.clone(),
            observed_at,
            snapshot_id: Some(snapshot_id),
            repository_id: None,
            repository_context_id: None,
            repository_root: Some(display_path(&root)),
            display_name: root
                .file_name()
                .and_then(|name| name.to_str())
                .map(ToString::to_string)
                .or_else(|| Some(display_path(&root))),
            cwd_relative_path: Some(String::new()),
            head: None,
            upstream: None,
            current_worktree: None,
            changes: Some(changes.summary.clone()),
            remotes: None,
            primary_action: None,
        },
        changes: Some(changes),
        worktree_root: Some(root),
        git_dir: None,
        git_common_dir: None,
    }
}

fn parse_porcelain_v2(output: &str) -> ParsedStatus {
    let mut parsed = ParsedStatus {
        head_oid: None,
        branch: None,
        upstream_ref: None,
        ahead: 0,
        behind: 0,
        records: Vec::new(),
    };
    let fields = output.split('\0').collect::<Vec<_>>();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        if field.is_empty() {
            index += 1;
            continue;
        }
        if let Some(value) = field.strip_prefix("# branch.oid ") {
            parsed.head_oid = (value != "(initial)").then(|| value.to_string());
        } else if let Some(value) = field.strip_prefix("# branch.head ") {
            parsed.branch = Some(value.to_string());
        } else if let Some(value) = field.strip_prefix("# branch.upstream ") {
            parsed.upstream_ref = Some(value.to_string());
        } else if let Some(value) = field.strip_prefix("# branch.ab ") {
            let mut parts = value.split(' ');
            if let Some(ahead) = parts.next().and_then(|part| part.strip_prefix('+')) {
                parsed.ahead = ahead.parse().unwrap_or(0);
            }
            if let Some(behind) = parts.next().and_then(|part| part.strip_prefix('-')) {
                parsed.behind = behind.parse().unwrap_or(0);
            }
        } else if let Some(rest) = field.strip_prefix("1 ") {
            let parts = rest.split(' ').collect::<Vec<_>>();
            if parts.len() >= 8 {
                parsed.records.push(ParsedStatusRecord {
                    kind: StatusRecordKind::Ordinary,
                    xy: parts[0].to_string(),
                    path: parts[7..].join(" "),
                    old_path: None,
                });
            }
        } else if let Some(rest) = field.strip_prefix("2 ") {
            let parts = rest.split(' ').collect::<Vec<_>>();
            if parts.len() >= 9 {
                parsed.records.push(ParsedStatusRecord {
                    kind: StatusRecordKind::Renamed,
                    xy: parts[0].to_string(),
                    path: parts[8..].join(" "),
                    old_path: fields.get(index + 1).map(|value| (*value).to_string()),
                });
                index += 1;
            }
        } else if let Some(rest) = field.strip_prefix("u ") {
            let parts = rest.split(' ').collect::<Vec<_>>();
            if parts.len() >= 10 {
                parsed.records.push(ParsedStatusRecord {
                    kind: StatusRecordKind::Unmerged,
                    xy: parts[0].to_string(),
                    path: parts[9..].join(" "),
                    old_path: None,
                });
            }
        } else if let Some(path) = field.strip_prefix("? ") {
            parsed.records.push(ParsedStatusRecord {
                kind: StatusRecordKind::Untracked,
                xy: "??".to_string(),
                path: path.to_string(),
                old_path: None,
            });
        }
        index += 1;
    }
    parsed
}

fn changed_path_versions(
    root: &Path,
    records: &[ParsedStatusRecord],
    index_state: &str,
) -> Vec<(String, String)> {
    let index_lines = index_state.split('\0').collect::<Vec<_>>();
    records
        .iter()
        .map(|record| {
            let file_path = root.join(record.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let content = match fs::symlink_metadata(&file_path) {
                Ok(metadata) if metadata.is_file() => fs::read(&file_path)
                    .map(|bytes| hex::encode(Sha256::digest(bytes)))
                    .unwrap_or_else(|_| "missing".to_string()),
                Ok(metadata) => {
                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                        .map(|value| value.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0);
                    let special = if metadata.file_type().is_symlink() {
                        fs::read_link(&file_path)
                            .map(|path| display_path(&path))
                            .unwrap_or_else(|_| "special".to_string())
                    } else {
                        "special".to_string()
                    };
                    format!(
                        "{}:{}:{modified}:{special}",
                        file_mode_bits(&metadata),
                        metadata.len()
                    )
                }
                Err(_) => "missing".to_string(),
            };
            let matching = index_lines
                .iter()
                .copied()
                .filter(|line| {
                    line.ends_with(&format!("\t{}", record.path))
                        || record
                            .old_path
                            .as_ref()
                            .is_some_and(|old| line.ends_with(&format!("\t{old}")))
                })
                .collect::<Vec<_>>()
                .join("\0");
            let version = hash_id("version", &[record.xy.clone(), content, matching]);
            (record.path.clone(), version)
        })
        .collect()
}

fn repository_changes(
    parsed: &ParsedStatus,
    versions: &[(String, String)],
    snapshot_id: String,
) -> RepositoryChanges {
    let version_by_path = versions.iter().cloned().collect::<HashMap<_, _>>();
    let mut entries = Vec::new();
    for record in &parsed.records {
        let status = change_status(record);
        for scope in change_scopes(record) {
            entries.push(RepositoryChangeEntry {
                path: record.path.clone(),
                old_path: record.old_path.clone(),
                scope,
                status,
                version: hash_id(
                    "version",
                    &[
                        version_by_path
                            .get(&record.path)
                            .cloned()
                            .unwrap_or_default(),
                        scope_wire(scope).to_string(),
                    ],
                ),
                binary: false,
            });
        }
    }
    RepositoryChanges {
        snapshot_id,
        summary: repository_change_summary(&parsed.records),
        entries,
    }
}

fn change_scopes(record: &ParsedStatusRecord) -> Vec<RepositoryChangeScope> {
    if record.kind == StatusRecordKind::Unmerged {
        return vec![RepositoryChangeScope::Conflict];
    }
    if record.kind == StatusRecordKind::Untracked {
        return vec![RepositoryChangeScope::Untracked];
    }
    let mut scopes = Vec::new();
    let bytes = record.xy.as_bytes();
    if bytes.first().copied() != Some(b'.') {
        scopes.push(RepositoryChangeScope::Staged);
    }
    if bytes.get(1).copied() != Some(b'.') {
        scopes.push(RepositoryChangeScope::Unstaged);
    }
    scopes
}

fn repository_change_summary(records: &[ParsedStatusRecord]) -> RepositoryChangeSummary {
    let mut summary = RepositoryChangeSummary::default();
    for record in records {
        for scope in change_scopes(record) {
            match scope {
                RepositoryChangeScope::Conflict => summary.conflicts += 1,
                RepositoryChangeScope::Staged => summary.staged += 1,
                RepositoryChangeScope::Unstaged => summary.unstaged += 1,
                RepositoryChangeScope::Untracked => summary.untracked += 1,
            }
        }
    }
    summary
}

#[derive(Debug, Clone)]
pub(crate) struct WorktreeStatus {
    pub summary: RepositoryChangeSummary,
    pub signature: String,
}

pub(crate) async fn read_worktree_status(root: &Path) -> Result<WorktreeStatus, GitError> {
    let output = GitProcess::new(root)
        .run(
            "status",
            &[
                "--porcelain=v2".to_string(),
                "-z".to_string(),
                "--untracked-files=all".to_string(),
            ],
        )
        .await?
        .stdout;
    let parsed = parse_porcelain_v2(&output);
    let mut changes = parsed
        .records
        .iter()
        .flat_map(|record| {
            change_scopes(record)
                .into_iter()
                .map(move |scope| format!("{}\0{}", scope_wire(scope), record.path))
        })
        .collect::<Vec<_>>();
    changes.sort();
    Ok(WorktreeStatus {
        summary: repository_change_summary(&parsed.records),
        signature: changes.join("\n"),
    })
}

fn change_status(record: &ParsedStatusRecord) -> RepositoryFileStatus {
    match record.kind {
        StatusRecordKind::Unmerged => return RepositoryFileStatus::Unmerged,
        StatusRecordKind::Untracked => return RepositoryFileStatus::Untracked,
        _ => {}
    }
    match record
        .xy
        .chars()
        .find(|character| *character != '.')
        .unwrap_or('M')
    {
        'A' => RepositoryFileStatus::Added,
        'D' => RepositoryFileStatus::Deleted,
        'R' => RepositoryFileStatus::Renamed,
        'C' => RepositoryFileStatus::Copied,
        'T' => RepositoryFileStatus::TypeChanged,
        _ => RepositoryFileStatus::Modified,
    }
}

async fn repository_remotes(git: &GitProcess) -> Vec<RepositoryRemote> {
    let Ok(names) = git.run("remote", &[]).await else {
        return Vec::new();
    };
    let mut remotes = Vec::new();
    for name in names
        .stdout
        .split('\n')
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        let fetch_url = git
            .run("remote", &["get-url".to_string(), name.to_string()])
            .await
            .ok()
            .map(|result| redact_remote_url(result.stdout.trim()));
        let push_url = git
            .run(
                "remote",
                &[
                    "get-url".to_string(),
                    "--push".to_string(),
                    name.to_string(),
                ],
            )
            .await
            .ok()
            .map(|result| redact_remote_url(result.stdout.trim()));
        remotes.push(RepositoryRemote {
            name: name.to_string(),
            fetch_url,
            push_url,
        });
    }
    remotes
}

pub fn primary_repository_action(
    summary: &RepositoryChangeSummary,
    upstream: Option<&RepositoryUpstream>,
) -> RepositoryPrimaryAction {
    if summary.conflicts > 0 {
        return RepositoryPrimaryAction::ResolveConflicts;
    }
    if summary.staged + summary.unstaged + summary.untracked > 0 {
        return RepositoryPrimaryAction::ReviewChanges;
    }
    let Some(upstream) = upstream else {
        return RepositoryPrimaryAction::PublishBranch;
    };
    match (upstream.ahead > 0, upstream.behind > 0) {
        (true, true) => RepositoryPrimaryAction::Diverged,
        (true, false) => RepositoryPrimaryAction::Push,
        (false, true) => RepositoryPrimaryAction::Pull,
        (false, false) => RepositoryPrimaryAction::UpToDate,
    }
}

pub fn hash_id(prefix: &str, parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(parts.join("\0"));
    format!("{prefix}:{}", hex::encode(hasher.finalize()))
}

pub fn repository_worktree_id(repository_id: &str, worktree_path: &Path) -> String {
    hash_id(
        "wt",
        &[repository_id.to_string(), display_path(worktree_path)],
    )
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn canonical_git_path(value: &str, cwd: &Path) -> PathBuf {
    fs::canonicalize(cwd.join(value)).unwrap_or_else(|_| cwd.join(value))
}

fn session_kind_wire(kind: RepositorySessionKind) -> &'static str {
    match kind {
        RepositorySessionKind::AiSession => "ai-session",
        RepositorySessionKind::AppSession => "app-session",
    }
}

pub fn scope_wire(scope: RepositoryChangeScope) -> &'static str {
    match scope {
        RepositoryChangeScope::Conflict => "conflict",
        RepositoryChangeScope::Staged => "staged",
        RepositoryChangeScope::Unstaged => "unstaged",
        RepositoryChangeScope::Untracked => "untracked",
    }
}

#[cfg(unix)]
fn file_mode_bits(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
fn file_mode_bits(_metadata: &fs::Metadata) -> u32 {
    0
}
