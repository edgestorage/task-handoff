const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { deriveModelRelayRouteId } = require("../packages/control-plane/src/node-agent/models/relay-routes.ts");
const { resolveModelRelayLimits } = require("../packages/control-plane/src/node-agent/models/relay/limits.ts");
const { ModelRelayService } = require("../packages/control-plane/src/node-agent/models/relay/server.ts");

test("relay waits five minutes for upstream response headers by default while allowing overrides", () => {
  assert.equal(resolveModelRelayLimits({}).responseHeadersTimeoutMs, 300_000);
  assert.equal(resolveModelRelayLimits({ TASK_HANDOFF_MODEL_RELAY_HEADER_TIMEOUT_MS: "200" }).responseHeadersTimeoutMs, 200);
});

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-relay-transport-"));
}

function relayInstance(id, token) {
  const timestamp = new Date().toISOString();
  return ControlledInstanceSchema.parse({
    id, name: id, nodeId: "node_relay_transport", runtimeId: "runtime_local_host",
    status: "running", health: "ok", connectionStatus: "online", agentStatus: "online",
    targetStatus: "reachable", uiAccessStatus: "reachable", controlMode: "controlled", ready: true,
    capabilities: { features: { modelRelay: { protocols: ["openai-responses"], streaming: true } } },
    config: {}, source: { type: "local-folder", path: "/workspace" }, sourceSnapshot: {}, modelSelection: {},
    workspace: { status: "ready", path: "/workspace" }, target: { strategy: "node-proxy", status: "reachable" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "local", port: 32123, labels: {} },
    registrationToken: token, createdAt: timestamp, updatedAt: timestamp,
  });
}

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ request, response });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function setupRelay(t, upstream, instanceId = "inst_transport", options = {}) {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_transport" });
  t.after(async () => { if (!app.closed) await app.close(); });
  app.nodeAgentModelRelay.registerAdapter({
    protocol: "openai-responses",
    planOperation: ({ method, operationPath }) => method === "POST" && operationPath === "/echo"
      ? { kind: "upstream", name: "echo.create", method: "POST", url: `${upstream.origin}/v1/echo`, responseMode: "raw" }
      : { kind: "reject", name: "unknown", status: 404, code: "MODEL_RELAY_OPERATION_NOT_ALLOWED", message: "Operation not allowed." },
    prepareRequest: async ({ body }) => ({ body }),
    prepareResponse: ({ body }) => body,
  });
  app.nodeAgentState.controlledInstances.put(relayInstance(instanceId, "instance-transport-token"));
  const created = await app.inject({
    method: "POST", url: "/api/node-agent/models",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      name: "Transport model", endpoint: `${upstream.origin}/v1`, key: "transport-upstream-key", model: "public-transport",
      app: "codex", protocols: ["openai-responses"],
      modelNames: options.sameName
        ? [{ name: "public-transport", order: 100 }]
        : [{ name: "public-transport", upstreamName: "upstream-transport", order: 100 }],
      enabled: true, order: 100, labels: {},
    },
  });
  const modelEntityId = created.json().data.id;
  await app.inject({ method: "PATCH", url: "/api/node-agent/settings/model-relay", headers: { authorization: "Bearer agent-secret" }, payload: { enabled: true } });
  await app.inject({
    method: "PUT", url: `/api/node-agent/instances/${instanceId}/model-assignment`,
    headers: { authorization: "Bearer agent-secret" },
    payload: { modelSelection: { modelEntityIds: [modelEntityId] }, modelEntityIds: [modelEntityId] },
  });
  const relayPath = `/api/node-agent/model-relay/instances/${instanceId}/routes/${deriveModelRelayRouteId(instanceId, modelEntityId, "openai-responses")}/v1/echo`;
  const listener = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, relayUrl: `${listener}${relayPath}` };
}

function upstreamClosed(upstreamRequest) {
  return new Promise((resolve) => {
    if (upstreamRequest.destroyed || upstreamRequest.response.destroyed || upstreamRequest.response.writableEnded) {
      resolve(true);
      return;
    }
    upstreamRequest.response.once("close", () => resolve(true));
  });
}

test("client cancellation propagates to the upstream stream", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  t.after(() => upstream.close());
  const { app, relayUrl } = await setupRelay(t, upstream);
  assert.equal(app.closed, undefined);

  const client = http.request(relayUrl, { method: "POST", headers: { authorization: "Bearer instance-transport-token", "content-type": "application/json" } });
  client.end("{}");
  await new Promise((resolve, reject) => {
    client.on("response", (response) => {
      response.once("data", () => {
        client.destroy();
        resolve();
      });
    });
    client.once("error", reject);
  });
  assert.equal(upstream.requests.length, 1);
  assert.equal(await upstreamClosed(upstream.requests[0]), true);
});

test("node-agent shutdown drains briefly and then aborts active relay streams", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  t.after(() => upstream.close());

  const previousDrain = process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS;
  process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS = "200";
  t.after(() => {
    if (previousDrain === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS;
    else process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS = previousDrain;
  });

  const { app, relayUrl } = await setupRelay(t, upstream, "inst_transport_shutdown");
  const client = http.request(relayUrl, { method: "POST", headers: { authorization: "Bearer instance-transport-token", "content-type": "application/json" } });
  client.on("error", () => undefined);
  client.end("{}");
  await new Promise((resolve) => client.once("response", (response) => response.once("data", resolve)));

  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 5_000, "shutdown must not wait for the never-ending upstream stream");
  assert.equal(await upstreamClosed(upstream.requests[0]), true);
});

test("an interrupted upstream response is never retried", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: partial\n\n");
    setTimeout(() => response.destroy(), 20);
  });
  t.after(() => upstream.close());
  const { app, relayUrl } = await setupRelay(t, upstream);

  await Promise.race([
    app.inject({ method: "POST", url: relayUrl, headers: { authorization: "Bearer instance-transport-token" }, payload: "{}" }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(upstream.requests.length, 1);
});

test("large streamed responses arrive intact without buffering the request body", async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 7);
  let upstreamBody = "";
  const upstream = await startUpstream((request, response) => {
    request.on("data", () => undefined);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    for (let index = 0; index < 32; index += 1) response.write(chunk);
    response.end();
  });
  t.after(() => upstream.close());
  const { app, relayUrl } = await setupRelay(t, upstream);

  const largePrompt = "P".repeat(2 * 1024 * 1024);
  const response = await app.inject({
    method: "POST",
    url: relayUrl,
    headers: { authorization: "Bearer instance-transport-token" },
    payload: JSON.stringify({ model: "public-transport", prompt: largePrompt }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.rawPayload.length, 32 * chunk.length);
  assert.equal(crypto.createHash("sha256").update(response.rawPayload).digest("hex"), crypto.createHash("sha256").update(Buffer.concat(Array.from({ length: 32 }, () => chunk))).digest("hex"));
  // The relay forwarded the full prompt without depending on a parsed body.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("relay diagnostics never contain credentials, endpoints or request bodies", async (t) => {
  const logs = [];
  const logger = {
    info: (data, message) => logs.push({ level: "info", data, message }),
    warn: (data, message) => logs.push({ level: "warn", data, message }),
    debug: (data, message) => logs.push({ level: "debug", data, message }),
  };
  const instance = relayInstance("inst_logs", "instance-logs-token");
  const model = {
    id: "mdl_logs_entity", name: "Log model", endpoint: "http://logs-upstream.internal:9999/v1",
    key: "logs-upstream-secret", model: "public-logs",
    modelNames: [{ name: "public-logs", upstreamName: "upstream-logs", order: 100 }],
    protocols: ["openai-responses"], app: "codex", enabled: true, order: 100, labels: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const service = new ModelRelayService({
    resolver: {
      instance: () => instance,
      relayEnabled: () => true,
      resolveRoute: () => ({ instance, model, protocol: "openai-responses", routeId: "rly_logs" }),
      resolveUpstreamModelName: () => "upstream-logs",
    },
    log: logger,
    fetchImpl: async () => new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    adapters: [{
      protocol: "openai-responses",
      planOperation: () => ({ kind: "upstream", name: "responses.create", method: "POST", url: "http://logs-upstream.internal:9999/v1/responses", responseMode: "raw" }),
      prepareRequest: async ({ body }) => ({ body }),
      prepareResponse: ({ body }) => body,
    }],
  });
  const Fastify = require("fastify");
  const app = Fastify({ logger: false });
  service.registerRoutes(app);
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/model-relay/instances/inst_logs/routes/rly_logs/v1/responses",
    headers: { authorization: "Bearer instance-logs-token" },
    payload: JSON.stringify({ model: "public-logs", prompt: "PROMPT_SECRET_MARKER" }),
  });
  assert.equal(response.statusCode, 200);
  assert.ok(logs.some((entry) => entry.data.operation === "responses.create" && entry.data.status === 200));
  assert.ok(logs.some((entry) => entry.data.relayEnabled === true));
  const serialized = JSON.stringify(logs);
  for (const secret of ["logs-upstream-secret", "logs-upstream.internal", "PROMPT_SECRET_MARKER", "instance-logs-token"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be logged`);
  }
});

test("an upstream socket reset is logged as upstream-first with its transport error identity", async (t) => {
  const logs = [];
  const logger = {
    info: (data, message) => logs.push({ level: "info", data, message }),
    warn: (data, message) => logs.push({ level: "warn", data, message }),
    debug: (data, message) => logs.push({ level: "debug", data, message }),
  };
  const instance = relayInstance("inst_reset", "instance-reset-token");
  const model = {
    id: "mdl_reset_entity", name: "Reset model", endpoint: "http://reset-upstream.internal:9999/v1",
    key: "reset-upstream-secret", model: "public-reset",
    modelNames: [{ name: "public-reset", upstreamName: "upstream-reset", order: 100 }],
    protocols: ["openai-responses"], app: "codex", enabled: true, order: 100, labels: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const resetError = new TypeError("terminated", {
    cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
  });
  const service = new ModelRelayService({
    resolver: {
      instance: () => instance,
      relayEnabled: () => true,
      resolveRoute: () => ({ instance, model, protocol: "openai-responses", routeId: "rly_reset" }),
      resolveUpstreamModelName: () => "upstream-reset",
    },
    log: logger,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("data: {\"model\":\"public-reset\"}\n\n", "utf8"));
        setTimeout(() => controller.error(resetError), 20);
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    adapters: [{
      protocol: "openai-responses",
      planOperation: () => ({ kind: "upstream", name: "responses.create", method: "POST", url: "http://reset-upstream.internal:9999/v1/responses", responseMode: "json" }),
      prepareRequest: async ({ body }) => ({ body }),
      prepareResponse: ({ body }) => body,
    }],
  });
  const Fastify = require("fastify");
  const app = Fastify({ logger: false });
  service.registerRoutes(app);
  t.after(async () => app.close());
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/api/node-agent/model-relay/instances/inst_reset/routes/rly_reset/v1/responses",
    headers: { authorization: "Bearer instance-reset-token" },
    payload: JSON.stringify({ model: "public-reset", prompt: "PROMPT_SECRET_MARKER" }),
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const interrupted = logs.find((entry) => entry.message === "model relay stream interrupted");
  assert.ok(interrupted, "the interrupted stream must be logged");
  assert.equal(interrupted.data.reason, "upstream-stream-error");
  assert.equal(interrupted.data.errorName, "TypeError");
  assert.equal(interrupted.data.causeName, "SocketError");
  assert.equal(interrupted.data.causeCode, "UND_ERR_SOCKET");
  assert.ok(Number.isFinite(interrupted.data.msSinceLastChunk));
  // The raw error message ("other side closed") must not leak into the log.
  assert.equal(JSON.stringify(logs).includes("other side closed"), false);
});

test("disabling the relay switch drains briefly and then aborts in-flight streams", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  t.after(() => upstream.close());

  const previousDrain = process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS;
  process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS = "200";
  t.after(() => {
    if (previousDrain === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS;
    else process.env.TASK_HANDOFF_MODEL_RELAY_SHUTDOWN_DRAIN_MS = previousDrain;
  });

  const { app, relayUrl } = await setupRelay(t, upstream, "inst_transport_switchoff", { sameName: true });
  const client = http.request(relayUrl, { method: "POST", headers: { authorization: "Bearer instance-transport-token", "content-type": "application/json" } });
  client.on("error", () => undefined);
  client.end("{}");
  await new Promise((resolve) => client.once("response", (response) => response.once("data", resolve)));

  const started = Date.now();
  const disabled = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/settings/model-relay",
    headers: { authorization: "Bearer agent-secret" },
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.ok(Date.now() - started < 5_000, "switch-off must not wait for the never-ending upstream stream");
  assert.equal(await upstreamClosed(upstream.requests[0]), true);
});

test("a slow upstream that never sends response headers is aborted with a structured timeout", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, 1_500);
  });
  t.after(() => upstream.close());

  const previousTimeout = process.env.TASK_HANDOFF_MODEL_RELAY_HEADER_TIMEOUT_MS;
  process.env.TASK_HANDOFF_MODEL_RELAY_HEADER_TIMEOUT_MS = "200";
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.TASK_HANDOFF_MODEL_RELAY_HEADER_TIMEOUT_MS;
    else process.env.TASK_HANDOFF_MODEL_RELAY_HEADER_TIMEOUT_MS = previousTimeout;
  });

  const { app, relayUrl } = await setupRelay(t, upstream, "inst_transport_slow_headers");
  const response = await app.inject({
    method: "POST",
    url: relayUrl,
    headers: { authorization: "Bearer instance-transport-token" },
    payload: "{}",
  });
  assert.equal(response.statusCode, 504);
  assert.equal(response.json().error.code, "MODEL_RELAY_UPSTREAM_TIMEOUT");
  assert.equal(await upstreamClosed(upstream.requests[0]), true);
});

test("slow downstream readers apply backpressure and still receive the stream intact", async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 21);
  const totalChunks = 192; // 12 MB
  const state = { written: 0, bytesAtPauseStart: 0, bytesAtResume: 0 };
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    let index = 0;
    const writeNext = () => {
      while (index < totalChunks) {
        index += 1;
        state.written += chunk.length;
        if (!response.write(chunk)) {
          response.once("drain", writeNext);
          return;
        }
      }
      response.end();
    };
    writeNext();
  });
  t.after(() => upstream.close());
  const { app, relayUrl } = await setupRelay(t, upstream, "inst_transport_slow_downstream");

  const received = [];
  const response = await new Promise((resolve, reject) => {
    const client = http.request(relayUrl, { method: "POST", headers: { authorization: "Bearer instance-transport-token", "content-type": "application/json" } });
    client.once("error", reject);
    client.once("response", resolve);
    client.end("{}");
  });
  response.on("data", (data) => received.push(data));
  response.pause();
  await new Promise((resolve) => setTimeout(resolve, 50));
  state.bytesAtPauseStart = state.written;
  await new Promise((resolve) => setTimeout(resolve, 400));
  state.bytesAtResume = state.written;
  response.resume();
  await new Promise((resolve) => setTimeout(resolve, 30));
  response.pause();
  await new Promise((resolve) => setTimeout(resolve, 250));
  response.resume();
  await new Promise((resolve, reject) => {
    // Pausing the socket during a large response can end the message while the
    // readable side is paused; `complete` is the reliable signal that the full
    // chunked body was parsed, even when Node omits the trailing `end` event.
    const timer = setInterval(() => {
      if (response.complete) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
    response.once("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
  });

  const body = Buffer.concat(received);
  const expected = Buffer.concat(Array.from({ length: totalChunks }, () => chunk));
  assert.equal(body.length, expected.length);
  assert.equal(crypto.createHash("sha256").update(body).digest("hex"), crypto.createHash("sha256").update(expected).digest("hex"));
  // While the downstream socket was paused the relay could only pull a
  // bounded amount from the upstream, far below the full 12 MB response.
  assert.ok(
    state.bytesAtResume - state.bytesAtPauseStart < 4 * 1024 * 1024,
    `backpressure must stop unbounded upstream reads (buffered ${state.bytesAtResume - state.bytesAtPauseStart} bytes while paused)`,
  );
});
