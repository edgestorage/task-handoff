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

const { RepositoryBranchService } = require("../packages/controlled-instance/src/repository/branches.ts");
const { RepositorySessionResolver } = require("../packages/controlled-instance/src/repository/context.ts");
const { ManagedWorktreeRegistry, RepositoryWorktreeService } = require("../packages/controlled-instance/src/repository/worktrees.ts");
const { RepositoryMutationQueue } = require("../packages/controlled-instance/src/repository/mutation-queue.ts");

function services(fixture) {
  const sessions = [{ id: "ai-1", cwd: fixture.root, status: "running" }];
  const resolver = new RepositorySessionResolver({ aiSession: (id) => sessions.find((item) => item.id === id), appSession: () => undefined });
  const resolve = () => resolver.resolveAiSession("ai-1");
  const queue = new RepositoryMutationQueue();
  const worktrees = new RepositoryWorktreeService(
    resolve,
    new ManagedWorktreeRegistry(path.join(fixture.base, "managed")),
    { aiSessions: () => sessions, appSessions: () => [] },
    [fixture.base],
    queue,
  );
  return { resolve, worktrees, branches: new RepositoryBranchService(resolve, worktrees, queue) };
}

function initializeRemote(fixture) {
  const remote = fixture.createBareRemote();
  fixture.git(["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return remote;
}

function collaboratorClone(fixture, remote) {
  const collaborator = path.join(fixture.base, `collaborator-${Date.now()}`);
  git(fixture.base, ["clone", remote, collaborator]);
  git(collaborator, ["config", "user.name", "Collaborator"]);
  git(collaborator, ["config", "user.email", "collaborator@example.invalid"]);
  return collaborator;
}

test("branch list includes local, remote-tracking, upstream, and worktree occupancy", async () => {
  const fixture = createGitFixture();
  initializeRemote(fixture);
  fixture.git(["checkout", "-b", "feature/remote-only"]);
  fixture.write("remote.txt", "remote\n");
  fixture.commit("remote branch");
  fixture.git(["push", "-u", "origin", "feature/remote-only"]);
  fixture.git(["checkout", "main"]);
  fixture.git(["branch", "-D", "feature/remote-only"]);
  const occupiedPath = fixture.createWorktree("occupied", "feature/occupied");
  const { branches } = services(fixture);
  const listed = await branches.list();
  const main = listed.branches.find((branch) => branch.kind === "local" && branch.name === "main");
  assert.equal(main.current, true);
  assert.equal(main.upstream, "origin/main");
  assert.equal(main.ahead, 0);
  assert.equal(main.behind, 0);
  assert.equal(listed.branches.some((branch) => branch.kind === "remote-tracking" && branch.name === "origin/feature/remote-only"), true);
  assert.equal(listed.branches.find((branch) => branch.name === "feature/occupied").checkedOutWorktreeIds.length, 1);
  assert.equal(fs.existsSync(occupiedPath), true);
});

test("branch mutations create, checkout, track, safely delete, and report blockers", async () => {
  const fixture = createGitFixture();
  initializeRemote(fixture);
  fixture.git(["checkout", "-b", "feature/remote-only"]);
  fixture.write("remote.txt", "remote\n");
  fixture.commit("remote branch");
  fixture.git(["push", "-u", "origin", "feature/remote-only"]);
  fixture.git(["checkout", "main"]);
  fixture.git(["branch", "-D", "feature/remote-only"]);
  const service = services(fixture);

  let state = await service.resolve();
  const created = await service.branches.create({ name: "feature/new", expectedSnapshotId: state.context.snapshotId });
  assert.equal(created.context.head.branch, "feature/new");
  state = await service.resolve();
  const tracked = await service.branches.createTracking({ name: "feature/tracked", remoteTrackingRef: "origin/feature/remote-only", expectedSnapshotId: state.context.snapshotId });
  assert.equal(tracked.context.head.branch, "feature/tracked");
  assert.equal(tracked.context.upstream.ref, "origin/feature/remote-only");

  state = await service.resolve();
  await service.branches.checkout({ branch: "main", expectedSnapshotId: state.context.snapshotId });
  fixture.git(["branch", "feature/merged"]);
  state = await service.resolve();
  const deleted = await service.branches.delete({ name: "feature/merged", expectedSnapshotId: state.context.snapshotId, confirm: true });
  assert.equal(deleted.branches.branches.some((branch) => branch.name === "feature/merged"), false);

  fixture.git(["checkout", "-b", "feature/unmerged"]);
  fixture.write("unmerged.txt", "commit\n");
  fixture.commit("unmerged commit");
  fixture.git(["checkout", "main"]);
  state = await service.resolve();
  await assert.rejects(() => service.branches.delete({ name: "feature/unmerged", expectedSnapshotId: state.context.snapshotId, confirm: true }), (error) => error.code === "REPOSITORY_BRANCH_UNMERGED");

  fixture.createWorktree("branch-blocked", "feature/blocked");
  state = await service.resolve();
  await assert.rejects(() => service.branches.checkout({ branch: "feature/blocked", expectedSnapshotId: state.context.snapshotId }), (error) => error.code === "REPOSITORY_BRANCH_OCCUPIED");
});

test("checkout preserves dirty files when Git reports an overwrite blocker", async () => {
  const fixture = createGitFixture();
  fixture.git(["checkout", "-b", "feature/different"]);
  fixture.write("tracked.txt", "branch version\n");
  fixture.commit("branch version");
  fixture.git(["checkout", "main"]);
  fixture.write("tracked.txt", "local dirty\n");
  const service = services(fixture);
  const state = await service.resolve();
  await assert.rejects(() => service.branches.checkout({ branch: "feature/different", expectedSnapshotId: state.context.snapshotId }), (error) => error.code === "REPOSITORY_DIRTY");
  assert.equal(fixture.git(["branch", "--show-current"]), "main");
  assert.equal(fs.readFileSync(path.join(fixture.root, "tracked.txt"), "utf8"), "local dirty\n");
});

test("fetch and ff-only pull update authoritative refs while dirty and diverged pulls are blocked", async () => {
  const fixture = createGitFixture();
  const remote = initializeRemote(fixture);
  const collaborator = collaboratorClone(fixture, remote);
  fs.writeFileSync(path.join(collaborator, "remote-change.txt"), "remote\n");
  git(collaborator, ["add", "--all"]);
  git(collaborator, ["commit", "-m", "remote change"]);
  git(collaborator, ["push", "origin", "main"]);
  const service = services(fixture);

  let state = await service.resolve();
  const fetched = await service.branches.fetch({ remote: "origin", expectedSnapshotId: state.context.snapshotId });
  assert.equal(fetched.context.upstream.behind, 1);
  const pulled = await service.branches.pull({ expectedSnapshotId: fetched.snapshotId });
  assert.equal(pulled.context.upstream.behind, 0);
  assert.equal(fs.readFileSync(path.join(fixture.root, "remote-change.txt"), "utf8"), "remote\n");

  fixture.write("dirty.txt", "dirty\n");
  state = await service.resolve();
  await assert.rejects(() => service.branches.pull({ expectedSnapshotId: state.context.snapshotId }), (error) => error.code === "REPOSITORY_DIRTY");
  fs.unlinkSync(path.join(fixture.root, "dirty.txt"));

  fixture.write("local.txt", "local\n");
  fixture.commit("local diverged");
  fs.writeFileSync(path.join(collaborator, "other.txt"), "other\n");
  git(collaborator, ["add", "--all"]);
  git(collaborator, ["commit", "-m", "remote diverged"]);
  git(collaborator, ["push", "origin", "main"]);
  state = await service.resolve();
  const diverged = await service.branches.fetch({ remote: "origin", expectedSnapshotId: state.context.snapshotId });
  assert.equal(diverged.context.primaryAction, "diverged");
  await assert.rejects(() => service.branches.pull({ expectedSnapshotId: diverged.snapshotId }), (error) => error.code === "REPOSITORY_NON_FAST_FORWARD");
});

test("publish sets upstream only with confirmation and push never retries non-fast-forward", async () => {
  const fixture = createGitFixture();
  const remote = initializeRemote(fixture);
  fixture.git(["checkout", "-b", "feature/publish"]);
  fixture.write("publish.txt", "publish\n");
  fixture.commit("publish branch");
  const service = services(fixture);
  let state = await service.resolve();
  await assert.rejects(() => service.branches.publish({ remote: "origin", sourceBranch: "feature/publish", targetBranch: "feature/publish", setUpstream: true, expectedSnapshotId: state.context.snapshotId }), (error) => error.code === "REPOSITORY_REQUEST_INVALID");
  const published = await service.branches.publish({ remote: "origin", sourceBranch: "feature/publish", targetBranch: "feature/publish", setUpstream: true, confirmSetUpstream: true, expectedSnapshotId: state.context.snapshotId });
  assert.equal(published.context.upstream.ref, "origin/feature/publish");

  const collaborator = collaboratorClone(fixture, remote);
  git(collaborator, ["checkout", "feature/publish"]);
  fs.writeFileSync(path.join(collaborator, "remote-ahead.txt"), "ahead\n");
  git(collaborator, ["add", "--all"]);
  git(collaborator, ["commit", "-m", "remote ahead"]);
  git(collaborator, ["push", "origin", "feature/publish"]);
  fixture.write("local-ahead.txt", "local\n");
  fixture.commit("local ahead");
  state = await service.resolve();
  await assert.rejects(() => service.branches.push({ remote: "origin", sourceBranch: "feature/publish", targetBranch: "feature/publish", expectedSnapshotId: state.context.snapshotId }), (error) => error.code === "REPOSITORY_NON_FAST_FORWARD");
  assert.equal(git(remote, ["show", "refs/heads/feature/publish:remote-ahead.txt"]), "ahead");
});
