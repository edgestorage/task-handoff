const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const Fastify = require("fastify");
const websocket = require("@fastify/websocket");

const {
  CONTROL_PLANE_PROXY_AUTH_HEADERS,
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
} = require("../packages/protocol/src/control-plane-proxy.ts");
const { registerNodeProxyRoutes } = require("../packages/control-plane/src/control-plane/http/node-proxy-routes.ts");
const { ControlPlaneNodeProxyRuntime } = require("../packages/control-plane/src/control-plane/proxy/runtime.ts");
const { ControlPlaneProxyEventHub } = require("../packages/control-plane/src/control-plane/proxy/event-hub.ts");
const {
  projectControlPlaneProxyTarget,
  publicControlPlaneProxyTarget,
} = require("../packages/control-plane/src/control-plane/proxy/target-projector.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");

const timestamp = new Date().toISOString();
const binding = {
  id: "proxy_binding_ab",
  claimId: "proxy_claim_ab",
  sourceControlPlaneId: "control_plane_a",
  targetNodeId: "node_b",
  bindingKeyId: "proxy_key_ab",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const node = {
  id: "node_b",
  name: "Node B",
  connectionMode: "reverse-wss",
  connectionPath: { kind: "direct" },
  auth: { mode: "paired-hmac", keyId: "node_key", secret: "node_secret" },
  status: "online",
  health: "ok",
  capabilities: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};

function authHeaders(overrides = {}) {
  return {
    [CONTROL_PLANE_PROXY_AUTH_HEADERS.protocolVersion]: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    [CONTROL_PLANE_PROXY_AUTH_HEADERS.sourceControlPlaneId]: binding.sourceControlPlaneId,
    [CONTROL_PLANE_PROXY_AUTH_HEADERS.bindingKeyId]: binding.bindingKeyId,
    [CONTROL_PLANE_PROXY_AUTH_HEADERS.credential]: "credential-value-that-is-long-enough",
    ...overrides,
  };
}

function authority() {
  return {
    authenticateBinding(id, input) {
      assert.equal(id, binding.id);
      assert.equal(input.sourceControlPlaneId, binding.sourceControlPlaneId);
      assert.equal(input.bindingKeyId, binding.bindingKeyId);
      assert.equal(input.credential, "credential-value-that-is-long-enough");
      return binding;
    },
    revokeBinding(id) {
      assert.equal(id, binding.id);
      return { ...binding, status: "revoked", revision: 2, revokedAt: timestamp };
    },
  };
}

function disconnectedEventHub() {
  return new ControlPlaneProxyEventHub(new ControlPlaneEventBus(), { projectTarget: () => targetProjection(node.id) });
}

function targetProjection(id) {
  return {
    id,
    name: id === node.id ? node.name : "Other Node",
    status: "online",
    health: "ok",
    capabilities: {},
  };
}

function manageableTargetProjection(id) {
  return { ...targetProjection(id), manageable: true };
}

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  closes = [];
  send(data, options) { this.sent.push({ data, options }); }
  close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); }
}

test("reverse-wss proxy target projection treats the live tunnel as authoritative over stale persisted status", () => {
  const staleNode = { ...node, status: "offline", health: "unknown" };
  const target = projectControlPlaneProxyTarget(staleNode, true);
  assert.equal(target.status, "online");
  assert.equal(target.manageable, true);
  assert.deepEqual(publicControlPlaneProxyTarget(target), {
    id: node.id,
    name: node.name,
    status: "online",
    health: "unknown",
    capabilities: {},
  });
});

test("binding-scoped HTTP proxy streams status/body and only allowlisted application headers", async (t) => {
  const app = Fastify({ logger: false });
  const requests = [];
  registerNodeProxyRoutes({
    app,
    authority: authority(),
    eventHub: disconnectedEventHub(),
    projectTarget: () => manageableTargetProjection(node.id),
    resolveTarget: async () => ({
      node,
      transport: {
        request() { throw new Error("ordinary request primitive must not buffer proxy responses"); },
        async requestStream(target, route, init) {
          requests.push({ target, route, init });
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("first-"));
              controller.enqueue(Buffer.from("second"));
              controller.close();
            },
          }), {
            status: 207,
            headers: {
              "content-type": "application/octet-stream",
              "server-timing": "node_proxy;dur=18.0",
              "x-request-id": "request_b",
              "x-private-node-header": "must-not-cross",
            },
          });
        },
        proxyWebSocket() {},
      },
    }),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/api/node-proxy/bindings/${binding.id}/http/instances?state=active`,
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      authorization: "Bearer application-token",
      "x-request-id": "request_a",
      "x-task-handoff-trace-id": "trace_proxy_a",
      "x-unrelated": "drop-me",
    },
    payload: { action: "list" },
  });

  assert.equal(response.statusCode, 207, response.body);
  assert.equal(response.body, "first-second");
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(response.headers["x-request-id"], "request_a");
  assert.equal(response.headers["x-task-handoff-trace-id"], "trace_proxy_a");
  assert.match(response.headers["server-timing"], /node_proxy;dur=18\.0/);
  assert.match(response.headers["server-timing"], /proxy_forward;dur=/);
  assert.equal(response.headers["x-private-node-header"], undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].target.id, node.id);
  assert.equal(requests[0].route, "/instances?state=active");
  assert.deepEqual(requests[0].init.headers, { authorization: "Bearer application-token", "content-type": "application/json", "x-request-id": "request_a", "x-task-handoff-trace-id": "trace_proxy_a" });
  assert.deepEqual(JSON.parse(Buffer.from(requests[0].init.body).toString()), { action: "list" });
  assert.equal(requests[0].init.signal.aborted, false);
});

test("HTTP proxy rejects missing machine auth, encoded traversal, and forged node transport headers", async (t) => {
  const app = Fastify({ logger: false });
  let forwarded = 0;
  registerNodeProxyRoutes({
    app,
    authority: authority(),
    eventHub: disconnectedEventHub(),
    projectTarget: () => manageableTargetProjection(node.id),
    resolveTarget: async () => ({
      node,
      transport: {
        async requestStream() { forwarded += 1; return new Response("unexpected"); },
        request() {},
        proxyWebSocket() {},
      },
    }),
  });
  t.after(() => app.close());

  const unauthenticated = await app.inject({ method: "GET", url: `/api/node-proxy/bindings/${binding.id}/http/health` });
  assert.equal(unauthenticated.statusCode, 426);
  assert.equal(unauthenticated.json().error.code, "CONTROL_PLANE_PROXY_PROTOCOL_UNSUPPORTED");

  const traversal = await app.inject({
    method: "GET",
    url: `/api/node-proxy/bindings/${binding.id}/http/%252e%252e/health`,
    headers: authHeaders(),
  });
  assert.equal(traversal.statusCode, 400, traversal.body);
  assert.equal(traversal.json().error.code, "CONTROL_PLANE_PROXY_ROUTE_INVALID");

  const forged = await app.inject({
    method: "GET",
    url: `/api/node-proxy/bindings/${binding.id}/http/health`,
    headers: { ...authHeaders(), "x-taskhandoff-node-id": "node_other" },
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.equal(forged.json().error.code, "CONTROL_PLANE_PROXY_HEADER_INVALID");

  const invalidCorrelation = await app.inject({
    method: "GET",
    url: `/api/node-proxy/bindings/${binding.id}/http/health`,
    headers: authHeaders({ "x-request-id": "invalid request id" }),
  });
  assert.equal(invalidCorrelation.statusCode, 400, invalidCorrelation.body);
  assert.equal(invalidCorrelation.json().error.code, "CONTROL_PLANE_PROXY_HEADER_INVALID");

  const invalidTrace = await app.inject({
    method: "GET",
    url: `/api/node-proxy/bindings/${binding.id}/http/health`,
    headers: authHeaders({ "x-task-handoff-trace-id": "invalid trace id" }),
  });
  assert.equal(invalidTrace.statusCode, 400, invalidTrace.body);
  assert.equal(invalidTrace.json().error.code, "CONTROL_PLANE_PROXY_HEADER_INVALID");

  const unauthenticatedInvalidJson = await app.inject({
    method: "POST",
    url: `/api/node-proxy/bindings/${binding.id}/http/health`,
    headers: { "content-type": "application/json", "x-request-id": "request_auth_error" },
    payload: "{",
  });
  assert.equal(unauthenticatedInvalidJson.statusCode, 426);
  assert.equal(unauthenticatedInvalidJson.headers["x-request-id"], "request_auth_error");

  const runtime = new ControlPlaneNodeProxyRuntime();
  const parserApp = Fastify({ logger: false });
  registerNodeProxyRoutes({
    app: parserApp,
    authority: authority(),
    eventHub: disconnectedEventHub(),
    projectTarget: () => manageableTargetProjection(node.id),
    runtime,
    resolveTarget: async () => assert.fail("invalid JSON must not reach target resolution"),
  });
  const parserFailure = await parserApp.inject({
    method: "POST",
    url: `/api/node-proxy/bindings/${binding.id}/http/health`,
    headers: { ...authHeaders(), "content-type": "application/json", "x-request-id": "request_parser_error" },
    payload: "{",
  });
  assert.equal(parserFailure.statusCode, 400);
  assert.equal(parserFailure.headers["x-request-id"], "request_parser_error");
  assert.equal(runtime.diagnostics(binding.id).activeHttp, 0);
  await parserApp.close();

  const targetOverride = await app.inject({
    method: "POST",
    url: `/api/node-proxy/bindings/${binding.id}/http/instances?targetNodeId=node_other`,
    headers: { ...authHeaders(), "content-type": "application/json" },
    payload: { nodeId: "node_other" },
  });
  assert.equal(targetOverride.statusCode, 409, targetOverride.body);
  assert.equal(targetOverride.json().error.code, "CONTROL_PLANE_PROXY_TARGET_MISMATCH");
  assert.equal(forwarded, 0);
});

test("snapshot, websocket, and event establishment revalidate the same active binding after target resolution", async () => {
  const handlers = new Map();
  const app = {
    all(route, ...args) { handlers.set(route, args.at(-1)); },
    get(route, ...args) { handlers.set(route, args.at(-1)); },
    delete(route, ...args) { handlers.set(route, args.at(-1)); },
  };
  let active = true;
  const pendingResolutions = [];
  let proxiedWebSockets = 0;
  const bus = new ControlPlaneEventBus();
  const hub = new ControlPlaneProxyEventHub(bus, { projectTarget: targetProjection });
  registerNodeProxyRoutes({
    app,
    authority: {
      authenticateBinding() {
        if (!active) {
          const error = new Error("Binding revoked.");
          Object.assign(error, {
            code: "CONTROL_PLANE_PROXY_BINDING_REVOKED",
            statusCode: 403,
            retryable: false,
            details: { bindingId: binding.id },
          });
          throw error;
        }
        return binding;
      },
      revokeBinding() { active = false; return { ...binding, status: "revoked", revision: 2 }; },
    },
    eventHub: hub,
    projectTarget: () => manageableTargetProjection(node.id),
    resolveTarget: () => new Promise((resolve) => pendingResolutions.push(resolve)),
  });

  const request = (query = {}) => ({ params: { bindingId: binding.id }, headers: authHeaders(), query });
  const resolveAfterRevoke = async (operation) => {
    active = true;
    const result = operation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pendingResolutions.length, 1);
    active = false;
    pendingResolutions.shift()({
      node,
      transport: { request() {}, requestStream() {}, proxyWebSocket() { proxiedWebSockets += 1; } },
    });
    return result;
  };

  const reply = { statusCode: 200, payload: undefined, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  await resolveAfterRevoke(() => handlers.get("/api/node-proxy/bindings/:bindingId/snapshot")(request(), reply));
  assert.equal(reply.statusCode, 403);
  assert.equal(reply.payload.error.code, "CONTROL_PLANE_PROXY_BINDING_REVOKED");

  const dataSocket = new Socket();
  await resolveAfterRevoke(() => handlers.get("/api/node-proxy/bindings/:bindingId/websocket")(dataSocket, request({ route: "/health" })));
  assert.equal(proxiedWebSockets, 0);
  assert.equal(dataSocket.closes[0].code, 1008);

  const eventSocket = new Socket();
  await resolveAfterRevoke(() => handlers.get("/api/node-proxy/bindings/:bindingId/events")(eventSocket, request({ sinceRevision: 0 })));
  assert.equal(hub.diagnostics(node.id).subscribers, 0);
  assert.equal(eventSocket.closes[0].code, 1008);
  hub.stop();
});

test("binding-authenticated WebSocket route uses the target transport and preserves frames", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  let observed;
  registerNodeProxyRoutes({
    app,
    authority: authority(),
    eventHub: disconnectedEventHub(),
    projectTarget: () => manageableTargetProjection(node.id),
    resolveTarget: async () => ({
      node,
      transport: {
        request() {},
        requestStream() {},
        proxyWebSocket(target, socket, route, protocols, headers) {
          observed = { target, route, protocols, headers };
          socket.on("message", (data, isBinary) => socket.send(
            isBinary ? data : Buffer.from(`echo:${String(data)}`),
            { binary: Boolean(isBinary) },
          ));
        },
      },
    }),
  });
  await app.ready();
  const client = await app.injectWS(
    `/api/node-proxy/bindings/${binding.id}/websocket?route=${encodeURIComponent("/terminal?mode=raw")}`,
    { headers: authHeaders({ "x-request-id": "request_ws" }) },
  );
  t.after(async () => {
    client.terminate();
    await app.close();
  });
  client.send("hello");
  const [reply, isBinary] = await once(client, "message");

  assert.equal(String(reply), "echo:hello");
  assert.equal(isBinary, false);
  assert.equal(observed.target.id, node.id);
  assert.equal(observed.route, "/terminal?mode=raw");
  assert.equal(observed.protocols, undefined);
  assert.deepEqual(observed.headers, { "x-request-id": "request_ws" });
});

test("runtime enforces per-binding quotas and revoke aborts HTTP and closes WebSockets", () => {
  const runtime = new ControlPlaneNodeProxyRuntime({
    maxConcurrentHttpPerBinding: 1,
    maxConcurrentStreamsPerBinding: 1,
    maxHttpRequestsPerMinutePerBinding: 2,
    maxConcurrentWebSocketsPerBinding: 1,
    maxRequestBodyBytes: 4,
    maxHttpResponseBytes: 6,
    maxWebSocketFrameBytes: 4,
    maxWebSocketBytes: 6,
    webSocketIdleTimeoutMs: 60_000,
  });
  const request = runtime.openHttp(binding.id, 4);
  assert.throws(() => runtime.openHttp(binding.id, 1), (error) => error.code === "CONTROL_PLANE_PROXY_RESOURCE_LIMIT");
  assert.throws(() => runtime.openHttp("binding_other", 5), (error) => error.details.resource === "request-body");

  const raw = new Socket();
  const wrapped = runtime.openWebSocket(binding.id, raw);
  wrapped.on("message", () => undefined);
  assert.throws(() => runtime.openWebSocket(binding.id, new Socket()), (error) => error.details.resource === "websocket-concurrency");
  const closed = runtime.closeBinding(binding.id, "revoked");

  assert.deepEqual(closed, { abortedRequests: 1, closedSockets: 1 });
  assert.equal(request.controller.signal.aborted, true);
  assert.deepEqual(raw.closes, [{ code: 1008, reason: "revoked" }]);
  assert.deepEqual(runtime.diagnostics(binding.id), { bindingId: binding.id, activeHttp: 0, activeStreams: 0, activeWebSockets: 0 });

  const oversized = new Socket();
  const limited = runtime.openWebSocket("binding_frame", oversized);
  limited.on("message", () => assert.fail("oversized frame must not reach the transport"));
  oversized.emit("message", "12345", false);
  assert.equal(oversized.closes[0].code, 1009);
});

test("runtime isolates HTTP stream concurrency, response byte, and request rate limits by binding", () => {
  const runtime = new ControlPlaneNodeProxyRuntime({
    maxConcurrentHttpPerBinding: 4,
    maxConcurrentStreamsPerBinding: 1,
    maxHttpRequestsPerMinutePerBinding: 2,
    maxHttpResponseBytes: 4,
    httpStreamIdleTimeoutMs: 60_000,
  });
  const first = runtime.openHttp("binding_limited", 0);
  const second = runtime.openHttp("binding_limited", 0);
  first.beginResponseStream();
  assert.throws(() => second.beginResponseStream(), (error) => error.details.resource === "stream-concurrency");
  assert.throws(() => first.acceptResponseChunk("12345"), (error) => error.details.resource === "response-bytes");
  assert.equal(first.controller.signal.aborted, true);
  assert.throws(() => runtime.openHttp("binding_limited", 0), (error) => error.details.resource === "request-rate");

  const isolated = runtime.openHttp("binding_other", 0);
  isolated.beginResponseStream();
  assert.equal(runtime.diagnostics("binding_other").activeStreams, 1);
  first.release();
  second.release();
  isolated.release();
});

test("runtime expires idle request-rate windows without dropping live rate enforcement", async () => {
  const runtime = new ControlPlaneNodeProxyRuntime({
    maxHttpRequestsPerMinutePerBinding: 1,
    httpRequestWindowMs: 5,
  });
  const tracked = runtime.reserveHttp("binding_window");
  tracked.release();
  assert.equal(runtime.requestWindows.size, 1);
  assert.throws(() => runtime.reserveHttp("binding_window"), (error) => error.details.resource === "request-rate");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(runtime.requestWindows.size, 0);
  const revoked = runtime.reserveHttp("binding_revoked_window");
  revoked.release();
  runtime.closeBinding("binding_revoked_window");
  assert.equal(runtime.requestWindows.has("binding_revoked_window"), false);
});

test("event hub rejects invalid and oversized projections without consuming revisions", () => {
  const bus = new ControlPlaneEventBus();
  let projection = { ...targetProjection(node.id), name: "" };
  const hub = new ControlPlaneProxyEventHub(bus, {
    maxEventBytes: 1024,
    projectTarget: () => projection,
  });
  bus.publish("node.invalid", {}, { scope: { nodeId: node.id }, topic: "nodes" });
  assert.equal(hub.cursor(node.id).revision, 0);
  projection = { ...targetProjection(node.id), capabilities: { large: "x".repeat(2048) } };
  bus.publish("node.oversized", {}, { scope: { nodeId: node.id }, topic: "nodes" });
  assert.equal(hub.cursor(node.id).revision, 0);
  projection = targetProjection(node.id);
  bus.publish("node.valid", {}, { scope: { nodeId: node.id }, topic: "nodes" });
  assert.equal(hub.cursor(node.id).revision, 1);
  hub.stop();
});

test("event hub isolates target projection failures from authoritative event publishers", () => {
  const bus = new ControlPlaneEventBus();
  const hub = new ControlPlaneProxyEventHub(bus, {
    projectTarget: () => {
      throw Object.assign(new Error("target projection is too large"), { code: "CONTROL_PLANE_PROXY_RESOURCE_LIMIT" });
    },
  });

  assert.doesNotThrow(() => bus.publish("node.updated", { nodeId: node.id }, { scope: { nodeId: node.id }, topic: "nodes" }));
  assert.equal(hub.cursor(node.id).revision, 0);
  hub.stop();
});

test("event hub closes a live subscriber immediately when event delivery fails", () => {
  const bus = new ControlPlaneEventBus();
  const hub = new ControlPlaneProxyEventHub(bus, { projectTarget: targetProjection });
  let deliveryFailures = 0;
  hub.subscribe({
    bindingId: binding.id,
    sourceControlPlaneId: binding.sourceControlPlaneId,
    targetNodeId: node.id,
  }, 0, (message) => {
    if (message.type === "control-plane-proxy.event") throw new Error("socket send failed");
  }, () => {
    deliveryFailures += 1;
  });

  assert.doesNotThrow(() => bus.publish("node.updated", {}, { scope: { nodeId: node.id }, topic: "nodes" }));
  assert.equal(deliveryFailures, 1);
  assert.equal(hub.diagnostics(node.id).subscribers, 0);
  hub.stop();
});

test("machine proxy access logs do not include forwarded route query values", async (t) => {
  const logs = [];
  const app = Fastify({ logger: { level: "info", stream: { write(line) { logs.push(String(line)); } } } });
  registerNodeProxyRoutes({
    app,
    authority: authority(),
    eventHub: disconnectedEventHub(),
    projectTarget: () => manageableTargetProjection(node.id),
    resolveTarget: async () => ({
      node,
      transport: { request() {}, async requestStream() { return new Response("ok"); }, proxyWebSocket() {} },
    }),
  });
  t.after(() => app.close());
  const secret = "query-secret-must-not-be-logged";
  const response = await app.inject({
    method: "GET",
    url: `/api/node-proxy/bindings/${binding.id}/http/health?token=${secret}`,
    headers: authHeaders(),
  });
  assert.equal(response.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.join("").includes(secret), false);
});

test("event hub isolates targets, preserves source identity, replays retained events, and reports gaps", () => {
  const bus = new ControlPlaneEventBus();
  const hub = new ControlPlaneProxyEventHub(bus, {
    historyLimit: 2,
    createStreamId: (targetId) => `stream_${targetId}`,
    projectTarget: targetProjection,
  });
  const other = bus.publish("node.updated", { nodeId: "node_other" }, { scope: { nodeId: "node_other" }, topic: "nodes" });
  const first = bus.publish("instance.updated", { instanceId: "instance_1" }, { scope: { nodeId: node.id, instanceId: "instance_1" }, topic: "instances" });
  const second = bus.publish("instance.updated", { instanceId: "instance_2" }, { scope: { nodeId: node.id, instanceId: "instance_2" }, topic: "instances" });
  const third = bus.publish("node.checked", { nodeId: node.id }, { scope: { nodeId: node.id }, topic: "node.state" });

  const replay = [];
  const subscription = hub.subscribe({ bindingId: binding.id, sourceControlPlaneId: binding.sourceControlPlaneId, targetNodeId: node.id }, 1, (message) => replay.push(message));
  assert.equal(subscription.kind, "subscribed");
  assert.deepEqual(replay.map((message) => message.type), [
    "control-plane-proxy.events.ready",
    "control-plane-proxy.event",
    "control-plane-proxy.event",
  ]);
  assert.deepEqual(replay.slice(1).map((message) => message.revision), [2, 3]);
  assert.equal(replay[1].source.id, second.id);
  assert.equal(replay[1].source.seq, second.seq);
  assert.equal(replay[1].bindingId, binding.id);
  assert.equal(replay[1].sourceControlPlaneId, binding.sourceControlPlaneId);
  assert.deepEqual(replay[1].target, targetProjection(node.id));
  assert.equal(replay[2].source.id, third.id);
  assert.notEqual(replay[1].source.id, other.id);
  assert.notEqual(replay[1].source.id, first.id);

  const gap = [];
  const gapSubscription = hub.subscribe({ bindingId: binding.id, sourceControlPlaneId: binding.sourceControlPlaneId, targetNodeId: node.id }, 0, (message) => gap.push(message));
  assert.equal(gapSubscription.kind, "snapshot-required");
  assert.equal(gap[0].type, "control-plane-proxy.snapshot-required");
  assert.equal(gap[0].error.code, "CONTROL_PLANE_PROXY_SNAPSHOT_REQUIRED");
  assert.equal(gap[0].earliestRetainedRevision, 2);
  assert.equal(hub.diagnostics("node_other").revision, 1);
  assert.equal(hub.diagnostics(node.id).subscribers, 1);
  assert.deepEqual(hub.diagnostics(node.id).subscriberBindings, [{ bindingId: binding.id, sourceControlPlaneId: binding.sourceControlPlaneId }]);
  subscription.close();
  hub.stop();
});

test("snapshot and event routes share a cursor, stream live target events, and revoke closes the event socket", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const bus = new ControlPlaneEventBus();
  const hub = new ControlPlaneProxyEventHub(bus, { createStreamId: () => "proxy_stream_b", projectTarget: targetProjection });
  const runtime = new ControlPlaneNodeProxyRuntime({ webSocketIdleTimeoutMs: 60_000 });
  registerNodeProxyRoutes({
    app,
    authority: authority(),
    eventHub: hub,
    runtime,
    projectTarget: () => manageableTargetProjection(node.id),
    resolveTarget: async () => ({ node, transport: { request() {}, requestStream() {}, proxyWebSocket() {} } }),
  });
  await app.ready();

  bus.publish("node.checked", { nodeId: "node_other" }, { scope: { nodeId: "node_other" } });
  const source = bus.publish("node.checked", { nodeId: node.id }, { scope: { nodeId: node.id } });
  const snapshot = await app.inject({
    method: "GET",
    url: `/api/node-proxy/bindings/${binding.id}/snapshot`,
    headers: authHeaders(),
  });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  const projection = snapshot.json().data;
  assert.equal(projection.streamId, "proxy_stream_b");
  assert.equal(projection.revision, 1);
  assert.equal(projection.binding.id, binding.id);
  assert.equal(projection.binding.sourceControlPlaneId, binding.sourceControlPlaneId);
  assert.equal(projection.binding.targetNodeId, binding.targetNodeId);
  assert.deepEqual(projection.target, {
    id: node.id,
    name: node.name,
    status: "online",
    health: "ok",
    capabilities: {},
  });
  assert.equal(snapshot.body.includes("node_secret"), false);
  assert.equal(snapshot.body.includes("connectionPath"), false);

  const messages = [];
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const client = await app.injectWS(
    `/api/node-proxy/bindings/${binding.id}/events?sinceRevision=1`,
    { headers: authHeaders() },
    { onInit(ws) { ws.on("message", (raw) => { messages.push(JSON.parse(String(raw))); resolveReady(); }); } },
  );
  t.after(async () => {
    for (const serverSocket of app.websocketServer.clients) serverSocket.terminate();
    client.terminate();
    hub.stop();
    await app.close();
  });
  await ready;
  assert.equal(messages[0].type, "control-plane-proxy.events.ready");
  assert.equal(messages[0].bindingId, binding.id);
  assert.equal(messages[0].sourceControlPlaneId, binding.sourceControlPlaneId);
  assert.equal(hub.diagnostics(node.id).subscribers, 1);

  let resolveLive;
  const live = new Promise((resolve) => { resolveLive = resolve; });
  client.on("message", () => resolveLive());
  bus.publish("node.checked", { nodeId: "node_other" }, { scope: { nodeId: "node_other" } });
  const liveSource = bus.publish(
    "instance.updated",
    { instanceId: "instance_live", credential: "event-secret-must-not-cross" },
    { scope: { nodeId: node.id, instanceId: "instance_live", internal: "private-metadata" } },
  );
  await live;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].source.id, liveSource.id);
  assert.equal(messages[1].source.seq, liveSource.seq);
  assert.equal(messages[1].targetNodeId, binding.targetNodeId);
  assert.equal(messages[1].bindingId, binding.id);
  assert.equal(messages[1].sourceControlPlaneId, binding.sourceControlPlaneId);
  assert.deepEqual(messages[1].target, targetProjection(node.id));
  assert.deepEqual(messages[1].event, {
    type: liveSource.type,
    topic: liveSource.topic,
    createdAt: liveSource.createdAt,
  });
  assert.equal(JSON.stringify(messages[1]).includes("event-secret-must-not-cross"), false);
  assert.equal(JSON.stringify(messages[1]).includes("private-metadata"), false);
  assert.equal(messages[1].source.id === source.id, false);

  const closed = once(client, "close");
  const revoked = await app.inject({
    method: "DELETE",
    url: `/api/node-proxy/bindings/${binding.id}`,
    headers: authHeaders(),
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().data.closed.closedSockets, 1);
  const [closeCode] = await closed;
  assert.equal(closeCode, 1008);
  assert.equal(hub.diagnostics(node.id).subscribers, 0);

});
