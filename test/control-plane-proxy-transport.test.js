const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  ControlPlaneProxyNodeAgentTransport,
  controlPlaneProxyHttpUrl,
  controlPlaneProxyWebSocketUrl,
} = require("../packages/control-plane/src/control-plane/nodes/control-plane-proxy-transport.ts");

class TestSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closes = [];
    this.pings = 0;
  }

  send(data, options) {
    this.sent.push({ data, options });
  }

  close(code, reason) {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  ping() {
    this.pings += 1;
  }
}

const now = "2026-08-01T00:00:00.000Z";
const credential = {
  id: "proxy_credential_1",
  nodeId: "node_b",
  proxyOrigin: "https://proxy.example.test",
  proxyBindingId: "binding_1",
  targetNodeId: "target_b",
  sourceControlPlaneId: "control_plane_a",
  bindingKeyId: "binding_key_1",
  credential: "c".repeat(48),
  createdAt: now,
  updatedAt: now,
};
const node = {
  id: "node_b",
  connectionMode: "control-plane-proxy",
  connectionPath: { kind: "control-plane-proxy", proxyId: "proxy_r", proxyBindingId: "binding_1", targetNodeId: "target_b" },
};

test("control-plane proxy request and stream use the binding-scoped endpoint without buffering", async () => {
  const calls = [];
  const chunks = [new Uint8Array([0, 1]), new Uint8Array([255])];
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), {
        status: 206,
        headers: { "x-contract-reply": "stream" },
      });
    },
  });

  const controller = new AbortController();
  const response = await transport.requestStream(node, "/instances/instance_1/stream?cursor=7", {
    method: "POST",
    body: "payload",
    signal: controller.signal,
    headers: {
      authorization: "Bearer application-token",
      "x-contract": "stream",
      "x-task-handoff-proxy-credential": "spoofed",
    },
  });

  assert.equal(response.status, 206);
  assert.deepEqual([...Buffer.from(await response.arrayBuffer())], [0, 1, 255]);
  assert.equal(calls[0].url, "https://proxy.example.test/api/node-proxy/bindings/binding_1/http/instances/instance_1/stream?cursor=7");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "payload");
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].headers.authorization, "Bearer application-token");
  assert.equal(calls[0].headers["x-task-handoff-proxy-protocol-version"], "2026-08-01");
  assert.equal(calls[0].headers["x-task-handoff-proxy-source-control-plane-id"], "control_plane_a");
  assert.equal(calls[0].headers["x-task-handoff-proxy-binding-key-id"], "binding_key_1");
  assert.equal(calls[0].headers["x-task-handoff-proxy-credential"], credential.credential);
  assert.match(calls[0].headers["x-request-id"], /^proxy_request_[a-f0-9]{32}$/);
  assert.doesNotMatch(calls[0].url, new RegExp(credential.credential));
});

test("control-plane proxy preserves a valid caller correlation id and replaces invalid values", async () => {
  const requestIds = [];
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    fetchImpl: async (_url, init) => {
      requestIds.push(new Headers(init.headers).get("x-request-id"));
      return new Response();
    },
  });
  await transport.request(node, "/health", { headers: { "x-request-id": "request_a" } });
  await transport.request(node, "/health", { headers: { "x-request-id": "contains spaces" } });
  assert.equal(requestIds[0], "request_a");
  assert.match(requestIds[1], /^proxy_request_[a-f0-9]{32}$/);
});

test("control-plane proxy websocket keeps route and auth binding-scoped and uses the shared bridge", () => {
  const opened = [];
  const upstream = new TestSocket();
  const downstream = new TestSocket();
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    openWebSocket(url, protocols, headers) {
      opened.push({ url, protocols, headers });
      return upstream;
    },
  });

  const control = transport.proxyWebSocket(node, downstream, "/instances/instance_1/terminal?cols=100", ["terminal-v1"], {
    authorization: "Bearer application-token",
  });
  assert.equal(opened[0].url, "wss://proxy.example.test/api/node-proxy/bindings/binding_1/websocket?route=%2Finstances%2Finstance_1%2Fterminal%3Fcols%3D100");
  assert.deepEqual(opened[0].protocols, ["terminal-v1"]);
  assert.equal(opened[0].headers.authorization, "Bearer application-token");
  assert.equal(opened[0].headers["x-task-handoff-proxy-credential"], credential.credential);

  let pongs = 0;
  control.onPong(() => { pongs += 1; });
  control.ping();
  upstream.emit("pong");
  assert.equal(upstream.pings, 1);
  assert.equal(pongs, 1);

  downstream.emit("message", "input", false);
  upstream.emit("message", Buffer.from([7, 8]), true);
  assert.deepEqual(upstream.sent[0], { data: "input", options: { binary: false } });
  assert.deepEqual(downstream.sent[0], { data: Buffer.from([7, 8]), options: { binary: true } });
  upstream.emit("close", 1000, "done");
  assert.deepEqual(downstream.closes.at(-1), { code: 1000, reason: "done" });
});

test("control-plane proxy keeps only the latest control frame until the upstream websocket opens", () => {
  const upstream = new TestSocket();
  upstream.readyState = 0;
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    openWebSocket: () => upstream,
  });
  const control = transport.proxyWebSocket(node, new TestSocket(), "/events");
  control.send("old-subscription");
  control.send("current-subscription");
  assert.deepEqual(upstream.sent, []);
  upstream.readyState = upstream.OPEN;
  upstream.emit("open");
  assert.deepEqual(upstream.sent.map((entry) => entry.data), ["current-subscription"]);
});

test("control-plane proxy validates route and credential identity before I/O", async () => {
  let requests = 0;
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    fetchImpl: async () => { requests += 1; return new Response("unexpected"); },
  });
  for (const route of ["https://other.example/api/node-agent/health", "../health", "/%252e%252e/health", "//other.example/health"]) {
    await assert.rejects(
      transport.request(node, route),
      (error) => error.code === "CONTROL_PLANE_PROXY_ROUTE_INVALID" && error.statusCode === 400,
    );
  }
  assert.equal(requests, 0);

  const mismatch = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => ({ ...credential, targetNodeId: "other_node" }),
  });
  await assert.rejects(
    mismatch.request(node, "/health"),
    (error) => error.code === "CONTROL_PLANE_PROXY_CREDENTIAL_MISMATCH" && error.statusCode === 409,
  );
});

test("control-plane proxy preserves AbortError and classifies proxy reachability failures", async () => {
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
  let failure = aborted;
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    fetchImpl: async () => { throw failure; },
  });
  await assert.rejects(transport.request(node, "/health"), (error) => error === aborted);

  failure = new Error("connect refused");
  await assert.rejects(
    transport.request(node, "/health"),
    (error) => error.code === "CONTROL_PLANE_PROXY_UNAVAILABLE" && error.statusCode === 503 && error.retryable === true,
  );
});

test("control-plane proxy URL helpers retain only normalized routes", () => {
  assert.equal(controlPlaneProxyHttpUrl(credential, "/health").toString(), "https://proxy.example.test/api/node-proxy/bindings/binding_1/http/health");
  assert.equal(controlPlaneProxyWebSocketUrl(credential, "/health").protocol, "wss:");
});
