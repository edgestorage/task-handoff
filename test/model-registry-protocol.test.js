const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceHeartbeatSchema,
  DeployNodeModelSchema,
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  NodeModelAssignmentSchema,
  NodeModelPublicRecordSchema,
  ProtocolVersionSchema,
  UpdateNodeModelAssignmentSchema,
  createModelEntityId,
  isModelContentRevision,
  isModelEntityId,
  modelContentRevision,
} = require("../packages/protocol/src/control-plane.ts");

const timestamp = "2026-07-15T00:00:00.000Z";
const spec = { app: "codex", endpoint: "https://example.test/v1", key: "secret", model: "gpt-test" };
const id = createModelEntityId();
const revision = modelContentRevision(spec);

test("control plane emits and accepts only date-formatted protocol versions", () => {
  assert.match(CONTROL_PLANE_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ProtocolVersionSchema.safeParse(CONTROL_PLANE_PROTOCOL_VERSION).success, true);
  assert.equal(ProtocolVersionSchema.safeParse("2026-07-15-model-hash-registry").success, false);
});

test("v0.0.21 instance reports keep their released app inventory requirement", () => {
  assert.equal(ControlledInstanceHeartbeatSchema.safeParse({ protocolVersion: "2026-08-01" }).success, false);
  assert.equal(ControlledInstanceHeartbeatSchema.safeParse({
    protocolVersion: "2026-08-01",
    appInventory: { items: [], issues: [], observedAt: timestamp },
  }).success, true);
});

test("model entity ids stay stable while content revisions advance", () => {
  assert.equal(isModelEntityId(id), true);
  assert.equal(isModelEntityId(`mdl_${"0".repeat(64)}`), false);
  assert.equal(isModelEntityId(revision), false);
  assert.equal(isModelContentRevision(revision), true);
  assert.equal(isModelContentRevision(id), false);
  assert.equal(modelContentRevision(spec), revision);
  assert.equal(modelContentRevision({ ...spec, key: "rotated" }) === revision, false);
  assert.equal(ModelConfigSchema.parse({ id, name: "Codex", ...spec, labels: {}, createdAt: timestamp, updatedAt: timestamp }).id, id);
});

test("node model public records are strict and never accept a key", () => {
  const record = {
    id, name: "Codex", endpoint: spec.endpoint, model: spec.model, app: spec.app,
    enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    keyPreview: "set", keySet: true, referenceCount: 1, revision,
  };
  assert.equal(NodeModelPublicRecordSchema.safeParse(record).success, true);
  assert.equal(NodeModelPublicRecordSchema.safeParse({ ...record, key: "leaked" }).success, false);
  assert.equal(NodeModelPublicRecordSchema.safeParse({ ...record, unknown: true }).success, false);
});

test("node copy payload carries the stable entity identity", () => {
  const deployed = DeployNodeModelSchema.parse({
    id, name: "Codex", ...spec, enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
  });
  assert.equal(deployed.id, id);
  assert.equal(isModelEntityId(deployed.id), true);
});

test("model assignments contain only entity ids and no credentials", () => {
  const assignment = NodeModelAssignmentSchema.parse({ instanceId: "inst_1", modelEntityIds: [id], updatedAt: timestamp });
  assert.deepEqual(assignment.modelEntityIds, [id]);
  // Compatibility for v0.0.23: the per-agent hash fields still normalize into
  // the ordered entity collection when read from legacy nodes.
  assert.deepEqual(
    NodeModelAssignmentSchema.parse({ instanceId: "inst_1", codexModelHash: id, updatedAt: timestamp }).modelEntityIds,
    [id],
  );
  assert.equal(NodeModelAssignmentSchema.safeParse({ ...assignment, key: "leaked" }).success, false);
  assert.equal(UpdateNodeModelAssignmentSchema.safeParse({
    modelSelection: { codexModelHash: id }, codexModelHash: id, env: { OPENAI_API_KEY: "leaked" },
  }).success, false);
  assert.deepEqual(UpdateNodeModelAssignmentSchema.parse({
    modelSelection: { codexModelHash: null },
  }).modelSelection, { codexModelHash: null });
});

test("federated registry groups one entity by location without exposing keys", () => {
  const registry = FederatedModelRegistrySchema.parse({
    models: [{
      id,
      model: {
        id, name: "Codex", endpoint: spec.endpoint, model: spec.model, app: spec.app,
        enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
        keyPreview: "set", keySet: true, revision,
      },
      locations: [
        { type: "control-plane", name: "Codex", enabled: true, order: 100, revision },
        { type: "node", nodeId: "node_a", name: "Codex", enabled: true, order: 100, referenceCount: 1, revision },
      ],
      referenceCount: 1,
    }],
    nodeDiagnostics: [], updatedAt: timestamp,
  });
  assert.equal(registry.models[0].locations.length, 2);
  assert.equal("key" in registry.models[0].model, false);
});
