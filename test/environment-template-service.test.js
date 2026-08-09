const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { EnvironmentTemplateService } = require("../packages/control-plane/src/node-agent/environment-templates/service.ts");
const { EnvironmentTemplateStore } = require("../packages/control-plane/src/node-agent/environment-templates/store.ts");
const { InstancePrivateConfigStore } = require("../packages/control-plane/src/node-agent/instances/private-config-store.ts");
const { InstanceOperationGate } = require("../packages/control-plane/src/node-agent/instances/instance-operation-gate.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { LocalDockerExecutor } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");

const timestamp = "2026-08-04T00:00:00.000Z";
const imageId = `sha256:${"c".repeat(64)}`;

function fixture(runtimeType = "docker") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-env-template-service-"));
  const paths = nodeAgentStorePaths(dataDir);
  const store = new EnvironmentTemplateStore(paths);
  const privateConfigs = new InstancePrivateConfigStore(paths);
  store.init();
  privateConfigs.init();
  privateConfigs.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
  const instance = {
    id: "inst_one",
    name: "Source",
    nodeId: "node_one",
    runtimeId: "runtime_one",
    runtime: { containerName: "task-handoff-inst_one", containerId: "container-one" },
  };
  const runtime = { id: "runtime_one", name: "Runtime", type: runtimeType };
  const gate = new InstanceOperationGate();
  return { dataDir, paths, store, privateConfigs, instance, runtime, gate };
}

test("environment template service commits, validates, persists ready, and safely deletes", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.dataDir, { recursive: true, force: true }));
  const calls = [];
  const docker = {
    inspectContainerConfigSecurity: async (_name, secrets) => { calls.push("container-security"); assert.ok(secrets.includes("registration-secret")); },
    commitEnvironmentTemplate: async (_name, expectedId, tag) => { calls.push("commit"); assert.equal(expectedId, "container-one"); assert.match(tag, /^task-handoff\/environment-template:/); return imageId; },
    inspectEnvironmentTemplateImage: async () => { calls.push("image-inspect"); return { imageId, platform: "linux", architecture: "x64", sizeBytes: 2048 }; },
    inspectImageConfigSecurity: async () => { calls.push("image-security"); },
    untagEnvironmentTemplate: async () => { calls.push("untag"); return true; },
    garbageCollectEnvironmentTemplateImage: async () => { calls.push("gc-referenced"); return false; },
  };
  const service = new EnvironmentTemplateService(
    state.store, state.privateConfigs, docker,
    () => state.instance,
    () => state.runtime,
    (id, operation) => state.gate.run(id, operation),
  );
  const ready = await service.create("inst_one", { name: "Configured tools" });
  assert.equal(ready.status, "ready");
  assert.equal(ready.imageId, imageId);
  assert.deepEqual(calls.slice(0, 4), ["container-security", "commit", "image-inspect", "image-security"]);
  assert.equal(service.list().length, 1);

  const deleted = await service.delete(ready.id);
  assert.equal(deleted.deleted, true);
  assert.equal(service.list().length, 0);
  assert.ok(calls.includes("gc-referenced"));
});

test("failed template creation records diagnostics and compensates the internal tag", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.dataDir, { recursive: true, force: true }));
  let untagged = false;
  const service = new EnvironmentTemplateService(
    state.store,
    state.privateConfigs,
    {
      inspectContainerConfigSecurity: async () => undefined,
      commitEnvironmentTemplate: async () => imageId,
      inspectEnvironmentTemplateImage: async () => { throw Object.assign(new Error("inspect failed"), { code: "ENVIRONMENT_TEMPLATE_IMAGE_INSPECT_FAILED" }); },
      inspectImageConfigSecurity: async () => undefined,
      untagEnvironmentTemplate: async () => { untagged = true; return true; },
      garbageCollectEnvironmentTemplateImage: async () => false,
    },
    () => state.instance,
    () => state.runtime,
    (id, operation) => state.gate.run(id, operation),
  );
  const failed = await service.create("inst_one", { name: "Broken" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "ENVIRONMENT_TEMPLATE_IMAGE_INSPECT_FAILED");
  assert.equal(untagged, true);
});

test("non-Docker instances are rejected without creating a template record", async (t) => {
  const state = fixture("local");
  t.after(() => fs.rmSync(state.dataDir, { recursive: true, force: true }));
  const service = new EnvironmentTemplateService(
    state.store, state.privateConfigs, {}, () => state.instance, () => state.runtime,
    (id, operation) => state.gate.run(id, operation),
  );
  await assert.rejects(() => service.create("inst_one", { name: "Unsupported" }), (error) => error.code === "ENVIRONMENT_TEMPLATE_RUNTIME_UNSUPPORTED");
  assert.deepEqual(service.list(), []);
});

test("Docker executor uses default-pause commit and reference-safe image removal", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "container-one", stderr: "" };
    if (args[0] === "commit") return { stdout: imageId, stderr: "" };
    if (args[0] === "image" && args[1] === "rm" && args[2] === imageId) {
      throw Object.assign(new Error("conflict: image is being used by stopped container"), { details: { stderr: "conflict: image is being used by stopped container" } });
    }
    return { stdout: "", stderr: "" };
  });
  assert.equal(await executor.commitEnvironmentTemplate("task-handoff-inst_one", "container-one", "task-handoff/environment-template:one"), imageId);
  assert.deepEqual(calls.find((args) => args[0] === "commit"), ["commit", "task-handoff-inst_one", "task-handoff/environment-template:one"]);
  await executor.untagEnvironmentTemplate("task-handoff/environment-template:one", imageId);
  assert.deepEqual(calls.find((args) => args[0] === "tag"), [
    "tag", imageId, `task-handoff/environment-image:${"c".repeat(64)}`,
  ]);
  assert.deepEqual(calls.find((args) => args[0] === "image" && args[1] === "rm" && args.includes("task-handoff/environment-template:one")), [
    "image", "rm", "task-handoff/environment-template:one",
  ]);
  assert.equal(await executor.garbageCollectEnvironmentTemplateImage(imageId), false);
});

test("template deletion is serialized with instance creation and skips GC after a new reference", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.dataDir, { recursive: true, force: true }));
  state.store.put({
    id: "template_ready", name: "Ready", sourceInstanceId: "inst_one", nodeId: "node_one", imageId,
    internalTag: "task-handoff/environment-template:template_ready", platform: "linux", architecture: "x64",
    sizeBytes: 2048, status: "ready", createdAt: timestamp, updatedAt: timestamp,
  });
  let referenced = false;
  let releaseCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  const calls = [];
  const service = new EnvironmentTemplateService(
    state.store, state.privateConfigs,
    {
      untagEnvironmentTemplate: async () => { calls.push("untag"); return true; },
      garbageCollectEnvironmentTemplateImage: async () => { calls.push("gc"); return true; },
    },
    () => state.instance,
    () => state.runtime,
    (id, operation) => state.gate.run(id, operation),
    () => referenced,
  );

  const creatingInstance = service.runTemplateOperation("template_ready", async () => {
    await creationGate;
    service.require("template_ready");
    referenced = true;
  });
  const deleting = service.delete("template_ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  releaseCreation();
  await Promise.all([creatingInstance, deleting]);
  assert.deepEqual(calls, ["untag"]);
  assert.equal(state.store.get("template_ready"), undefined);
  referenced = false;
  assert.equal(await service.releaseUnusedImage(imageId), true);
  assert.deepEqual(calls, ["untag", "gc"]);
});

test("deleting an interrupted template recovers and garbage collects its committed image", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.dataDir, { recursive: true, force: true }));
  state.store.put({
    id: "template_interrupted", name: "Interrupted", sourceInstanceId: "inst_one", nodeId: "node_one",
    internalTag: "task-handoff/environment-template:template_interrupted", status: "creating",
    createdAt: timestamp, updatedAt: timestamp,
  });
  state.store.init();
  const calls = [];
  const service = new EnvironmentTemplateService(
    state.store, state.privateConfigs,
    {
      untagEnvironmentTemplate: async (_tag, knownImageId) => { calls.push(["untag", knownImageId]); return imageId; },
      garbageCollectEnvironmentTemplateImage: async (candidate) => { calls.push(["gc", candidate]); return true; },
    },
    () => state.instance,
    () => state.runtime,
    (id, operation) => state.gate.run(id, operation),
  );

  await service.delete("template_interrupted");
  assert.deepEqual(calls, [["untag", undefined], ["gc", imageId]]);
  assert.equal(state.store.get("template_interrupted"), undefined);
});
