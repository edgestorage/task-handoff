const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const {
  NodeModelRelayResolver,
  deriveModelRelayRouteId,
  modelRelayRouteBaseUrl,
  modelRelayRoutePath,
  parseModelRelayRoutePathname,
} = require("../packages/control-plane/src/node-agent/models/relay-routes.ts");
const { modelContentRevision } = require("../packages/protocol/src/control-plane.ts");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-relay-"));
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
    imageSelection: { imageId: "img_relay" },
    image: {
      id: "img_relay", origin: "custom", name: "Relay image", repository: "example/relay", tag: "latest",
      requestedReference: "example/relay:latest", pullPolicy: "if-not-present",
      capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    source: { type: "local-folder", path: "/tmp/relay" },
    sourceSnapshot: {},
    modelSelection: {},
  };
}

async function createInstance(app, id) {
  const timestamp = new Date().toISOString();
  const created = await request(app, "POST", "/api/node-agent/instances", instancePayload(id, timestamp));
  assert.equal(created.statusCode, 201);
  return app.nodeAgentState.requireInstance(id);
}

function markRelayCapable(app, id, protocols = ["openai-responses"]) {
  const instance = app.nodeAgentState.requireInstance(id);
  return app.nodeAgentState.controlledInstances.put({
    ...instance,
    capabilities: { features: { modelRelay: { protocols, streaming: true } } },
  });
}

function relaySettingsPayload(app, method, payload) {
  return request(app, method, "/api/node-agent/settings/model-relay", payload);
}

function assignPayload(modelEntityId, modelApp) {
  const legacy = modelApp === "claude" ? "claudeModelHash" : modelApp === "opencode" ? "opencodeModelHash" : "codexModelHash";
  return {
    modelSelection: { modelEntityIds: [modelEntityId], [legacy]: modelEntityId },
    modelEntityIds: [modelEntityId],
    [legacy]: modelEntityId,
  };
}

test("node relay settings default to off, persist across restart, and reject invalid writes", async (t) => {
  const dataDir = tempDataDir();
  let app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_settings" });
  t.after(async () => app.close());

  const initial = await relaySettingsPayload(app, "GET");
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().data, { enabled: false, unknownModelPolicy: "passthrough", source: "default" });
  assert.equal(fs.existsSync(path.join(dataDir, "runtime-settings.json")), true);

  for (const invalid of [{ enabled: "yes" }, { enabled: true, extra: 1 }, {}]) {
    const rejected = await relaySettingsPayload(app, "PATCH", invalid);
    assert.equal(rejected.statusCode, 400, JSON.stringify(invalid));
    assert.equal(rejected.json().error.code, "VALIDATION_ERROR");
  }
  assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: false, unknownModelPolicy: "passthrough", source: "default" });

  const enabled = await relaySettingsPayload(app, "PATCH", { enabled: true });
  assert.equal(enabled.statusCode, 200);
  assert.deepEqual(enabled.json().data, { enabled: true, unknownModelPolicy: "passthrough", source: "persisted" });
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime-settings.json"), "utf8"));
  assert.deepEqual(stored.modelRelay, { enabled: true, unknownModelPolicy: "passthrough" });
  assert.equal(typeof stored.externalListener.port, "number");
  assert.equal(app.nodeAgentState.modelRegistry.modelRelayEnabled(), true);

  await app.close();
  app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_settings" });
  assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: true, unknownModelPolicy: "passthrough", source: "persisted" });
  assert.equal(app.nodeAgentState.modelRegistry.modelRelayEnabled(), true);

  const disabled = await relaySettingsPayload(app, "PATCH", { enabled: false });
  assert.deepEqual(disabled.json().data, { enabled: false, unknownModelPolicy: "passthrough", source: "persisted" });
  assert.equal(app.nodeAgentState.modelRegistry.modelRelayEnabled(), false);
});

test("node relay gate keeps mapped records writable and pins the switch only for relay consumers", async (t) => {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_gate" });
  t.after(async () => app.close());

  await createInstance(app, "inst_relay_plain");
  await createInstance(app, "inst_relay_ready");
  markRelayCapable(app, "inst_relay_ready");

  const mapped = await request(app, "POST", "/api/node-agent/models", modelInput({
    name: "Mapped Codex",
    key: "mapped-secret",
    modelNames: [{ name: "public-model", upstreamName: "upstream-model", order: 100 }],
  }));
  assert.equal(mapped.statusCode, 201);
  const mappedId = mapped.json().data.id;
  assert.equal(mapped.json().data.modelNames[0].upstreamName, "upstream-model");
  assert.equal(mapped.json().data.revision, modelContentRevision({
    ...modelInput({ name: "Mapped Codex", key: "mapped-secret" }),
    model: "public-model",
    modelNames: [{ name: "public-model", upstreamName: "upstream-model", order: 100 }],
    protocols: ["openai-responses"],
  }));

  // Neither the switch nor the instance relay capability gates a write: with
  // the relay off the assignment still stores and simply projects nothing.
  assert.equal((await relaySettingsPayload(app, "PATCH", { enabled: false })).statusCode, 200);
  const offAssignment = await request(app, "PUT", "/api/node-agent/instances/inst_relay_ready/model-assignment", assignPayload(mappedId, "codex"));
  assert.equal(offAssignment.statusCode, 200);
  assert.deepEqual(app.nodeAgentState.modelRegistry.privateCatalog("inst_relay_ready").entities, []);

  assert.equal((await relaySettingsPayload(app, "PATCH", { enabled: true })).statusCode, 200);
  assert.equal(app.nodeAgentState.modelRegistry.privateCatalog("inst_relay_ready").entities.length, 1);
  // Instance relay support is not a write-time gate: a plain instance accepts
  // the assignment and simply projects no relay routes.
  const plainGate = await request(app, "PUT", "/api/node-agent/instances/inst_relay_plain/model-assignment", assignPayload(mappedId, "codex"));
  assert.equal(plainGate.statusCode, 200);
  assert.deepEqual(app.nodeAgentState.modelRegistry.resolvedEnvironment("inst_relay_plain"), {});
  assert.deepEqual(app.nodeAgentState.modelRegistry.privateCatalog("inst_relay_plain").entities, []);

  const assigned = await request(app, "PUT", "/api/node-agent/instances/inst_relay_ready/model-assignment", assignPayload(mappedId, "codex"));
  assert.equal(assigned.statusCode, 200);

  const refused = await relaySettingsPayload(app, "PATCH", { enabled: false });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "NODE_MODEL_RELAY_IN_USE");
  // Only instances that actually consume relay routes pin the switch.
  assert.deepEqual(refused.json().error.details.instanceIds, ["inst_relay_ready"]);
  assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: true, unknownModelPolicy: "passthrough", source: "persisted" });

  // Editing an already assigned same-name entity into a mapping applies
  // directly; the plain consumer keeps projecting nothing.
  const sameName = await request(app, "POST", "/api/node-agent/models", modelInput({ name: "Same name", key: "same-secret", model: "same-model" }));
  const sameNameId = sameName.json().data.id;
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_relay_plain/model-assignment", assignPayload(sameNameId, "codex"))).statusCode, 200);
  const promoted = await request(app, "PATCH", `/api/node-agent/models/${sameNameId}`, {
    modelNames: [{ name: "same-model", upstreamName: "elsewhere", order: 100 }],
  });
  assert.equal(promoted.statusCode, 200);
  assert.deepEqual(app.nodeAgentState.modelRegistry.resolvedEnvironment("inst_relay_plain"), {});

  // Same-name assignment stays allowed on a plain instance while relay is on.
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_relay_ready/model-assignment", { modelSelection: {} })).statusCode, 200);
  const closed = await relaySettingsPayload(app, "PATCH", { enabled: false });
  assert.equal(closed.statusCode, 200);
  assert.deepEqual(closed.json().data, { enabled: false, unknownModelPolicy: "passthrough", source: "persisted" });
});

test("node relay routes are derived, fail closed, and resolve after restart without control-plane", async (t) => {
  const dataDir = tempDataDir();
  let app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_routes" });
  t.after(async () => app.close());

  const instanceId = "inst_relay_routes";
  await createInstance(app, instanceId);
  markRelayCapable(app, instanceId);

  const mapped = await request(app, "POST", "/api/node-agent/models", modelInput({
    name: "Routed Codex",
    key: "routed-secret",
    modelNames: [{ name: "public-routed", upstreamName: "upstream-routed", order: 100 }],
  }));
  const mappedId = mapped.json().data.id;
  const routeId = deriveModelRelayRouteId(instanceId, mappedId, "openai-responses");
  assert.notEqual(routeId, deriveModelRelayRouteId(instanceId, mappedId, "anthropic-messages"));
  assert.notEqual(routeId, deriveModelRelayRouteId("inst_other", mappedId, "openai-responses"));
  assert.equal(
    modelRelayRoutePath(instanceId, mappedId, "openai-responses"),
    `/api/node-agent/model-relay/instances/${instanceId}/routes/${routeId}/v1`,
  );
  assert.equal(
    modelRelayRouteBaseUrl("http://host.docker.internal:8091/", instanceId, mappedId, "openai-responses"),
    `http://host.docker.internal:8091/api/node-agent/model-relay/instances/${instanceId}/routes/${routeId}/v1`,
  );
  assert.deepEqual(
    parseModelRelayRoutePathname(`${modelRelayRoutePath(instanceId, mappedId, "openai-responses")}/responses`),
    { instanceId, routeId, operationPath: "/responses" },
  );
  assert.equal(parseModelRelayRoutePathname("/api/node-agent/models"), undefined);
  // Malformed percent-encoding is not a relay route: it must not throw out of
  // the node-agent auth hook (an unhandled URIError would surface as a 500).
  assert.equal(parseModelRelayRoutePathname("/api/node-agent/model-relay/instances/%E0%A4%A/routes/rly_bad/v1/responses"), undefined);
  // The operation path stays encoded so adapters only ever see their allowlist.
  assert.equal(
    parseModelRelayRoutePathname(`${modelRelayRoutePath(instanceId, mappedId, "openai-responses")}/%2e%2e%2fadmin`)?.operationPath,
    "/%2e%2e%2fadmin",
  );

  const resolver = new NodeModelRelayResolver(app.nodeAgentState.modelRegistry);
  assert.throws(
    () => resolver.resolveRoute(instanceId, routeId),
    (error) => error.code === "MODEL_RELAY_DISABLED" && error.statusCode === 503,
  );

  assert.equal((await relaySettingsPayload(app, "PATCH", { enabled: true })).statusCode, 200);
  assert.equal((await request(app, "PUT", `/api/node-agent/instances/${instanceId}/model-assignment`, assignPayload(mappedId, "codex"))).statusCode, 200);

  const resolved = resolver.resolveRoute(instanceId, routeId);
  assert.equal(resolved.model.id, mappedId);
  assert.equal(resolved.protocol, "openai-responses");
  assert.equal(resolver.resolveUpstreamModelName(resolved.model, "public-routed"), "upstream-routed");
  // Default policy forwards an unmatched name verbatim.
  assert.equal(resolver.resolveUpstreamModelName(resolved.model, "gpt-test"), "gpt-test");
  assert.equal((await relaySettingsPayload(app, "PATCH", { enabled: true, unknownModelPolicy: "reject" })).statusCode, 200);
  assert.throws(
    () => resolver.resolveUpstreamModelName(resolved.model, "gpt-test"),
    (error) => error.code === "MODEL_RELAY_UNKNOWN_MODEL_NAME" && error.statusCode === 400,
  );
  assert.throws(
    () => resolver.resolveRoute(instanceId, deriveModelRelayRouteId(instanceId, "mdl_unknown", "openai-responses")),
    (error) => error.code === "MODEL_RELAY_ROUTE_NOT_FOUND" && error.statusCode === 404,
  );

  await app.close();
  // Restart without any control-plane contact: SQLite and runtime settings are
  // the only inputs for switch state, assignment and route resolution.
  app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_routes" });
  const offlineResolver = new NodeModelRelayResolver(app.nodeAgentState.modelRegistry);
  assert.equal(offlineResolver.resolveRoute(instanceId, routeId).model.id, mappedId);
  // The explicit reject policy set above also survives the restart.
  assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: true, unknownModelPolicy: "reject", source: "persisted" });

  // Assignment removal invalidates the derived route immediately.
  assert.equal((await request(app, "PUT", `/api/node-agent/instances/${instanceId}/model-assignment`, { modelSelection: {} })).statusCode, 200);
  assert.throws(
    () => offlineResolver.resolveRoute(instanceId, routeId),
    (error) => error.code === "MODEL_RELAY_ROUTE_NOT_FOUND",
  );
});

test("stored runtime settings sanitize unknown and malformed relay values to default off", async (t) => {
  const dataDir = tempDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "runtime-settings.json"), `${JSON.stringify({
    version: 1,
    externalListener: { bindScope: "loopback", port: 8091 },
    modelRelay: { enabled: "yes" },
    futureDomain: { enabled: true },
  })}\n`);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let app;
  try {
    app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_sanitize" });
    assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: false, unknownModelPolicy: "passthrough", source: "default" });

    const enabled = await relaySettingsPayload(app, "PATCH", { enabled: true });
    assert.deepEqual(enabled.json().data, { enabled: true, unknownModelPolicy: "passthrough", source: "persisted" });
  } finally {
    console.warn = originalWarn;
  }
  t.after(async () => app.close());
  assert.equal(app.nodeAgentState.modelRegistry.modelRelayEnabled(), true);
  assert.ok(warnings.some((warning) => warning.includes("modelRelay.enabled")), warnings.join("\n"));
  assert.ok(warnings.some((warning) => warning.includes("futureDomain")), warnings.join("\n"));

  // The persisted file is rewritten from the sanitized model, so the unknown
  // domain disappears on the next write.
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime-settings.json"), "utf8"));
  assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: true, unknownModelPolicy: "passthrough", source: "persisted" });
  assert.deepEqual(stored.modelRelay, { enabled: true, unknownModelPolicy: "passthrough" });
  assert.equal("futureDomain" in stored, false);
});

test("stored runtime settings normalize an invalid relay policy to the passthrough default", async (t) => {
  const dataDir = tempDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "runtime-settings.json"), `${JSON.stringify({
    version: 1,
    externalListener: { bindScope: "loopback", port: 8091 },
    modelRelay: { enabled: true, unknownModelPolicy: "bogus" },
  })}\n`);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let app;
  try {
    app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_sanitize_policy" });
    // Only the policy is dropped; the switch itself stays persisted and on.
    assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: true, unknownModelPolicy: "passthrough", source: "persisted" });
  } finally {
    console.warn = originalWarn;
  }
  t.after(async () => app.close());
  assert.ok(warnings.some((warning) => warning.includes("modelRelay.unknownModelPolicy")), warnings.join("\n"));

  await relaySettingsPayload(app, "PATCH", { enabled: true, unknownModelPolicy: "reject" });
  assert.deepEqual((await relaySettingsPayload(app, "GET")).json().data, { enabled: true, unknownModelPolicy: "reject", source: "persisted" });
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime-settings.json"), "utf8"));
  assert.deepEqual(stored.modelRelay, { enabled: true, unknownModelPolicy: "reject" });
});

test("mapping edits keep entity identity, advance revision, and store the private mapping only in SQLite", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_identity" });
  t.after(async () => app.close());

  const created = await request(app, "POST", "/api/node-agent/models", modelInput({ name: "Identity Codex", key: "identity-secret", model: "gpt-identity" }));
  assert.equal(created.statusCode, 201);
  const entityId = created.json().data.id;
  const originalRevision = created.json().data.revision;
  assert.deepEqual(created.json().data.modelNames, [{ name: "gpt-identity", order: 100 }]);

  const mapped = await request(app, "PATCH", `/api/node-agent/models/${entityId}`, {
    modelNames: [{ name: "public-identity", upstreamName: "upstream-identity", order: 100 }],
  });
  assert.equal(mapped.statusCode, 200);
  assert.equal(mapped.json().data.id, entityId);
  assert.notEqual(mapped.json().data.revision, originalRevision);
  assert.deepEqual(mapped.json().data.modelNames, [{ name: "public-identity", upstreamName: "upstream-identity", order: 100 }]);

  const renamed = await request(app, "PATCH", `/api/node-agent/models/${entityId}`, { name: "Identity Codex renamed" });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().data.id, entityId);
  // Display-level entity metadata stays out of the content revision.
  assert.equal(renamed.json().data.revision, mapped.json().data.revision);

  const database = new DatabaseSync(path.join(dataDir, "node-agent.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT model_names_json FROM na_models WHERE id = ?").get(entityId);
  database.close();
  assert.deepEqual(JSON.parse(row.model_names_json), [{ name: "public-identity", upstreamName: "upstream-identity", order: 100 }]);

  const duplicateNames = await request(app, "POST", "/api/node-agent/models", modelInput({
    key: "duplicate-secret",
    modelNames: [{ name: "dup", order: 100 }, { name: "dup", order: 200 }],
  }));
  assert.equal(duplicateNames.statusCode, 400);
  assert.equal(duplicateNames.json().error.code, "VALIDATION_ERROR");

  // Different entities may expose the same external name; only within-entity
  // duplicates are ambiguous.
  const twin = await request(app, "POST", "/api/node-agent/models", modelInput({
    name: "Identity twin",
    key: "twin-secret",
    model: "gpt-twin",
    modelNames: [{ name: "public-identity", upstreamName: "upstream-twin", order: 100 }],
  }));
  assert.equal(twin.statusCode, 201);
  assert.notEqual(twin.json().data.id, entityId);
});

test("relay switch changes converge assigned instances without restarting them", async (t) => {
  const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
  const dataDir = tempDataDir();
  const calls = [];
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    nodeId: "node_relay_converge",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  t.after(async () => app.close());

  const timestamp = new Date().toISOString();
  app.nodeAgentState.controlledInstances.put(ControlledInstanceSchema.parse({
    id: "inst_relay_converge",
    name: "Relay convergence",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_relay_converge",
    runtimeId: "runtime_local_host",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    controlMode: "controlled",
    ready: true,
    capabilities: {},
    config: {},
    workspace: { status: "ready", path: "/workspace" },
    target: { strategy: "node-proxy", status: "reachable", web: "http://127.0.0.1:32123" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "local", port: 32123, labels: {} },
    registrationToken: "instance-registration-secret",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const model = await request(app, "POST", "/api/node-agent/models", modelInput({ key: "converge-secret" }));
  const modelId = model.json().data.id;
  assert.equal((await request(app, "PUT", "/api/node-agent/instances/inst_relay_converge/model-assignment", assignPayload(modelId, "codex"))).statusCode, 200);

  calls.length = 0;
  assert.equal((await relaySettingsPayload(app, "PATCH", { enabled: true })).statusCode, 200);
  assert.ok(calls.some((call) => call.url === "http://127.0.0.1:32123/api/internal/model-environment" && call.method === "PUT"), JSON.stringify(calls));

  calls.length = 0;
  assert.equal((await relaySettingsPayload(app, "PATCH", { enabled: false })).statusCode, 200);
  assert.ok(calls.some((call) => call.url === "http://127.0.0.1:32123/api/internal/model-environment" && call.method === "PUT"), JSON.stringify(calls));
});

test("v0.0.34 name rows stay readable without a migration rewrite", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dataDir = tempDataDir();
  let app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_legacy_rows" });
  t.after(async () => app.close());
  const created = await request(app, "POST", "/api/node-agent/models", modelInput({ key: "legacy-row-secret", model: "gpt-legacy-row" }));
  const entityId = created.json().data.id;

  const database = new DatabaseSync(path.join(dataDir, "node-agent.sqlite"));
  // Simulate a v0.0.34 row: { name, order } with no upstreamName field.
  database.prepare("UPDATE na_models SET model_names_json = ? WHERE id = ?")
    .run(JSON.stringify([{ name: "gpt-legacy-row", order: 100 }]), entityId);
  database.close();
  await app.close();

  app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_legacy_rows" });
  const model = app.nodeAgentState.modelRegistry.getModel(entityId);
  const resolver = new NodeModelRelayResolver(app.nodeAgentState.modelRegistry);
  // Missing upstreamName normalizes to the external name without contacting or
  // rewriting the stored record.
  assert.equal(resolver.resolveUpstreamModelName(model, "gpt-legacy-row"), "gpt-legacy-row");
  assert.deepEqual(
    (await request(app, "GET", "/api/node-agent/models")).json().data.find((entry) => entry.id === entityId).modelNames,
    [{ name: "gpt-legacy-row", order: 100 }],
  );

  const verify = new DatabaseSync(path.join(dataDir, "node-agent.sqlite"), { readOnly: true });
  const row = verify.prepare("SELECT model_names_json FROM na_models WHERE id = ?").get(entityId);
  verify.close();
  assert.deepEqual(JSON.parse(row.model_names_json), [{ name: "gpt-legacy-row", order: 100 }]);
});
