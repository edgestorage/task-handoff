const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");
const { createGitFixture } = require("./fixtures/git-repository.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { RepositoryChangesService, RepositoryOperationError } = require("../packages/controlled-instance/src/repository/changes.ts");
const { RepositorySessionResolver } = require("../packages/controlled-instance/src/repository/context.ts");

function services(fixture) {
  const resolver = new RepositorySessionResolver({
    aiSession: (id) => id === "ai-1" ? { cwd: fixture.root, status: "running" } : undefined,
    appSession: () => undefined,
  });
  const resolve = () => resolver.resolveAiSession("ai-1");
  return { resolve, changes: new RepositoryChangesService(resolve) };
}

function selected(state, scope, paths) {
  return paths.map((relativePath) => {
    const entry = state.changes.entries.find((candidate) => candidate.scope === scope && candidate.path === relativePath);
    assert.ok(entry, `${scope}:${relativePath}`);
    return { path: relativePath, expectedVersion: entry.version };
  });
}

test("change entries and diffs keep staged and unstaged versions independent", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "staged content\n");
  fixture.git(["add", "--", "tracked.txt"]);
  fixture.write("tracked.txt", "unstaged content\n");
  fixture.write("new.txt", "new content\n");
  fs.writeFileSync(path.join(fixture.root, "binary.dat"), Buffer.from([0, 1, 2]));
  fixture.write("large.txt", `${"line\n".repeat(100)}`);
  const { resolve, changes } = services(fixture);
  const state = await resolve();
  const staged = state.changes.entries.find((entry) => entry.path === "tracked.txt" && entry.scope === "staged");
  const unstaged = state.changes.entries.find((entry) => entry.path === "tracked.txt" && entry.scope === "unstaged");
  assert.notEqual(staged.version, unstaged.version);

  const stagedDiff = await changes.diff("staged", "tracked.txt");
  const unstagedDiff = await changes.diff("unstaged", "tracked.txt");
  assert.match(stagedDiff.content, /staged content/);
  assert.doesNotMatch(stagedDiff.content, /unstaged content/);
  assert.match(unstagedDiff.content, /unstaged content/);
  const untrackedDiff = await changes.diff("untracked", "new.txt");
  assert.match(untrackedDiff.content, /--- \/dev\/null/);
  assert.match(untrackedDiff.content, /\+new content/);
  const binaryDiff = await changes.diff("untracked", "binary.dat");
  assert.equal(binaryDiff.binary, true);
  assert.equal(binaryDiff.complete, false);
  assert.equal(binaryDiff.content, "");
  const truncated = await changes.diff("untracked", "large.txt", 80);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.complete, false);
  assert.ok(Buffer.byteLength(truncated.content) <= 80);
});

test("conflicted paths remain a distinct change and provide a safe diff", async () => {
  const fixture = createGitFixture();
  fixture.createConflict();
  const { resolve, changes } = services(fixture);
  const state = await resolve();
  assert.equal(state.changes.summary.conflicts, 1);
  assert.equal(state.changes.entries.some((entry) => entry.scope === "unstaged" && entry.path === "conflict.txt"), false);
  const diff = await changes.diff("conflict", "conflict.txt");
  assert.equal(diff.scope, "conflict");
  assert.match(diff.content, /conflict.txt/);
});

test("stage and unstage affect only selected paths and return fresh authority", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "one changed\n");
  fixture.write("second.txt", "second base\n");
  fixture.commit("add second");
  fixture.write("tracked.txt", "one worktree\n");
  fixture.write("second.txt", "second worktree\n");
  const { resolve, changes } = services(fixture);
  const before = await resolve();
  const stagedResult = await changes.stage({ expectedSnapshotId: before.context.snapshotId, paths: selected(before, "unstaged", ["tracked.txt"]) });
  assert.notEqual(stagedResult.snapshotId, before.context.snapshotId);
  assert.equal(stagedResult.changes.entries.some((entry) => entry.scope === "staged" && entry.path === "tracked.txt"), true);
  assert.equal(stagedResult.changes.entries.some((entry) => entry.scope === "unstaged" && entry.path === "second.txt"), true);
  const unstagedResult = await changes.unstage({ expectedSnapshotId: stagedResult.snapshotId, paths: selected(stagedResult, "staged", ["tracked.txt"]) });
  assert.equal(unstagedResult.changes.summary.staged, 0);
  assert.equal(unstagedResult.changes.summary.unstaged, 2);
});

test("discard-worktree preserves index while discard-all-tracked restores only selected paths", async () => {
  const fixture = createGitFixture();
  fixture.write("other.txt", "other base\n");
  fixture.commit("add other");
  fixture.write("tracked.txt", "staged value\n");
  fixture.git(["add", "--", "tracked.txt"]);
  fixture.write("tracked.txt", "worktree value\n");
  fixture.write("other.txt", "other changed\n");
  const { resolve, changes } = services(fixture);
  const before = await resolve();
  const discardedWorktree = await changes.discardWorktree({
    expectedSnapshotId: before.context.snapshotId,
    paths: selected(before, "unstaged", ["tracked.txt"]),
    confirm: true,
  });
  assert.equal(fs.readFileSync(path.join(fixture.root, "tracked.txt"), "utf8"), "staged value\n");
  assert.equal(discardedWorktree.changes.entries.some((entry) => entry.scope === "staged" && entry.path === "tracked.txt"), true);
  assert.equal(fs.readFileSync(path.join(fixture.root, "other.txt"), "utf8"), "other changed\n");

  const discardedAll = await changes.discardAllTracked({
    expectedSnapshotId: discardedWorktree.snapshotId,
    paths: selected(discardedWorktree, "staged", ["tracked.txt"]),
    confirm: true,
  });
  assert.equal(fs.readFileSync(path.join(fixture.root, "tracked.txt"), "utf8"), "initial\n");
  assert.equal(fs.readFileSync(path.join(fixture.root, "other.txt"), "utf8"), "other changed\n");
  assert.equal(discardedAll.changes.entries.some((entry) => entry.path === "tracked.txt"), false);
});

test("change mutations reject stale snapshots, stale path versions, and unsupported discard paths", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "changed\n");
  fixture.write("new.txt", "new\n");
  const { resolve, changes } = services(fixture);
  const state = await resolve();
  await assert.rejects(() => changes.stage({ expectedSnapshotId: "snapshot:stale", paths: selected(state, "unstaged", ["tracked.txt"]) }), (error) => error instanceof RepositoryOperationError && error.code === "REPOSITORY_STATE_STALE");
  await assert.rejects(() => changes.stage({ expectedSnapshotId: state.context.snapshotId, paths: [{ path: "tracked.txt", expectedVersion: "version:stale000000" }] }), (error) => error.code === "REPOSITORY_STATE_STALE");
  await assert.rejects(() => changes.discardAllTracked({ expectedSnapshotId: state.context.snapshotId, paths: selected(state, "untracked", ["new.txt"]), confirm: true }), (error) => error.code === "REPOSITORY_CONFLICT");
  assert.equal(fs.existsSync(path.join(fixture.root, "new.txt")), true);
});

test("Git lock competition is reported as failure with refreshed authority", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "changed\n");
  const { resolve, changes } = services(fixture);
  const state = await resolve();
  const lockPath = path.join(fixture.root, ".git", "index.lock");
  fs.writeFileSync(lockPath, "external lock");
  try {
    await assert.rejects(
      () => changes.stage({ expectedSnapshotId: state.context.snapshotId, paths: selected(state, "unstaged", ["tracked.txt"]) }),
      (error) => error.code === "REPOSITORY_OPERATION_FAILED" && error.current?.context.snapshotId === state.context.snapshotId,
    );
  } finally {
    fs.unlinkSync(lockPath);
  }
  assert.equal(fixture.git(["diff", "--cached", "--name-only"]), "");
});

test("commit consumes only the current index and reports empty index, hook, and identity failures", async () => {
  const fixture = createGitFixture();
  fixture.write("staged.txt", "staged\n");
  fixture.git(["add", "--", "staged.txt"]);
  fixture.write("unstaged.txt", "unstaged\n");
  const { resolve, changes } = services(fixture);
  const before = await resolve();
  const committed = await changes.commit({ expectedSnapshotId: before.context.snapshotId, message: "commit staged only" });
  assert.match(committed.commitOid, /^[0-9a-f]{40}$/);
  assert.match(fixture.git(["show", "--format=", "--name-only", "HEAD"]), /staged.txt/);
  assert.doesNotMatch(fixture.git(["show", "--format=", "--name-only", "HEAD"]), /unstaged.txt/);
  assert.equal(committed.changes.entries.some((entry) => entry.path === "unstaged.txt" && entry.scope === "untracked"), true);
  await assert.rejects(() => changes.commit({ expectedSnapshotId: committed.snapshotId, message: "empty" }), (error) => error.code === "REPOSITORY_NOTHING_TO_COMMIT");

  fixture.write("hooked.txt", "hooked\n");
  fixture.git(["add", "--", "hooked.txt"]);
  const hook = path.join(fixture.root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'pre-commit hook failed' >&2\nexit 1\n", { mode: 0o755 });
  const hookState = await resolve();
  await assert.rejects(() => changes.commit({ expectedSnapshotId: hookState.context.snapshotId, message: "rejected" }), (error) => error.code === "REPOSITORY_HOOK_FAILED");
  fs.unlinkSync(hook);
  fixture.git(["config", "user.name", ""]);
  fixture.git(["config", "user.email", ""]);
  const identityState = await resolve();
  await assert.rejects(() => changes.commit({ expectedSnapshotId: identityState.context.snapshotId, message: "no identity" }), (error) => error.code === "REPOSITORY_IDENTITY_MISSING");
});
