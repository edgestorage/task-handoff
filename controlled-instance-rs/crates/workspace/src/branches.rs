use crate::{
    changes::mutation_result,
    context::{repository_worktree_id, require_repository},
    error::RepositoryOperationError,
    git::{GitError, GitProcess},
    worktrees::{canonical_worktree_path, parse_worktree_porcelain},
    ResolvedRepository,
};
use controlled_instance_protocol::{
    RepositoryBranch, RepositoryBranchKind, RepositoryBranchMutationResult, RepositoryBranches,
    RepositoryChangeSummary, RepositoryContext, RepositoryMutationResult,
};
use std::collections::HashMap;
use tokio::time::Duration;

pub async fn list_branches(
    resolved: &ResolvedRepository,
) -> Result<RepositoryBranches, RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    list_branches_from_state(&state).await
}

pub async fn create_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    name: &str,
) -> Result<(), RepositoryOperationError> {
    validate_git_name(name)?;
    checkout_mutation(resolved, Some(expected_snapshot_id), |git| async move {
        git.run("checkout", &["-b".to_string(), name.to_string()])
            .await
            .map(|_| ())
    })
    .await
}

pub async fn checkout_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    branch: &str,
) -> Result<(), RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    let branches = list_branches_from_state(&state).await?;
    let target = branches
        .branches
        .iter()
        .find(|candidate| candidate.kind == RepositoryBranchKind::Local && candidate.name == branch)
        .ok_or_else(|| {
            RepositoryOperationError::with_current(
                "REPOSITORY_BRANCH_INVALID",
                "Local branch does not exist.",
                &state,
            )
        })?;
    if !target.checked_out_worktree_ids.is_empty() && !target.current {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_OCCUPIED",
            "Branch is checked out in another worktree.",
            &state,
        ));
    }
    checkout_mutation(&state, None, |git| async move {
        git.run("checkout", &[branch.to_string()]).await.map(|_| ())
    })
    .await
}

pub async fn checkout_branch_for_ai_session(
    resolved: &ResolvedRepository,
    branch: &str,
) -> Result<(), RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    let branches = list_branches_from_state(&state).await?;
    let target = branches
        .branches
        .iter()
        .find(|candidate| candidate.kind == RepositoryBranchKind::Local && candidate.name == branch)
        .ok_or_else(|| {
            RepositoryOperationError::with_current(
                "REPOSITORY_BRANCH_INVALID",
                "Local branch does not exist.",
                &state,
            )
        })?;
    if !target.checked_out_worktree_ids.is_empty() && !target.current {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_OCCUPIED",
            "Branch is checked out in another worktree.",
            &state,
        ));
    }
    checkout_mutation(&state, None, |git| async move {
        git.run("checkout", &[branch.to_string()]).await.map(|_| ())
    })
    .await
}

pub async fn create_tracking_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    name: &str,
    remote_tracking_ref: &str,
) -> Result<(), RepositoryOperationError> {
    validate_git_name(name)?;
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    let branches = list_branches_from_state(&state).await?;
    if !branches.branches.iter().any(|branch| {
        branch.kind == RepositoryBranchKind::RemoteTracking && branch.name == remote_tracking_ref
    }) {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_INVALID",
            "Remote-tracking branch does not exist in local refs.",
            &state,
        ));
    }
    checkout_mutation(&state, None, |git| async move {
        git.run(
            "checkout",
            &[
                "-b".to_string(),
                name.to_string(),
                "--track".to_string(),
                remote_tracking_ref.to_string(),
            ],
        )
        .await
        .map(|_| ())
    })
    .await
}

pub async fn delete_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    name: &str,
) -> Result<(), RepositoryOperationError> {
    validate_git_name(name)?;
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    let branches = list_branches_from_state(&state).await?;
    let target = branches
        .branches
        .iter()
        .find(|candidate| candidate.kind == RepositoryBranchKind::Local && candidate.name == name)
        .ok_or_else(|| {
            RepositoryOperationError::with_current(
                "REPOSITORY_BRANCH_INVALID",
                "Local branch does not exist.",
                &state,
            )
        })?;
    if target.current || !target.checked_out_worktree_ids.is_empty() {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_OCCUPIED",
            "Current or checked-out branches cannot be deleted.",
            &state,
        ));
    }
    GitProcess::new(state.worktree_root.as_ref().expect("required root"))
        .run(
            "branch",
            &["-d".to_string(), "--".to_string(), name.to_string()],
        )
        .await
        .map_err(|error| {
            git_error(
                error,
                "delete",
                "Git rejected safe branch deletion.",
                &state,
            )
        })?;
    Ok(())
}

pub async fn fetch_remote(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    remote: &str,
) -> Result<(), RepositoryOperationError> {
    validate_git_name(remote)?;
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    assert_remote(&state, remote)?;
    let options = crate::GitProcessOptions {
        timeout: Duration::from_secs(60),
        remote: true,
        ..crate::GitProcessOptions::default()
    };
    GitProcess::new(state.worktree_root.as_ref().expect("required root"))
        .run_with_options("fetch", &[remote.to_string()], options)
        .await
        .map_err(|error| git_error(error, "fetch", "Git fetch failed.", &state))?;
    Ok(())
}

pub async fn pull_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
) -> Result<(), RepositoryOperationError> {
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    if !is_clean(&state) {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_DIRTY",
            "Pull requires a clean worktree and index.",
            &state,
        ));
    }
    let Some(upstream) = state.context.upstream.clone() else {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_UPSTREAM_MISSING",
            "Current branch has no upstream.",
            &state,
        ));
    };
    if upstream.ahead > 0 && upstream.behind > 0 {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_NON_FAST_FORWARD",
            "Current branch has diverged from its upstream.",
            &state,
        ));
    }
    let options = crate::GitProcessOptions {
        timeout: Duration::from_secs(60),
        remote: true,
        ..crate::GitProcessOptions::default()
    };
    GitProcess::new(state.worktree_root.as_ref().expect("required root"))
        .run_with_options(
            "pull",
            &["--ff-only".to_string(), upstream.remote, upstream.branch],
            options,
        )
        .await
        .map_err(|error| git_error(error, "pull", "Git pull could not fast-forward.", &state))?;
    Ok(())
}

pub async fn publish_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    remote: &str,
    source_branch: &str,
    target_branch: &str,
    set_upstream: bool,
    confirm_set_upstream: bool,
) -> Result<(), RepositoryOperationError> {
    push_mutation(PushMutation {
        resolved,
        expected_snapshot_id,
        remote,
        source_branch,
        target_branch,
        set_upstream,
        confirm_set_upstream,
        publish: true,
    })
    .await
}

pub async fn push_branch(
    resolved: &ResolvedRepository,
    expected_snapshot_id: &str,
    remote: &str,
    source_branch: &str,
    target_branch: &str,
) -> Result<(), RepositoryOperationError> {
    push_mutation(PushMutation {
        resolved,
        expected_snapshot_id,
        remote,
        source_branch,
        target_branch,
        set_upstream: false,
        confirm_set_upstream: false,
        publish: false,
    })
    .await
}

pub fn branch_mutation_result(
    state: &ResolvedRepository,
    branches: RepositoryBranches,
) -> RepositoryBranchMutationResult {
    RepositoryBranchMutationResult {
        snapshot_id: state.context.snapshot_id.clone().unwrap_or_default(),
        context: state.context.clone(),
        branches,
    }
}

pub fn branch_mutation_as_mutation(state: &ResolvedRepository) -> RepositoryMutationResult {
    mutation_result(state, None)
}

pub fn validate_git_name(value: &str) -> Result<(), RepositoryOperationError> {
    let invalid_character = value.chars().any(|character| {
        character.is_ascii_control()
            || matches!(character, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    });
    if value.trim().is_empty()
        || value.chars().count() > 255
        || invalid_character
        || value.contains("..")
        || value.ends_with('.')
        || value.ends_with('/')
    {
        return Err(RepositoryOperationError::new(
            "REPOSITORY_REQUEST_INVALID",
            "Invalid Git name.",
        ));
    }
    Ok(())
}

async fn list_branches_from_state(
    state: &ResolvedRepository,
) -> Result<RepositoryBranches, RepositoryOperationError> {
    let root = state.worktree_root.as_ref().expect("required root");
    let result = GitProcess::new(root)
        .run(
            "for-each-ref",
            &[
                "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)"
                    .to_string(),
                "refs/heads".to_string(),
                "refs/remotes".to_string(),
            ],
        )
        .await
        .map_err(|error| git_error(error, "delete", "Git branches are unavailable.", state))?;
    let worktree_output = GitProcess::new(root)
        .run(
            "worktree",
            &[
                "list".to_string(),
                "--porcelain".to_string(),
                "-z".to_string(),
            ],
        )
        .await
        .map_err(|error| git_error(error, "list", "Git worktrees are unavailable.", state))?
        .stdout;
    let mut occupied: HashMap<String, Vec<String>> = HashMap::new();
    let repository_id = state.context.repository_id.as_deref().unwrap_or_default();
    for record in parse_worktree_porcelain(&worktree_output) {
        let Some(branch) = record.branch else {
            continue;
        };
        let canonical = canonical_worktree_path(&record.path);
        occupied
            .entry(branch)
            .or_default()
            .push(repository_worktree_id(repository_id, &canonical));
    }
    let mut branches = Vec::new();
    for line in result.stdout.split('\n').filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        let reference = fields.first().copied().unwrap_or_default();
        let oid = fields.get(1).copied().unwrap_or_default();
        if reference.is_empty() || oid.is_empty() || reference.ends_with("/HEAD") {
            continue;
        }
        let local = reference.starts_with("refs/heads/");
        let name = reference
            .strip_prefix(if local {
                "refs/heads/"
            } else {
                "refs/remotes/"
            })
            .unwrap_or(reference)
            .to_string();
        let upstream = fields
            .get(2)
            .copied()
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let track = fields.get(3).copied().unwrap_or_default();
        let ahead = parse_track(track, "ahead");
        let behind = parse_track(track, "behind");
        branches.push(RepositoryBranch {
            name: name.clone(),
            oid: oid.to_string(),
            kind: if local {
                RepositoryBranchKind::Local
            } else {
                RepositoryBranchKind::RemoteTracking
            },
            current: local
                && state
                    .context
                    .head
                    .as_ref()
                    .is_some_and(|head| head.branch.as_deref() == Some(name.as_str())),
            upstream,
            ahead: local.then_some(ahead),
            behind: local.then_some(behind),
            checked_out_worktree_ids: if local {
                occupied.get(&name).cloned().unwrap_or_default()
            } else {
                Vec::new()
            },
        });
    }
    Ok(RepositoryBranches {
        snapshot_id: state.context.snapshot_id.clone().unwrap_or_default(),
        branches,
    })
}

async fn checkout_mutation<F, Fut>(
    resolved: &ResolvedRepository,
    expected_snapshot_id: Option<&str>,
    operation: F,
) -> Result<(), RepositoryOperationError>
where
    F: FnOnce(GitProcess) -> Fut,
    Fut: std::future::Future<Output = Result<(), GitError>>,
{
    let state = require_repository(resolved.clone())?;
    if let Some(expected) = expected_snapshot_id {
        assert_snapshot(&state, expected)?;
    }
    operation(GitProcess::new(
        state.worktree_root.as_ref().expect("required root"),
    ))
    .await
    .map_err(|error| {
        git_error(
            error,
            "checkout",
            "Git could not switch branches without overwriting changes.",
            &state,
        )
    })
}

struct PushMutation<'a> {
    resolved: &'a ResolvedRepository,
    expected_snapshot_id: &'a str,
    remote: &'a str,
    source_branch: &'a str,
    target_branch: &'a str,
    set_upstream: bool,
    confirm_set_upstream: bool,
    publish: bool,
}

async fn push_mutation(input: PushMutation<'_>) -> Result<(), RepositoryOperationError> {
    let PushMutation {
        resolved,
        expected_snapshot_id,
        remote,
        source_branch,
        target_branch,
        set_upstream,
        confirm_set_upstream,
        publish,
    } = input;
    validate_git_name(remote)?;
    validate_git_name(source_branch)?;
    validate_git_name(target_branch)?;
    let state = require_repository(resolved.clone())?;
    assert_snapshot(&state, expected_snapshot_id)?;
    if !is_clean(&state) {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_DIRTY",
            "Push requires a clean worktree and index.",
            &state,
        ));
    }
    if state.context.head.as_ref().is_none_or(|head| {
        head.state != controlled_instance_protocol::RepositoryHeadState::Branch
            || head.branch.as_deref() != Some(source_branch)
    }) {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_INVALID",
            "Push source must be the current local branch.",
            &state,
        ));
    }
    if publish && set_upstream && !confirm_set_upstream {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_REQUEST_INVALID",
            "Setting upstream requires explicit confirmation.",
            &state,
        ));
    }
    if !publish
        && state
            .context
            .upstream
            .as_ref()
            .is_some_and(|upstream| upstream.behind > 0)
    {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_NON_FAST_FORWARD",
            "Local branch is behind its upstream.",
            &state,
        ));
    }
    assert_remote(&state, remote)?;
    let mut args = Vec::new();
    if set_upstream {
        args.push("--set-upstream".to_string());
    }
    args.push(remote.to_string());
    args.push(format!(
        "refs/heads/{source_branch}:refs/heads/{target_branch}"
    ));
    let options = crate::GitProcessOptions {
        timeout: Duration::from_secs(60),
        remote: true,
        ..crate::GitProcessOptions::default()
    };
    GitProcess::new(state.worktree_root.as_ref().expect("required root"))
        .run_with_options("push", &args, options)
        .await
        .map_err(|error| git_error(error, "push", "Git push failed.", &state))?;
    Ok(())
}

fn assert_snapshot(
    state: &ResolvedRepository,
    expected: &str,
) -> Result<(), RepositoryOperationError> {
    if state.context.snapshot_id.as_deref() != Some(expected) {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_STATE_STALE",
            "Repository state changed after it was loaded.",
            state,
        ));
    }
    Ok(())
}

fn assert_remote(state: &ResolvedRepository, remote: &str) -> Result<(), RepositoryOperationError> {
    if !state
        .context
        .remotes
        .as_ref()
        .is_some_and(|remotes| remotes.iter().any(|item| item.name == remote))
    {
        return Err(RepositoryOperationError::with_current(
            "REPOSITORY_BRANCH_INVALID",
            "Configured remote does not exist.",
            state,
        ));
    }
    Ok(())
}

fn is_clean(state: &ResolvedRepository) -> bool {
    state
        .changes
        .as_ref()
        .map(|changes| &changes.summary)
        .is_none_or(summary_is_clean)
}

fn summary_is_clean(summary: &RepositoryChangeSummary) -> bool {
    summary.conflicts + summary.staged + summary.unstaged + summary.untracked == 0
}

fn parse_track(value: &str, direction: &str) -> u64 {
    let prefix = format!("{direction} ");
    value
        .split(' ')
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|window| {
            (window[0] == direction)
                .then(|| window[1].parse().ok())
                .flatten()
        })
        .or_else(|| {
            value
                .strip_prefix(&prefix)
                .and_then(|number| number.parse().ok())
        })
        .unwrap_or(0)
}

fn git_error(
    error: GitError,
    operation: &str,
    fallback: &str,
    current: &ResolvedRepository,
) -> RepositoryOperationError {
    if matches!(error, GitError::NotFound) {
        return RepositoryOperationError::with_current(
            "REPOSITORY_GIT_UNAVAILABLE",
            "Git executable is unavailable.",
            current,
        );
    }
    let message = match &error {
        GitError::Exit {
            message, stderr, ..
        } => format!("{message}\n{stderr}"),
        _ => error.to_string(),
    };
    let code = if message.contains("non-fast-forward")
        || message.contains("fetch first")
        || message.contains("Not possible to fast-forward")
        || (message.contains("rejected") && message.contains("behind"))
    {
        "REPOSITORY_NON_FAST_FORWARD"
    } else if message.contains("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=AMBIGUOUS") {
        "REPOSITORY_CREDENTIAL_AMBIGUOUS"
    } else if message.contains("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=UNSUPPORTED") {
        "REPOSITORY_REMOTE_UNSUPPORTED"
    } else if message.contains("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=MISSING_HOST_KEY") {
        "REPOSITORY_HOST_KEY_REQUIRED"
    } else if message.contains("TASK_HANDOFF_GIT_CREDENTIAL_ERROR=REJECTED") {
        "REPOSITORY_AUTHENTICATION_REJECTED"
    } else if message.contains("could not read Username")
        || message.contains("terminal prompts disabled")
    {
        "REPOSITORY_CREDENTIAL_MISSING"
    } else if message.contains("authentication failed")
        || message.contains("permission denied")
        || message.contains("publickey")
    {
        "REPOSITORY_AUTHENTICATION_REJECTED"
    } else if operation == "delete"
        && (message.contains("not fully merged") || message.contains("not merged"))
    {
        "REPOSITORY_BRANCH_UNMERGED"
    } else if operation == "checkout"
        && (message.contains("already checked out") || message.contains("used by worktree"))
    {
        "REPOSITORY_BRANCH_OCCUPIED"
    } else if operation == "checkout"
        && (message.contains("would be overwritten")
            || message.contains("local changes")
            || message.contains("untracked working tree files"))
    {
        "REPOSITORY_DIRTY"
    } else if matches!(error, GitError::Timeout(_)) {
        "REPOSITORY_COMMAND_TIMEOUT"
    } else {
        "REPOSITORY_OPERATION_FAILED"
    };
    let message = match code {
        "REPOSITORY_CREDENTIAL_AMBIGUOUS" => {
            "More than one retained credential matches this Git remote.".to_string()
        }
        "REPOSITORY_REMOTE_UNSUPPORTED" => {
            "The Git remote cannot be matched to a managed credential scope.".to_string()
        }
        "REPOSITORY_HOST_KEY_REQUIRED" => {
            "The matching SSH credential does not have a pinned host key.".to_string()
        }
        "REPOSITORY_AUTHENTICATION_REJECTED" => {
            "The Git remote rejected the available credential.".to_string()
        }
        "REPOSITORY_CREDENTIAL_MISSING" => {
            "No credential is available for this Git remote.".to_string()
        }
        "REPOSITORY_BRANCH_UNMERGED" => "Branch contains commits that are not merged.".to_string(),
        _ => fallback.to_string(),
    };
    RepositoryOperationError::with_current(code, message, current)
}

#[allow(dead_code)]
fn context_with_snapshot(context: &RepositoryContext, snapshot_id: String) -> RepositoryContext {
    let mut context = context.clone();
    context.snapshot_id = Some(snapshot_id);
    context
}
