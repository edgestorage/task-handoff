const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { modelConfigHash } = require("../packages/protocol/src/control-plane.ts");

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
    imageId: "img_models",
    image: {
      id: "img_models", name: "Models image", image: "example/models:latest", registry: "local",
      capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    source: { type: "local-folder", path: "/tmp/models" },
    sourceSnapshot: {},
    modelSelection: {},
  };
}

test("node model registry uses immutable content hashes, private storage, and hash assignments", async (t) => {
  const dataDir = tempDataDir();
  let app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_a" });
  t.after(async () => app.close());

  const codexInput = modelInput();
  const codexHash = modelConfigHash(codexInput);
  const created = await request(app, "POST", "/api/node-agent/models", codexInput);
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().data.id, codexHash);
  assert.equal("key" in created.json().data, false);

  const modelPath = path.join(dataDir, "models", `${codexHash}.json`);
  assert.equal(fs.statSync(path.dirname(modelPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(modelPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(modelPath, "utf8")).key, codexInput.key);

  const duplicate = await request(app, "POST", "/api/node-agent/models", { ...codexInput, name: "Same content" });
  assert.equal(duplicate.statusCode, 201);
  assert.equal(duplicate.json().data.id, codexHash);
  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.length, 1);

  fs.writeFileSync(path.join(dataDir, "models", "mdl_tampered.json"), fs.readFileSync(modelPath));
  assert.equal((await request(app, "GET", "/api/node-agent/models")).json().data.length, 1);

  const claudeInput = modelInput({ name: "Local Claude", key: "claude-secret", model: "claude-test", app: "claude", order: 200 });
  const claudeHash = modelConfigHash(claudeInput);
  assert.equal((await request(app, "POST", "/api/node-agent/models", claudeInput)).statusCode, 201);

  const timestamp = new Date().toISOString();
  const deployInput = modelInput({ name: "Deployed Codex", key: "deployed-secret" });
  const deployHash = modelConfigHash(deployInput);
  const deployedPayload = { ...deployInput, id: deployHash, createdAt: timestamp, updatedAt: timestamp };
  assert.equal((await request(app, "PUT", `/api/node-agent/models/${deployHash}/deploy`, deployedPayload)).statusCode, 200);
  const mismatch = await request(app, "PUT", `/api/node-agent/models/${deployHash}/deploy`, { ...deployedPayload, key: "different" });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error.code, "NODE_MODEL_HASH_MISMATCH");

  assert.equal((await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_models", timestamp))).statusCode, 201);
  const wrongApp = await request(app, "PUT", "/api/node-agent/instances/inst_models/model-assignment", {
    modelSelection: { claudeModelHash: codexHash }, claudeModelHash: codexHash,
  });
  assert.equal(wrongApp.statusCode, 400);
  assert.equal(wrongApp.json().error.code, "NODE_MODEL_APP_MISMATCH");

  const assigned = await request(app, "PUT", "/api/node-agent/instances/inst_models/model-assignment", {
    modelSelection: { codexModelHash: codexHash, claudeModelHash: claudeHash },
    codexModelHash: codexHash,
    claudeModelHash: claudeHash,
  });
  assert.equal(assigned.statusCode, 200);
  assert.deepEqual(assigned.json().data.instance.modelSelection, { codexModelHash: codexHash, claudeModelHash: claudeHash });
  assert.deepEqual(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_models"), {
    OPENAI_API_KEY: codexInput.key,
    OPENAI_BASE_URL: codexInput.endpoint,
    TASK_HANDOFF_CODEX_BASE_URL: codexInput.endpoint,
    TASK_HANDOFF_CODEX_MODEL: codexInput.model,
    ANTHROPIC_API_KEY: claudeInput.key,
    ANTHROPIC_BASE_URL: claudeInput.endpoint,
    TASK_HANDOFF_CLAUDE_MODEL: claudeInput.model,
  });

  const rotated = await request(app, "PATCH", `/api/node-agent/models/${codexHash}`, { key: "rotated-secret" });
  const rotatedHash = modelConfigHash({ ...codexInput, key: "rotated-secret" });
  assert.equal(rotated.statusCode, 200);
  assert.equal(rotated.json().data.id, rotatedHash);
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_models").OPENAI_API_KEY, codexInput.key);
  assert.equal(fs.existsSync(modelPath), true);

  assert.equal((await request(app, "DELETE", `/api/node-agent/models/${codexHash}`)).statusCode, 409);
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_models/model-assignment", {
    modelSelection: { codexModelHash: rotatedHash }, codexModelHash: rotatedHash,
  })).statusCode, 200);
  assert.equal((await request(app, "DELETE", `/api/node-agent/models/${codexHash}`)).statusCode, 200);

  const assignmentPath = path.join(dataDir, "model-assignments", "inst_models.json");
  const storedAssignment = JSON.parse(fs.readFileSync(assignmentPath, "utf8"));
  fs.writeFileSync(assignmentPath, JSON.stringify({ ...storedAssignment, futureField: true }));
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_models").OPENAI_API_KEY, "rotated-secret");

  await app.close();
  app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_a" });
  assert.equal(app.nodeAgentState.resolvedAssignedModelEnvironment("inst_models").OPENAI_API_KEY, "rotated-secret");
});

test("node agent migrates complete legacy model sidecars to content hashes and preserves unmappable sidecars", async (t) => {
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
  const hash = modelConfigHash({ app: "codex", endpoint: "https://legacy.example/v1", key: "legacy-secret-key", model: "gpt-legacy" });
  assert.equal(fs.existsSync(path.join(dataDir, "models", `${hash}.json`)), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "model-assignments", "inst_mappable.json"), "utf8")).codexModelHash, hash);
  assert.equal(fs.existsSync(path.join(legacyDir, "inst_mappable.json")), false);
  assert.equal(fs.existsSync(path.join(legacyDir, "inst_unmappable.json")), true);
});
