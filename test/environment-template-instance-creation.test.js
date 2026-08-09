const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { dockerRunArgs } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");
const { NodeAgentState } = require("../packages/control-plane/src/node-agent/state.ts");

const imageId = `sha256:${"d".repeat(64)}`;
const timestamp = "2026-08-04T00:00:00.000Z";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-template-instance-"));
  const state = new NodeAgentState(nodeAgentStorePaths(dataDir), "node_one", "http://127.0.0.1:8091", "http://host.docker.internal:8091", 8091, "linux");
  state.init();
  state.environmentTemplates.put({
    id: "template_ready",
    name: "Configured tools",
    sourceInstanceId: "inst_source",
    nodeId: "node_one",
    imageId,
    internalTag: "task-handoff/environment-template:template_ready",
    platform: "linux",
    architecture: "x64",
    sizeBytes: 4096,
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { dataDir, state };
}

function createInput(id, source) {
  return {
    id,
    runtimeId: "runtime_local_docker",
    environmentSource: { type: "template", environmentTemplateId: "template_ready" },
    source,
  };
}

test("template-derived instances combine with independent Git and local workspaces", (t) => {
  const { dataDir, state } = fixture();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const git = state.createInstance(createInput("inst_git", {
    type: "git-repository",
    repositoryId: "repo_one",
    url: "https://example.com/one.git",
    auth: { type: "none" },
    clone: { depth: 1, submodules: false, lfs: false },
  }));
  const local = state.createInstance(createInput("inst_local", { type: "local-folder", path: "/tmp/local-project" }));

  assert.equal(git.environmentTemplateOrigin.templateId, "template_ready");
  assert.equal(git.environmentTemplateOrigin.imageId, imageId);
  assert.equal(git.imageSnapshot.resolvedDigest, imageId);
  assert.equal(git.status, "created");
  assert.equal(git.imageProvisioning, undefined);
  assert.equal("managedVolumes" in git.runtime, false);
  assert.equal("managedVolumes" in local.runtime, false);
  assert.notEqual(git.registrationToken, local.registrationToken);
  assert.equal(state.instancePrivateConfigs.get(git.id).instanceCredential, git.registrationToken);
  assert.equal(state.instancePrivateConfigs.get(local.id).instanceCredential, local.registrationToken);
  const persistedGit = JSON.parse(fs.readFileSync(state.paths.controlledInstancesDir + "/inst_git.json", "utf8"));
  assert.equal("registrationToken" in persistedGit, false);

  const gitRunArgs = dockerRunArgs(state.context(git), "task-handoff-inst_git");
  const localRunArgs = dockerRunArgs(state.context(local), "task-handoff-inst_local");
  assert.equal(gitRunArgs.at(-4), imageId);
  assert.equal(localRunArgs.at(-4), imageId);
  assert.ok(gitRunArgs.includes("type=volume,src=task-handoff-inst_git-workspace,dst=/workspace"));
  assert.ok(localRunArgs.includes("/tmp/local-project:/workspace:rw"));
});

test("template instance creation rejects missing, non-ready, cross-node, and non-Docker templates", (t) => {
  const { dataDir, state } = fixture();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const localSource = { type: "local-folder", path: "/tmp/local-project" };

  assert.throws(
    () => state.createInstance({ ...createInput("inst_missing", localSource), environmentSource: { type: "template", environmentTemplateId: "template_missing" } }),
    (error) => error.code === "ENVIRONMENT_TEMPLATE_NOT_FOUND",
  );

  state.environmentTemplates.put({
    id: "template_failed", name: "Failed", sourceInstanceId: "inst_source", nodeId: "node_one", status: "failed",
    error: { code: "COMMIT_FAILED", message: "commit failed", phase: "commit" }, createdAt: timestamp, updatedAt: timestamp,
  });
  assert.throws(
    () => state.createInstance({ ...createInput("inst_failed", localSource), environmentSource: { type: "template", environmentTemplateId: "template_failed" } }),
    (error) => error.code === "ENVIRONMENT_TEMPLATE_NOT_READY",
  );

  state.environmentTemplates.put({
    ...state.environmentTemplates.get("template_ready"), id: "template_foreign", nodeId: "node_other",
  });
  assert.throws(
    () => state.createInstance({ ...createInput("inst_foreign", localSource), environmentSource: { type: "template", environmentTemplateId: "template_foreign" } }),
    (error) => error.code === "ENVIRONMENT_TEMPLATE_NODE_MISMATCH",
  );

  const localRuntimeId = state.nodeRuntimes.list().find((runtime) => runtime.type === "local").id;
  assert.throws(
    () => state.createInstance({ ...createInput("inst_local_runtime", localSource), runtimeId: localRuntimeId }),
    (error) => error.code === "ENVIRONMENT_TEMPLATE_RUNTIME_UNSUPPORTED",
  );
});

test("legacy instance registration tokens migrate into the private credential store", (t) => {
  const first = fixture();
  t.after(() => fs.rmSync(first.dataDir, { recursive: true, force: true }));
  const created = first.state.createInstance(createInput("inst_legacy_credential", { type: "local-folder", path: "/tmp/local-project" }));
  const instancePath = path.join(first.state.paths.controlledInstancesDir, `${created.id}.json`);
  const persistentRecord = JSON.parse(fs.readFileSync(instancePath, "utf8"));
  fs.writeFileSync(instancePath, JSON.stringify({ ...persistentRecord, registrationToken: created.registrationToken }));
  first.state.instancePrivateConfigs.delete(created.id);

  const restored = new NodeAgentState(first.state.paths, "node_one", "http://127.0.0.1:8091", "http://host.docker.internal:8091", 8091, "linux");
  restored.init();

  assert.equal(restored.requireInstance(created.id).registrationToken, created.registrationToken);
  assert.equal(restored.instancePrivateConfigs.get(created.id).instanceCredential, created.registrationToken);
  assert.equal("registrationToken" in JSON.parse(fs.readFileSync(instancePath, "utf8")), false);
});
