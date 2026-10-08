import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneClient } from "../src/client.ts";
import { isControlPlaneNotFoundError, type RepositorySessionTarget, type RepositoryWorkspaceTarget } from "../src/repository.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const oid = "a".repeat(40);

function worktree(overrides: Record<string, unknown> = {}) {
  return {
    id: "worktree_one",
    isCurrent: true,
    isMain: true,
    managed: false,
    head: { state: "branch", branch: "main", oid },
    dirty: false,
    locked: false,
    prunable: false,
    activeAiSessionIds: [],
    activeAppSessionIds: [],
    canCreateAiSession: true,
    canRemove: false,
    createAiSessionBlockers: [],
    removeBlockers: ["main-worktree"],
    ...overrides,
  };
}

function worktreesPayload(overrides: Record<string, unknown> = {}) {
  return {
    repositoryId: "repo_one",
    repositoryContextId: "context_one",
    snapshotId: "snapshot_one",
    items: [worktree()],
    ...overrides,
  };
}

function branchesPayload() {
  return {
    snapshotId: "snapshot_one",
    branches: [{
      name: "main",
      oid,
      kind: "local",
      current: true,
      checkedOutWorktreeIds: ["worktree_one"],
    }],
  };
}

function notFound() {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function fixture(handler: (path: string, init?: RequestInit) => unknown) {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      const data = handler(path, init);
      if (data instanceof Error) throw data;
      return schema.parse({ data });
    },
  };
  return { api: createControlPlaneClient(transport).repository, requests };
}

const target: RepositoryWorkspaceTarget = { instanceId: "instance one", cwdFolderId: "folder/one" };
const legacySession: RepositorySessionTarget = { instanceId: "instance one", sessionKind: "ai-session", sessionId: "session one" };

test("repository client owns workspace routes, query encoding and tolerant response parsing", async () => {
  const { api, requests } = fixture((path) => (
    path.includes("/worktrees")
      ? worktreesPayload({ future: "ignored", items: [worktree({ futureField: "ignored" })] })
      : branchesPayload()
  ));

  const list = await api.worktrees(target);
  assert.equal(list.repositoryContextId, "context_one");
  assert.equal(list.items[0].isMain, true);
  assert.equal((list.items[0] as Record<string, unknown>).futureField, undefined);
  await api.branches(target);

  assert.deepEqual(requests.map((request) => request.path), [
    "/api/controlled-instances/instance%20one/repository/worktrees?cwdFolderId=folder%2Fone",
    "/api/controlled-instances/instance%20one/repository/branches?cwdFolderId=folder%2Fone",
  ]);
});

test("repository client validates create input and posts to the workspace route", async () => {
  const { api, requests } = fixture(() => ({ worktreeId: "worktree_two", worktrees: worktreesPayload() }));
  const created = await api.createWorktree(target, {
    mode: "new-branch",
    branchName: "session/demo",
    startRef: "main",
    expectedSnapshotId: "snapshot_one",
  });
  assert.equal(created.worktreeId, "worktree_two");
  assert.deepEqual(requests.map((request) => [request.path, request.init?.method]), [
    ["/api/controlled-instances/instance%20one/repository/worktrees?cwdFolderId=folder%2Fone", "POST"],
  ]);
  await assert.rejects(() => api.createWorktree(target, { mode: "existing-branch", branchName: " ", expectedSnapshotId: "snapshot_one" }));
});

test("repository client reads a session's own context from the session route", async () => {
  const { api, requests } = fixture(() => ({
    availability: "available",
    sessionKind: "ai-session",
    sessionId: "session_one",
    observedAt: "2026-09-04T00:00:00.000Z",
    repositoryContextId: "context_one",
    currentWorktree: worktree({ activeAiSessionIds: ["session_one"] }),
  }));

  const context = await api.context(legacySession);

  assert.equal(context.currentWorktree?.id, "worktree_one");
  assert.deepEqual(requests.map((request) => request.path), [
    "/instances/instance%20one/api/ai-sessions/session%20one/repository/context",
  ]);
});

test("repository client falls back to the legacy session route on 404", async () => {
  const { api, requests } = fixture((path) => (
    path.startsWith("/api/") ? notFound() : worktreesPayload()
  ));
  const viaLegacy: RepositoryWorkspaceTarget = { instanceId: "instance one", legacySession };
  const list = await api.worktrees(viaLegacy);
  assert.equal(list.snapshotId, "snapshot_one");
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/controlled-instances/instance%20one/repository/worktrees",
    "/instances/instance%20one/api/ai-sessions/session%20one/repository/worktrees",
  ]);
});

test("repository client keeps the 404 when no legacy session is available", async () => {
  const { api, requests } = fixture(() => notFound());
  await assert.rejects(() => api.worktrees(target), (error: unknown) => isControlPlaneNotFoundError(error));
  assert.equal(requests.length, 1);
});

test("repository client never falls back for non-404 failures", async () => {
  const conflict = Object.assign(new Error("Conflict"), { status: 409 });
  const { api, requests } = fixture(() => conflict);
  await assert.rejects(() => api.branches({ instanceId: "instance one", legacySession }));
  assert.equal(requests.length, 1);
});

test("repository client restricts the legacy remove fallback to AI session contexts", async () => {
  const { api } = fixture((path) => (path.startsWith("/api/") ? notFound() : ({ removedWorktreeId: "worktree_one", branchRetained: true, worktrees: worktreesPayload() })));
  const appSession: RepositorySessionTarget = { instanceId: "instance one", sessionKind: "app-session", sessionId: "app_one" };
  await assert.rejects(() => api.removeWorktree({ instanceId: "instance one", legacySession: appSession }, {
    worktreeId: "worktree_one",
    expectedSnapshotId: "snapshot_one",
    confirm: true,
  }), /AI session repository context/);

  const removed = await api.removeWorktree({ instanceId: "instance one", legacySession }, {
    worktreeId: "worktree_one",
    expectedSnapshotId: "snapshot_one",
    confirm: true,
  });
  assert.equal(removed.branchRetained, true);
});

test("repository client requires preflight before moving a worktree to main", async () => {
  const preflight = {
    worktreeId: "worktree_two",
    canMove: true,
    blockers: [],
    targetBranch: "feature/demo",
    targetChanges: { conflicts: 0, staged: 0, unstaged: 1, untracked: 0 },
    mainWorktreeId: "worktree_one",
    mainBranch: "main",
  };
  const { api, requests } = fixture((path) => (
    path.includes("/preflight")
      ? preflight
      : { movedWorktreeId: "worktree_two", adoptedBranch: "main", previousHead: oid, carriedChanges: true, worktrees: worktreesPayload() }
  ));

  const result = await api.moveWorktreeToMainPreflight(target, { worktreeId: "worktree_two" });
  assert.equal(result.canMove, true);
  await api.moveWorktreeToMain(target, { worktreeId: "worktree_two", expectedSnapshotId: "snapshot_one", confirm: true });

  assert.deepEqual(requests.map((request) => request.path), [
    "/api/controlled-instances/instance%20one/repository/worktrees/move-to-main/preflight?cwdFolderId=folder%2Fone",
    "/api/controlled-instances/instance%20one/repository/worktrees/move-to-main?cwdFolderId=folder%2Fone",
  ]);
});

test("repository client surfaces incompatible responses instead of an empty projection", async () => {
  const { api } = fixture(() => ({ repositoryId: "repo_one", repositoryContextId: "context_one", items: [] }));
  await assert.rejects(() => api.worktrees(target));

  const invalidPreflight = fixture(() => ({ worktreeId: "worktree_two", canMove: "yes", mainWorktreeId: "worktree_one" }));
  await assert.rejects(() => invalidPreflight.api.moveWorktreeToMainPreflight(target, { worktreeId: "worktree_two" }));
});
