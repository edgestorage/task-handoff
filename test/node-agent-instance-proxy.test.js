const assert = require("node:assert/strict");
const test = require("node:test");

const {
  proxyRequestBody,
  proxyResponseHeaders,
  proxyWebSocketProtocols,
  readResponseBodyWithLimit,
} = require("../packages/node-agent/src/instance-proxy-codec.ts");
const { EventEmitter } = require("node:events");
const Fastify = require("fastify");
const websocket = require("@fastify/websocket");
const {
  createInstanceProxyMetrics,
  registerInstanceProxyRoutes,
} = require("../packages/node-agent/src/instances/proxy-routes.ts");

test("instance proxy codec preserves binary request bodies", () => {
  assert.deepEqual(proxyRequestBody({ bodyBase64: "AAH/" }), Buffer.from([0, 1, 255]));
  assert.equal(proxyRequestBody({ body: "plain text" }), "plain text");
});

test("instance proxy codec strips headers invalidated by decoded fetch bodies", () => {
  const headers = proxyResponseHeaders(new Headers({
    "content-encoding": "gzip",
    "content-length": "123",
    "content-type": "application/json",
    "x-trace-id": "trace-1",
  }));
  assert.deepEqual(headers, {
    "content-type": "application/json",
    "x-trace-id": "trace-1",
  });
});

test("instance proxy codec normalizes websocket protocol lists", () => {
  assert.deepEqual(proxyWebSocketProtocols({ "sec-websocket-protocol": ["events", " binary, audit "] }), ["events", "binary", "audit"]);
  assert.equal(proxyWebSocketProtocols({}), undefined);
});

test("instance proxy codec rejects a decoded response above the configured boundary", async () => {
  const response = new Response(new Uint8Array([0, 1, 2, 3]));
  await assert.rejects(
    readResponseBodyWithLimit(response, 3),
    (error) => error.code === "INSTANCE_PROXY_RESPONSE_TOO_LARGE",
  );
});

test("instance proxy codec combines response chunks within the boundary", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1]));
      controller.enqueue(new Uint8Array([2, 255]));
      controller.close();
    },
  });
  assert.deepEqual(await readResponseBodyWithLimit(new Response(stream), 4), Buffer.from([0, 1, 2, 255]));
});

test("raw instance proxy cancels a declared oversized upstream response", async (t) => {
  let cancellations = 0;
  const upstreamBody = new ReadableStream({
    cancel() {
      cancellations += 1;
    },
  });
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const metrics = createInstanceProxyMetrics();
  metrics.maxResponseBytes = 1;
  registerInstanceProxyRoutes(app, {
    fetchImpl: async () => new Response(upstreamBody, { headers: { "content-length": "2" } }),
    metrics,
    instanceBase: () => "http://instance.invalid",
    syncModelEnvironment: async () => undefined,
    diagnostic: () => undefined,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_proxy/proxy/raw",
    payload: { path: "/large", method: "GET", headers: {} },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "INSTANCE_PROXY_RESPONSE_TOO_LARGE");
  assert.equal(cancellations, 1);
});

test("instance proxy propagates trace id and appends its Server-Timing phase", async (t) => {
  const diagnostics = [];
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  registerInstanceProxyRoutes(app, {
    fetchImpl: async (_url, init) => new Response(JSON.stringify({ data: { ok: true } }), {
      headers: {
        "content-type": "application/json",
        "server-timing": "instance_action;dur=12.5",
        "x-task-handoff-trace-id": init.headers["x-task-handoff-trace-id"],
      },
    }),
    metrics: createInstanceProxyMetrics(),
    instanceBase: () => "http://instance.invalid",
    syncModelEnvironment: async () => undefined,
    diagnostic: (data) => diagnostics.push(data),
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_proxy/proxy",
    payload: {
      path: "/api/ai-sessions/ais_1/messages",
      method: "POST",
      headers: { "content-type": "application/json", "x-task-handoff-trace-id": "trace-message-1" },
      body: "{}",
    },
  });

  assert.equal(response.headers["x-task-handoff-trace-id"], "trace-message-1");
  assert.match(response.headers["server-timing"], /instance_action;dur=12\.5/);
  assert.match(response.headers["server-timing"], /node_proxy;dur=/);
  assert.equal(diagnostics.at(-1).traceId, "trace-message-1");
});

test("instance proxy reports an unreachable controlled-instance endpoint as a retryable bad gateway", async (t) => {
  const diagnostics = [];
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  registerInstanceProxyRoutes(app, {
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    metrics: createInstanceProxyMetrics(),
    instanceBase: () => "http://instance.invalid",
    syncModelEnvironment: async () => undefined,
    diagnostic: (data) => diagnostics.push(data),
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_unreachable/proxy",
    payload: { path: "/api/health", method: "GET", headers: {} },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().code, "INSTANCE_PROXY_UPSTREAM_UNREACHABLE");
  assert.equal(response.json().message, "Instance inst_unreachable web endpoint is not reachable.");
  assert.ok(diagnostics.some((entry) => entry.action === "proxy.upstream.failed"));
});

class CapturingUpstreamWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closes = [];
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

test("instance shell upstream uses the registration credential and rejects a missing subprotocol", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const constructed = [];
  registerInstanceProxyRoutes(app, {
    fetchImpl: fetch,
    metrics: createInstanceProxyMetrics(),
    instanceBase: () => "http://instance.internal",
    syncModelEnvironment: async () => undefined,
    webSocketUpstreamHeaders: async (id, path) => {
      assert.equal(id, "inst_shell");
      assert.equal(path, "/api/internal/instance-shell");
      return { authorization: "Bearer registration-secret" };
    },
    webSocketFactory: (url, protocols, options) => {
      const upstream = new CapturingUpstreamWebSocket();
      constructed.push({ url: url.toString(), protocols, options });
      queueMicrotask(() => {
        upstream.readyState = upstream.OPEN;
        upstream.emit("open");
      });
      return upstream;
    },
    diagnostic: () => undefined,
  });
  await app.ready();
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });

  const missingProtocol = await app.injectWS("/api/node-agent/instances/inst_shell/proxy/ws/api/internal/instance-shell");
  const [missingCode, missingReason] = await Promise.all([
    new Promise((resolve) => missingProtocol.once("close", resolve)),
    new Promise((resolve) => missingProtocol.once("close", (_code, reason) => resolve(String(reason)))),
  ]);
  assert.equal(missingCode, 1002);
  assert.match(missingReason, /subprotocol is required/);
  assert.equal(constructed.length, 0);

  const client = await app.injectWS("/api/node-agent/instances/inst_shell/proxy/ws/api/internal/instance-shell", {
    headers: {
      authorization: "Bearer user-cli-secret",
      cookie: "session=browser-secret",
      "sec-websocket-protocol": "task-handoff.instance-shell.2026-10-31",
    },
  });
  client.terminate();
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].url, "ws://instance.internal/api/internal/instance-shell");
  assert.deepEqual(constructed[0].protocols, ["task-handoff.instance-shell.2026-10-31"]);
  assert.deepEqual(constructed[0].options, {
    perMessageDeflate: false,
    headers: { authorization: "Bearer registration-secret" },
  });
});

test("instance shell replays a start frame received while the proxy resolves its upstream", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  let resolveBase;
  const base = new Promise((resolve) => { resolveBase = resolve; });
  let upstream;
  registerInstanceProxyRoutes(app, {
    fetchImpl: fetch,
    metrics: createInstanceProxyMetrics(),
    instanceBase: () => base,
    syncModelEnvironment: async () => undefined,
    webSocketUpstreamHeaders: () => ({ authorization: "Bearer registration-secret" }),
    webSocketFactory: () => {
      upstream = new CapturingUpstreamWebSocket();
      queueMicrotask(() => {
        upstream.readyState = upstream.OPEN;
        upstream.emit("open");
      });
      return upstream;
    },
    diagnostic: () => undefined,
  });
  await app.ready();
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });

  const client = await app.injectWS("/api/node-agent/instances/inst_shell/proxy/ws/api/internal/instance-shell", {
    headers: { "sec-websocket-protocol": "task-handoff.instance-shell.2026-10-31" },
  });
  client.send("early-start");
  resolveBase("http://instance.internal");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(upstream);
  assert.equal(String(upstream.sent[0]), "early-start");
  client.terminate();
});
