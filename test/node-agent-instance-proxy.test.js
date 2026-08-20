const assert = require("node:assert/strict");
const test = require("node:test");

const {
  proxyRequestBody,
  proxyResponseHeaders,
  proxyWebSocketProtocols,
  readResponseBodyWithLimit,
} = require("../packages/control-plane/src/node-agent/instance-proxy-codec.ts");
const Fastify = require("fastify");
const {
  createInstanceProxyMetrics,
  registerInstanceProxyRoutes,
} = require("../packages/control-plane/src/node-agent/instances/proxy-routes.ts");

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
