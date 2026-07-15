const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTROL_PLANE_PROTOCOL_VERSION,
  DeployNodeModelSchema,
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  NodeModelAssignmentSchema,
  NodeModelPublicRecordSchema,
  ProtocolVersionSchema,
  UpdateNodeModelAssignmentSchema,
  modelConfigHash,
} = require("../packages/protocol/src/control-plane.ts");

const timestamp = "2026-07-15T00:00:00.000Z";
const spec = { app: "codex", endpoint: "https://example.test/v1", key: "secret", model: "gpt-test" };
const id = modelConfigHash(spec);

test("control plane emits a date-only protocol version while parsing historical identifiers", () => {
  assert.equal(CONTROL_PLANE_PROTOCOL_VERSION, "2026-07-15");
  assert.equal(ProtocolVersionSchema.safeParse(CONTROL_PLANE_PROTOCOL_VERSION).success, true);
  assert.equal(ProtocolVersionSchema.safeParse("2026-07-15-model-hash-registry").success, true);
});

test("model identity is a stable canonical content hash", () => {
  assert.equal(modelConfigHash(spec), id);
  assert.equal(modelConfigHash({ ...spec, key: "rotated" }) === id, false);
  assert.match(id, /^mdl_[a-f0-9]{64}$/);
  assert.equal(ModelConfigSchema.parse({ id, name: "Codex", ...spec, labels: {}, createdAt: timestamp, updatedAt: timestamp }).id, id);
});

test("node model public records are strict and never accept a key", () => {
  const record = {
    id, name: "Codex", endpoint: spec.endpoint, model: spec.model, app: spec.app,
    enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    keyPreview: "set", keySet: true, referenceCount: 1,
  };
  assert.equal(NodeModelPublicRecordSchema.safeParse(record).success, true);
  assert.equal(NodeModelPublicRecordSchema.safeParse({ ...record, key: "leaked" }).success, false);
  assert.equal(NodeModelPublicRecordSchema.safeParse({ ...record, unknown: true }).success, false);
});

test("node copy payload carries immutable hash-addressed content", () => {
  const deployed = DeployNodeModelSchema.parse({
    id, name: "Codex", ...spec, enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
  });
  assert.equal(modelConfigHash(deployed), deployed.id);
});

test("model assignments contain only hashes and no credentials", () => {
  const assignment = NodeModelAssignmentSchema.parse({ instanceId: "inst_1", codexModelHash: id, updatedAt: timestamp });
  assert.equal(assignment.codexModelHash, id);
  assert.equal(NodeModelAssignmentSchema.safeParse({ ...assignment, key: "leaked" }).success, false);
  assert.equal(UpdateNodeModelAssignmentSchema.safeParse({
    modelSelection: { codexModelHash: id }, codexModelHash: id, env: { OPENAI_API_KEY: "leaked" },
  }).success, false);
});

test("federated registry groups equal hashes by location without exposing keys", () => {
  const registry = FederatedModelRegistrySchema.parse({
    models: [{
      id,
      model: {
        id, name: "Codex", endpoint: spec.endpoint, model: spec.model, app: spec.app,
        enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
        keyPreview: "set", keySet: true,
      },
      locations: [
        { type: "control-plane", name: "Codex", enabled: true, order: 100 },
        { type: "node", nodeId: "node_a", name: "Codex", enabled: true, order: 100, referenceCount: 1 },
      ],
      referenceCount: 1,
    }],
    nodeDiagnostics: [], updatedAt: timestamp,
  });
  assert.equal(registry.models[0].locations.length, 2);
  assert.equal("key" in registry.models[0].model, false);
});
