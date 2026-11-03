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

test("repository context reports staged and unstaged scopes independently and detects file revisions", async () => {
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

test("repository listing versions detect same-size writes with restored mtime, replacement, mode, and symlink changes", async (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }));
  const file = fixture.write("tracked.txt", "first\n");
  const fixedTime = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(file, fixedTime, fixedTime);
  const service = resolver({ ai_1: { cwd: fixture.root, status: "idle" } });
  const first = await service.resolveAiSession("ai_1");
  const version = (state, name = "tracked.txt") => state.changes.entries.find((entry) => entry.path === name).version;
  const unchanged = await service.resolveAiSession("ai_1");
  assert.equal(unchanged.context.snapshotId, first.context.snapshotId);
  assert.equal(version(unchanged), version(first));

  fixture.write("tracked.txt", "other\n");
  fs.utimesSync(file, fixedTime, fixedTime);
  const rewritten = await service.resolveAiSession("ai_1");
  assert.equal(fs.statSync(file).size, 6);
  assert.equal(fs.statSync(file).mtimeMs, fixedTime.getTime());
  assert.notEqual(rewritten.context.snapshotId, first.context.snapshotId);
  assert.notEqual(version(rewritten), version(first));

  const replacement = fixture.write("replacement.tmp", "other\n");
  fs.utimesSync(replacement, fixedTime, fixedTime);
  fs.renameSync(replacement, file);
  const replaced = await service.resolveAiSession("ai_1");
  assert.notEqual(version(replaced), version(rewritten));
  fs.chmodSync(file, 0o755);
  const executable = await service.resolveAiSession("ai_1");
  assert.notEqual(version(executable), version(replaced));

  fs.readFileSync(file);
  const read = await service.resolveAiSession("ai_1");
  assert.equal(read.context.snapshotId, executable.context.snapshotId, "opening a file must not invalidate its revision");

  const link = path.join(fixture.root, "link");
  fs.symlinkSync("tracked.txt", link);
  const linked = await service.resolveAiSession("ai_1");
  fs.unlinkSync(link);
  fs.symlinkSync("missing.txt", link);
  const retargeted = await service.resolveAiSession("ai_1");
  assert.notEqual(version(linked, "link"), version(retargeted, "link"));
});

test("large repository listings do not read file contents and keep filesystem work bounded", async (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }));
  // Sparse files reproduce a multi-GiB worktree without allocating its contents.
  // The guarantee applies to arbitrary source paths, with no build-dir exclusions.
  const count = 257;
  for (let i = 0; i < count; i += 1) {
    const file = fixture.write(`sources/file-${i}.bin`, "");
    fs.truncateSync(file, 64 * 1024 * 1024);
  }
  let reads = 0;
  const denyContentRead = () => { reads += 1; throw new Error("Listing may not read file contents"); };
  t.mock.method(fs, "readFileSync", denyContentRead);
  t.mock.method(fs.promises, "readFile", denyContentRead);
  t.mock.method(fs, "createReadStream", denyContentRead);
  const lstat = fs.promises.lstat.bind(fs.promises);
  let outstanding = 0;
  let peak = 0;
  let stats = 0;
  t.mock.method(fs.promises, "lstat", async (...args) => {
    outstanding += 1;
    peak = Math.max(peak, outstanding);
    stats += 1;
    try { return await lstat(...args); }
    finally { outstanding -= 1; }
  });
  const service = resolver({ ai_1: { cwd: fixture.root, status: "idle" } });
  const first = await service.resolveAiSession("ai_1");
  const repeated = await service.resolveAiSession("ai_1");
  assert.equal(first.changes.entries.length, count);
  assert.equal(first.changes.summary.untracked, count);
  assert.equal(repeated.context.snapshotId, first.context.snapshotId);
  assert.equal(reads, 0);
  assert.equal(stats, count * 2);
  assert.ok(peak > 1 && peak <= 64, `outstanding filesystem calls: ${peak}`);
});

test("index-only changes invalidate listing versions without worktree edits", async (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }));
  fixture.write("tracked.txt", "worktree\n");
  const service = resolver({ ai_1: { cwd: fixture.root, status: "idle" } });
  const before = await service.resolveAiSession("ai_1");
  // Change the staged blob while leaving both porcelain XY and the file alone.
  const blob = fixture.git(["hash-object", "-w", "--stdin"], { input: "index-only\n", stdio: ["pipe", "pipe", "pipe"] });
  fixture.git(["update-index", "--cacheinfo", `100644,${blob},tracked.txt`]);
  const staged = await service.resolveAiSession("ai_1");
  const otherBlob = fixture.git(["hash-object", "-w", "--stdin"], { input: "other-index\n", stdio: ["pipe", "pipe", "pipe"] });
  fixture.git(["update-index", "--cacheinfo", `100644,${otherBlob},tracked.txt`]);
  const restaged = await service.resolveAiSession("ai_1");
  assert.notEqual(before.context.snapshotId, staged.context.snapshotId);
  assert.notEqual(staged.context.snapshotId, restaged.context.snapshotId);
  assert.notEqual(staged.changes.entries.find((e) => e.scope === "staged").version, restaged.changes.entries.find((e) => e.scope === "staged").version);
});

test("repository listing tolerates a vanished path but does not hide filesystem inspection errors", async (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }));
  const file = fs.realpathSync(fixture.write("tracked.txt", "changed\n"));
  const service = resolver({ ai_1: { cwd: fixture.root, status: "idle" } });
  const lstat = fs.promises.lstat.bind(fs.promises);
  let code = "ENOENT";
  t.mock.method(fs.promises, "lstat", async (filePath, options) => {
    if (filePath === file) throw Object.assign(new Error("inspection failed"), { code });
    return lstat(filePath, options);
  });
  const vanished = await service.resolveAiSession("ai_1");
  assert.equal(vanished.changes.entries[0].path, "tracked.txt");
  code = "EACCES";
  await assert.rejects(() => service.resolveAiSession("ai_1"), (error) => error.code === "EACCES");
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
  const plain = await service.resolveAiSession("plain");
  assert.equal(plain.context.availability, "not-worktree");
  assert.equal(plain.context.repositoryRoot, fs.realpathSync(fixture.base));
  assert.equal(plain.context.displayName, path.basename(fs.realpathSync(fixture.base)));
  assert.equal(plain.worktreeRoot, fs.realpathSync(fixture.base));
  assert.deepEqual(plain.changes.entries, []);
  assert.deepEqual(plain.changes.summary, { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(plain.context.snapshotId, plain.changes.snapshotId);
  assert.equal((await service.resolveAiSession("unborn")).context.head.state, "unborn");
  assert.equal((await service.resolveAiSession("stopped")).context.availability, "session-inactive");
  assert.equal((await service.resolveAiSession("plain")).worktreeRoot, plain.worktreeRoot);

  fixture.git(["checkout", "--detach"]);
  assert.equal((await resolver({ detached: { cwd: fixture.root, status: "running" } }).resolveAiSession("detached")).context.head.state, "detached");
  const withoutGit = await resolver({ repo: { cwd: fixture.root, status: "running" } }, {}, { gitCommand: path.join(fixture.base, "missing-git") }).resolveAiSession("repo");
  assert.equal(withoutGit.context.availability, "git-unavailable");
  assert.equal(withoutGit.context.repositoryRoot, fs.realpathSync(fixture.root));
  assert.equal(withoutGit.context.head, undefined);
  assert.deepEqual(withoutGit.changes.entries, []);
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
  const previousBrokerSocket = process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET;
  delete process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET;
  try {
    const env = gitEnvironment(true);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GCM_INTERACTIVE, "Never");
    assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
  } finally {
    if (previousBrokerSocket === undefined) delete process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET;
    else process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET = previousBrokerSocket;
  }
  const redacted = redactGitDiagnostic("fatal https://user:secret@example.com/repo?token=abcd Authorization: Bearer ghp_secretvalue /run/task-handoff/git-broker/ssh-1/identity -----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----");
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("abcd"), false);
  assert.equal(redacted.includes("private-material"), false);
  assert.equal(redacted.includes("ssh-1"), false);
  assert.match(redacted, /\[git-broker-runtime\]/);
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
