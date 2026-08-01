const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  NODE_TUNNEL_PROTOCOL_VERSION,
  NodeTunnelRequestBodySchema,
  decodeNodeTunnelRequestBody,
  encodeNodeTunnelRequestBody,
} = require("../packages/protocol/src/control-plane.ts");
const { ControlPlaneNodeAgentTunnelTransport, registerNodeAgentTunnelRoutes } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");
const { NodeTunnelIngress } = require("../packages/control-plane/src/control-plane/nodes/tunnel-ingress.ts");
const { createNodeAgentHmacHeaders } = require("../packages/control-plane/src/shared/security/node-agent-auth.ts");

class TestSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closes = [];
  }

  send(data, options) {
    this.sent.push({ data, options });
  }

  close(code, reason) {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }
}

function attachMain(transport, nodeId = "node_a") {
  const socket = new TestSocket();
  new NodeTunnelIngress(transport).attachMain(nodeId, socket);
  return socket;
}

test("node tunnel ingress owns hello and main message handling", () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const socket = attachMain(transport);
  const hello = JSON.parse(socket.sent[0].data);
  assert.equal(hello.type, "control-plane.hello");
  assert.equal(hello.protocolVersion, NODE_TUNNEL_PROTOCOL_VERSION);
  assert.deepEqual(hello.capabilities, {
    reverseTunnel: "request-response",
    auxiliaryChannels: true,
    httpResponseStreaming: true,
    lifecycleCommands: true,
    instanceApiProxy: true,
  });

  socket.emit("message", JSON.stringify({ type: "node-agent.ping" }));
  assert.equal(JSON.parse(socket.sent.at(-1).data).type, "control-plane.pong");
  socket.emit("message", "not-json");
  assert.equal(JSON.parse(socket.sent.at(-1).data).code, "INVALID_JSON");
  socket.emit("message", JSON.stringify({ type: "node-agent.identify" }));
  assert.equal(JSON.parse(socket.sent.at(-1).data).type, "control-plane.identified");
});

test("node tunnel protocol preserves UTF-8 and binary request bodies with an explicit date version", async () => {
  assert.match(NODE_TUNNEL_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  const textBody = encodeNodeTunnelRequestBody("你好 tunnel");
  const binary = Buffer.from([0, 255, 1, 128, 10]);
  const binaryBody = encodeNodeTunnelRequestBody(binary);
  assert.deepEqual(NodeTunnelRequestBodySchema.parse(textBody), { encoding: "utf8", data: "你好 tunnel" });
  assert.equal(decodeNodeTunnelRequestBody(textBody), "你好 tunnel");
  assert.deepEqual(decodeNodeTunnelRequestBody(binaryBody), binary);
  assert.equal(NodeTunnelRequestBodySchema.safeParse({ encoding: "base64", data: "not base64" }).success, false);

  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const main = attachMain(transport);
  const controller = new AbortController();
  const pending = transport.requestStream({ id: "node_a" }, "/binary", { method: "POST", body: binary, signal: controller.signal });
  const open = main.sent.map((entry) => JSON.parse(entry.data)).find((message) => message.type === "control-plane.http.open");
  assert.deepEqual(open.init.body, binaryBody);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("disabled nodes reject main and every auxiliary tunnel handshake until re-enabled", () => {
  const handlers = new Map();
  let connectionEnabled = false;
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  registerNodeAgentTunnelRoutes({
    app: {
      get(path, _options, handler) { handlers.set(path, handler); },
    },
    service: {
      requireNode(id) { return { id, connectionEnabled, auth: { mode: "paired-hmac", keyId: "key_1", secret: "secret_1" } }; },
    },
    nodeAgentTunnel: transport,
    errorPayload(error) {
      return { code: error.code || "INTERNAL_ERROR", message: error.message };
    },
  });

  const cases = [
    ["/api/node-tunnel", {}],
    ["/api/node-tunnel/streams/:streamId", { streamId: "stream_1" }],
    ["/api/node-tunnel/channels/:channelId", { channelId: "channel_1" }],
    ["/api/node-tunnel/http-streams/:streamId", { streamId: "http_1" }],
  ];
  for (const [path, params] of cases) {
    const socket = new TestSocket();
    const concretePath = path
      .replace(":streamId", params.streamId || "")
      .replace(":channelId", params.channelId || "");
    const url = `${concretePath}?nodeId=node_disabled`;
    const headers = createNodeAgentHmacHeaders({
      nodeId: "node_disabled", keyId: "key_1", secret: "secret_1", method: "GET", pathWithQuery: url,
    });
    handlers.get(path)(socket, { query: { nodeId: "node_disabled" }, params, headers, url });
    assert.equal(socket.closes[0].code, 1008);
    assert.match(socket.closes[0].reason, /disabled locally/i);
    assert.equal(transport.isCurrentSocket("node_disabled", socket), false);
  }

  connectionEnabled = true;
  const enabled = new TestSocket();
  const url = "/api/node-tunnel?nodeId=node_disabled";
  const headers = createNodeAgentHmacHeaders({
    nodeId: "node_disabled", keyId: "key_1", secret: "secret_1", method: "GET", pathWithQuery: url,
  });
  handlers.get("/api/node-tunnel")(enabled, { query: { nodeId: "node_disabled" }, params: {}, headers, url });
  assert.equal(enabled.closes.length, 0);
  assert.equal(transport.isCurrentSocket("node_disabled", enabled), true);
});

test("pending auxiliary channels reject unknown duplicate and canceled attach", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const main = attachMain(transport);
  const controller = new AbortController();
  const response = transport.requestStream({ id: "node_a" }, "/logs", { signal: controller.signal });
  const open = main.sent.map((entry) => JSON.parse(entry.data)).find((message) => message.type === "control-plane.http.open");

  const first = new TestSocket();
  assert.equal(transport.attachAuxiliary("node_a", open.streamId, first), true);
  const duplicate = new TestSocket();
  assert.equal(transport.attachAuxiliary("node_a", open.streamId, duplicate), false);
  assert.equal(duplicate.closes[0].code, 1008);

  controller.abort();
  await assert.rejects(response, (error) => error.name === "AbortError");
  const unknown = new TestSocket();
  assert.equal(transport.attachAuxiliary("node_a", "missing", unknown), false);
  assert.equal(unknown.closes[0].code, 1008);
});

test("main replacement invalidates pending auxiliary channels without replacing the new session", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const oldMain = attachMain(transport);
  const pendingResponse = transport.requestStream({ id: "node_a" }, "/logs");
  const open = oldMain.sent.map((entry) => JSON.parse(entry.data)).find((message) => message.type === "control-plane.http.open");
  const newMain = attachMain(transport);

  await assert.rejects(pendingResponse, /replaced/i);
  const late = new TestSocket();
  assert.equal(transport.attachAuxiliary("node_a", open.streamId, late), false);
  assert.equal(transport.isCurrentSocket("node_a", newMain), true);
  assert.equal(transport.isCurrentSocket("node_a", oldMain), false);
});

test("websocket pending frames preserve text binary and order through generic attach", () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const main = attachMain(transport);
  const downstream = new TestSocket();
  transport.proxyWebSocket({ id: "node_a" }, downstream, "/terminal", ["binary"], { "x-test": "value" });
  const open = main.sent.map((entry) => JSON.parse(entry.data)).find((message) => message.type === "control-plane.websocket.open");
  assert.deepEqual(open.protocols, ["binary"]);
  assert.deepEqual(open.headers, { "x-test": "value" });

  downstream.emit("message", "first", false);
  downstream.emit("message", Buffer.from([1, 2, 3]), true);
  const upstream = new TestSocket();
  assert.equal(transport.attachAuxiliary("node_a", open.streamId, upstream), true);
  assert.equal(upstream.sent[0].data, "first");
  assert.equal(upstream.sent[0].options.binary, false);
  assert.deepEqual(upstream.sent[1].data, Buffer.from([1, 2, 3]));
  assert.equal(upstream.sent[1].options.binary, true);
});

test("expired pending auxiliary channels close their owner and reject late attach", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport(undefined, { auxiliaryAttachTimeoutMs: 5 });
  const main = attachMain(transport);
  const downstream = new TestSocket();
  transport.proxyWebSocket({ id: "node_a" }, downstream, "/terminal");
  const open = main.sent.map((entry) => JSON.parse(entry.data)).find((message) => message.type === "control-plane.websocket.open");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(downstream.closes[0].code, 1011);
  const late = new TestSocket();
  assert.equal(transport.attachAuxiliary("node_a", open.streamId, late), false);
  assert.equal(late.closes[0].code, 1008);
});
