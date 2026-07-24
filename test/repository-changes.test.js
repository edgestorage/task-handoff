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

const { RepositoryChangesService, RepositoryOperationError, structuredDiffLines } = require("../packages/controlled-instance/src/repository/changes.ts");
const { RepositorySessionResolver } = require("../packages/controlled-instance/src/repository/context.ts");
const { RepositoryDiffSchema } = require("@task-handoff/protocol/repository");

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
  assert.equal(stagedDiff.lines.some((line) => line.kind === "addition" && line.content === "staged content" && line.newLine === 1), true);
  assert.equal(stagedDiff.lines.some((line) => line.kind === "deletion" && line.content === "initial" && line.oldLine === 1), true);
  assert.doesNotMatch(stagedDiff.content, /unstaged content/);
  assert.match(unstagedDiff.content, /unstaged content/);
  const untrackedDiff = await changes.diff("untracked", "new.txt");
  assert.match(untrackedDiff.content, /--- \/dev\/null/);
  assert.match(untrackedDiff.content, /\+new content/);
  const binaryDiff = await changes.diff("untracked", "binary.dat");
  assert.equal(binaryDiff.binary, true);
  assert.equal(binaryDiff.complete, false);
  assert.equal(binaryDiff.content, "");
  assert.deepEqual(binaryDiff.lines, []);
  const truncated = await changes.diff("untracked", "large.txt", 80);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.complete, false);
  assert.ok(Buffer.byteLength(truncated.content) <= 80);
});

test("diff hunks expose ranges and bounded authoritative context gaps", async () => {
  const parsed = structuredDiffLines("@@ -707,16 +705,6 @@ render section\n-old\n+new\n");
  assert.deepEqual(parsed[0], {
    kind: "hunk",
    content: "@@ -707,16 +705,6 @@ render section",
    oldStart: 707,
    oldCount: 16,
    newStart: 705,
    newCount: 6,
    hunkId: "hunk:707:16:705:6",
    heading: "render section",
  });

  const fixture = createGitFixture({ initialCommit: false });
  const original = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  fixture.write("context.txt", `${original.join("\n")}\n`);
  fixture.commit("context base");
  const changed = [...original];
  changed[29] = "changed line 30";
  fixture.write("context.txt", `${changed.join("\n")}\n`);
  const { changes } = services(fixture);
  const diff = await changes.diff("unstaged", "context.txt", 512 * 1024, true);
  assert.equal(RepositoryDiffSchema.safeParse(diff).success, true);
  const hunk = diff.lines.find((line) => line.kind === "hunk");
  assert.ok(hunk.hunkId);
  assert.equal(diff.contextGaps.some((gap) => (gap.beforeHunkId === hunk.hunkId || gap.afterHunkId === hunk.hunkId) && gap.lines.length > 0), true);
  assert.equal(diff.contextGaps.every((gap) => gap.lines.length <= 20 && typeof gap.hasMore === "boolean" && gap.lines.every((line) => line.kind === "context")), true);
  assert.equal(diff.contextGaps.some((gap) => gap.hasMore), true);
  const expandedAgain = await changes.diff("unstaged", "context.txt", 512 * 1024, true, 40);
  assert.equal(expandedAgain.contextGaps.some((gap) => gap.lines.length > 20), true);
  assert.equal(expandedAgain.contextGaps.every((gap) => !gap.hasMore), true);
});

test("context between adjacent hunks is one authoritative shared gap", async () => {
  const fixture = createGitFixture({ initialCommit: false });
  const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  fixture.write("shared-gap.txt", `${original.join("\n")}\n`);
  fixture.commit("shared gap base");
  const changed = [...original];
  changed[9] = "changed line 10";
  changed[23] = "changed line 24";
  fixture.write("shared-gap.txt", `${changed.join("\n")}\n`);

  const { changes } = services(fixture);
  const diff = await changes.diff("unstaged", "shared-gap.txt", 512 * 1024, true);
  const hunks = diff.lines.filter((line) => line.kind === "hunk");
  assert.equal(hunks.length, 2);
  const middleGap = diff.contextGaps.find((gap) => gap.beforeHunkId === hunks[0].hunkId && gap.afterHunkId === hunks[1].hunkId);
  assert.ok(middleGap);
  assert.equal(middleGap.lines.length, 7);
  assert.equal(middleGap.startLineCount > 0 && middleGap.startLineCount < middleGap.lines.length, true);
  assert.equal(middleGap.hasMore, false);
  assert.equal(new Set(diff.contextGaps.map((gap) => gap.gapId)).size, diff.contextGaps.length);
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
  assert.equal(diff.content.includes("@@@"), false);
  assert.equal(diff.lines.some((line) => line.kind === "addition" && line.content.includes("<<<<<<<")), true);
});

test("delete-modify conflicts provide reviewable content instead of only an unmerged-path marker", async () => {
  const fixture = createGitFixture({ initialCommit: false });
  fixture.write("delete-modify.txt", "base\n");
  fixture.commit("delete-modify base");
  fixture.git(["checkout", "-b", "fixture/delete-modify"]);
  fixture.write("delete-modify.txt", "modified on branch\n");
  fixture.commit("modify conflict side");
  fixture.git(["checkout", "main"]);
  fixture.git(["rm", "--", "delete-modify.txt"]);
  fixture.commit("delete conflict side");
  try {
    fixture.git(["merge", "fixture/delete-modify"]);
  } catch {}

  const { changes } = services(fixture);
  const diff = await changes.diff("conflict", "delete-modify.txt");
  assert.match(diff.content, /modified on branch/);
  assert.equal(diff.lines.some((line) => line.kind === "hunk"), true);
  assert.equal(diff.lines.some((line) => line.kind === "addition" && line.content === "modified on branch"), true);
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
