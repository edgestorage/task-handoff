const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");
const { createGitFixture, git } = require("./fixtures/git-repository.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { RepositorySessionResolver, repositoryWorktreeId } = require("../packages/controlled-instance/src/repository/context.ts");
const { RepositoryOperationError } = require("../packages/controlled-instance/src/repository/changes.ts");
const { ManagedWorktreeRegistry, RepositoryWorktreeService } = require("../packages/controlled-instance/src/repository/worktrees.ts");

function setup(fixture, options = {}) {
  const aiSessions = options.aiSessions || [{ id: "ai-current", cwd: fixture.root, status: "running" }];
  const appSessions = options.appSessions || [];
  const resolver = new RepositorySessionResolver({
    aiSession: (id) => aiSessions.find((session) => session.id === id),
    appSession: (id) => appSessions.find((session) => session.id === id),
  });
  const resolve = () => resolver.resolveAiSession("ai-current");
  const managedRoot = options.managedRoot || path.join(fixture.base, "managed-worktrees");
  const registry = new ManagedWorktreeRegistry(managedRoot);
  const service = new RepositoryWorktreeService(
    resolve,
    registry,
    { aiSessions: () => aiSessions, appSessions: () => appSessions },
    options.workspaceRoots || [fixture.base],
    undefined,
    options.gitOptions,
  );
  return { aiSessions, appSessions, resolve, managedRoot, registry, service };
}

function managedPath(registryRoot, worktreeId) {
  const data = JSON.parse(fs.readFileSync(path.join(registryRoot, "registry.json"), "utf8"));
  return data.entries.find((entry) => entry.worktreeId === worktreeId)?.path;
}

test("managed worktree registry does not create storage until a mutation needs it", () => {
  const fixture = createGitFixture();
  const managedRoot = path.join(fixture.base, "not-created-yet", "managed-worktrees");
  new ManagedWorktreeRegistry(managedRoot);
  assert.equal(fs.existsSync(managedRoot), false);
});

test("worktree listing returns opaque ids, state, authorization, and session occupancy", async () => {
  const fixture = createGitFixture();
  const externalPath = fixture.createWorktree("external");
  const detachedPath = fixture.createWorktree("detached");
  git(detachedPath, ["checkout", "--detach"]);
  fixture.lockWorktree(externalPath, "do not move");
  const prunablePath = fixture.createWorktree("prunable");
  fixture.makeWorktreePrunable(prunablePath);
  const appSessions = [{ id: "app-external", workspace: { cwd: detachedPath }, status: "running" }];
  const { resolve, service } = setup(fixture, { workspaceRoots: [path.dirname(externalPath)], appSessions });
  const context = await resolve();
  const listed = await service.list();
  assert.equal(JSON.stringify(listed).includes(fixture.base), false);
  assert.equal(listed.items.find((item) => item.isCurrent).id, context.context.currentWorktree.id);
  assert.deepEqual(listed.items.find((item) => item.isCurrent).activeAiSessionIds, ["ai-current"]);
  const external = listed.items.find((item) => item.head.branch === "fixture/external");
  assert.equal(external.managed, false);
  assert.equal(external.locked, true);
  assert.equal(external.lockReason, "do not move");
  assert.equal(external.canCreateAiSession, false);
  assert.equal(listed.items.some((item) => item.head.state === "detached"), true);
  assert.deepEqual(listed.items.find((item) => item.head.state === "detached").activeAppSessionIds, ["app-external"]);
  assert.equal(listed.items.some((item) => item.prunable), true);
});

test("external worktrees can host sessions only inside configured workspace roots", async () => {
  const fixture = createGitFixture();
  const externalPath = fixture.createWorktree("external-auth");
  const allowed = setup(fixture, { workspaceRoots: [path.dirname(externalPath)] });
  const allowedList = await allowed.service.list();
  const target = allowedList.items.find((item) => item.head.branch === "fixture/external-auth");
  assert.equal(target.managed, false);
  assert.equal(target.canCreateAiSession, true);
  assert.equal(await allowed.service.resolveWorkspace(allowedList.repositoryContextId, target.id), fs.realpathSync(externalPath));

  const denied = setup(fixture, { workspaceRoots: [path.join(fixture.base, "unrelated")] });
  fs.mkdirSync(path.join(fixture.base, "unrelated"), { recursive: true });
  const deniedList = await denied.service.list();
  const deniedTarget = deniedList.items.find((item) => item.head.branch === "fixture/external-auth");
  assert.equal(deniedTarget.canCreateAiSession, false);
  assert.equal(deniedTarget.createAiSessionBlockers.includes("outside-workspace-roots"), true);
  await assert.rejects(() => denied.service.resolveWorkspace(deniedList.repositoryContextId, deniedTarget.id), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");
});

test("existing sessions do not block another AI session and host app sessions are not double-counted", async () => {
  const fixture = createGitFixture();
  const aiSessions = [
    { id: "ai-current", appSessionId: "app-current", cwd: fixture.root, status: "running" },
    { id: "ai-second", appSessionId: "app-second", cwd: fixture.root, status: "idle" },
  ];
  const appSessions = [
    { id: "app-current", workspace: { cwd: fixture.root }, status: "running" },
    { id: "app-second", workspace: { cwd: fixture.root }, status: "running" },
    { id: "app-closed", workspace: { cwd: fixture.root }, status: "closed" },
  ];
  const { service } = setup(fixture, { aiSessions, appSessions });
  const current = (await service.list()).items.find((item) => item.isCurrent);
  assert.deepEqual(current.activeAiSessionIds, ["ai-current", "ai-second"]);
  assert.deepEqual(current.activeAppSessionIds, []);
  assert.equal(current.canCreateAiSession, true);
  assert.equal(current.createAiSessionBlockers.includes("session-occupied"), false);
  assert.equal(current.removeBlockers.includes("session-occupied"), true);
});

test("an active session with a missing nested cwd still blocks worktree removal", async () => {
  const fixture = createGitFixture();
  const setupResult = setup(fixture);
  const state = await setupResult.resolve();
  const created = await setupResult.service.create({
    mode: "new-branch",
    branchName: "feature/missing-session-cwd",
    startRef: "HEAD",
    expectedSnapshotId: state.context.snapshotId,
  });
  const targetPath = managedPath(setupResult.managedRoot, created.worktreeId);
  setupResult.aiSessions.push({ id: "ai-missing-cwd", cwd: path.join(targetPath, "deleted-subdirectory"), status: "running" });
  const target = (await setupResult.service.list()).items.find((item) => item.id === created.worktreeId);
  assert.deepEqual(target.activeAiSessionIds, ["ai-missing-cwd"]);
  assert.equal(target.removeBlockers.includes("session-occupied"), true);
});

test("worktree listing fails closed when Git cannot determine dirty state", async () => {
  const fixture = createGitFixture();
  const gitWrapper = path.join(fixture.base, "git-status-failure.js");
  fs.writeFileSync(gitWrapper, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const subcommand = args.find((arg) => !arg.startsWith("-") && arg !== "color.ui=false" && arg !== "core.pager=cat" && arg !== "pager.branch=false" && arg !== "diff.external=" && arg !== "diff.trustExitCode=false" && arg !== "diff.colorMoved=false");
if (subcommand === "status") process.exit(71);
const result = spawnSync("git", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  fs.chmodSync(gitWrapper, 0o700);
  const { service } = setup(fixture, { gitOptions: { gitCommand: gitWrapper } });

  await assert.rejects(() => service.list(), (error) => error?.code === "GIT_EXIT");
});

test("managed worktrees are allocated privately from new and existing branches", async () => {
  const fixture = createGitFixture();
  const { aiSessions, appSessions, resolve, managedRoot, service } = setup(fixture);
  const before = await resolve();
  const created = await service.create({ mode: "new-branch", branchName: "feature/managed", startRef: "HEAD", expectedSnapshotId: before.context.snapshotId });
  const createdItem = created.worktrees.items.find((item) => item.id === created.worktreeId);
  assert.equal(createdItem.managed, true);
  assert.equal(createdItem.canCreateAiSession, true);
  assert.equal(JSON.stringify(created).includes(managedRoot), false);
  const createdPath = managedPath(managedRoot, created.worktreeId);
  assert.equal(createdPath.startsWith(`${fs.realpathSync(managedRoot)}${path.sep}`), true);
  assert.equal(git(createdPath, ["branch", "--show-current"]), "feature/managed");

  fixture.git(["branch", "feature/existing"]);
  const next = await resolve();
  const existing = await service.create({ mode: "existing-branch", branchName: "feature/existing", expectedSnapshotId: next.context.snapshotId });
  assert.equal(git(managedPath(managedRoot, existing.worktreeId), ["branch", "--show-current"]), "feature/existing");
  const reloaded = new ManagedWorktreeRegistry(managedRoot);
  const reloadedService = new RepositoryWorktreeService(
    resolve,
    reloaded,
    { aiSessions: () => aiSessions, appSessions: () => appSessions },
    [fixture.base],
  );
  assert.equal((await reloadedService.list()).items.find((item) => item.id === existing.worktreeId).managed, true);
});

test("registry reconciliation recovers interrupted creation only when Git state matches the recorded intent", async () => {
  const fixture = createGitFixture();
  const setupResult = setup(fixture);
  const state = await setupResult.resolve();
  const destination = setupResult.registry.allocate(state.context.repositoryId, "HEAD", "interrupted-create");
  const worktreeId = repositoryWorktreeId(state.context.repositoryId, path.resolve(destination));
  const oid = fixture.git(["rev-parse", "HEAD"]);
  setupResult.registry.prepare(state.context.repositoryId, worktreeId, destination, {
    requestId: "interrupted-create",
    ref: { type: "head" },
    resolvedOid: oid,
    checkout: "detached",
  });
  fixture.git(["worktree", "add", "--detach", destination, oid]);

  const recoveredSetup = setup(fixture, { managedRoot: setupResult.managedRoot });
  const recovered = (await recoveredSetup.service.list()).items.find((item) => item.id === worktreeId);
  assert.equal(recovered.managed, true);
  const registry = JSON.parse(fs.readFileSync(path.join(setupResult.managedRoot, "registry.json"), "utf8"));
  assert.equal(registry.version, 2);
  assert.equal(registry.entries.find((entry) => entry.worktreeId === worktreeId).state, "ready");
});

test("v0.0.21 registry downgrade preserves the existing worktree generation on re-upgrade", async () => {
  const fixture = createGitFixture();
  const setupResult = setup(fixture);
  const state = await setupResult.resolve();
  const created = await setupResult.service.create({
    mode: "new-branch",
    branchName: "feature/downgrade-roundtrip",
    startRef: "HEAD",
    expectedSnapshotId: state.context.snapshotId,
  });
  const registryPath = path.join(setupResult.managedRoot, "registry.json");
  const current = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  fs.writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    entries: current.entries.map(({ repositoryId, worktreeId, path: worktreePath, createdAt }) => ({
      repositoryId,
      worktreeId,
      path: worktreePath,
      createdAt,
    })),
  }, null, 2)}\n`);

  const upgraded = setup(fixture, { managedRoot: setupResult.managedRoot });
  const target = (await upgraded.service.list()).items.find((item) => item.id === created.worktreeId);
  assert.equal(target.managed, true);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, "utf8")).version, 2);
});

test("stale registry ownership does not transfer to a replacement worktree at the same path", async () => {
  const fixture = createGitFixture();
  const setupResult = setup(fixture);
  const state = await setupResult.resolve();
  const created = await setupResult.service.create({
    mode: "new-branch",
    branchName: "feature/original-generation",
    startRef: "HEAD",
    expectedSnapshotId: state.context.snapshotId,
  });
  const targetPath = managedPath(setupResult.managedRoot, created.worktreeId);
  fixture.git(["worktree", "remove", targetPath]);
  fixture.git(["branch", "feature/replacement-generation"]);
  fixture.git(["worktree", "add", targetPath, "feature/replacement-generation"]);

  const replacementSetup = setup(fixture, { managedRoot: setupResult.managedRoot });
  const replacement = (await replacementSetup.service.list()).items.find((item) => item.id === created.worktreeId);
  assert.equal(replacement.managed, false);
  assert.equal(replacement.canRemove, false);
  assert.equal(replacement.removeBlockers.includes("external-worktree"), true);
});

test("interrupted removal rolls back to ready when the original generation still exists", async () => {
  const fixture = createGitFixture();
  const setupResult = setup(fixture);
  const state = await setupResult.resolve();
  const created = await setupResult.service.create({
    mode: "new-branch",
    branchName: "feature/interrupted-remove",
    startRef: "HEAD",
    expectedSnapshotId: state.context.snapshotId,
  });
  const targetPath = managedPath(setupResult.managedRoot, created.worktreeId);
  setupResult.registry.beginRemove(created.worktreeId, targetPath);

  const recoveredSetup = setup(fixture, { managedRoot: setupResult.managedRoot });
  const recovered = (await recoveredSetup.service.list()).items.find((item) => item.id === created.worktreeId);
  assert.equal(recovered.managed, true);
  assert.equal(recovered.canRemove, true);
});

test("AI session worktrees are idempotent per request and detach occupied refs", async () => {
  const fixture = createGitFixture();
  fixture.git(["branch", "feature/free"]);
  const { managedRoot, service } = setup(fixture);

  const current = await service.createForAiSession({ ref: { type: "branch", name: "main" }, clientRequestId: "session-main" });
  const currentPath = managedPath(managedRoot, current.worktreeId);
  assert.equal(git(currentPath, ["branch", "--show-current"]), "");
  assert.equal(git(currentPath, ["rev-parse", "HEAD"]), fixture.git(["rev-parse", "main"]));

  const repeated = await service.createForAiSession({ ref: { type: "branch", name: "main" }, clientRequestId: "session-main" });
  assert.equal(repeated.worktreeId, current.worktreeId);

  const head = await service.createForAiSession({ ref: { type: "head" }, clientRequestId: "session-head" });
  assert.notEqual(head.worktreeId, current.worktreeId);
  assert.equal(git(managedPath(managedRoot, head.worktreeId), ["branch", "--show-current"]), "");

  const free = await service.createForAiSession({ ref: { type: "branch", name: "feature/free" }, clientRequestId: "session-free" });
  assert.equal(git(managedPath(managedRoot, free.worktreeId), ["branch", "--show-current"]), "feature/free");
  const occupied = await service.createForAiSession({ ref: { type: "branch", name: "feature/free" }, clientRequestId: "session-free-second" });
  assert.equal(git(managedPath(managedRoot, occupied.worktreeId), ["branch", "--show-current"]), "");
  assert.equal(git(managedPath(managedRoot, occupied.worktreeId), ["rev-parse", "HEAD"]), fixture.git(["rev-parse", "feature/free"]));
});

test("AI session worktree creation never removes a preexisting unregistered destination", async () => {
  const fixture = createGitFixture();
  const { managedRoot, registry, resolve, service } = setup(fixture);
  const state = await resolve();
  const destination = registry.allocate(state.context.repositoryId, "HEAD", "preexisting-request");
  fs.mkdirSync(destination, { recursive: true });
  const marker = path.join(destination, "keep.txt");
  fs.writeFileSync(marker, "owned by somebody else\n");

  await assert.rejects(
    () => service.createForAiSession({ ref: { type: "head" }, clientRequestId: "preexisting-request" }),
    (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE",
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "owned by somebody else\n");
  assert.equal(fs.existsSync(path.join(managedRoot, "registry.json")), false);
});

test("worktree creation serializes refs and rejects stale or occupied branches", async () => {
  const fixture = createGitFixture();
  const { resolve, service } = setup(fixture);
  const state = await resolve();
  const attempts = await Promise.allSettled([
    service.create({ mode: "new-branch", branchName: "feature/race", startRef: "HEAD", expectedSnapshotId: state.context.snapshotId }),
    service.create({ mode: "new-branch", branchName: "feature/race", startRef: "HEAD", expectedSnapshotId: state.context.snapshotId }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  const fresh = await resolve();
  await assert.rejects(() => service.create({ mode: "existing-branch", branchName: "feature/race", expectedSnapshotId: fresh.context.snapshotId }), (error) => error instanceof RepositoryOperationError && error.code === "REPOSITORY_BRANCH_OCCUPIED");
});

test("managed worktree removal is non-force, retains branches, and honors safety blockers", async () => {
  const fixture = createGitFixture();
  const setupResult = setup(fixture);
  const before = await setupResult.resolve();
  const created = await setupResult.service.create({ mode: "new-branch", branchName: "feature/remove", startRef: "HEAD", expectedSnapshotId: before.context.snapshotId });
  const targetPath = managedPath(setupResult.managedRoot, created.worktreeId);
  fixture.write("main-dirty.txt", "main only\n");
  fs.writeFileSync(path.join(targetPath, "dirty.txt"), "dirty\n");
  const dirtyList = await setupResult.service.list();
  await assert.rejects(() => setupResult.service.remove({ worktreeId: created.worktreeId, expectedSnapshotId: dirtyList.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");
  fs.unlinkSync(path.join(targetPath, "dirty.txt"));

  setupResult.aiSessions.push({ id: "ai-occupied", cwd: targetPath, status: "running" });
  const occupied = await setupResult.service.list();
  await assert.rejects(() => setupResult.service.remove({ worktreeId: created.worktreeId, expectedSnapshotId: occupied.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");
  setupResult.aiSessions.pop();

  const removable = await setupResult.service.list();
  const removed = await setupResult.service.remove({ worktreeId: created.worktreeId, expectedSnapshotId: removable.snapshotId, confirm: true });
  assert.equal(removed.branchRetained, true);
  assert.equal(fs.existsSync(targetPath), false);
  assert.equal(fixture.git(["show-ref", "--verify", "refs/heads/feature/remove"]).length > 0, true);
  const main = removed.worktrees.items.find((item) => item.isMain);
  await assert.rejects(() => setupResult.service.remove({ worktreeId: main.id, expectedSnapshotId: removed.worktrees.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");
});

test("managed removal rejects locked, prunable, external, and stale worktrees", async () => {
  const fixture = createGitFixture();
  const externalPath = fixture.createWorktree("external-remove");
  const setupResult = setup(fixture);
  const externalList = await setupResult.service.list();
  const external = externalList.items.find((item) => item.head.branch === "fixture/external-remove");
  await assert.rejects(() => setupResult.service.remove({ worktreeId: external.id, expectedSnapshotId: externalList.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");

  let state = await setupResult.resolve();
  const locked = await setupResult.service.create({ mode: "new-branch", branchName: "feature/locked", startRef: "HEAD", expectedSnapshotId: state.context.snapshotId });
  const lockedPath = managedPath(setupResult.managedRoot, locked.worktreeId);
  fixture.lockWorktree(lockedPath, "fixture managed lock");
  const lockedList = await setupResult.service.list();
  await assert.rejects(() => setupResult.service.remove({ worktreeId: locked.worktreeId, expectedSnapshotId: lockedList.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");

  state = await setupResult.resolve();
  const prunable = await setupResult.service.create({ mode: "new-branch", branchName: "feature/prunable", startRef: "HEAD", expectedSnapshotId: state.context.snapshotId });
  fixture.makeWorktreePrunable(managedPath(setupResult.managedRoot, prunable.worktreeId));
  const prunableList = await setupResult.service.list();
  assert.equal(prunableList.items.find((item) => item.id === prunable.worktreeId).prunable, true);
  assert.equal(prunableList.items.find((item) => item.id === prunable.worktreeId).managed, true);
  await assert.rejects(() => setupResult.service.remove({ worktreeId: prunable.worktreeId, expectedSnapshotId: prunableList.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_WORKTREE_UNSAFE");

  state = await setupResult.resolve();
  const stale = await setupResult.service.create({ mode: "new-branch", branchName: "feature/stale-remove", startRef: "HEAD", expectedSnapshotId: state.context.snapshotId });
  const beforeDirty = await setupResult.service.list();
  fs.writeFileSync(path.join(managedPath(setupResult.managedRoot, stale.worktreeId), "late.txt"), "late\n");
  await assert.rejects(() => setupResult.service.remove({ worktreeId: stale.worktreeId, expectedSnapshotId: beforeDirty.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_STATE_STALE");
  assert.equal(fs.existsSync(externalPath), true);
});
