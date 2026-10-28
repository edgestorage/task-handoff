const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent/app.ts");
const {
  DEFAULT_WORKSPACE_HOSTNAME_MAX_LENGTH,
  DEFAULT_WORKSPACE_INSTANCE_INITIALIZATION_KEY,
  defaultWorkspaceInstanceName,
  resolveDefaultWorkspacePath,
} = require("../packages/control-plane/src/node-agent/default-workspace.ts");

function tempDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("default workspace instance workspace is the user-visible home th-workspace directory", () => {
  const homeDir = path.join(path.sep, "Users", "example");
  assert.equal(resolveDefaultWorkspacePath(undefined, homeDir), path.join(homeDir, "th-workspace"));
  assert.equal(
    resolveDefaultWorkspacePath("/tmp/custom-th-workspace", homeDir),
    path.resolve("/tmp/custom-th-workspace"),
  );
});

test("default workspace instance name includes a bounded hostname", () => {
  assert.equal(defaultWorkspaceInstanceName("  studio-mac.local  "), "studio-mac.local Workspace");
  const longHostname = "h".repeat(DEFAULT_WORKSPACE_HOSTNAME_MAX_LENGTH + 20);
  assert.equal(
    defaultWorkspaceInstanceName(longHostname),
    `${"h".repeat(DEFAULT_WORKSPACE_HOSTNAME_MAX_LENGTH)} Workspace`,
  );
  assert.equal(defaultWorkspaceInstanceName("   "), "Workspace");
});

test("node agent creates the default workspace instance once with no model and starts recovery", async (t) => {
  const dataDir = tempDir(t, "task-handoff-default-workspace-data-");
  const workspacePath = path.join(tempDir(t, "task-handoff-default-workspace-home-"), "th-workspace");
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_default_local",
    platform: process.platform,
    defaultWorkspacePath: workspacePath,
  });
  t.after(() => app.close());

  const initialized = app.nodeAgentEnsureDefaultWorkspaceInstance();
  assert.equal(initialized.status, "created");
  assert.equal(initialized.workspacePath, workspacePath);
  assert.ok(fs.statSync(workspacePath).isDirectory());
  assert.ok(!workspacePath.startsWith(`${dataDir}${path.sep}`));
  if (process.platform !== "win32") assert.equal(fs.statSync(workspacePath).mode & 0o777, 0o700);

  const instances = app.nodeAgentState.listInstances();
  assert.equal(instances.length, 1);
  const [instance] = instances;
  assert.equal(instance.id, initialized.instanceId);
  assert.equal(instance.name, defaultWorkspaceInstanceName(app.nodeAgentState.node.name));
  assert.equal(instance.runtimeId, "runtime_local_host");
  assert.equal(instance.status, "starting");
  assert.equal(instance.source.type, "local-folder");
  assert.equal(instance.source.path, workspacePath);
  assert.deepEqual(instance.modelSelection, {});

  const folder = app.nodeAgentState.resolveLocalFolder(instance.source.localFolderId);
  assert.ok(folder);
  assert.equal(folder.path, workspacePath);
  assert.equal(folder.origin, "user");

  const marker = app.nodeAgentState.initializationMarkers.get(DEFAULT_WORKSPACE_INSTANCE_INITIALIZATION_KEY);
  assert.equal(marker.instanceId, instance.id);
});

test("default workspace instance initialization is idempotent across restarts", async (t) => {
  const dataDir = tempDir(t, "task-handoff-default-workspace-restart-");
  const workspacePath = path.join(tempDir(t, "task-handoff-default-workspace-restart-home-"), "th-workspace");
  const options = {
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_default_local_restart",
    platform: process.platform,
    defaultWorkspacePath: workspacePath,
  };

  const first = await createNodeAgentApp(options);
  const created = first.nodeAgentEnsureDefaultWorkspaceInstance();
  assert.equal(created.status, "created");
  await first.close();

  const second = await createNodeAgentApp(options);
  t.after(() => second.close());
  const restarted = second.nodeAgentEnsureDefaultWorkspaceInstance();
  assert.equal(restarted.status, "already-initialized");
  assert.equal(restarted.instanceId, created.instanceId);
  assert.equal(second.nodeAgentState.listInstances().length, 1);
});

test("deleting the default workspace instance does not recreate it on restart", async (t) => {
  const dataDir = tempDir(t, "task-handoff-default-workspace-delete-");
  const workspacePath = path.join(tempDir(t, "task-handoff-default-workspace-delete-home-"), "th-workspace");
  const options = {
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_default_local_delete",
    platform: process.platform,
    defaultWorkspacePath: workspacePath,
  };

  const first = await createNodeAgentApp(options);
  const created = first.nodeAgentEnsureDefaultWorkspaceInstance();
  assert.equal(first.nodeAgentState.controlledInstances.delete(created.instanceId), true);
  await first.close();

  const second = await createNodeAgentApp(options);
  t.after(() => second.close());
  const restarted = second.nodeAgentEnsureDefaultWorkspaceInstance();
  assert.equal(restarted.status, "already-initialized");
  assert.equal(restarted.instanceId, undefined);
  assert.equal(second.nodeAgentState.listInstances().length, 0);
});

test("an existing Local Runtime satisfies default workspace initialization without starting or duplicating it", async (t) => {
  const dataDir = tempDir(t, "task-handoff-default-workspace-existing-");
  const workspacePath = path.join(tempDir(t, "task-handoff-default-workspace-existing-home-"), "th-workspace");
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_default_local_existing",
    platform: process.platform,
    defaultWorkspacePath: workspacePath,
  });
  t.after(() => app.close());

  const existingWorkspace = tempDir(t, "task-handoff-existing-local-workspace-");
  const folder = app.nodeAgentState.createLocalFolder({
    name: "Existing workspace",
    path: existingWorkspace,
    labels: {},
  });
  const existing = app.nodeAgentState.createInstance({
    runtimeId: "runtime_local_host",
    name: "Existing Local Runtime",
    source: { type: "local-folder", localFolderId: folder.id, path: folder.path, ownerNodeId: app.nodeAgentState.nodeId },
    sourceSnapshot: { localFolderId: folder.id, path: folder.path },
    modelSelection: {},
  });

  const initialized = app.nodeAgentEnsureDefaultWorkspaceInstance();
  assert.equal(initialized.status, "existing-local-runtime");
  assert.equal(initialized.instanceId, existing.id);
  assert.equal(app.nodeAgentState.listInstances().length, 1);
  assert.equal(app.nodeAgentState.requireInstance(existing.id).status, "created");
  assert.equal(fs.existsSync(workspacePath), false);
});

test("an invalid default workspace leaves no instance or initialization marker", async (t) => {
  const dataDir = tempDir(t, "task-handoff-default-workspace-invalid-");
  const workspacePath = path.join(tempDir(t, "task-handoff-default-workspace-invalid-home-"), "th-workspace");
  fs.writeFileSync(workspacePath, "not a directory\n");
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_default_local_invalid",
    platform: process.platform,
    defaultWorkspacePath: workspacePath,
  });
  t.after(() => app.close());

  assert.throws(
    () => app.nodeAgentEnsureDefaultWorkspaceInstance(),
    (error) => error.code === "NODE_FOLDER_PATH_NOT_DIRECTORY",
  );
  assert.equal(app.nodeAgentState.listInstances().length, 0);
  assert.equal(app.nodeAgentState.initializationMarkers.get(DEFAULT_WORKSPACE_INSTANCE_INITIALIZATION_KEY), undefined);
});
