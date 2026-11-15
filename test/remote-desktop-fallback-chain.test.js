const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const Fastify = require("fastify");
const websocket = require("@fastify/websocket");
require("./workspace-require.js").registerWorkspaceRequire();

const { ControlledInstanceGateway } = require("../packages/control-plane/src/control-plane/instances/gateway.ts");
const { registerManagedDesktopRoutes } = require("../packages/node-agent/src/instances/remote-desktop-routes.ts");
const {
  DESKTOP_FALLBACK_ACTOR_HEADER,
  DESKTOP_FALLBACK_DEVICE_HEADER,
  DESKTOP_FALLBACK_GENERATION_HEADER,
  DESKTOP_FALLBACK_SELECTION_HEADER,
  DESKTOP_FALLBACK_VIEWER_HEADER,
} = require("../packages/runtime-shared/src/remote-desktop-managed.ts");

const mediaProtocol = "taskhandoff.remote-desktop.fallback.media.v1";
const controlProtocol = "taskhandoff.remote-desktop.fallback.control.v1";
const context = {
  [DESKTOP_FALLBACK_VIEWER_HEADER]: "rdv_viewer",
  [DESKTOP_FALLBACK_GENERATION_HEADER]: "fgen_1",
  [DESKTOP_FALLBACK_ACTOR_HEADER]: "user:user_1",
  [DESKTOP_FALLBACK_DEVICE_HEADER]: "device_1",
  [DESKTOP_FALLBACK_SELECTION_HEADER]: JSON.stringify({ sourceRef: "display-primary" }),
};

test("control plane fallback reuses the node-agent WebSocket proxy with role context", () => {
  const instance = {
    id: "inst_remote",
    name: "Remote",
    nodeId: "node_1",
    connectionStatus: "online",
    agentStatus: "online",
    ready: true,
    target: { web: true },
    runtimeVersion: { phase: "matched" },
  };
  const node = { id: "node_1" };
  const calls = [];
  const gateway = new ControlledInstanceGateway({
    requireNode: () => node,
    nodeAgentTransport: () => ({
      proxyWebSocket: (...args) => calls.push(args),
    }),
  });
  const socket = {};
  gateway.desktopFallback(instance, "media", socket, context);
  assert.deepEqual(calls, [[
    node,
    socket,
    "/instances/inst_remote/remote-desktop/fallback/media",
    mediaProtocol,
    context,
  ]]);
});

test("node agent maps permission operations to fixed instance endpoints without forwarding caller URLs", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });
  const requests = [];
  registerManagedDesktopRoutes(app, {
    instanceBase: () => "http://instance.internal",
    instanceCredential: () => "registration-secret",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { platform: "darwin", supported: true, screenCapture: "required", inputControl: "granted" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await app.ready();

  for (const [operation, payload] of [
    ["permissions-get", {}],
    ["permissions-request", { kind: "screen-capture" }],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/node-agent/instances/inst_remote/remote-desktop/${operation}`,
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.platform, "darwin");
  }
  assert.deepEqual(requests.map(request => ({
    url: request.url,
    method: request.init.method,
    authorization: request.init.headers.authorization,
    body: request.init.body,
  })), [
    { url: "http://instance.internal/api/internal/remote-desktop/permissions", method: "GET", authorization: "Bearer registration-secret", body: undefined },
    { url: "http://instance.internal/api/internal/remote-desktop/permissions/request", method: "POST", authorization: "Bearer registration-secret", body: JSON.stringify({ kind: "screen-capture" }) },
  ]);
});

class CapturingUpstreamWebSocket extends EventEmitter {
  static OPEN = 1;
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = [];
  }
  send(data, options, callback) {
    this.sent.push({ data, options });
    callback?.();
  }
  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
  open() {
    this.readyState = CapturingUpstreamWebSocket.OPEN;
    this.emit("open");
  }
}

test("node agent proxies one fallback role through the instance credential and replays pre-open frames", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });
  let upstream;
  const constructed = [];
  registerManagedDesktopRoutes(app, {
    instanceBase: () => "http://instance.internal",
    instanceCredential: () => "registration-secret",
    webSocketFactory: (url, protocols, options) => {
      upstream = new CapturingUpstreamWebSocket();
      constructed.push({ url: url.toString(), protocols, options });
      return upstream;
    },
  });
  await app.ready();

  const client = await app.injectWS(
    "/api/node-agent/instances/inst_remote/remote-desktop/fallback/media",
    { headers: { ...context, "sec-websocket-protocol": mediaProtocol } },
  );
  client.send(Buffer.from([1, 2, 3]));
  while (!upstream) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  upstream.open();
  while (upstream.sent.length < 2) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].url, "ws://instance.internal/api/internal/remote-desktop/fallback/media");
  assert.equal(constructed[0].protocols, mediaProtocol);
  assert.deepEqual(constructed[0].options, {
    perMessageDeflate: false,
    maxPayload: 128 * 1024,
    headers: { authorization: "Bearer registration-secret" },
  });
  assert.deepEqual(JSON.parse(upstream.sent[0].data.toString()), {
    type: "fallback.attach",
    role: "media",
    fallbackGeneration: "fgen_1",
    viewerSessionId: "rdv_viewer",
    actorId: "user:user_1",
    deviceSessionId: "device_1",
    captureSelection: { sourceRef: "display-primary" },
  });
  assert.deepEqual(upstream.sent[1].data, Buffer.from([1, 2, 3]));
  assert.deepEqual(upstream.sent[1].options, { binary: true, compress: false });
  client.terminate();
});

test("node agent rejects a fallback role/protocol mismatch before opening upstream", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });
  let opened = 0;
  registerManagedDesktopRoutes(app, {
    instanceBase: () => "http://instance.internal",
    instanceCredential: () => "registration-secret",
    webSocketFactory: () => {
      opened += 1;
      throw new Error("must not open upstream");
    },
  });
  await app.ready();

  const client = await app.injectWS(
    "/api/node-agent/instances/inst_remote/remote-desktop/fallback/media",
    { headers: { ...context, "sec-websocket-protocol": controlProtocol } },
  );
  const [code] = await once(client, "close");
  assert.equal(code, 1008);
  assert.equal(opened, 0);
});

test("node agent preserves the instance close reason for attach signaling", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });
  let upstream;
  registerManagedDesktopRoutes(app, {
    instanceBase: () => "http://instance.internal",
    instanceCredential: () => "registration-secret",
    webSocketFactory: () => {
      upstream = new CapturingUpstreamWebSocket();
      return upstream;
    },
  });
  await app.ready();

  const client = await app.injectWS("/api/node-agent/instances/inst_remote/remote-desktop/attach");
  client.send(JSON.stringify({
    requestId: "attach_a",
    owner: { actorId: "user:user_1", deviceSessionId: "device_1" },
    viewerSessionId: "rdv_viewer",
    captureSelection: { sourceRef: "display-primary" },
    attachToken: "attach-token",
  }));
  while (!upstream) await new Promise((resolve) => setImmediate(resolve));
  upstream.open();
  while (!upstream.sent.length) await new Promise((resolve) => setImmediate(resolve));
  const closed = once(client, "close");
  upstream.emit("close", 1008, Buffer.from("REMOTE_DESKTOP_WINDOW_UNAVAILABLE"));
  const [code, reason] = await closed;
  assert.equal(code, 1008);
  assert.equal(String(reason), "REMOTE_DESKTOP_WINDOW_UNAVAILABLE");
});

test("node agent rejects malformed fallback context before opening upstream", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  t.after(async () => {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });
  let opened = 0;
  registerManagedDesktopRoutes(app, {
    instanceBase: () => "http://instance.internal",
    instanceCredential: () => "registration-secret",
    webSocketFactory: () => {
      opened += 1;
      throw new Error("must not open upstream");
    },
  });
  await app.ready();

  const client = await app.injectWS(
    "/api/node-agent/instances/inst_remote/remote-desktop/fallback/media",
    {
      headers: {
        ...context,
        [DESKTOP_FALLBACK_SELECTION_HEADER]: JSON.stringify({ sourceRef: "" }),
        "sec-websocket-protocol": mediaProtocol,
      },
    },
  );
  const [code] = await once(client, "close");
  assert.equal(code, 1008);
  assert.equal(opened, 0);
});
