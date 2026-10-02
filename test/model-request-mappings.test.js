const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { ControlledInstanceSchema, modelConfigHash } = require("../packages/protocol/src/control-plane.ts");
const { NodeModelRelayResolver } = require("../packages/control-plane/src/node-agent/models/relay-routes.ts");

const RELAY_INSTANCE_ID = "inst_request_mappings";
const DIRECT_INSTANCE_ID = "inst_request_mappings_direct";
const INSTANCE_TOKEN = "request-mappings-token";
const CODEX_KEY = "request-mappings-upstream-key";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function mappedInstance(instanceId, capabilities) {
  const timestamp = new Date().toISOString();
  return ControlledInstanceSchema.parse({
    id: instanceId, name: instanceId, nodeId: "node_request_mappings", runtimeId: "runtime_local_host",
    status: "running", health: "ok", connectionStatus: "online", agentStatus: "online",
    targetStatus: "reachable", uiAccessStatus: "reachable", controlMode: "controlled", ready: true,
    capabilities,
    config: {}, source: { type: "local-folder", path: "/workspace" }, sourceSnapshot: {}, modelSelection: {},
    workspace: { status: "ready", path: "/workspace" }, target: { strategy: "node-proxy", status: "reachable" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "local", port: 32124, labels: {} },
    registrationToken: INSTANCE_TOKEN, createdAt: timestamp, updatedAt: timestamp,
  });
}

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.alloc(0) };
    requests.push(record);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      record.body = Buffer.concat(chunks);
      handler(record, response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function agentRequest(app, method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: "Bearer agent-secret" },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function startHarness(t, upstream) {
  const dataDir = tempDir("task-handoff-request-mappings-");
  const port = await freePort();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_request_mappings", port });
  t.after(async () => { if (!app.closed) await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  app.nodeAgentState.controlledInstances.put(mappedInstance(RELAY_INSTANCE_ID, {
    features: {
      privateModelCatalog: true,
      modelRelay: { protocols: ["openai-responses"], streaming: false },
    },
  }));
  app.nodeAgentState.controlledInstances.put(mappedInstance(DIRECT_INSTANCE_ID, {
    features: { privateModelCatalog: true },
  }));

  const created = await agentRequest(app, "POST", "/api/node-agent/models", {
    name: "Codex relay",
    endpoint: `${upstream.origin}/v1`,
    key: CODEX_KEY,
    model: "public-codex",
    app: "codex",
    protocols: ["openai-responses"],
    modelNames: [{ name: "public-codex", order: 100 }],
    mappings: [
      { name: " gpt-5.6-luna ", upstreamName: " upstream-codex ", order: 300 },
      { name: "codex-auto-review", upstreamName: "upstream-codex", order: 100 },
    ],
    enabled: true,
    order: 100,
    labels: {},
  });
  assert.equal(created.statusCode, 201, created.body);
  const model = created.json().data;
  const listener = await app.listen({ host: "127.0.0.1", port });
  return { app, dataDir, model, listener };
}

test("request mappings rewrite relay requests without changing catalogs, assignments or exposed names", async (t) => {
  let upstreamRequest;
  const upstream = await startUpstream((record, response) => {
    upstreamRequest = record;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_1", model: "upstream-codex", output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }] }));
  });
  t.after(() => upstream.close());
  const { app, model, listener } = await startHarness(t, upstream);

  // The stored record keeps both lists separate and normalizes the write.
  assert.deepEqual(model.modelNames, [{ name: "public-codex", order: 100 }]);
  assert.deepEqual(model.mappings, [
    { name: "codex-auto-review", upstreamName: "upstream-codex", order: 100 },
    { name: "gpt-5.6-luna", upstreamName: "upstream-codex", order: 200 },
  ]);
  const stored = app.nodeAgentState.modelRegistry.getModel(model.id);
  assert.equal(app.nodeAgentState.modelRegistry.isMappedModel(stored), false);

  const enabled = await agentRequest(app, "PATCH", "/api/node-agent/settings/model-relay", { enabled: true });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const relayAssignment = await agentRequest(app, "PUT", `/api/node-agent/instances/${RELAY_INSTANCE_ID}/model-assignment`, {
    modelSelection: { modelEntityIds: [model.id] },
    modelEntityIds: [model.id],
  });
  assert.equal(relayAssignment.statusCode, 200, relayAssignment.body);

  // Zero impact: the same entity stays assignable to an instance that never
  // consumes the relay, and the direct catalog carries endpoint and key.
  const directAssignment = await agentRequest(app, "PUT", `/api/node-agent/instances/${DIRECT_INSTANCE_ID}/model-assignment`, {
    modelSelection: { modelEntityIds: [model.id] },
    modelEntityIds: [model.id],
  });
  assert.equal(directAssignment.statusCode, 200, directAssignment.body);
  const directCatalog = app.nodeAgentState.modelRegistry.privateCatalog(DIRECT_INSTANCE_ID);
  const directEntity = directCatalog.entities.find((entity) => entity.id === model.id);
  assert.equal(directEntity.endpoint, `${upstream.origin}/v1`);
  assert.equal(directEntity.key, CODEX_KEY);
  assert.deepEqual(directEntity.modelNames, [{ name: "public-codex", order: 100 }]);

  // The relay catalog exposes only the declared model names: mapping request
  // names stay hidden and no upstream secret is reachable from the instance.
  const catalog = app.nodeAgentState.modelRegistry.privateCatalog(RELAY_INSTANCE_ID);
  const entity = catalog.entities.find((candidate) => candidate.id === model.id);
  assert.deepEqual(entity.modelNames, [{ name: "public-codex", order: 100 }]);
  assert.equal(entity.endpoint, undefined);
  assert.equal(entity.key, undefined);
  const routeBaseUrl = entity.routes[0].baseUrl;
  assert.ok(routeBaseUrl.startsWith(listener));
  const privateConfig = fs.readFileSync(app.nodeAgentState.instancePrivateConfigs.filePath(RELAY_INSTANCE_ID), "utf8");
  for (const secret of [CODEX_KEY, upstream.origin, "upstream-codex", "gpt-5.6-luna", "codex-auto-review"]) {
    assert.equal(privateConfig.includes(secret), false, `${secret} must not reach the relay catalog`);
  }
  assert.equal(privateConfig.includes("public-codex"), true);

  // A mapped request name reaches the upstream target and is rewritten back.
  const mappedRequest = await fetch(`${routeBaseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
  });
  assert.equal(mappedRequest.status, 200);
  assert.equal((await mappedRequest.json()).model, "gpt-5.6-luna");
  assert.equal(upstreamRequest.url, "/v1/responses");
  assert.equal(upstreamRequest.headers.authorization, `Bearer ${CODEX_KEY}`);
  assert.equal(upstreamRequest.body.toString("utf8"), JSON.stringify({ model: "upstream-codex", input: "hi" }));

  // Declared names still resolve through modelNames, and unknown names stay
  // fail closed.
  const declaredRequest = await fetch(`${routeBaseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-codex", input: "hi" }),
  });
  assert.equal(declaredRequest.status, 200);
  assert.equal(upstreamRequest.body.toString("utf8"), JSON.stringify({ model: "public-codex", input: "hi" }));

  const unknownRequest = await fetch(`${routeBaseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-terra", input: "hi" }),
  });
  assert.equal(unknownRequest.status, 400);
  assert.equal((await unknownRequest.json()).error.code, "MODEL_RELAY_UNKNOWN_MODEL_NAME");
});

test("declared model names win over request mappings and legacy hash ids reject mappings", async (t) => {
  const upstream = await startUpstream((_record, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { app, model } = await startHarness(t, upstream);
  const resolver = new NodeModelRelayResolver(app.nodeAgentState.modelRegistry);
  const stored = app.nodeAgentState.modelRegistry.getModel(model.id);
  assert.equal(resolver.resolveUpstreamModelName(stored, "codex-auto-review"), "upstream-codex");
  assert.equal(resolver.resolveUpstreamModelName(stored, "public-codex"), "public-codex");

  const shadowed = await agentRequest(app, "POST", "/api/node-agent/models", {
    name: "Shadowed",
    endpoint: `${upstream.origin}/v1`,
    key: "shadowed-key",
    model: "shadowed",
    app: "codex",
    protocols: ["openai-responses"],
    modelNames: [{ name: "same-name", upstreamName: "via-names", order: 100 }],
    mappings: [{ name: "same-name", upstreamName: "via-mapping", order: 100 }],
    enabled: true,
    order: 200,
    labels: {},
  });
  assert.equal(shadowed.statusCode, 201, shadowed.body);
  const shadowedModel = app.nodeAgentState.modelRegistry.getModel(shadowed.json().data.id);
  assert.equal(resolver.resolveUpstreamModelName(shadowedModel, "same-name"), "via-names");

  // Compatibility for v0.0.34: legacy hash identities cannot be edited in
  // place, so they must never carry request mappings.
  const legacyPayload = {
    id: "0".repeat(64),
    name: "Legacy",
    endpoint: `${upstream.origin}/v1`,
    key: "legacy-key",
    model: "legacy-model",
    app: "codex",
    protocols: ["openai-responses"],
    modelNames: [{ name: "legacy-model", order: 100 }],
    mappings: [{ name: "legacy-hidden", upstreamName: "legacy-upstream", order: 100 }],
    enabled: true,
    order: 300,
    labels: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  legacyPayload.id = modelConfigHash(legacyPayload);
  const legacy = await agentRequest(app, "PUT", `/api/node-agent/models/${legacyPayload.id}/deploy`, legacyPayload);
  assert.equal(legacy.statusCode, 400, legacy.body);
  assert.equal(legacy.json().error.code, "NODE_MODEL_REQUEST_MAPPING_REQUIRES_STABLE_IDENTITY");

  // The update route carries the same invariant: an explicit mapping edit on a
  // stored legacy hash record fails closed instead of writing a mapping under
  // an identity deploy() refuses to accept.
  delete legacyPayload.mappings;
  legacyPayload.id = modelConfigHash(legacyPayload);
  const legacyStored = await agentRequest(app, "PUT", `/api/node-agent/models/${legacyPayload.id}/deploy`, legacyPayload);
  assert.equal(legacyStored.statusCode, 200, legacyStored.body);
  const legacyUpdate = await agentRequest(app, "PATCH", `/api/node-agent/models/${legacyPayload.id}`, {
    mappings: [{ name: "legacy-hidden", upstreamName: "legacy-upstream", order: 100 }],
  });
  assert.equal(legacyUpdate.statusCode, 400, legacyUpdate.body);
  assert.equal(legacyUpdate.json().error.code, "NODE_MODEL_REQUEST_MAPPING_REQUIRES_STABLE_IDENTITY");
  // Untouched patches to the stored legacy record keep working.
  const legacyRename = await agentRequest(app, "PATCH", `/api/node-agent/models/${legacyPayload.id}`, { name: "Legacy renamed" });
  assert.equal(legacyRename.statusCode, 200, legacyRename.body);
});
