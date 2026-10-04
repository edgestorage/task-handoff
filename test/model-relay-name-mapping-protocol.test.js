const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ControlledInstanceCapabilitiesSchema,
  CONTROL_PLANE_PROTOCOL_VERSION,
  CreateNodeModelSchema,
  ControlledInstanceHeartbeatSchema,
  DeployNodeModelSchema,
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  MODEL_REQUEST_MAPPING_PRESETS,
  ModelRequestMappingListSchema,
  NodeAgentModelRelaySchema,
  UpdateNodeAgentModelRelaySchema,
  UpdateNodeModelSchema,
  createModelEntityId,
  isModelEntityId,
  isModelContentRevision,
  migratedModelEntityId,
  modelContentRevision,
  normalizeControlledInstanceCapabilities,
  normalizeModelNameEntries,
  normalizeModelRequestMappings,
  normalizeNodeAgentModelRelaySettings,
  projectModelNameEntries,
  sanitizeModelNameEntries,
  sanitizeModelRequestMappings,
  supportsControlledInstanceModelRelay,
  supportsControlledInstanceModelRelayProtocol,
  supportsControlledInstanceModelRelayStreaming,
} = require("../packages/protocol/src/control-plane.ts");
const {
  normalizeNodeAgentCapabilities,
  supportsNodeModelRelay,
  supportsNodeModelRelayProtocol,
  supportsNodeModelRelayStreaming,
} = require("../packages/protocol/src/node-agent-capabilities.ts");
const { AiSessionCreateInputSchema, AiSessionHistoryItemSchema, AiSessionModelSelectionSchema, AiSessionRealtimeInputSchema } = require("../packages/protocol/src/ai-sessions.ts");
const { ControlPlaneInstanceDirectoryEntrySchema } = require("../packages/protocol/src/control-plane-directory.ts");
const { CreateModelInputSchema } = require("../packages/control-plane/src/control-plane/application/inputs.ts");
const { normalizeModel, publicModel } = require("../packages/control-plane/src/control-plane/public-records.ts");
const { deriveAiSessionModelGroups } = require("../packages/control-plane-client/src/ai-session-model-catalog.ts");
const { resolveControlledPrivateModelSelection } = require("../packages/controlled-instance/src/web/private-model-catalog.ts");
const {
  INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION,
  INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
  directInstancePrivateModelCatalog,
  parseInstancePrivateModelCatalog,
  relayInstancePrivateModelCatalog,
  summarizeInstancePrivateModelCatalog,
} = require("../packages/core/src/core/instance-private-model-catalog.ts");

const timestamp = "2026-10-02T00:00:00.000Z";
const baselineFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/v0.0.34-model-relay-baseline.json"), "utf8"));

function mappedModelInput(overrides = {}) {
  return {
    name: "Coding fast",
    endpoint: "https://provider.example/v1",
    key: "provider-secret",
    model: "coding-fast",
    app: "codex",
    modelNames: [{ name: "coding-fast", upstreamName: "provider-model-2026-09", order: 100 }],
    ...overrides,
  };
}

function mappingInput(overrides = {}) {
  return { name: "gpt-5.6-luna", upstreamName: "provider-model-2026-09", order: 100, ...overrides };
}

function modelRecord(overrides = {}) {
  return ModelConfigSchema.parse({
    ...mappedModelInput(),
    protocols: ["openai-responses"],
    id: "mdl_abcdefghjkmnp",
    enabled: true,
    order: 100,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

test("management input accepts strict name mappings and rejects ambiguity", () => {
  const parsed = CreateModelInputSchema.parse(mappedModelInput());
  assert.deepEqual(parsed.modelNames, [{ name: "coding-fast", upstreamName: "provider-model-2026-09", order: 100 }]);

  // Unknown per-entry fields stay rejected on network writes.
  assert.throws(() => CreateModelInputSchema.parse(mappedModelInput({
    modelNames: [{ name: "coding-fast", alias: "provider-model", order: 100 }],
  })), /alias|Unrecognized key/i);
  // Duplicate external names within one entity are ambiguous and rejected.
  assert.throws(() => CreateModelInputSchema.parse(mappedModelInput({
    modelNames: [
      { name: "coding-fast", upstreamName: "provider-a", order: 100 },
      { name: "coding-fast", upstreamName: "provider-b", order: 200 },
    ],
  })), /Duplicate model name/i);
  assert.equal(CreateNodeModelSchema.safeParse(mappedModelInput()).success, true);
  assert.equal(CreateNodeModelSchema.safeParse(mappedModelInput({
    modelNames: [{ name: "coding-fast", order: 100 }, { name: "coding-fast", upstreamName: "provider-b", order: 200 }],
  })).success, false);
  assert.equal(DeployNodeModelSchema.safeParse({
    ...mappedModelInput(),
    id: createModelEntityId(Date.parse(timestamp)),
    protocols: ["openai-responses"],
    enabled: true,
    order: 100,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }).success, true);
});

test("management output exposes upstreamName without ever exposing the key", () => {
  const record = modelRecord();
  const projected = publicModel(record);
  assert.deepEqual(projected.modelNames, [{ name: "coding-fast", upstreamName: "provider-model-2026-09", order: 100 }]);
  assert.equal("key" in projected, false);
  assert.equal(projected.keySet, true);
  assert.equal(projected.keyPreview, "prov...cret");
  assert.equal(isModelContentRevision(projected.revision), true);

  // Same-name entries stay compact so v0.0.34 readers keep parsing records.
  const sameName = publicModel(modelRecord({ modelNames: [{ name: "coding-fast", order: 100 }] }));
  assert.deepEqual(sameName.modelNames, [{ name: "coding-fast", order: 100 }]);
});

test("v0.0.34 name entries sanitize to upstreamName = name and warn on unknown fields", () => {
  const warnings = [];
  const sanitized = sanitizeModelNameEntries([
    { name: " coding-fast ", order: 100, alias: "provider-model" },
  ], (warning) => warnings.push(warning));
  assert.deepEqual(sanitized, [{ name: "coding-fast", order: 100 }]);
  assert.deepEqual(warnings, [{ field: "modelNames[0].alias" }]);

  const normalized = normalizeModelNameEntries(ModelConfigSchema.shape.modelNames.parse(sanitized), "coding-fast");
  assert.deepEqual(normalized, [{ name: "coding-fast", upstreamName: "coding-fast", order: 100 }]);

  const record = modelRecord({ modelNames: [{ name: "coding-fast", order: 100 }] });
  assert.deepEqual(record.modelNames, [{ name: "coding-fast", order: 100 }]);
  assert.deepEqual(normalizeModel(record).modelNames, [{ name: "coding-fast", upstreamName: "coding-fast", order: 100 }]);

  // Wrongly typed required fields fail with a structured parse error instead
  // of being silently repaired.
  assert.throws(() => ModelConfigSchema.parse({
    ...record, modelNames: [{ name: 5, order: 100 }],
  }));
  // Historical duplicate entries are reduced to the first one with a warning
  // instead of making the whole stored record unreadable.
  const duplicateWarnings = [];
  assert.deepEqual(
    sanitizeModelNameEntries([{ name: "a", order: 100 }, { name: "a", order: 200 }], (warning) => duplicateWarnings.push(warning)),
    [{ name: "a", order: 100 }],
  );
  assert.deepEqual(duplicateWarnings, [{ field: "modelNames[1].name" }]);
});

test("mapping, endpoint and key edits advance the content revision while the entity id stays stable", () => {
  const base = modelRecord();
  const baseRevision = modelContentRevision(base);

  const mappingChange = modelRecord({ modelNames: [{ name: "coding-fast", upstreamName: "provider-model-2026-10", order: 100 }] });
  assert.notEqual(modelContentRevision(mappingChange), baseRevision);
  // The entity id identifies the record, not its content.
  assert.equal(mappingChange.id, base.id);
  assert.equal(isModelEntityId(base.id), true);
  // Legacy ids stay derivable exactly once; the derivation is deterministic.
  assert.equal(migratedModelEntityId(`mdl_${"0".repeat(64)}`), migratedModelEntityId(`mdl_${"0".repeat(64)}`));
  assert.equal(isModelEntityId(migratedModelEntityId(`mdl_${"0".repeat(64)}`)), true);

  assert.notEqual(modelContentRevision(modelRecord({ endpoint: "https://provider-v2.example/v1" })), baseRevision);
  assert.notEqual(modelContentRevision(modelRecord({ key: "rotated-secret" })), baseRevision);
  // Display-level metadata stays out of the revision, so copy/convergence
  // semantics for a pure rename stay unchanged.
  assert.equal(modelContentRevision(modelRecord({ name: "Renamed display" })), baseRevision);
  assert.equal(isModelEntityId(baseRevision), false);
  assert.match(baseRevision, /^mdlr_[a-f0-9]{64}$/);
});

test("request mappings stay a separate strict list that never changes exposed names or the entity id", () => {
  const base = modelRecord();
  const baseRevision = modelContentRevision(base);
  const mapping = { name: "gpt-5.6-luna", upstreamName: "provider-model-2026-09", order: 100 };
  const withMapping = modelRecord({ mappings: [mapping] });

  // The record keeps both lists separate: mappings never join modelNames.
  assert.deepEqual(withMapping.mappings, [mapping]);
  assert.deepEqual(withMapping.modelNames, base.modelNames);
  assert.equal(projectModelNameEntries(withMapping.modelNames).some((entry) => entry.name === "gpt-5.6-luna"), false);

  // The content revision tracks mapped requests; an empty list keeps the exact
  // released canonical payload, and the entity id never changes.
  assert.equal(modelContentRevision(base), baseRevision);
  assert.equal(modelContentRevision(modelRecord({ mappings: [] })), baseRevision);
  assert.notEqual(modelContentRevision(withMapping), baseRevision);
  assert.equal(withMapping.id, base.id);
});

test("request mapping writes are strict while patches keep absent and empty distinguishable", () => {
  const input = { ...mappedModelInput(), mappings: [{ name: " gpt-5.6-luna ", upstreamName: " provider-model ", order: 200 }] };
  assert.deepEqual(CreateModelInputSchema.parse(input).mappings, [{ name: "gpt-5.6-luna", upstreamName: "provider-model", order: 200 }]);
  assert.deepEqual(CreateNodeModelSchema.parse(input).mappings, [{ name: "gpt-5.6-luna", upstreamName: "provider-model", order: 200 }]);
  assert.equal(DeployNodeModelSchema.safeParse({
    ...modelRecord({ mappings: [mappingInput()] }),
  }).success, true);

  // Duplicate request names, unknown entry fields and oversized lists fail closed.
  assert.throws(() => CreateModelInputSchema.parse({
    ...mappedModelInput(),
    mappings: [mappingInput(), { ...mappingInput(), upstreamName: "elsewhere" }],
  }), /Duplicate request mapping/i);
  assert.throws(() => CreateModelInputSchema.parse({
    ...mappedModelInput(),
    mappings: [{ ...mappingInput(), alias: "x" }],
  }), /alias|Unrecognized key/i);
  assert.equal(ModelRequestMappingListSchema.safeParse(
    Array.from({ length: 65 }, (_, index) => ({ name: `n${index}`, upstreamName: "upstream", order: index })),
  ).success, false);

  // Create defaults to no mappings; PATCH keeps "absent" distinct from an
  // explicit clear so an unrelated edit never drops stored mappings.
  assert.equal(CreateNodeModelSchema.parse(mappedModelInput()).mappings, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(UpdateNodeModelSchema.parse({ name: "Renamed" }), "mappings"), false);
  assert.deepEqual(UpdateNodeModelSchema.parse({ mappings: [] }).mappings, []);
});

test("request mappings sanitize like name entries and presets stay read-only metadata", () => {
  const warnings = [];
  assert.deepEqual(sanitizeModelRequestMappings([
    { name: " gpt-5.6-luna ", upstreamName: " upstream ", order: 100, alias: "dropped" },
  ], (warning) => warnings.push(warning)), [{ name: "gpt-5.6-luna", upstreamName: "upstream", order: 100 }]);
  assert.deepEqual(warnings, [{ field: "mappings[0].alias" }]);

  const duplicateWarnings = [];
  assert.deepEqual(sanitizeModelRequestMappings([
    { name: "a", upstreamName: "upstream-a", order: 100 },
    { name: "a", upstreamName: "upstream-b", order: 200 },
  ], (warning) => duplicateWarnings.push(warning)), [{ name: "a", upstreamName: "upstream-a", order: 100 }]);
  assert.deepEqual(duplicateWarnings, [{ field: "mappings[1].name" }]);
  // A row that lost its required target still fails the schema instead of
  // silently degrading to a same-name no-op.
  assert.throws(() => ModelConfigSchema.parse({ ...modelRecord(), mappings: [{ name: "a", order: 100 }] }));

  assert.deepEqual(normalizeModelRequestMappings([
    { name: " b ", upstreamName: " upstream-b ", order: 200 },
    { name: "a", upstreamName: "upstream-a", order: 100 },
  ]), [
    { name: "a", upstreamName: "upstream-a", order: 100 },
    { name: "b", upstreamName: "upstream-b", order: 200 },
  ]);
  assert.deepEqual(normalizeModelRequestMappings([{ name: "a", upstreamName: "b", order: 7 }], { renumber: false }), [
    { name: "a", upstreamName: "b", order: 7 },
  ]);

  assert.deepEqual(MODEL_REQUEST_MAPPING_PRESETS.map((preset) => preset.id), ["codex-auto-approval", "codex-background-tasks"]);
  assert.deepEqual(MODEL_REQUEST_MAPPING_PRESETS[0].names, ["codex-auto-review", "gpt-5.6-luna"]);
});

test("deployed models carry stable entity identities and allow cross-entity duplicate names", () => {
  const base = modelRecord();
  const deployed = DeployNodeModelSchema.parse({
    ...base,
    modelNames: projectModelNameEntries(base.modelNames),
  });
  assert.equal(deployed.id, base.id);
  assert.equal(isModelEntityId(deployed.id), true);

  // Two entities may expose the same external name; the entity id, not the
  // name, is the routing identity.
  const first = createModelEntityId(Date.parse(timestamp));
  const second = createModelEntityId(Date.parse(timestamp) + 1);
  const registry = FederatedModelRegistrySchema.parse({
    models: [first, second].map((id) => ({
      id,
      model: { ...publicModel(modelRecord()), id },
      locations: [{ type: "control-plane", name: "Coding fast", enabled: true, order: 100 }],
      referenceCount: 0,
    })),
    nodeDiagnostics: [],
    updatedAt: timestamp,
  });
  assert.equal(registry.models.length, 2);
  assert.deepEqual(registry.models.map((group) => group.model.modelNames[0].name), ["coding-fast", "coding-fast"]);
  assert.notEqual(registry.models[0].id, registry.models[1].id);
});

test("instance directory and AI session projections only carry external names", () => {
  // The ordinary instance directory wire model has no place for routing data.
  const directoryEntry = {
    id: "inst_directory",
    name: "Directory",
    nodeId: "node_a",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    ready: true,
    modelSelection: { modelEntityIds: ["mdl_abcdefghjkmnp"] },
    observedAt: timestamp,
    runtime: { id: "runtime_a" },
    workspace: { status: "ready" },
    protocol: { compatible: true },
    aiSessions: { updatedAt: timestamp },
    availableAgents: [],
  };
  assert.equal(ControlPlaneInstanceDirectoryEntrySchema.safeParse(directoryEntry).success, true);
  assert.equal(ControlPlaneInstanceDirectoryEntrySchema.safeParse({
    ...directoryEntry,
    modelSelection: { modelEntityIds: ["mdl_abcdefghjkmnp"], upstreamName: "provider-model-2026-09" },
  }).success, false);

  assert.equal(AiSessionModelSelectionSchema.safeParse({ modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast" }).success, true);
  assert.equal(AiSessionModelSelectionSchema.safeParse({
    modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast", upstreamName: "provider-model-2026-09",
  }).success, false);
  const createInput = {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    clientRequestId: "req_1",
    message: "hello",
  };
  assert.equal(AiSessionCreateInputSchema.safeParse({
    ...createInput, modelSelection: { modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast" },
  }).success, true);
  assert.equal(AiSessionCreateInputSchema.safeParse({
    ...createInput,
    modelSelection: { modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast", upstreamName: "provider-model-2026-09" },
  }).success, false);
  assert.equal(AiSessionHistoryItemSchema.safeParse({
    id: "session_1",
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "provider_1",
    lineage: { parent: null, root: "session_1" },
    cwd: "/workspace",
    lastActiveAt: timestamp,
    archivedAt: timestamp,
    modelSelection: { modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast", upstreamName: "provider-model-2026-09" },
  }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({
    source: "instance",
    type: "event",
    sessionId: "session_1",
    kind: "model-selection",
    modelSelection: { modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast", upstreamName: "provider-model-2026-09" },
  }).success, false);

  const groups = deriveAiSessionModelGroups({
    entities: [{
      id: "mdl_abcdefghjkmnp",
      name: "Coding fast",
      model: "coding-fast",
      enabled: true,
      order: 100,
      protocols: ["openai-responses"],
      locations: [{ type: "control-plane", enabled: true }],
      modelNames: [{ name: "coding-fast", upstreamName: "provider-model-2026-09", order: 100 }],
      // Simulated over-fetch from a management response: routing data must not
      // reach the session option projection.
      endpoint: "https://provider.example/v1",
      key: "provider-secret",
    }],
    assignment: { modelEntityIds: ["mdl_abcdefghjkmnp"] },
    agent: "codex",
    nodeId: "node_a",
    mode: "create",
    capability: { selectModelAtCreate: true, selectProviderAtCreate: true },
  });
  assert.deepEqual(groups, [{
    modelEntityId: "mdl_abcdefghjkmnp",
    providerName: "Coding fast",
    models: [{ modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast", providerName: "Coding fast" }],
  }]);
  assert.doesNotMatch(JSON.stringify(groups), /upstreamName|provider-model-2026-09|provider-secret|provider\.example/);
});

test("relay capability documents normalize to unsupported when absent", () => {
  assert.equal(supportsNodeModelRelay(baselineFixture.nodeAgentCapabilities), false);
  assert.equal(supportsNodeModelRelayProtocol(baselineFixture.nodeAgentCapabilities, "openai-responses"), false);
  const nodeCapabilities = normalizeNodeAgentCapabilities({
    managedModels: { multiEntityAssignment: true, modelRelay: { protocols: ["openai-responses"], streaming: true } },
  });
  assert.equal(nodeCapabilities.managedModels.modelRelay.streaming, true);
  assert.equal(supportsNodeModelRelay(nodeCapabilities), true);
  assert.equal(supportsNodeModelRelayProtocol(nodeCapabilities, "openai-responses"), true);
  assert.equal(supportsNodeModelRelayProtocol(nodeCapabilities, "anthropic-messages"), false);
  assert.equal(supportsNodeModelRelayStreaming(nodeCapabilities), true);

  assert.equal(supportsControlledInstanceModelRelay(baselineFixture.controlledInstanceCapabilities), false);
  assert.equal(ControlledInstanceCapabilitiesSchema.parse({}).features.modelRelay.protocols.length, 0);
  const instanceCapabilities = normalizeControlledInstanceCapabilities({
    features: { modelRelay: { protocols: ["anthropic-messages"], streaming: true } },
  });
  assert.equal(supportsControlledInstanceModelRelay(instanceCapabilities), true);
  assert.equal(supportsControlledInstanceModelRelayProtocol(instanceCapabilities, "anthropic-messages"), true);
  assert.equal(supportsControlledInstanceModelRelayStreaming(instanceCapabilities), true);
});

test("private catalog v1/v2 union keeps relay projections free of upstream secrets", () => {
  const relayCatalog = {
    protocolVersion: INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
    instanceId: "inst_relay",
    entities: [{
      id: "mdl_abcdefghjkmnp",
      protocols: ["openai-responses", "anthropic-messages"],
      modelNames: [{ name: "coding-fast", order: 100 }],
      routes: [
        { protocol: "openai-responses", baseUrl: "http://127.0.0.1:4123/api/node-agent/model-relay/instances/inst_relay/routes/route_a/v1" },
        { protocol: "anthropic-messages", baseUrl: "http://127.0.0.1:4123/api/node-agent/model-relay/instances/inst_relay/routes/route_b" },
      ],
    }],
    updatedAt: timestamp,
  };
  const parsed = parseInstancePrivateModelCatalog({
    ...relayCatalog,
    entities: [{
      ...relayCatalog.entities[0],
      endpoint: "https://provider.example/v1",
      key: "provider-secret",
      modelNames: [{ name: "coding-fast", upstreamName: "provider-model-2026-09", order: 100 }],
    }],
  });
  const relay = relayInstancePrivateModelCatalog(parsed);
  assert.equal(parsed.protocolVersion, INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION);
  assert.equal(relay.entities.length, 1);
  assert.equal("endpoint" in relay.entities[0], false);
  assert.equal("key" in relay.entities[0], false);
  assert.equal("upstreamName" in relay.entities[0].modelNames[0], false);
  assert.equal(relay.entities[0].routes[0].baseUrl.includes("/model-relay/"), true);

  const summary = summarizeInstancePrivateModelCatalog(parsed);
  assert.equal("routes" in summary.entities[0], false);
  assert.equal(JSON.stringify(summary).includes("provider-secret"), false);

  const direct = parseInstancePrivateModelCatalog(baselineFixture.privateCatalog);
  assert.equal(directInstancePrivateModelCatalog(direct)?.protocolVersion, INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION);
  assert.equal(relayInstancePrivateModelCatalog(direct), undefined);

  assert.throws(() => parseInstancePrivateModelCatalog({ ...relayCatalog, protocolVersion: "2027-01-01" }));
  assert.throws(() => parseInstancePrivateModelCatalog({
    ...relayCatalog,
    entities: [{ ...relayCatalog.entities[0], routes: [] }],
  }));
  assert.throws(() => parseInstancePrivateModelCatalog({
    ...relayCatalog,
    entities: [{
      ...relayCatalog.entities[0],
      routes: [
        { protocol: "openai-responses", baseUrl: "http://127.0.0.1:1/a" },
        { protocol: "openai-responses", baseUrl: "http://127.0.0.1:1/b" },
      ],
    }],
  }));
});

test("session selection consumes external names from both catalog projections", () => {
  const catalog = parseInstancePrivateModelCatalog({
    protocolVersion: INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
    instanceId: "inst_relay",
    entities: [{
      id: "mdl_abcdefghjkmnp",
      protocols: ["openai-responses"],
      modelNames: [{ name: "coding-fast", order: 100 }],
      routes: [{ protocol: "openai-responses", baseUrl: "http://127.0.0.1:4123/api/node-agent/model-relay/instances/inst_relay/routes/route_a/v1" }],
    }],
    updatedAt: timestamp,
  });
  const selection = resolveControlledPrivateModelSelection(catalog, "codex");
  assert.deepEqual(selection, { modelEntityId: "mdl_abcdefghjkmnp", modelName: "coding-fast" });
  assert.equal(AiSessionModelSelectionSchema.safeParse(selection).success, true);
});

test("node relay settings wire model defaults to disabled and writes strictly", () => {
  assert.deepEqual(normalizeNodeAgentModelRelaySettings(undefined), { enabled: false, source: "default" });
  assert.deepEqual(normalizeNodeAgentModelRelaySettings({ enabled: "yes" }), { enabled: false, source: "default" });
  assert.deepEqual(NodeAgentModelRelaySchema.parse({ enabled: true, source: "persisted", future: true }), { enabled: true, source: "persisted" });
  assert.equal(UpdateNodeAgentModelRelaySchema.safeParse({ enabled: true }).success, true);
  assert.equal(UpdateNodeAgentModelRelaySchema.safeParse({ enabled: true, scope: "all" }).success, false);
  assert.equal(UpdateNodeAgentModelRelaySchema.safeParse({ enabled: "true" }).success, false);
});

test("protocol version mismatch keeps relay capability gating non-blocking", () => {
  assert.match(CONTROL_PLANE_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  const heartbeat = ControlledInstanceHeartbeatSchema.parse({
    protocolVersion: "2026-09-29",
    appInventory: { items: [], issues: [], observedAt: timestamp },
    capabilities: baselineFixture.controlledInstanceCapabilities,
  });
  assert.equal(heartbeat.protocolVersion, "2026-09-29");
  assert.equal(supportsControlledInstanceModelRelay(heartbeat.capabilities), false);
  assert.equal(supportsNodeModelRelay(baselineFixture.nodeAgentCapabilities), false);
});
