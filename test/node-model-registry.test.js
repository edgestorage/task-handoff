const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { modelConfigHash, modelContentRevision } = require("../packages/protocol/src/control-plane.ts");

const openCodeReasoningVariants = Object.fromEntries(
  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    .map((effort) => [effort, { reasoningEffort: effort }]),
);

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-models-"));
}

function request(app, method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: "Bearer agent-secret" },
    ...(payload === undefined ? {} : { payload }),
  });
}

function modelInput(overrides = {}) {
  return {
    name: "Local Codex",
    endpoint: "https://example.test/v1",
    key: "local-secret-key",
    model: "gpt-test",
    app: "codex",
    enabled: true,
    order: 100,
    labels: {},
    ...overrides,
  };
}

function instancePayload(id, timestamp) {
  return {
    id,
    name: id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "img_models" },
    image: {
      id: "img_models", origin: "custom", name: "Models image", repository: "example/models", tag: "latest",
      requestedReference: "example/models:latest", pullPolicy: "if-not-present",
      capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    source: { type: "local-folder", path: "/tmp/models" },
    sourceSnapshot: {},
    modelSelection: {},
  };
}

test("node model registry keeps entity ids stable across edits and protects referenced models", async (t) => {
  const dataDir = tempDataDir();
  let app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_a" });
  t.after(async () => app.close());

  const codexInput = modelInput();
  const codexHash = modelConfigHash(codexInput);
  const created = await request(app, "POST", "/api/node-agent/models", codexInput);
  assert.equal(created.statusCode, 201);
  const codexId = created.json().data.id;
  assert.match(codexId, /^mdl_[0-9abcdefghjkmnpqrstvwxyz]{13}$/);
  assert.equal(created.json().data.revision, modelContentRevision({
    ...codexInput,
    modelNames: [{ name: codexInput.model, order: 100 }],
    protocols: ["openai-responses"],
  }));
  assert.deepEqual(created.json().data.modelNames, [{ name: codexInput.model, order: 100 }]);
  assert.equal("key" in created.json().data, false);

  const storedDatabase = new DatabaseSync(path.join(dataDir, "node-agent.sqlite"), { readOnly: true });
  const storedCodex = storedDatabase.prepare("SELECT key, model_names_json, protocols_json FROM na_models WHERE id = ?").get(codexId);
  assert.equal(storedCodex.key, codexInput.key);
  assert.deepEqual(JSON.parse(storedCodex.model_names_json), [{ name: codexInput.model, order: 100 }]);
  assert.deepEqual(JSON.parse(storedCodex.protocols_json), ["openai-responses"]);
  storedDatabase.close();
  assert.equal(fs.existsSync(path.join(dataDir, "models")), false);

  const upgradedLegacy = await request(app, "PATCH", `/api/node-agent/models/${codexId}`, { name: "Saved legacy model" });
  assert.equal(upgradedLegacy.statusCode, 200);
  assert.equal(upgradedLegacy.json().data.id, codexId);

  const duplicate = await request(app, "POST", "/api/node-agent/models", { ...codexInput, name: "Same content" });
  assert.equal(duplicate.statusCode, 201);
  assert.equal(duplicate.json().data.id, codexId);
  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.length, 1);

  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.length, 1);

  const claudeInput = modelInput({ name: "Local Claude", key: "claude-secret", model: "claude-test", app: "claude", order: 200 });
  const claudeId = (await request(app, "POST", "/api/node-agent/models", claudeInput)).json().data.id;
  const opencodeInput = modelInput({ name: "Local OpenCode", key: "opencode-secret", model: "openai-compatible-test", app: "opencode", order: 300 });
  const opencodeId = (await request(app, "POST", "/api/node-agent/models", opencodeInput)).json().data.id;

  const timestamp = new Date().toISOString();
  const deployInput = modelInput({ name: "Deployed Codex", key: "deployed-secret" });
  const deployHash = modelConfigHash(deployInput);
  const deployedPayload = { ...deployInput, id: deployHash, createdAt: timestamp, updatedAt: timestamp };
  assert.equal((await request(app, "PUT", `/api/node-agent/models/${deployHash}/deploy`, deployedPayload)).statusCode, 200);
  const revised = await request(app, "PUT", `/api/node-agent/models/${deployHash}/deploy`, { ...deployedPayload, key: "deployed-secret-2" });
  assert.equal(revised.statusCode, 200);
  assert.equal(revised.json().data.id, deployHash);
  assert.equal(revised.json().data.revision, modelContentRevision({
    ...deployInput,
    key: "deployed-secret-2",
    modelNames: [{ name: deployInput.model, order: 100 }],
    protocols: ["openai-responses"],
  }));
  const unknownDeployId = `mdl_${"0".repeat(64)}`;
  const mismatch = await request(app, "PUT", `/api/node-agent/models/${unknownDeployId}/deploy`, { ...deployedPayload, id: unknownDeployId });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error.code, "NODE_MODEL_HASH_MISMATCH");

  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_models", timestamp))).statusCode, 201);
  const wrongApp = await request(app, "PUT", "/api/node-agent/instances/inst_models/model-assignment", {
    modelSelection: { claudeModelHash: codexId }, claudeModelHash: codexId,
  });
  assert.equal(wrongApp.statusCode, 400);
  assert.equal(wrongApp.json().error.code, "NODE_MODEL_APP_MISMATCH");

  const assigned = await request(app, "PUT", "/api/node-agent/instances/inst_models/model-assignment", {
    modelSelection: { codexModelHash: codexId, claudeModelHash: claudeId, opencodeModelHash: opencodeId },
    codexModelHash: codexId,
    claudeModelHash: claudeId,
    opencodeModelHash: opencodeId,
  });
  assert.equal(assigned.statusCode, 200);
  assert.deepEqual(assigned.json().data.instance.modelSelection, {
    modelEntityIds: [codexId, claudeId, opencodeId],
    codexModelHash: codexId, claudeModelHash: claudeId, opencodeModelHash: opencodeId,
  });
  const assignedEnvironment = app.nodeAgentState.resolvedAssignedModelEnvironment("inst_models");
  assert.deepEqual({ ...assignedEnvironment, TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: undefined }, {
    OPENAI_API_KEY: codexInput.key,
    OPENAI_BASE_URL: codexInput.endpoint,
    TASK_HANDOFF_CODEX_BASE_URL: codexInput.endpoint,
    TASK_HANDOFF_CODEX_MODEL: codexInput.model,
    ANTHROPIC_API_KEY: claudeInput.key,
    ANTHROPIC_BASE_URL: claudeInput.endpoint,
    TASK_HANDOFF_CLAUDE_MODEL: claudeInput.model,
    TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: undefined,
  });
  assert.deepEqual(JSON.parse(assignedEnvironment.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT), {
    $schema: "https://opencode.ai/config.json",
    model: `task-handoff-${opencodeId}/${opencodeInput.model}`,
    provider: {
      [`task-handoff-${opencodeId}`]: {
        npm: "@ai-sdk/openai-compatible",
        name: opencodeInput.name,
        options: { baseURL: opencodeInput.endpoint, apiKey: opencodeInput.key },
        models: { [opencodeInput.model]: { name: opencodeInput.name, variants: openCodeReasoningVariants } },
      },
      "task-handoff": {
        npm: "@ai-sdk/openai-compatible",
        name: opencodeInput.name,
        options: { baseURL: opencodeInput.endpoint, apiKey: opencodeInput.key },
        models: { [opencodeInput.model]: { name: opencodeInput.name, variants: openCodeReasoningVariants } },
      },
    },
  });

  const rotated = await request(app, "PATCH", `/api/node-agent/models/${codexId}`, { key: "rotated-secret" });
  const rotatedHash = modelContentRevision({
    ...codexInput,
    key: "rotated-secret",
    modelNames: [{ name: codexInput.model, order: 100 }],
    protocols: ["openai-responses"],
  });
  assert.equal(rotated.statusCode, 200);
  // The entity keeps its identity: only the content revision advances.
  assert.equal(rotated.json().data.id, codexId);
  assert.equal(rotated.json().data.revision, rotatedHash);
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_models").OPENAI_API_KEY, "rotated-secret");
  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.some((model) => model.id === codexId), true);
  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.length, 4);

  assert.equal((await request(app, "DELETE", `/api/node-agent/models/${codexId}`)).statusCode, 409);
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_models/model-assignment", {
    modelSelection: {},
  })).statusCode, 200);
  assert.equal((await request(app, "DELETE", `/api/node-agent/models/${codexId}`)).statusCode, 200);

  assert.equal(fs.existsSync(path.join(dataDir, "model-assignments")), false);

  await app.close();
  app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_a" });
  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.some((model) => model.id === codexId), false);
});

test("node model registry merges a superseded entity into its successor", async (t) => {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_merge" });
  t.after(async () => app.close());

  const ghostInput = modelInput({ name: "Legacy copy", key: "legacy-secret", model: "gpt-legacy" });
  const ghostCreated = await request(app, "POST", "/api/node-agent/models", ghostInput);
  assert.equal(ghostCreated.statusCode, 201);
  const ghostId = ghostCreated.json().data.id;
  const targetInput = modelInput({ name: "Legacy copy", key: "legacy-secret", model: "gpt-successor" });
  const targetCreated = await request(app, "POST", "/api/node-agent/models", targetInput);
  assert.equal(targetCreated.statusCode, 201);
  const targetId = targetCreated.json().data.id;

  const timestamp = new Date().toISOString();
  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_merge", timestamp))).statusCode, 201);
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_merge/model-assignment", {
    modelSelection: { modelEntityIds: [ghostId], codexModelHash: ghostId },
    modelEntityIds: [ghostId],
    codexModelHash: ghostId,
  })).statusCode, 200);

  const merged = await request(app, "POST", `/api/node-agent/models/${ghostId}/merge`, { targetModelId: targetId });
  assert.equal(merged.statusCode, 200);
  assert.deepEqual(merged.json().data.reassignedInstances, ["inst_merge"]);

  const models = (await request(app, "GET", "/api/node-agent/models")).json().data;
  assert.equal(models.some((model) => model.id === ghostId), false);
  assert.equal(models.find((model) => model.id === targetId).referenceCount, 1);
  const selection = app.nodeAgentState.requireInstance("inst_merge").modelSelection;
  assert.deepEqual(selection.modelEntityIds, [targetId]);
  assert.equal(selection.codexModelHash, targetId);
  assert.equal(selection.claudeModelHash ?? null, null);
  assert.equal(selection.opencodeModelHash ?? null, null);
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_merge").TASK_HANDOFF_CODEX_MODEL, "gpt-successor");
});

test("node model assignment persists private config when live environment sync cannot connect", async (t) => {
  const dataDir = tempDataDir();
  let fetchCalls = 0;
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_offline_assignment",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new TypeError("fetch failed");
    },
  });
  t.after(async () => app.close());

  const timestamp = new Date().toISOString();
  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_offline_assignment", timestamp))).statusCode, 201);
  const current = app.nodeAgentState.requireInstance("inst_offline_assignment");
  app.nodeAgentState.controlledInstances.put({
    ...current,
    status: "running",
    connectionStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    target: {
      strategy: "direct-port",
      status: "reachable",
      web: "http://127.0.0.1:18080",
      api: "http://127.0.0.1:18080/api",
    },
    updatedAt: timestamp,
  });

  const model = modelInput({ key: "offline-instance-secret" });
  const created = await request(app, "POST", "/api/node-agent/models", model);
  assert.equal(created.statusCode, 201);
  const assigned = await request(app, "PUT", "/api/node-agent/instances/inst_offline_assignment/model-assignment", {
    modelSelection: { codexModelHash: created.json().data.id },
    codexModelHash: created.json().data.id,
  });

  assert.equal(assigned.statusCode, 200);
  assert.equal(
    app.nodeAgentState.instancePrivateConfigs.inspectMaterialized("inst_offline_assignment").environment.OPENAI_API_KEY,
    "offline-instance-secret",
  );
  assert.equal(fetchCalls, 0, "v0.0.23 controlled instances must not receive the private catalog endpoint call");
});

test("ordered model entities resolve defaults by protocol and preserve provider identity", async (t) => {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_multi_models" });
  t.after(async () => app.close());
  const timestamp = new Date().toISOString();
  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_multi_models", timestamp))).statusCode, 201);

  const shared = await request(app, "POST", "/api/node-agent/models", modelInput({
    name: "Shared endpoint",
    app: "opencode",
    protocols: ["openai-chat-completions", "openai-responses"],
    model: "shared-default",
    modelNames: [{ name: "same-name", order: 200 }, { name: "shared-first", order: 100 }],
    key: "shared-secret",
  }));
  const responses = await request(app, "POST", "/api/node-agent/models", modelInput({
    name: "Second Responses endpoint",
    endpoint: "https://second.example/v1",
    protocols: ["openai-responses", "openai-chat-completions"],
    model: "same-name",
    modelNames: [{ name: "same-name", order: 100 }, { name: "second-later", order: 200 }],
    key: "second-secret",
  }));
  const disabled = await request(app, "POST", "/api/node-agent/models", modelInput({
    name: "Disabled endpoint",
    endpoint: "https://disabled.example/v1",
    key: "disabled-secret",
    enabled: false,
  }));
  const sharedId = shared.json().data.id;
  const responsesId = responses.json().data.id;

  const assigned = await request(app, "PUT", "/api/node-agent/instances/inst_multi_models/model-assignment", {
    modelSelection: { modelEntityIds: [sharedId, responsesId, sharedId], opencodeModelHash: sharedId },
    modelEntityIds: [sharedId, responsesId, sharedId],
    opencodeModelHash: sharedId,
  });
  assert.equal(assigned.statusCode, 200);
  assert.deepEqual(assigned.json().data.assignment.modelEntityIds, [sharedId, responsesId]);
  assert.equal(assigned.json().data.instance.modelSelection.codexModelHash, undefined);
  const environment = app.nodeAgentState.resolvedAssignedModelEnvironment("inst_multi_models");
  assert.equal(environment.TASK_HANDOFF_CODEX_MODEL, "shared-first");
  const openCodeConfig = JSON.parse(environment.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT);
  assert.equal(openCodeConfig.model, `task-handoff-${sharedId}/shared-first`);
  assert.deepEqual(Object.keys(openCodeConfig.provider), [`task-handoff-${sharedId}`, `task-handoff-${responsesId}`, "task-handoff"]);
  assert.deepEqual(Object.keys(openCodeConfig.provider[`task-handoff-${sharedId}`].models), ["shared-first", "same-name"]);
  assert.ok(openCodeConfig.provider[`task-handoff-${sharedId}`].models["same-name"], "selected non-default model must be registered");
  assert.deepEqual(openCodeConfig.provider[`task-handoff-${sharedId}`].models["shared-first"].variants, openCodeReasoningVariants);
  assert.deepEqual(Object.keys(openCodeConfig.provider["task-handoff"].models), ["shared-first"]);
  const catalog = app.nodeAgentState.modelRegistry.privateCatalog("inst_multi_models");
  assert.deepEqual(catalog.entities.map((entity) => entity.id), [sharedId, responsesId]);
  assert.deepEqual(catalog.entities[0].modelNames.map((entry) => entry.name), ["shared-first", "same-name"]);
  assert.equal(catalog.entities[1].modelNames[0].name, "same-name");

  const reordered = await request(app, "PUT", "/api/node-agent/instances/inst_multi_models/model-assignment", {
    modelSelection: { modelEntityIds: [responsesId, sharedId] },
    modelEntityIds: [responsesId, sharedId],
  });
  assert.equal(reordered.statusCode, 200);
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_multi_models").TASK_HANDOFF_CODEX_MODEL, "same-name");

  const cleared = await request(app, "PUT", "/api/node-agent/instances/inst_multi_models/model-assignment", {
    modelSelection: { modelEntityIds: [] },
    modelEntityIds: [],
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json().data.instance.modelSelection, { modelEntityIds: [] });
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_multi_models").OPENAI_API_KEY, undefined);

  const rejected = await request(app, "PUT", "/api/node-agent/instances/inst_multi_models/model-assignment", {
    modelSelection: { modelEntityIds: [disabled.json().data.id] },
    modelEntityIds: [disabled.json().data.id],
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error.code, "NODE_MODEL_DISABLED");
});

test("node agent never treats model sidecars created after SQLite migration as a fallback", async (t) => {
  const dataDir = tempDataDir();
  let app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_migration" });
  t.after(async () => app.close());
  const timestamp = new Date().toISOString();
  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_mappable", timestamp))).statusCode, 201);
  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_unmappable", timestamp))).statusCode, 201);
  await app.close();

  const legacyDir = path.join(dataDir, "model-environments");
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyDir, "inst_mappable.json"), JSON.stringify({
    OPENAI_API_KEY: "legacy-secret-key",
    OPENAI_BASE_URL: "https://legacy.example/v1",
    TASK_HANDOFF_CODEX_MODEL: "gpt-legacy",
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(legacyDir, "inst_unmappable.json"), JSON.stringify({ OPENAI_API_KEY: "incomplete-secret-key" }), { mode: 0o600 });

  app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_migration" });
  assert.deepEqual(app.nodeAgentState.modelRegistry.list(), []);
  assert.deepEqual(app.nodeAgentState.requireInstance("inst_mappable").modelSelection, {});
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(fs.existsSync(`${legacyDir}.migrated-v0.0.28/inst_mappable.json`), true);
  assert.equal(fs.existsSync(`${legacyDir}.migrated-v0.0.28/inst_unmappable.json`), true);
});
