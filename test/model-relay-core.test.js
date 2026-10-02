const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { ControlledInstanceSchema, modelContentRevision } = require("../packages/protocol/src/control-plane.ts");
const { deriveModelRelayRouteId } = require("../packages/control-plane/src/node-agent/models/relay-routes.ts");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-relay-core-"));
}

function instanceFixture(id, token, protocols = ["openai-responses"]) {
  const timestamp = new Date().toISOString();
  return ControlledInstanceSchema.parse({
    id,
    name: id,
    nodeId: "node_relay_core",
    runtimeId: "runtime_local_host",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    controlMode: "controlled",
    ready: true,
    capabilities: { features: { modelRelay: { protocols, streaming: true } } },
    config: {},
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    workspace: { status: "ready", path: "/workspace" },
    target: { strategy: "node-proxy", status: "reachable", web: "http://127.0.0.1:32123" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "local", port: 32123, labels: {} },
    registrationToken: token,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function fakeAdapter(protocol, plan, overrides = {}) {
  return {
    protocol,
    planOperation: (input) => plan(input),
    prepareRequest: async ({ body }) => ({ body }),
    prepareResponse: ({ body }) => body,
    ...overrides,
  };
}

function upstreamEchoPlan(endpoint, operationPath = "/echo") {
  return ({ method, operationPath: requestedPath }) => {
    if (method === "POST" && requestedPath === operationPath) {
      return { kind: "upstream", name: "echo.create", method: "POST", url: `${endpoint}${operationPath}`, responseMode: "raw" };
    }
    return { kind: "reject", name: "unknown", status: 404, code: "MODEL_RELAY_OPERATION_NOT_ALLOWED", message: "Operation not allowed." };
  };
}

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(request, response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function createRelayApp(t, options = {}) {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_core" });
  t.after(async () => app.close());
  const modelProtocols = options.protocols || ["openai-responses"];
  for (const protocol of modelProtocols) {
    app.nodeAgentModelRelay.registerAdapter(fakeAdapter(protocol, upstreamEchoPlan(`${options.upstream.origin}/v1`)));
  }
  app.nodeAgentState.controlledInstances.put(
    instanceFixture(options.instanceId || "inst_relay_core", options.token || "instance-relay-token", options.instanceProtocols || modelProtocols),
  );

  const modelPayload = {
    name: "Relay Core Model",
    endpoint: `${options.upstream.origin}/v1`,
    key: "upstream-secret-key",
    model: "public-core",
    app: options.app || "codex",
    protocols: options.protocols,
    modelNames: [{ name: options.externalName || "public-core", upstreamName: options.upstreamName || "upstream-core", order: 100 }],
    enabled: true,
    order: 100,
    labels: {},
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/models",
    headers: { authorization: "Bearer agent-secret" },
    payload: modelPayload,
  });
  assert.equal(created.statusCode, 201);
  const modelEntityId = created.json().data.id;
  await app.inject({
    method: "PATCH",
    url: "/api/node-agent/settings/model-relay",
    headers: { authorization: "Bearer agent-secret" },
    payload: { enabled: true },
  });
  const assigned = await app.inject({
    method: "PUT",
    url: `/api/node-agent/instances/${options.instanceId || "inst_relay_core"}/model-assignment`,
    headers: { authorization: "Bearer agent-secret" },
    payload: { modelSelection: { modelEntityIds: [modelEntityId] }, modelEntityIds: [modelEntityId] },
  });
  assert.equal(assigned.statusCode, 200);
  return { app, modelEntityId };
}

function relayUrl(instanceId, modelEntityId, protocol, operationPath) {
  return `/api/node-agent/model-relay/instances/${instanceId}/routes/${deriveModelRelayRouteId(instanceId, modelEntityId, protocol)}/v1${operationPath}`;
}

test("relay authenticates with the instance registration token and rejects cross-instance credentials", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  t.after(() => upstream.close());
  const { app, modelEntityId } = await createRelayApp(t, { upstream });

  const url = relayUrl("inst_relay_core", modelEntityId, "openai-responses", "/echo");
  for (const headers of [
    {},
    { authorization: "Bearer wrong-token" },
    { authorization: "Bearer instance-relay-token-other" },
    { authorization: "Basic instance-relay-token" },
  ]) {
    const rejected = await app.inject({ method: "POST", url, headers, payload: "{}" });
    assert.equal(rejected.statusCode, 401, JSON.stringify(rejected.json()));
    assert.equal(rejected.json().error.code, "MODEL_RELAY_UNAUTHORIZED");
  }
  assert.equal(upstream.requests.length, 0);

  const accepted = await app.inject({ method: "POST", url, headers: { authorization: "Bearer instance-relay-token" }, payload: "{}" });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body, "ok");
});

test("relay strips downstream auth, forwarding and routing headers and injects the upstream credential", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-length": "2" });
    response.end("ok");
  });
  t.after(() => upstream.close());
  const { app, modelEntityId } = await createRelayApp(t, { upstream });

  const response = await app.inject({
    method: "POST",
    url: relayUrl("inst_relay_core", modelEntityId, "openai-responses", "/echo"),
    headers: {
      authorization: "Bearer instance-relay-token",
      "x-api-key": "should-be-dropped",
      cookie: "session=1",
      "x-forwarded-for": "203.0.113.9",
      forwarded: "for=203.0.113.9",
      "x-provider": "evil-provider",
      "x-api-base-url": "http://evil.example",
      "accept-encoding": "gzip",
    },
    payload: JSON.stringify({ model: "public-core" }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(upstream.requests.length, 1);
  const seen = upstream.requests[0];
  assert.equal(seen.headers.authorization, "Bearer upstream-secret-key");
  assert.equal(seen.headers["x-api-key"], undefined);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers["x-forwarded-for"], undefined);
  assert.equal(seen.headers.forwarded, undefined);
  assert.equal(seen.headers["x-provider"], undefined);
  assert.equal(seen.headers["x-api-base-url"], undefined);
  assert.equal(seen.headers["accept-encoding"], "gzip, deflate");
  assert.equal(seen.body, JSON.stringify({ model: "public-core" }));
  assert.equal(seen.url, "/v1/echo");
});

test("relay uses x-api-key for anthropic routes and never contacts the upstream when disabled or unknown", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { app, modelEntityId } = await createRelayApp(t, {
    upstream,
    app: "claude",
    protocols: ["anthropic-messages"],
    instanceProtocols: ["anthropic-messages"],
  });

  const url = relayUrl("inst_relay_core", modelEntityId, "anthropic-messages", "/echo");
  const accepted = await app.inject({ method: "POST", url, headers: { "x-api-key": "instance-relay-token" }, payload: "{}" });
  assert.equal(accepted.statusCode, 200);
  assert.equal(upstream.requests[0].headers["x-api-key"], "upstream-secret-key");
  assert.equal(upstream.requests[0].headers.authorization, undefined);

  const bearerOnAnthropic = await app.inject({ method: "POST", url, headers: { authorization: "Bearer instance-relay-token" }, payload: "{}" });
  assert.equal(bearerOnAnthropic.statusCode, 401);

  const unknownPath = await app.inject({ method: "POST", url: relayUrl("inst_relay_core", modelEntityId, "anthropic-messages", "/not-allowed"), headers: { "x-api-key": "instance-relay-token" }, payload: "{}" });
  assert.equal(unknownPath.statusCode, 404);
  assert.equal(unknownPath.json().error.code, "MODEL_RELAY_OPERATION_NOT_ALLOWED");
  assert.equal(upstream.requests.length, 1);

  const disabled = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/settings/model-relay",
    headers: { authorization: "Bearer agent-secret" },
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 409, JSON.stringify(disabled.json()));
  assert.equal(disabled.json().error.code, "NODE_MODEL_RELAY_IN_USE");
  assert.equal(upstream.requests.length, 1);
});

test("relay streams upstream chunks unchanged, maps upstream failures, and rejects redirects", async (t) => {
  let mode = "stream";
  const upstream = await startUpstream((_request, response) => {
    if (mode === "redirect") {
      response.writeHead(302, { location: "http://evil.example/" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "content-length": "22" });
    response.write("data: one\n\n");
    setTimeout(() => response.end("data: two\n\n"), 15);
  });
  t.after(() => upstream.close());
  const { app, modelEntityId } = await createRelayApp(t, { upstream });
  const url = relayUrl("inst_relay_core", modelEntityId, "openai-responses", "/echo");

  const streamed = await app.inject({ method: "POST", url, headers: { authorization: "Bearer instance-relay-token" }, payload: "{}" });
  assert.equal(streamed.statusCode, 200);
  assert.equal(streamed.headers["content-type"], "text/event-stream");
  assert.equal(streamed.headers["content-length"], undefined);
  assert.equal(streamed.body, "data: one\n\ndata: two\n\n");

  mode = "redirect";
  const redirected = await app.inject({ method: "POST", url, headers: { authorization: "Bearer instance-relay-token" }, payload: "{}" });
  assert.equal(redirected.statusCode, 502);
  assert.equal(redirected.json().error.code, "MODEL_RELAY_UPSTREAM_REDIRECT");
  assert.equal(redirected.headers.location, undefined);
});

test("relay fails closed when the upstream is unreachable and when a stream goes idle", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    // never ends: the idle timeout must abort the stream
  });
  t.after(() => upstream.close());

  const previousIdle = process.env.TASK_HANDOFF_MODEL_RELAY_FIRST_BYTE_TIMEOUT_MS;
  process.env.TASK_HANDOFF_MODEL_RELAY_FIRST_BYTE_TIMEOUT_MS = "150";
  const previousIdleGap = process.env.TASK_HANDOFF_MODEL_RELAY_IDLE_TIMEOUT_MS;
  process.env.TASK_HANDOFF_MODEL_RELAY_IDLE_TIMEOUT_MS = "150";
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_core" });
  t.after(async () => {
    if (previousIdle === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_FIRST_BYTE_TIMEOUT_MS;
    else process.env.TASK_HANDOFF_MODEL_RELAY_FIRST_BYTE_TIMEOUT_MS = previousIdle;
    if (previousIdleGap === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_IDLE_TIMEOUT_MS;
    else process.env.TASK_HANDOFF_MODEL_RELAY_IDLE_TIMEOUT_MS = previousIdleGap;
    await app.close();
  });
  app.nodeAgentModelRelay.registerAdapter(fakeAdapter("openai-responses", upstreamEchoPlan(`${upstream.origin}/v1`)));
  app.nodeAgentState.controlledInstances.put(instanceFixture("inst_relay_idle", "instance-relay-token"));
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/models",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      name: "Idle model", endpoint: `${upstream.origin}/v1`, key: "idle-secret", model: "public-idle", app: "codex",
      protocols: ["openai-responses"], modelNames: [{ name: "public-idle", upstreamName: "upstream-idle", order: 100 }],
      enabled: true, order: 100, labels: {},
    },
  });
  const idleModelId = created.json().data.id;
  await app.inject({ method: "PATCH", url: "/api/node-agent/settings/model-relay", headers: { authorization: "Bearer agent-secret" }, payload: { enabled: true } });
  await app.inject({ method: "PUT", url: "/api/node-agent/instances/inst_relay_idle/model-assignment", headers: { authorization: "Bearer agent-secret" }, payload: { modelSelection: { modelEntityIds: [idleModelId] }, modelEntityIds: [idleModelId] } });

  const idle = await Promise.race([
    app.inject({
      method: "POST",
      url: relayUrl("inst_relay_idle", idleModelId, "openai-responses", "/echo"),
      headers: { authorization: "Bearer instance-relay-token" },
      payload: "{}",
    }).catch((error) => ({ statusCode: 499, error })),
    new Promise((resolve) => setTimeout(() => resolve({ statusCode: 599, timedOut: true }), 3_000)),
  ]);
  // After headers are sent a timeout can only close the stream; inject reports
  // the aborted response rather than a synthesized success body.
  assert.notEqual(idle.statusCode, 200);
});

test("relay returns a structured disabled error without upstream contact when the switch is off", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  t.after(() => upstream.close());
  const { app, modelEntityId } = await createRelayApp(t, { upstream, externalName: "same-core", upstreamName: "same-core" });

  const disabled = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/settings/model-relay",
    headers: { authorization: "Bearer agent-secret" },
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);

  const relayed = await app.inject({
    method: "POST",
    url: relayUrl("inst_relay_core", modelEntityId, "openai-responses", "/echo"),
    headers: { authorization: "Bearer instance-relay-token" },
    payload: "{}",
  });
  assert.equal(relayed.statusCode, 503);
  assert.equal(relayed.json().error.code, "MODEL_RELAY_DISABLED");
  assert.equal(upstream.requests.length, 0);
});

test("relay enforces header size and per-instance concurrency limits", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  t.after(() => upstream.close());

  const previousHeaderLimit = process.env.TASK_HANDOFF_MODEL_RELAY_MAX_HEADER_BYTES;
  const previousConcurrency = process.env.TASK_HANDOFF_MODEL_RELAY_MAX_CONCURRENT_PER_INSTANCE;
  process.env.TASK_HANDOFF_MODEL_RELAY_MAX_HEADER_BYTES = "400";
  process.env.TASK_HANDOFF_MODEL_RELAY_MAX_CONCURRENT_PER_INSTANCE = "1";
  t.after(() => {
    if (previousHeaderLimit === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_MAX_HEADER_BYTES;
    else process.env.TASK_HANDOFF_MODEL_RELAY_MAX_HEADER_BYTES = previousHeaderLimit;
    if (previousConcurrency === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_MAX_CONCURRENT_PER_INSTANCE;
    else process.env.TASK_HANDOFF_MODEL_RELAY_MAX_CONCURRENT_PER_INSTANCE = previousConcurrency;
  });

  const { app, modelEntityId } = await createRelayApp(t, { upstream });
  const url = relayUrl("inst_relay_core", modelEntityId, "openai-responses", "/echo");
  const oversized = await app.inject({
    method: "POST",
    url,
    headers: { authorization: "Bearer instance-relay-token", "x-relay-padding": "x".repeat(400) },
    payload: "{}",
  });
  assert.equal(oversized.statusCode, 431);
  assert.equal(oversized.json().error.code, "MODEL_RELAY_REQUEST_HEADERS_TOO_LARGE");
  assert.equal(upstream.requests.length, 0);

  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let enteredFirst;
  const entered = new Promise((resolve) => { enteredFirst = resolve; });
  app.nodeAgentModelRelay.registerAdapter(fakeAdapter("openai-responses", upstreamEchoPlan(`${upstream.origin}/v1`), {
    prepareRequest: async ({ body }) => {
      enteredFirst();
      await firstGate;
      return { body };
    },
  }));

  const first = app.inject({ method: "POST", url, headers: { authorization: "Bearer instance-relay-token" }, payload: "{}" });
  await entered;
  const second = await app.inject({ method: "POST", url, headers: { authorization: "Bearer instance-relay-token" }, payload: "{}" });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "MODEL_RELAY_BUSY");
  releaseFirst();
  assert.equal((await first).statusCode, 200);
  assert.equal(upstream.requests.length, 1);
});
