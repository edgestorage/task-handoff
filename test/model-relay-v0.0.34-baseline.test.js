const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ControlledInstanceCapabilitiesSchema,
  NodeAgentExternalListenerConfigSchema,
  NodeModelAssignmentSchema,
  NodeModelConfigSchema,
  isModelConfigHashId,
  modelConfigHash,
  normalizeControlledInstanceCapabilities,
} = require("../packages/protocol/src/control-plane.ts");
const {
  normalizeNodeAgentCapabilities,
  supportsNodeStableModelIdentity,
} = require("../packages/protocol/src/node-agent-capabilities.ts");
const { parseInstancePrivateModelCatalog } = require("../packages/core/src/core/instance-private-model-catalog.ts");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/v0.0.34-model-relay-baseline.json"), "utf8"));

test("v0.0.34 baseline pins the legacy content-hash identity for every entity", () => {
  for (const [app, spec] of Object.entries(fixture.modelSpecs)) {
    const id = modelConfigHash(spec);
    assert.equal(id, fixture.entityIds[app]);
    assert.equal(isModelConfigHashId(id), true);
    assert.equal(modelConfigHash(fixture.nodeModels.find((model) => model.id === id)), id);
  }
});

test("v0.0.34 baseline model records and assignments keep the released name-item shape", () => {
  for (const model of fixture.nodeModels) {
    const parsed = NodeModelConfigSchema.parse(model);
    assert.deepEqual(parsed.modelNames, model.modelNames);
    assert.equal("upstreamName" in parsed.modelNames[0], false);
    assert.deepEqual(parsed.protocols, model.protocols);
  }
  const assignment = NodeModelAssignmentSchema.parse(fixture.assignment);
  assert.deepEqual(assignment.modelEntityIds, fixture.assignment.modelEntityIds);
  assert.equal(assignment.codexModelHash, fixture.entityIds.codex);
});

test("v0.0.34 baseline direct catalog still materializes upstream endpoint, key and names", () => {
  const catalog = parseInstancePrivateModelCatalog(fixture.privateCatalog);
  assert.equal(catalog.protocolVersion, "2026-08-27");
  for (const entity of catalog.entities) {
    assert.equal(typeof entity.endpoint, "string");
    assert.equal(typeof entity.key, "string");
    assert.equal(entity.modelNames.length, 1);
  }
});

test("v0.0.34 baseline upstream requests reuse the instance-materialized upstream credential", () => {
  // Evidence chain for the change: in v0.0.34 the instance holds the upstream
  // key and calls the provider directly, which is exactly what the relay
  // replaces. The same entity id, name, endpoint and key must stay traceable
  // through every layer above.
  const codexKey = fixture.nodeModels.find((model) => model.app === "codex").key;
  const claudeKey = fixture.nodeModels.find((model) => model.app === "claude").key;
  const opencodeKey = fixture.nodeModels.find((model) => model.app === "opencode").key;
  assert.equal(fixture.upstreamRequests.codex.authorization, `Bearer ${codexKey}`);
  assert.equal(fixture.upstreamRequests.claude["x-api-key"], claudeKey);
  assert.equal(fixture.upstreamRequests.opencode.authorization, `Bearer ${opencodeKey}`);
  assert.equal(fixture.instanceEnvironment.codex.OPENAI_API_KEY, codexKey);
  assert.equal(fixture.instanceEnvironment.claude.ANTHROPIC_API_KEY, claudeKey);
  assert.match(fixture.instanceEnvironment.opencode.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT, new RegExp(opencodeKey));
});

test("v0.0.34 baseline runtime settings carry only the TCP listener configuration", () => {
  assert.equal(fixture.runtimeSettings.version, 1);
  assert.equal("modelRelay" in fixture.runtimeSettings, false);
  const listener = NodeAgentExternalListenerConfigSchema.parse(fixture.runtimeSettings.externalListener);
  assert.equal(listener.bindScope, "loopback");
});

test("v0.0.34 baseline capability documents normalize without relay support", () => {
  const nodeCapabilities = normalizeNodeAgentCapabilities(fixture.nodeAgentCapabilities);
  assert.equal(nodeCapabilities.managedModels.multiEntityAssignment, true);
  assert.equal(nodeCapabilities.managedModels.privateModelCatalog, true);
  assert.equal(supportsNodeStableModelIdentity(fixture.nodeAgentCapabilities), false);

  const parsedInstance = ControlledInstanceCapabilitiesSchema.parse(fixture.controlledInstanceCapabilities);
  assert.deepEqual(parsedInstance.features.aiSessionProviders, []);
  const instanceCapabilities = normalizeControlledInstanceCapabilities(parsedInstance);
  assert.equal(instanceCapabilities.features.privateModelCatalog, true);
  assert.deepEqual(instanceCapabilities.features.aiSessionProviders, []);
});

test("v0.0.34 baseline documents the mixed-version expectations pinned for the relay change", () => {
  // Old readers strip additive fields: a v0.0.34 node-agent parses a newer
  // capability document without relay fields and keeps the connection.
  const parsed = normalizeNodeAgentCapabilities({
    ...fixture.nodeAgentCapabilities,
    managedModels: { ...fixture.nodeAgentCapabilities.managedModels, modelRelay: { protocols: ["openai-responses"] } },
    futureField: true,
  });
  assert.equal(parsed.managedModels.multiEntityAssignment, true);
  assert.equal(parsed.managedModels.privateModelCatalog, true);
  assert.equal(parsed.managedModels.stableModelIdentity, false);
});
