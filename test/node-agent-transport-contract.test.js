const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { decodeNodeTunnelRequestBody } = require("../packages/protocol/src/control-plane.ts");

const { createDirectNodeAgentTransport } = require("../packages/control-plane/src/control-plane/nodes/direct-transport.ts");
const { NodeAgentTransportResolver } = require("../packages/control-plane/src/control-plane/nodes/transport-resolver.ts");
const { ControlPlaneNodeAgentTunnelTransport } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");
const { NodeTunnelIngress } = require("../packages/control-plane/src/control-plane/nodes/tunnel-ingress.ts");
const { ControlPlaneProxyNodeAgentTransport } = require("../packages/control-plane/src/control-plane/nodes/control-plane-proxy-transport.ts");

class ContractSocket extends EventEmitter {
  constructor(onSend) {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closes = [];
    this.onSend = onSend;
  }

  send(data, options) {
    this.sent.push({ data, options });
    this.onSend?.(data, options);
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
  }
}

function abortError(message) {
  return Object.assign(new Error(message), { name: "AbortError", code: "ABORT_ERR" });
}

function waitForTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function directNode() {
  return {
    id: "node_direct",
    connectionMode: "direct-http",
    connectionPath: { kind: "direct" },
    endpoint: "https://node.test",
    auth: { mode: "paired-hmac", keyId: "key_direct", secret: "secret_direct" },
  };
}

function reverseNode() {
  return {
    id: "node_reverse_direct",
    connectionMode: "reverse-wss",
    connectionPath: { kind: "direct" },
    auth: { mode: "paired-hmac", keyId: "key_reverse", secret: "secret_reverse" },
  };
}

function createDirectHarness() {
  const requests = [];
  const websockets = [];
  let online = true;
  let cancellation;
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(String(url)).pathname.replace(/^\/api\/node-agent/, "");
    const record = {
      route,
      method: init.method || "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
    };
    requests.push(record);
    if (!online) throw Object.assign(new Error("Direct transport is offline."), { code: "DIRECT_OFFLINE" });
    if (route === "/contract/cancel") {
      return new Promise((_resolve, reject) => {
        const cancel = () => {
          cancellation = { kind: "request", route };
          reject(abortError("Direct request was aborted."));
        };
        init.signal?.addEventListener("abort", cancel, { once: true });
        if (init.signal?.aborted) cancel();
      });
    }
    if (route === "/contract/error") {
      return new Response("contract failure", { status: 503, headers: { "x-contract-reply": "error" } });
    }
    if (route.includes("stream")) {
      return new Response(Buffer.from([0, 1, 255]), { status: 206, headers: { "x-contract-reply": "stream" } });
    }
    return new Response(`request:${init.body || ""}`, { status: 201, headers: { "x-contract-reply": "request" } });
  };
  const transport = createDirectNodeAgentTransport(fetchImpl, {
    openWebSocket(node, route, protocols, headers) {
      const upstream = new ContractSocket();
      websockets.push({ node, route, protocols, headers, upstream });
      return upstream;
    },
  });
  return {
    transport,
    node: directNode(),
    requests,
    websockets,
    cancellation: () => cancellation,
    disconnect() { online = false; },
    reconnect() { online = true; },
  };
}

function createTunnelHarness() {
  const transport = new ControlPlaneNodeAgentTunnelTransport(undefined, {
    requestTimeoutMs: 1_000,
    httpStreamHeaderTimeoutMs: 1_000,
    auxiliaryAttachTimeoutMs: 1_000,
  });
  const ingress = new NodeTunnelIngress(transport);
  const node = reverseNode();
  const requests = [];
  const websockets = [];
  let cancellation;
  let main;

  const connect = () => {
    main = new ContractSocket((raw) => {
      if (typeof raw !== "string") return;
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message.type === "control-plane.request") {
        const body = decodeNodeTunnelRequestBody(message.init.body);
        requests.push({ kind: "request", route: message.route, ...message.init, body });
        if (message.route === "/contract/cancel") return;
        queueMicrotask(() => main.emit("message", JSON.stringify({
          type: "node-agent.response",
          requestId: message.requestId,
          status: message.route === "/contract/error" ? 503 : 201,
          headers: { "x-contract-reply": message.route === "/contract/error" ? "error" : "request" },
          body: message.route === "/contract/error" ? "contract failure" : `request:${body || ""}`,
        })));
        return;
      }
      if (message.type === "control-plane.request.cancel") {
        cancellation = { kind: "request", id: message.requestId };
        return;
      }
      if (message.type === "control-plane.http.open") {
        requests.push({ kind: "stream", route: message.route, ...message.init, body: decodeNodeTunnelRequestBody(message.init.body) });
        const upstream = new ContractSocket();
        queueMicrotask(() => {
          ingress.attachAuxiliary(node.id, message.streamId, upstream);
          upstream.emit("message", JSON.stringify({ type: "node-agent.http.head", status: 206, headers: { "x-contract-reply": "stream" } }), false);
          upstream.emit("message", Buffer.from([0, 1, 255]), true);
          upstream.emit("message", JSON.stringify({ type: "node-agent.http.end" }), false);
        });
        return;
      }
      if (message.type === "control-plane.http.cancel") {
        cancellation = { kind: "stream", id: message.streamId };
        return;
      }
      if (message.type === "control-plane.websocket.open") {
        requests.push({ kind: "websocket", route: message.route, headers: message.headers, protocols: message.protocols });
        const upstream = new ContractSocket();
        websockets.push({ route: message.route, protocols: message.protocols, headers: message.headers, upstream });
        queueMicrotask(() => ingress.attachAuxiliary(node.id, message.streamId, upstream));
      }
    });
    ingress.attachMain(node.id, main);
  };
  connect();

  return {
    transport,
    node,
    requests,
    websockets,
    cancellation: () => cancellation,
    disconnect() {
      const closed = main;
      closed.readyState = 3;
      closed.emit("close", 1006, "offline");
    },
    reconnect: connect,
  };
}

function createProxyHarness() {
  const requests = [];
  const websockets = [];
  let online = true;
  let cancellation;
  const credential = {
    id: "proxy_credential_node_proxy", nodeId: "node_proxy", proxyOrigin: "https://proxy.test",
    proxyBindingId: "binding_1", targetNodeId: "node_proxy", sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "proxy_key_1", credential: "proxy_credential_value_0123456789",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const node = {
    id: "node_proxy", connectionMode: "control-plane-proxy",
    connectionPath: { kind: "control-plane-proxy", proxyId: "proxy.test", proxyBindingId: "binding_1", targetNodeId: "node_proxy" },
    auth: { mode: "proxy-binding" },
  };
  const transport = new ControlPlaneProxyNodeAgentTransport({
    credentialForNode: () => credential,
    fetchImpl: async (url, init = {}) => {
      const route = new URL(String(url)).pathname.replace(/^\/api\/node-proxy\/bindings\/[^/]+\/http/, "");
      requests.push({ route, method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body });
      if (!online) throw Object.assign(new Error("Proxy transport is offline."), { code: "PROXY_OFFLINE" });
      if (route === "/contract/cancel") {
        return new Promise((_resolve, reject) => {
          const cancel = () => { cancellation = { kind: "request", route }; reject(abortError("Proxy request was aborted.")); };
          init.signal?.addEventListener("abort", cancel, { once: true });
          if (init.signal?.aborted) cancel();
        });
      }
      if (route === "/contract/error") return new Response("contract failure", { status: 503, headers: { "x-contract-reply": "error" } });
      if (route.includes("stream")) return new Response(Buffer.from([0, 1, 255]), { status: 206, headers: { "x-contract-reply": "stream" } });
      return new Response(`request:${init.body || ""}`, { status: 201, headers: { "x-contract-reply": "request" } });
    },
    openWebSocket(url, protocols, headers) {
      const upstream = new ContractSocket();
      websockets.push({ route: new URL(url).searchParams.get("route"), protocols, headers, upstream });
      return upstream;
    },
  });
  return {
    transport, node, requests, websockets, cancellation: () => cancellation,
    disconnect() { online = false; }, reconnect() { online = true; },
  };
}

const transportVariants = [
  ["direct adapter", createDirectHarness],
  ["direct reverse tunnel", createTunnelHarness],
  ["trusted control-plane proxy", createProxyHarness],
];

for (const [name, createHarness] of transportVariants) {
  test(`${name} carries health and instance websocket routes through the same adapter`, async () => {
    const harness = createHarness();
    const health = await harness.transport.request(harness.node, "/health");
    assert.equal(health.status, 201);
    assert.equal(harness.requests.find((entry) => entry.route === "/health").method, "GET");
    const downstream = new ContractSocket();
    harness.transport.proxyWebSocket(harness.node, downstream, "/instances/instance_1/stream", ["instance-v1"]);
    await waitForTurn();
    assert.equal(harness.websockets[0].route, "/instances/instance_1/stream");
    assert.deepEqual(harness.websockets[0].protocols, ["instance-v1"]);
  });

  test(`${name} satisfies the NodeAgentTransport request and header contract`, async () => {
    const harness = createHarness();
    const response = await harness.transport.request(harness.node, "/contract/request", {
      method: "POST",
      headers: { "x-contract": "request" },
      body: "payload",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-contract-reply"), "request");
    assert.equal(await response.text(), "request:payload");
    const request = harness.requests.find((entry) => entry.route === "/contract/request");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-contract"], "request");
    assert.equal(request.body, "payload");
  });

  test(`${name} satisfies the NodeAgentTransport streaming contract`, async () => {
    const harness = createHarness();
    const response = await harness.transport.requestStream(harness.node, "/contract/stream", {
      method: "POST",
      headers: { "x-contract": "stream" },
      body: "stream-payload",
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("x-contract-reply"), "stream");
    assert.deepEqual([...Buffer.from(await response.arrayBuffer())], [0, 1, 255]);
    const request = harness.requests.find((entry) => entry.route === "/contract/stream");
    assert.equal(request.headers["x-contract"], "stream");
    assert.equal(request.body, "stream-payload");
  });

  test(`${name} satisfies the NodeAgentTransport websocket contract`, async () => {
    const harness = createHarness();
    const downstream = new ContractSocket();
    harness.transport.proxyWebSocket(harness.node, downstream, "/contract/websocket", ["binary"], { "x-contract": "websocket" });
    await waitForTurn();
    const websocket = harness.websockets[0];
    assert.equal(websocket.route, "/contract/websocket");
    assert.deepEqual(websocket.protocols, ["binary"]);
    assert.equal(websocket.headers["x-contract"], "websocket");
    downstream.emit("message", "text-frame", false);
    downstream.emit("message", Buffer.from([7, 8]), true);
    assert.equal(websocket.upstream.sent[0].data, "text-frame");
    assert.equal(websocket.upstream.sent[0].options.binary, false);
    assert.deepEqual(websocket.upstream.sent[1].data, Buffer.from([7, 8]));
    assert.equal(websocket.upstream.sent[1].options.binary, true);
    websocket.upstream.emit("message", "reply", false);
    assert.equal(downstream.sent.at(-1).data, "reply");
  });

  test(`${name} satisfies cancellation and HTTP error response contracts`, async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const pending = harness.transport.request(harness.node, "/contract/cancel", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
    assert.equal(harness.cancellation().kind, "request");
    const response = await harness.transport.request(harness.node, "/contract/error");
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "contract failure");
  });

  test(`${name} recovers without changing the transport contract`, async () => {
    const harness = createHarness();
    harness.disconnect();
    await assert.rejects(harness.transport.request(harness.node, "/contract/request"));
    harness.reconnect();
    const response = await harness.transport.request(harness.node, "/contract/request", { body: "recovered" });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), "request:recovered");
  });
}

test("the resolver maps direct, reverse, and proxy modes to one adapter each", () => {
  const direct = { request() {}, requestStream() {}, proxyWebSocket() {} };
  const tunnel = { request() {}, requestStream() {}, proxyWebSocket() {} };
  const proxy = { request() {}, requestStream() {}, proxyWebSocket() {} };
  const resolver = new NodeAgentTransportResolver({ direct, tunnel, proxy });
  for (const connectionMode of ["local-ipc", "local-loopback", "direct-http"]) {
    assert.equal(resolver.resolve({ connectionMode }), direct);
  }
  assert.equal(resolver.resolve(reverseNode()), tunnel);
  assert.equal(resolver.resolve(createProxyHarness().node), proxy);
});

test("the resolver reports a structured error when the shared reverse transport is unavailable", () => {
  const resolver = new NodeAgentTransportResolver({ direct: { request() {}, requestStream() {}, proxyWebSocket() {} } });
  assert.throws(
    () => resolver.resolve(reverseNode()),
    (error) => error.code === "NODE_AGENT_REVERSE_TRANSPORT_UNAVAILABLE" && error.statusCode === 503,
  );
});

test("the resolver rejects a locally disabled node before selecting any transport path", () => {
  const resolver = new NodeAgentTransportResolver({
    direct: { request() {}, requestStream() {}, proxyWebSocket() {} },
    tunnel: { request() {}, requestStream() {}, proxyWebSocket() {} },
  });
  for (const node of [
    { connectionMode: "direct-http", connectionEnabled: false },
    { ...reverseNode(), connectionEnabled: false },
    { ...createProxyHarness().node, connectionEnabled: false },
  ]) {
    assert.throws(
      () => resolver.resolve(node),
      (error) => error.code === "NODE_AGENT_CONNECTION_DISABLED" && error.statusCode === 409,
    );
  }
});

test("direct transport preserves an explicit application bearer while owning its transport auth headers", async () => {
  let capturedHeaders;
  const localNode = {
    id: "node_local",
    connectionMode: "local-loopback",
    endpoint: "http://127.0.0.1:8091",
    auth: { mode: "local-static-key", secret: "transport-token" },
  };
  const transport = createDirectNodeAgentTransport(async (_url, init) => {
    capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
    return new Response("ok");
  });
  await transport.request(localNode, "/instances/instance_1/heartbeat", {
    headers: { authorization: "Bearer registration-token" },
  });
  assert.equal(capturedHeaders.authorization, "Bearer registration-token");
});

test("an example request and pending auxiliary capability works through every adapter without transport changes", async () => {
  for (const [, createHarness] of transportVariants) {
    const harness = createHarness();
    const request = await harness.transport.request(harness.node, "/contract/example-capability", { body: "example" });
    assert.equal(await request.text(), "request:example");
    const stream = await harness.transport.requestStream(harness.node, "/contract/example-capability/stream");
    assert.deepEqual([...Buffer.from(await stream.arrayBuffer())], [0, 1, 255]);
  }
});
