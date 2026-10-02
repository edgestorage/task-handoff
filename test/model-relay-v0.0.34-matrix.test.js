const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const {
  NodeModelRelayResolver,
  deriveModelRelayRouteId,
} = require("../packages/control-plane/src/node-agent/models/relay-routes.ts");
const { supportsControlledInstanceModelRelay } = require("../packages/protocol/src/control-plane.ts");

// Compatibility for v0.0.34: this file pins the N-1 mixed-version matrix for
// the model relay change. A v0.0.34 control-plane sends `{ name, order }` only
// and never touches the relay settings; a v0.0.34 controlled instance never
// declares the relay consumer capability. Both must keep the released
// same-name direct path, and mappings must fail closed instead of degrading.

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-relay-matrix-"));
}

function request(app, method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: "Bearer agent-secret" },
    ...(payload === undefined ? {} : { payload }),
  });
}

function instancePayload(id, timestamp) {
  return {
    id,
    name: id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "img_relay_matrix" },
    image: {
      id: "img_relay_matrix", origin: "custom", name: "Relay matrix image", repository: "example/relay", tag: "latest",
      requestedReference: "example/relay:latest", pullPolicy: "if-not-present",
      capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    source: { type: "local-folder", path: "/tmp/relay-matrix" },
    sourceSnapshot: {},
    modelSelection: {},
  };
}

// Compatibility for v0.0.34: the released control-plane creates node models
// without `upstreamName` and without a `modelRelay` producer capability.
function legacyModelInput(overrides = {}) {
  return {
    name: "Legacy Codex",
    endpoint: "https://legacy.example.test/v1",
    key: "legacy-secret",
    model: "gpt-v028",
    modelNames: [{ name: "gpt-v028", order: 0 }],
    protocols: ["openai-responses"],
    app: "codex",
    enabled: true,
    ...overrides,
  };
}

function assignPayload(modelEntityId) {
  return {
    modelSelection: { modelEntityIds: [modelEntityId], codexModelHash: modelEntityId },
    modelEntityIds: [modelEntityId],
    codexModelHash: modelEntityId,
  };
}

test("v0.0.34 control-plane wire stays same-name and relay defaults off on a current node-agent", async (t) => {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_matrix_legacy_cp" });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const timestamp = new Date().toISOString();
  const createdInstance = await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_matrix_legacy_cp", timestamp));
  assert.equal(createdInstance.statusCode, 201, createdInstance.body);
  const instance = app.nodeAgentState.requireInstance("inst_matrix_legacy_cp");
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    capabilities: { features: { modelRelay: { protocols: ["openai-responses"], streaming: true } } },
  });

  const settings = await request(app, "GET", "/api/node-agent/settings/model-relay");
  assert.equal(settings.statusCode, 200);
  assert.deepEqual(settings.json().data, { enabled: false, source: "default" });

  const created = await request(app, "POST", "/api/node-agent/models", legacyModelInput());
  assert.equal(created.statusCode, 201, created.body);
  const model = created.json().data;
  // Write paths keep the released renumbering onto the 100-step grid.
  assert.deepEqual(model.modelNames, [{ name: "gpt-v028", order: 100 }]);
  assert.equal(Object.prototype.hasOwnProperty.call(model.modelNames[0], "upstreamName"), false);

  // The switch is the only enable authority: without it the derived route is
  // refused before any upstream contact.
  await request(app, "PATCH", "/api/node-agent/settings/model-relay", { enabled: true });
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_matrix_legacy_cp/model-assignment", assignPayload(model.id))).statusCode, 200);
  const resolver = new NodeModelRelayResolver(app.nodeAgentState.modelRegistry);
  const routeId = deriveModelRelayRouteId("inst_matrix_legacy_cp", model.id, "openai-responses");
  const resolved = resolver.resolveRoute("inst_matrix_legacy_cp", routeId);
  // Reading a v0.0.34 record normalizes the internal mapping to upstreamName = name.
  assert.equal(resolved.model.modelNames[0].upstreamName, "gpt-v028");
  assert.equal(resolver.resolveUpstreamModelName(resolved.model, "gpt-v028"), "gpt-v028");
});

test("a v0.0.34 controlled instance keeps the direct catalog and rejects mapped assignments", async (t) => {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_matrix_legacy_instance" });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const timestamp = new Date().toISOString();
  const createdInstance = await request(app, "POST", "/api/node-agent/instances", instancePayload("inst_matrix_legacy_instance", timestamp));
  assert.equal(createdInstance.statusCode, 201, createdInstance.body);
  const instance = app.nodeAgentState.requireInstance("inst_matrix_legacy_instance");
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    // Compatibility for v0.0.34: released instances only declare the direct
    // private model catalog feature.
    capabilities: { features: { privateModelCatalog: true } },
  });
  assert.equal(supportsControlledInstanceModelRelay(app.nodeAgentState.requireInstance("inst_matrix_legacy_instance").capabilities), false);

  const sameName = await request(app, "POST", "/api/node-agent/models", legacyModelInput());
  assert.equal(sameName.statusCode, 201, sameName.body);
  const assigned = await request(app, "PUT", "/api/node-agent/instances/inst_matrix_legacy_instance/model-assignment", assignPayload(sameName.json().data.id));
  assert.equal(assigned.statusCode, 200, assigned.body);

  const catalog = app.nodeAgentState.modelRegistry.privateCatalog("inst_matrix_legacy_instance");
  assert.equal(catalog.protocolVersion, "2026-08-27");
  assert.equal(catalog.entities.length, 1);
  assert.equal(catalog.entities[0].endpoint, "https://legacy.example.test/v1");
  assert.equal(catalog.entities[0].key, "legacy-secret");

  const mapped = await request(app, "POST", "/api/node-agent/models", legacyModelInput({
    name: "Mapped Codex",
    key: "mapped-secret",
    model: "public-model",
    modelNames: [{ name: "public-model", upstreamName: "upstream-model", order: 100 }],
  }));
  assert.equal(mapped.statusCode, 201, mapped.body);
  const refused = await request(app, "PUT", "/api/node-agent/instances/inst_matrix_legacy_instance/model-assignment", assignPayload(mapped.json().data.id));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error.code, "NODE_MODEL_RELAY_UNSUPPORTED");

  const unchanged = app.nodeAgentState.modelRegistry.privateCatalog("inst_matrix_legacy_instance");
  assert.equal(unchanged.protocolVersion, "2026-08-27");
  assert.deepEqual(unchanged.entities.map((entity) => entity.id), [sameName.json().data.id]);
});
