import assert from "node:assert/strict";
import test from "node:test";

import {
  AiSessionWorkspaceSelectionSchema,
  RepositoryCheckoutBranchRequestSchema,
  RepositoryCommitRequestSchema,
  RepositoryCreateBranchRequestSchema,
  RepositoryCreateFileRequestSchema,
  RepositoryCreateTrackingBranchRequestSchema,
  RepositoryCreateWorktreeRequestSchema,
  RepositoryCreateWorktreeAiSessionRequestSchema,
  RepositoryDeleteBranchRequestSchema,
  RepositoryDeleteFileRequestSchema,
  RepositoryDiscardAllTrackedRequestSchema,
  RepositoryDiscardWorktreeRequestSchema,
  RepositoryFetchRequestSchema,
  RepositoryPullRequestSchema,
  RepositoryPublishRequestSchema,
  RepositoryPushRequestSchema,
  RepositoryRemoveWorktreeRequestSchema,
  RepositoryRenameFileRequestSchema,
  RepositoryStageRequestSchema,
  RepositoryStartAiSessionRequestSchema,
  RepositoryUnstageRequestSchema,
  RepositoryWriteFileRequestSchema,
} from "../src/repository.ts";
import { normalizeAppSessionRecord } from "../src/app-sessions.ts";

const snapshot = "snapshot-1";
const version = "version-1234567890";
const validMutations = [
  [RepositoryCreateFileRequestSchema, { path: "src/new.ts", content: "", expectedAbsent: true, expectedSnapshotId: snapshot }],
  [RepositoryWriteFileRequestSchema, { path: "src/a.ts", content: "next", expectedVersion: version, expectedSnapshotId: snapshot }],
  [RepositoryRenameFileRequestSchema, { path: "src/a.ts", destination: "src/b.ts", expectedVersion: version, expectedDestinationAbsent: true, expectedSnapshotId: snapshot }],
  [RepositoryDeleteFileRequestSchema, { path: "src/a.ts", expectedVersion: version, expectedSnapshotId: snapshot, confirm: true }],
  [RepositoryStageRequestSchema, { paths: [{ path: "src/a.ts", expectedVersion: version }], expectedSnapshotId: snapshot }],
  [RepositoryUnstageRequestSchema, { paths: [{ path: "src/a.ts", expectedVersion: version }], expectedSnapshotId: snapshot }],
  [RepositoryDiscardWorktreeRequestSchema, { paths: [{ path: "src/a.ts", expectedVersion: version }], expectedSnapshotId: snapshot, confirm: true }],
  [RepositoryDiscardAllTrackedRequestSchema, { paths: [{ path: "src/a.ts", expectedVersion: version }], expectedSnapshotId: snapshot, confirm: true }],
  [RepositoryCommitRequestSchema, { message: "feat: add repository", expectedSnapshotId: snapshot }],
  [RepositoryCreateWorktreeRequestSchema, { mode: "new-branch", branchName: "feature/repository", startRef: "HEAD", expectedSnapshotId: snapshot }],
  [RepositoryRemoveWorktreeRequestSchema, { worktreeId: "wt-1", expectedSnapshotId: snapshot, confirm: true }],
  [RepositoryCreateBranchRequestSchema, { name: "feature/repository", expectedSnapshotId: snapshot }],
  [RepositoryCheckoutBranchRequestSchema, { branch: "feature/repository", expectedSnapshotId: snapshot }],
  [RepositoryCreateTrackingBranchRequestSchema, { name: "feature/repository", remoteTrackingRef: "origin/feature/repository", expectedSnapshotId: snapshot }],
  [RepositoryDeleteBranchRequestSchema, { name: "feature/repository", expectedSnapshotId: snapshot, confirm: true }],
  [RepositoryFetchRequestSchema, { remote: "origin", expectedSnapshotId: snapshot }],
  [RepositoryPullRequestSchema, { expectedSnapshotId: snapshot }],
  [RepositoryPublishRequestSchema, { remote: "origin", sourceBranch: "feature/repository", targetBranch: "feature/repository", setUpstream: true, confirmSetUpstream: true, expectedSnapshotId: snapshot }],
  [RepositoryPushRequestSchema, { remote: "origin", sourceBranch: "feature/repository", targetBranch: "feature/repository", expectedSnapshotId: snapshot }],
];

test("repository mutation inputs are strict and never accept filesystem or credential overrides", () => {
  const forbidden = ["cwd", "repositoryRoot", "gitCommonDir", "worktreePath", "credential", "token", "privateKey", "force", "forceWithLease", "detach", "rebase", "reset", "amend"];
  for (const [schema, value] of validMutations) {
    assert.equal(schema.safeParse(value).success, true);
    for (const field of forbidden) {
      assert.equal(schema.safeParse({ ...value, [field]: field === "force" ? true : "attacker-controlled" }).success, false, `${field} was accepted`);
    }
  }
});

test("workspace selection uses opaque server-issued identifiers, never a path", () => {
  assert.deepEqual(AiSessionWorkspaceSelectionSchema.parse({ type: "worktree", repositoryContextId: "repo-context-1", worktreeId: "wt-1" }), {
    type: "worktree",
    repositoryContextId: "repo-context-1",
    worktreeId: "wt-1",
  });
  assert.equal(AiSessionWorkspaceSelectionSchema.safeParse({ type: "worktree", repositoryContextId: "repo-context-1", worktreeId: "wt-1", cwd: "/tmp/escape" }).success, false);
  assert.equal(AiSessionWorkspaceSelectionSchema.safeParse({ type: "current", path: "/tmp/escape" }).success, false);
  assert.equal(RepositoryStartAiSessionRequestSchema.safeParse({
    agent: "codex",
    workspaceSelection: { type: "worktree", repositoryContextId: "repo-context-1", worktreeId: "wt-1" },
  }).success, true);
  assert.equal(RepositoryStartAiSessionRequestSchema.safeParse({
    agent: "codex",
    workspaceSelection: { type: "worktree", repositoryContextId: "repo-context-1", worktreeId: "wt-1" },
    cwd: "/tmp/escape",
  }).success, false);
  assert.equal(RepositoryCreateWorktreeAiSessionRequestSchema.safeParse({
    agent: "claude",
    worktree: { mode: "new-branch", branchName: "feature/isolated", startRef: "HEAD", expectedSnapshotId: snapshot },
  }).success, true);
  assert.equal(RepositoryCreateWorktreeAiSessionRequestSchema.safeParse({
    agent: "claude",
    worktree: { mode: "new-branch", branchName: "feature/isolated", startRef: "HEAD", expectedSnapshotId: snapshot, worktreePath: "/tmp/escape" },
  }).success, false);
});

test("repository paths reject absolute, traversal, git metadata, and empty segments", () => {
  for (const path of ["/etc/passwd", "../secret", "src/../secret", ".git/config", "src//file", "src/./file", "C:\\secret"] ) {
    assert.equal(RepositoryCreateFileRequestSchema.safeParse({ path, content: "", expectedAbsent: true, expectedSnapshotId: snapshot }).success, false, path);
  }
});

test("publish requires explicit confirmation before setting first upstream", () => {
  const value = { remote: "origin", sourceBranch: "feature/repository", targetBranch: "feature/repository", setUpstream: true, expectedSnapshotId: snapshot };
  assert.equal(RepositoryPublishRequestSchema.safeParse(value).success, false);
  assert.equal(RepositoryPublishRequestSchema.safeParse({ ...value, confirmSetUpstream: true }).success, true);
});

test("app session projection migrates legacy cwd into workspace", () => {
  const projected = normalizeAppSessionRecord({
    id: "app-1",
    status: "running",
    tty: { cwd: "/workspace/project" },
  });
  assert.deepEqual(projected.workspace, { cwd: "/workspace/project" });
  assert.equal(normalizeAppSessionRecord({
    id: "app-2",
    status: "running",
    workspace: { cwd: "/workspace/current", future: true },
    launch: { cwd: "/workspace/legacy" },
  }).workspace.cwd, "/workspace/current");
});
