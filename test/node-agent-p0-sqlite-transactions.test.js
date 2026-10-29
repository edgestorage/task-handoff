const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { CONTROL_PLANE_PROTOCOL_VERSION, createModelEntityId } = require("../packages/protocol/src/control-plane.ts");

function image(timestamp) {
  return {
    id: "img_p0", origin: "custom", name: "P0 image", repository: "example/p0", tag: "latest",
    requestedReference: "example/p0:latest", pullPolicy: "if-not-present",
    capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
  };
}

function instanceInput(id, overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    id,
    name: id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "img_p0" },
    image: image(timestamp),
    source: { type: "local-folder", path: os.tmpdir() },
    sourceSnapshot: { immutable: true },
    modelSelection: {},
    ...overrides,
  };
}

function modelInput(name, key, model, order) {
  return { name, endpoint: "https://models.example.test/v1", key, model, app: "codex", enabled: true, order, labels: {} };
}

async function fixture(t, name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-p0-transactions-${name}-`));
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: `node_${name}` });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, state: app.nodeAgentState, dataDir, databasePath: path.join(dataDir, "node-agent.sqlite") };
}

test("instance creation rolls back instance and observation when Git provisioning insert fails", async (t) => {
  const { state, databasePath } = await fixture(t, "create_rollback");
  const inject = new DatabaseSync(databasePath);
  inject.exec(`CREATE TRIGGER fail_p0_provisioning BEFORE INSERT ON na_git_workspace_provisioning
    BEGIN SELECT RAISE(ABORT, 'injected provisioning failure'); END`);
  inject.close();

  const provisioning = {
    operationId: "gitop_create_rollback",
    instanceId: "inst_create_rollback",
    remoteUrl: "https://git.example.test/team/repo.git",
    ref: { type: "branch", name: "main" },
    clone: { submodules: false, lfs: false, subdirectory: "" },
    credentials: [{
      operationId: "gitcredop_create_rollback",
      retention: "operation-only",
      payload: {
        credential: {
          id: "gitcred_create_rollback", name: "Operation token", kind: "https-token",
          scope: { scheme: "https", host: "git.example.test", pathPrefix: "/team/" },
          secretSet: true, status: "enabled", revision: 1,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        secret: { kind: "https-token", username: "git", token: "operation-secret" },
      },
    }],
  };
  assert.throws(
    () => state.createInstance(instanceInput("inst_create_rollback", {
      source: { type: "git-repository", url: provisioning.remoteUrl, ref: provisioning.ref, auth: { type: "none" }, clone: provisioning.clone },
      gitWorkspaceProvisioning: provisioning,
    })),
    /injected provisioning failure/,
  );

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instances WHERE id = ?").get("inst_create_rollback").count, 0);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instance_observations WHERE instance_id = ?").get("inst_create_rollback").count, 0);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_git_workspace_provisioning WHERE instance_id = ?").get("inst_create_rollback").count, 0);
  verify.close();
});

test("model assignment failure rolls back members and instance desired state", async (t) => {
  const { state, databasePath } = await fixture(t, "assignment_rollback");
  state.createInstance(instanceInput("inst_assignment_rollback"));
  const first = state.modelRegistry.create(modelInput("First", "first-secret", "gpt-first", 10));
  const second = state.modelRegistry.create(modelInput("Second", "second-secret", "gpt-second", 20));
  state.modelRegistry.assign("inst_assignment_rollback", {
    modelSelection: { modelEntityIds: [first.id] }, modelEntityIds: [first.id],
  });
  const before = new DatabaseSync(databasePath, { readOnly: true });
  const desiredJson = before.prepare("SELECT desired_json FROM na_instances WHERE id = ?").get("inst_assignment_rollback").desired_json;
  const members = before.prepare("SELECT model_id, display_order FROM na_instance_model_entities WHERE instance_id = ? ORDER BY display_order").all("inst_assignment_rollback");
  before.close();

  const inject = new DatabaseSync(databasePath);
  inject.exec(`CREATE TRIGGER fail_p0_model_member BEFORE INSERT ON na_instance_model_entities
    BEGIN SELECT RAISE(ABORT, 'injected model member failure'); END`);
  inject.close();
  assert.throws(
    () => state.modelRegistry.assign("inst_assignment_rollback", {
      modelSelection: { modelEntityIds: [second.id] }, modelEntityIds: [second.id],
    }),
    /injected model member failure/,
  );

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT desired_json FROM na_instances WHERE id = ?").get("inst_assignment_rollback").desired_json, desiredJson);
  assert.deepEqual(verify.prepare("SELECT model_id, display_order FROM na_instance_model_entities WHERE instance_id = ? ORDER BY display_order").all("inst_assignment_rollback"), members);
  verify.close();
});

test("instance delete failure preserves all cascaded P0 relations", async (t) => {
  const { state, databasePath } = await fixture(t, "delete_rollback");
  state.createInstance(instanceInput("inst_delete_rollback"));
  const model = state.modelRegistry.create(modelInput("Delete", "delete-secret", "gpt-delete", 10));
  state.modelRegistry.assign("inst_delete_rollback", {
    modelSelection: { modelEntityIds: [model.id] }, modelEntityIds: [model.id],
  });
  const inject = new DatabaseSync(databasePath);
  inject.exec(`CREATE TRIGGER fail_p0_instance_delete BEFORE DELETE ON na_instances
    BEGIN SELECT RAISE(ABORT, 'injected instance delete failure'); END`);
  inject.close();

  assert.throws(() => state.controlledInstances.delete("inst_delete_rollback"), /injected instance delete failure/);
  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instances WHERE id = ?").get("inst_delete_rollback").count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instance_observations WHERE instance_id = ?").get("inst_delete_rollback").count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instance_model_assignments WHERE instance_id = ?").get("inst_delete_rollback").count, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instance_model_entities WHERE instance_id = ?").get("inst_delete_rollback").count, 1);
  verify.close();
});

test("high-frequency heartbeat only changes observation-owned state", async (t) => {
  const { state, databasePath } = await fixture(t, "heartbeat_projection");
  const instance = state.createInstance(instanceInput("inst_heartbeat_projection"));
  const token = instance.registrationToken;
  state.registerInstance("inst_heartbeat_projection", {
    instanceId: "inst_heartbeat_projection",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    appInventory: { items: [], observedAt: new Date().toISOString(), issues: [] },
    processIncarnationId: "process-current",
    workspace: { status: "ready" },
  }, token);
  const before = new DatabaseSync(databasePath, { readOnly: true });
  const desiredJson = before.prepare("SELECT desired_json FROM na_instances WHERE id = ?").get("inst_heartbeat_projection").desired_json;
  before.close();

  for (let index = 0; index < 25; index += 1) {
    state.heartbeatInstance("inst_heartbeat_projection", {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: { items: [], observedAt: new Date().toISOString(), issues: [] },
      processIncarnationId: "process-current",
      status: "running",
      health: "ok",
      apps: { runningCount: index, problemCount: 0 },
    }, token);
  }
  assert.throws(
    () => state.heartbeatInstance("inst_heartbeat_projection", {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: { items: [], observedAt: new Date().toISOString(), issues: [] },
      processIncarnationId: "process-obsolete",
      status: "failed",
      health: "failed",
    }, token),
    (error) => error.code === "INSTANCE_PROCESS_INCARNATION_MISMATCH",
  );

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT desired_json FROM na_instances WHERE id = ?").get("inst_heartbeat_projection").desired_json, desiredJson);
  assert.equal(JSON.parse(verify.prepare("SELECT observed_json FROM na_instance_observations WHERE instance_id = ?").get("inst_heartbeat_projection").observed_json).apps.runningCount, 24);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instance_model_assignments WHERE instance_id = ?").get("inst_heartbeat_projection").count, 0);
  verify.close();
});

test("runtime references are restricted while local folder deletion preserves the source snapshot", async (t) => {
  const { state, databasePath } = await fixture(t, "topology_relations");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-workspace-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const folder = state.createLocalFolder({ id: "folder_topology", name: "Workspace", path: workspace, labels: {} });
  const runtime = state.createRuntime({ id: "runtime_topology", name: "Docker", type: "docker", status: "online", labels: {} });
  state.createInstance(instanceInput("inst_topology", {
    runtimeId: runtime.id,
    source: { type: "local-folder", localFolderId: folder.id, path: workspace, ownerNodeId: state.nodeId },
    sourceSnapshot: { localFolderId: folder.id, path: workspace, immutable: true },
  }));

  assert.throws(() => state.deleteRuntime(runtime.id), (error) => error.code === "NODE_RUNTIME_IN_USE");
  assert.equal(state.localFolders.delete(folder.id), true);
  const instance = state.requireInstance("inst_topology");
  assert.deepEqual(instance.sourceSnapshot, { localFolderId: folder.id, path: workspace, immutable: true });

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT source_local_folder_id FROM na_instances WHERE id = ?").get("inst_topology").source_local_folder_id, null);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_runtimes WHERE id = ?").get(runtime.id).count, 1);
  verify.close();
});

test("private config write failure keeps SQLite authority and a later operation rematerializes it", async (t) => {
  const { state, databasePath } = await fixture(t, "private_config_recovery");
  const filePath = state.instancePrivateConfigs.filePath("inst_private_config_recovery");
  fs.mkdirSync(filePath, { recursive: true });
  assert.throws(
    () => state.createInstance(instanceInput("inst_private_config_recovery")),
    /EISDIR|directory|rename/i,
  );
  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instances WHERE id = ?").get("inst_private_config_recovery").count, 1);
  verify.close();

  fs.rmSync(filePath, { recursive: true, force: true });
  const instance = state.requireInstance("inst_private_config_recovery");
  state.context(instance);
  assert.equal(state.instancePrivateConfigs.inspectMaterialized(instance.id).instanceCredential, instance.registrationToken);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("restart cleans a private config left after the instance database delete committed", async (t) => {
  const { app, state, dataDir } = await fixture(t, "delete_cleanup_recovery");
  const instance = state.createInstance(instanceInput("inst_delete_cleanup_recovery"));
  const filePath = state.instancePrivateConfigs.filePath(instance.id);
  assert.equal(fs.existsSync(filePath), true);

  // Simulate process exit after the SQLite DELETE commits and before file cleanup runs.
  assert.equal(state.controlledInstances.delete(instance.id), true);
  assert.equal(fs.existsSync(filePath), true);
  await app.close();

  const restarted = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_delete_cleanup_recovery" });
  assert.equal(restarted.nodeAgentState.listInstances().length, 0);
  assert.equal(fs.existsSync(filePath), false);
  await restarted.close();
});

test("SQLite instance reads sanitize v0.0.46 snapshots at the repository boundary and stay isolated", async (t) => {
  const { state, databasePath } = await fixture(t, "read_boundary");
  const instance = state.createInstance(instanceInput("inst_read_boundary"));
  const inject = new DatabaseSync(databasePath);
  t.after(() => inject.close());
  const desired = JSON.parse(inject.prepare("SELECT desired_json FROM na_instances WHERE id = ?").get(instance.id).desired_json);
  const observed = JSON.parse(inject.prepare("SELECT observed_json FROM na_instance_observations WHERE instance_id = ?").get(instance.id).observed_json);
  desired.futureDesiredField = true;
  desired.source.futureSourceField = true;
  observed.futureObservedField = true;
  observed.runtime.futureRuntimeField = true;
  // Legacy v0.0.46 endpoint projection must still migrate before validation.
  delete observed.target;
  observed.endpoints = { strategy: "node-proxy", status: "reachable", web: "http://127.0.0.1:19000" };
  inject.prepare("UPDATE na_instances SET desired_json = ? WHERE id = ?").run(JSON.stringify(desired), instance.id);
  inject.prepare("UPDATE na_instance_observations SET observed_json = ? WHERE instance_id = ?").run(JSON.stringify(observed), instance.id);

  const direct = state.controlledInstances.get(instance.id);
  assert.equal(direct.target.web, observed.endpoints.web);
  assert.equal("futureDesiredField" in direct, false);
  assert.equal("futureObservedField" in direct, false);
  assert.equal("futureSourceField" in direct.source, false);
  assert.equal("futureRuntimeField" in direct.runtime, false);
  assert.equal("endpoints" in direct, false);
  assert.deepEqual(state.requireInstance(instance.id), direct);
  assert.deepEqual(state.listInstances().find((item) => item.id === instance.id), direct);
  const firstListed = state.listInstances().find((item) => item.id === instance.id);
  const secondListed = state.listInstances().find((item) => item.id === instance.id);
  assert.notEqual(firstListed, secondListed);
  firstListed.runtime.labels.injected = "list-only";
  assert.equal(state.listInstances().find((item) => item.id === instance.id).runtime.labels.injected, undefined);
  direct.runtime.labels.injected = "caller-only";
  direct.source.path = "/caller-only";
  assert.notEqual(state.requireInstance(instance.id).source.path, "/caller-only");
  assert.equal(state.requireInstance(instance.id).runtime.labels.injected, undefined);
});

test("an invalid required instance field remains a structured read error and does not hide valid instances", async (t) => {
  const { state, databasePath } = await fixture(t, "invalid_read_boundary");
  const broken = state.createInstance(instanceInput("inst_invalid_read_boundary"));
  const valid = state.createInstance(instanceInput("inst_valid_read_boundary"));
  const inject = new DatabaseSync(databasePath);
  t.after(() => inject.close());
  const desired = JSON.parse(inject.prepare("SELECT desired_json FROM na_instances WHERE id = ?").get(broken.id).desired_json);
  desired.source = { type: "unsupported-source" };
  inject.prepare("UPDATE na_instances SET desired_json = ? WHERE id = ?").run(JSON.stringify(desired), broken.id);
  assert.throws(() => state.requireInstance(broken.id), (error) => error.code === "NODE_INSTANCE_PAYLOAD_INVALID" && error.statusCode === 409);
  assert.equal(state.listInstances().some((item) => item.id === broken.id), false);
  assert.equal(state.listInstances().some((item) => item.id === valid.id), true);
  assert.throws(() => state.requireInstance("inst_missing"), (error) => error.code === "NODE_INSTANCE_NOT_FOUND" && error.statusCode === 404);
});

test("instance reads invalidate when model assignments or cascaded model identities change", async (t) => {
  const { state } = await fixture(t, "assignment_cache_invalidation");
  const instance = state.createInstance(instanceInput("inst_assignment_cache_invalidation"));
  const first = state.modelRegistry.create(modelInput("First", "first-secret", "gpt-first", 10));
  const second = state.modelRegistry.create(modelInput("Second", "second-secret", "gpt-second", 20));
  state.modelRegistry.assign(instance.id, {
    modelSelection: { modelEntityIds: [first.id] }, modelEntityIds: [first.id],
  });

  // Warm the aggregate cache before changing tables that are not na_instances.
  assert.deepEqual(state.requireInstance(instance.id).modelSelection.modelEntityIds, [first.id]);
  const assignment = state.persistence.model.assignments.get(instance.id);
  state.persistence.model.assignments.put({
    ...assignment,
    modelEntityIds: [second.id],
    updatedAt: new Date().toISOString(),
  });
  assert.deepEqual(state.requireInstance(instance.id).modelSelection.modelEntityIds, [second.id]);

  // Renaming a model updates assignment entity rows through ON UPDATE CASCADE.
  assert.deepEqual(state.requireInstance(instance.id).modelSelection.modelEntityIds, [second.id]);
  const renamedId = createModelEntityId();
  state.persistence.model.models.rename(second.id, renamedId);
  assert.deepEqual(state.requireInstance(instance.id).modelSelection.modelEntityIds, [renamedId]);

  // Removing the assignment falls back to the model selection stored beside
  // the instance, which must also be visible without another instance write.
  assert.equal(state.persistence.model.assignments.delete(instance.id), true);
  assert.deepEqual(state.requireInstance(instance.id).modelSelection.modelEntityIds, [first.id]);
});

test("instance cache never publishes an uncommitted snapshot across rollback", async (t) => {
  const { state } = await fixture(t, "instance_cache_rollback");
  const instance = state.createInstance(instanceInput("inst_cache_rollback"));
  assert.equal(state.requireInstance(instance.id).name, instance.name);

  assert.throws(() => state.persistence.transactionSync((repository) => {
    const current = repository.topology.instances.get(instance.id);
    repository.topology.instances.put({ ...current, name: "uncommitted", updatedAt: new Date().toISOString() });
    assert.equal(repository.topology.instances.get(instance.id).name, "uncommitted");
    throw new Error("rollback instance cache fixture");
  }), /rollback instance cache fixture/);

  assert.equal(state.requireInstance(instance.id).name, instance.name);
});
