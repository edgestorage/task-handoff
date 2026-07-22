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

const { RepositorySessionResolver, primaryRepositoryAction } = require("../packages/controlled-instance/src/repository/context.ts");
const { GitProcess, GitProcessError, gitEnvironment, redactGitDiagnostic } = require("../packages/controlled-instance/src/repository/git-process.ts");
const { RepositoryMutationQueue } = require("../packages/controlled-instance/src/repository/mutation-queue.ts");

function resolver(aiSessions, appSessions = {}, gitOptions = {}) {
  return new RepositorySessionResolver({
    aiSession: (id) => aiSessions[id],
    appSession: (id) => appSessions[id],
  }, gitOptions);
}

test("repository context reports staged and unstaged scopes independently and fingerprints content", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "staged\n");
  fixture.git(["add", "--", "tracked.txt"]);
  fixture.write("tracked.txt", "unstaged one\n");
  fixture.write("name with space\nand newline.txt", "untracked\n");

  const service = resolver({ ai_1: { cwd: fixture.root, status: "running" } });
  const first = await service.resolveAiSession("ai_1");
  assert.equal(first.context.availability, "available");
  assert.equal(first.context.head.state, "branch");
  assert.equal(first.context.head.branch, "main");
  assert.deepEqual(first.context.changes, { conflicts: 0, staged: 1, unstaged: 1, untracked: 1 });
  assert.deepEqual(first.changes.entries.filter((entry) => entry.path === "tracked.txt").map((entry) => entry.scope).sort(), ["staged", "unstaged"]);
  assert.equal(first.changes.entries.some((entry) => entry.path === "name with space\nand newline.txt"), true);
  const firstVersion = first.changes.entries.find((entry) => entry.path === "tracked.txt" && entry.scope === "unstaged").version;

  fixture.write("tracked.txt", "unstaged two\n");
  const second = await service.resolveAiSession("ai_1");
  const secondVersion = second.changes.entries.find((entry) => entry.path === "tracked.txt" && entry.scope === "unstaged").version;
  assert.notEqual(second.context.snapshotId, first.context.snapshotId);
  assert.notEqual(secondVersion, firstVersion);
});

test("repository context distinguishes unavailable, non-worktree, unborn, detached, and inactive sessions", async () => {
  const fixture = createGitFixture();
  const initial = createGitFixture({ initialCommit: false });
  const missing = path.join(fixture.base, "missing");
  const service = resolver({
    missing: undefined,
    inaccessible: { cwd: missing, status: "running" },
    plain: { cwd: fixture.base, status: "running" },
    unborn: { cwd: initial.root, status: "running" },
    stopped: { cwd: fixture.root, status: "stopped" },
  });
  assert.equal((await service.resolveAiSession("missing")).context.availability, "session-not-found");
  assert.equal((await service.resolveAiSession("inaccessible")).context.availability, "cwd-inaccessible");
  assert.equal((await service.resolveAiSession("plain")).context.availability, "not-worktree");
  assert.equal((await service.resolveAiSession("unborn")).context.head.state, "unborn");
  assert.equal((await service.resolveAiSession("stopped")).context.availability, "session-inactive");

  fixture.git(["checkout", "--detach"]);
  assert.equal((await resolver({ detached: { cwd: fixture.root, status: "running" } }).resolveAiSession("detached")).context.head.state, "detached");
  assert.equal((await resolver({ repo: { cwd: fixture.root, status: "running" } }, {}, { gitCommand: path.join(fixture.base, "missing-git") }).resolveAiSession("repo")).context.availability, "git-unavailable");
});

test("app repository context uses workspace cwd through stop and disappears on delete", async () => {
  const fixture = createGitFixture();
  const other = createGitFixture();
  const appSessions = {
    app_1: { workspace: { cwd: fixture.root }, launch: { cwd: other.root }, tty: { cwd: other.root }, status: "running" },
  };
  const service = resolver({}, appSessions);
  const running = await service.resolveAppSession("app_1");
  assert.equal(running.context.availability, "available");
  assert.equal(running.context.repositoryRoot, fs.realpathSync(fixture.root));
  appSessions.app_1.status = "stopped";
  assert.equal((await service.resolveAppSession("app_1")).context.availability, "available");
  delete appSessions.app_1;
  assert.equal((await service.resolveAppSession("app_1")).context.availability, "session-not-found");
  assert.equal(fs.existsSync(fixture.root), true);
});

test("Git process is bounded, allowlisted, non-interactive, and redacts credentials", async () => {
  const fixture = createGitFixture();
  const git = new GitProcess(fixture.root, { outputLimitBytes: 8 });
  await assert.rejects(() => git.run("for-each-ref", ["--format=%(refname) %(objectname)"]), (error) => error instanceof GitProcessError && error.code === "GIT_OUTPUT_LIMIT");
  assert.throws(() => git.run("credential", []), (error) => error instanceof GitProcessError);
  const env = gitEnvironment(true);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "Never");
  assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
  const redacted = redactGitDiagnostic("fatal https://user:secret@example.com/repo?token=abcd Authorization: Bearer ghp_secretvalue");
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("abcd"), false);
});

test("Git process timeout terminates the command with a stable adapter error", async () => {
  const fixture = createGitFixture();
  const fakeGit = path.join(fixture.base, "fake-git");
  fs.writeFileSync(fakeGit, "#!/usr/bin/env node\nsetTimeout(() => {}, 1000);\n", { mode: 0o755 });
  const git = new GitProcess(fixture.root, { gitCommand: fakeGit, timeoutMs: 20 });
  await assert.rejects(() => git.run("status"), (error) => error instanceof GitProcessError && error.code === "GIT_TIMEOUT");
});

test("repository mutation queue serializes each key and uses repository-before-worktree order", async () => {
  const queue = new RepositoryMutationQueue();
  const events = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.withWorktree("wt-1", async () => { events.push("first:start"); await gate; events.push("first:end"); });
  const second = queue.withWorktree("wt-1", async () => { events.push("second:start"); events.push("second:end"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);

  const nested = await queue.withRepositoryAndWorktree("repo-1", "wt-2", async () => "done");
  assert.equal(nested, "done");

  const concurrent = [];
  let releaseDifferent;
  const differentGate = new Promise((resolve) => { releaseDifferent = resolve; });
  const left = queue.withWorktree("wt-left", async () => { concurrent.push("left:start"); await differentGate; concurrent.push("left:end"); });
  const right = queue.withWorktree("wt-right", async () => { concurrent.push("right:start"); concurrent.push("right:end"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(concurrent, ["left:start", "right:start", "right:end"]);
  releaseDifferent();
  await Promise.all([left, right]);
});

test("sessions in one canonical worktree share its opaque worktree identity", async () => {
  const fixture = createGitFixture();
  const service = resolver({
    ai_one: { cwd: fixture.root, status: "running" },
    ai_two: { cwd: path.join(fixture.root, "."), status: "running" },
  });
  const [one, two] = await Promise.all([service.resolveAiSession("ai_one"), service.resolveAiSession("ai_two")]);
  assert.equal(one.context.currentWorktree.id, two.context.currentWorktree.id);
  assert.notEqual(one.context.repositoryContextId, two.context.repositoryContextId);
});

test("primary repository action is derived only from authoritative status", () => {
  const clean = { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 };
  assert.equal(primaryRepositoryAction({ ...clean, conflicts: 1 }), "resolve-conflicts");
  assert.equal(primaryRepositoryAction({ ...clean, unstaged: 1 }), "review-changes");
  assert.equal(primaryRepositoryAction(clean), "publish-branch");
  assert.equal(primaryRepositoryAction(clean, { ahead: 1, behind: 1 }), "diverged");
  assert.equal(primaryRepositoryAction(clean, { ahead: 1, behind: 0 }), "push");
  assert.equal(primaryRepositoryAction(clean, { ahead: 0, behind: 1 }), "pull");
  assert.equal(primaryRepositoryAction(clean, { ahead: 0, behind: 0 }), "up-to-date");
});
