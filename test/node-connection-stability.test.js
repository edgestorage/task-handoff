const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { CONTROL_PLANE_PROTOCOL_VERSION, ControlledInstanceSchema, NodeAgentControlPlaneConnectionSchema, NodeAgentHealthSchema, NodeConnectionDiagnosticsSchema } = require("../packages/protocol/src/control-plane.ts");
const { ControlPlaneFleetDirectoryMetaSchema } = require("../packages/protocol/src/control-plane-directory.ts");
const { ControlPlaneNodeAgentClient } = require("../packages/control-plane/src/control-plane/nodes/client.ts");
const { ControlPlaneNodeAgentGateway } = require("../packages/control-plane/src/control-plane/nodes/gateway.ts");
const { NodeConnectionRuntime } = require("../packages/control-plane/src/control-plane/nodes/connection-runtime.ts");
const { createDirectNodeAgentTransport } = require("../packages/control-plane/src/control-plane/nodes/direct-transport.ts");
const { ControlPlaneNodeAgentTunnelTransport, ControlPlaneNodeEventSubscriber } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");
const { NodeTunnelIngress } = require("../packages/control-plane/src/control-plane/nodes/tunnel-ingress.ts");
const { WebSocketConnectionSupervisor } = require("../packages/control-plane/src/shared/transport/websocket-connection-supervisor.ts");

function fakeClock() {
  let timestamp = 0;
  let sequence = 0;
  const tasks = new Map();
  const setTimeoutFn = (callback, delay) => {
    const handle = { id: ++sequence, unref() {} };
    tasks.set(handle, { callback, at: timestamp + delay });
    return handle;
  };
  const clearTimeoutFn = (handle) => tasks.delete(handle);
  const advance = (duration) => {
    const target = timestamp + duration;
    while (true) {
      const next = [...tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0].id - right[0].id)[0];
      if (!next) break;
      tasks.delete(next[0]);
      timestamp = next[1].at;
      next[1].callback();
    }
    timestamp = target;
  };
  return { advance, clearTimeoutFn, now: () => timestamp, setTimeoutFn };
}

test("shared websocket supervisor detects connect handshake and half-open failures", () => {
  const clock = fakeClock();
  const timeouts = [];
  let pings = 0;
  let stable = 0;
  const supervisor = new WebSocketConnectionSupervisor({
    connectTimeoutMs: 10,
    handshakeTimeoutMs: 8,
    heartbeatIntervalMs: 6,
    heartbeatTimeoutMs: 4,
    stableThresholdMs: 20,
    ...clock,
    ping: () => { pings += 1; },
    onStable: () => { stable += 1; },
    onTimeout: (kind) => timeouts.push(kind),
  });

  supervisor.start();
  clock.advance(5);
  supervisor.opened();
  clock.advance(3);
  supervisor.healthy();
  clock.advance(6);
  assert.equal(pings, 1);
  clock.advance(4);
  assert.equal(pings, 2);
  assert.deepEqual(timeouts, []);
  clock.advance(4);
  assert.deepEqual(timeouts, ["heartbeat"]);
  assert.equal(supervisor.phase, "failed");
  assert.equal(stable, 0);
});

test("shared websocket supervisor treats business traffic as liveness and requires consecutive missed probes", () => {
  const clock = fakeClock();
  const timeouts = [];
  let pings = 0;
  const supervisor = new WebSocketConnectionSupervisor({
    heartbeatIntervalMs: 6,
    heartbeatTimeoutMs: 4,
    heartbeatMissThreshold: 2,
    ...clock,
    ping: () => { pings += 1; },
    onTimeout: (kind) => timeouts.push(kind),
  });
  supervisor.start();
  supervisor.opened();
  supervisor.healthy();

  clock.advance(6);
  assert.equal(pings, 1);
  clock.advance(3);
  supervisor.activity();
  clock.advance(6);
  assert.equal(pings, 2);
  clock.advance(4);
  assert.equal(pings, 3);
  supervisor.pong();
  clock.advance(6);
  assert.equal(pings, 4);
  assert.deepEqual(timeouts, []);
});

test("shared websocket supervisor resets retry only after a stable healthy window", () => {
  const clock = fakeClock();
  let stable = 0;
  const supervisor = new WebSocketConnectionSupervisor({
    connectTimeoutMs: 10,
    handshakeTimeoutMs: 10,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10,
    stableThresholdMs: 20,
    ...clock,
    ping() {},
    onStable: () => { stable += 1; },
    onTimeout: () => assert.fail("connection should remain healthy"),
  });
  supervisor.start();
  supervisor.opened();
  supervisor.healthy();
  clock.advance(19);
  assert.equal(stable, 0);
  clock.advance(1);
  assert.equal(stable, 1);
  supervisor.close();
});

test("shared websocket supervisor reports current and recent p95 ping RTT", () => {
  const clock = fakeClock();
  const supervisor = new WebSocketConnectionSupervisor({
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 100,
    ...clock,
    ping() {},
    onTimeout: () => assert.fail("connection should remain healthy"),
  });
  supervisor.start();
  supervisor.opened();
  supervisor.healthy();

  for (const rtt of [5, 8, 3, 12]) {
    clock.advance(10);
    clock.advance(rtt);
    supervisor.pong();
  }

  assert.deepEqual(supervisor.diagnostics(), {
    phase: "healthy",
    stable: false,
    pingRttMs: 12,
    pingRttP95Ms: 12,
    lastActivityAt: new Date(clock.now()).toISOString(),
    lastPongAt: new Date(clock.now()).toISOString(),
  });
});

test("control-plane connection diagnostics remain optional across the v0.0.21 boundary", () => {
  const base = {
    id: "connection_1",
    pairingKeyId: "key_1",
    url: "https://control.example.test",
    enabled: true,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    status: "connected",
  };
  assert.equal(NodeAgentControlPlaneConnectionSchema.safeParse(base).success, true);
  assert.deepEqual(NodeAgentControlPlaneConnectionSchema.parse({
    ...base,
    pingRttMs: 18,
    pingRttP95Ms: 31,
    consecutiveReconnects: 2,
    nextRetryAt: "2026-08-18T00:00:05.000Z",
  }), {
    ...base,
    pingRttMs: 18,
    pingRttP95Ms: 31,
    consecutiveReconnects: 2,
    nextRetryAt: "2026-08-18T00:00:05.000Z",
  });
});

test("node connection diagnostics validate the ephemeral public projection", () => {
  assert.deepEqual(NodeConnectionDiagnosticsSchema.parse({
    pingRttMs: 9,
    pingRttP95Ms: 14,
    consecutiveReconnects: 3,
    nextRetryAt: "2026-08-20T00:00:05.000Z",
  }), {
    pingRttMs: 9,
    pingRttP95Ms: 14,
    consecutiveReconnects: 3,
    nextRetryAt: "2026-08-20T00:00:05.000Z",
  });
});

test("runtime projection rejects persisted direct HTTP health until the control API is observed", () => {
  const runtime = new NodeConnectionRuntime();
  const observations = [];
  runtime.onChange((observation) => observations.push(observation));
  const node = {
    id: "node_runtime",
    name: "Node",
    connectionMode: "direct-http",
    connectionEnabled: true,
    status: "online",
    health: "ok",
    auth: { mode: "paired-hmac" },
    labels: {},
    capabilities: {},
    connectionPath: { kind: "direct" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.equal(runtime.project(node).status, "unknown");
  const first = runtime.begin(node.id, "direct-http");
  assert.equal(runtime.project(node).connectionPhase, "connecting");
  const second = runtime.begin(node.id, "direct-http");
  assert.equal(runtime.connected(node.id, first), false);
  assert.equal(runtime.connected(node.id, second), true);
  assert.equal(runtime.project(node).status, "unknown");
  assert.equal(runtime.observedReachable(node), true);
  assert.equal(runtime.project(node).status, "online");
  assert.equal(runtime.project(node).connectionPhase, "healthy");
  assert.deepEqual(runtime.project(node).connectionDiagnostics, { consecutiveReconnects: 0 });
  assert.equal(runtime.pong(node.id, second, { pingRttMs: 7, pingRttP95Ms: 11 }), true);
  assert.deepEqual(runtime.project(node).connectionDiagnostics, {
    pingRttMs: 7,
    pingRttP95Ms: 11,
    consecutiveReconnects: 0,
  });
  const publishedAfterReachable = observations.length;
  const controlChangedAt = runtime.observation(node.id).controlChangedAt;
  assert.equal(runtime.observedReachable(node), true);
  assert.equal(observations.length, publishedAfterReachable);
  assert.equal(runtime.observation(node.id).controlChangedAt, controlChangedAt);
  runtime.disconnected(node.id, second, { error: "closed", nextRetryAt: "2026-08-20T00:00:05.000Z" });
  assert.equal(runtime.project(node).status, "online");
  assert.equal(runtime.project(node).connectionPhase, "healthy");
  assert.deepEqual(runtime.project(node).connectionDiagnostics, {
    pingRttMs: 7,
    pingRttP95Ms: 11,
    consecutiveReconnects: 1,
    nextRetryAt: "2026-08-20T00:00:05.000Z",
  });
  assert.equal(runtime.observedFailure(node, "request timed out"), true);
  assert.equal(runtime.project(node).status, "offline");
  assert.equal(runtime.project(node).health, "failed");
});

test("reverse tunnel becomes healthy only after identify and ignores a replaced generation", () => {
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.sent = [];
      this.failSend = false;
    }
    send(value) {
      if (this.failSend) throw new Error("reverse subscription send failed");
      this.sent.push(String(value));
    }
    ping() {}
    terminate() { this.readyState = 3; this.emit("close", 1006, Buffer.alloc(0)); }
    close(code = 1000, reason = "") { this.readyState = 3; this.emit("close", code, Buffer.from(reason)); }
  }
  const runtime = new NodeConnectionRuntime();
  const transport = new ControlPlaneNodeAgentTunnelTransport(undefined, { connectionRuntime: runtime });
  transport.setEventSubscription("node_reverse", {
    legacyAll: false,
    messageDeltas: { allInstances: false, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  });
  const ingress = new NodeTunnelIngress(transport);
  const first = new Socket();
  ingress.attachMain("node_reverse", first);
  assert.equal(JSON.parse(first.sent[0]).type, "control-plane.hello");
  assert.equal(runtime.observation("node_reverse").phase, "handshaking");
  first.emit("message", JSON.stringify({ type: "node-agent.identify" }));
  assert.equal(runtime.observation("node_reverse").phase, "healthy");
  assert.equal(JSON.parse(first.sent[1]).type, "control-plane.identified");
  assert.deepEqual(JSON.parse(first.sent[2]), {
    type: "control-plane.event-subscribe",
    aiSessionTransient: {
      messageDeltas: { allInstances: false, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [],
    },
  });

  const second = new Socket();
  ingress.attachMain("node_reverse", second);
  assert.equal(runtime.observation("node_reverse").phase, "handshaking");
  first.emit("close", 1006, Buffer.alloc(0));
  assert.equal(runtime.observation("node_reverse").phase, "handshaking");
  second.emit("message", JSON.stringify({ type: "node-agent.identify" }));
  assert.equal(runtime.observation("node_reverse").phase, "healthy");
  second.failSend = true;
  assert.doesNotThrow(() => transport.setEventSubscription("node_reverse", {
    legacyAll: false,
    messageDeltas: { allInstances: true, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  }));
  assert.equal(runtime.observation("node_reverse").phase, "offline");
  const third = new Socket();
  ingress.attachMain("node_reverse", third);
  assert.equal(JSON.parse(third.sent[0]).type, "control-plane.hello");
  third.emit("message", JSON.stringify({ type: "node-agent.identify" }));
  assert.equal(JSON.parse(third.sent[2]).aiSessionTransient.messageDeltas.allInstances, true);
  third.emit("close", 1000, Buffer.alloc(0));
});

test("direct requests enforce total and streaming-header deadlines", async () => {
  const neverRespond = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const transport = createDirectNodeAgentTransport(neverRespond, { requestTimeoutMs: 5, streamHeaderTimeoutMs: 5 });
  const node = {
    id: "node_direct_timeout",
    connectionMode: "direct-http",
    endpoint: "http://127.0.0.1:18080",
    auth: { mode: "local-static-key", secret: "secret" },
  };
  await assert.rejects(transport.request(node, "/health"), (error) => error?.name === "TimeoutError");
  await assert.rejects(transport.requestStream(node, "/logs"), (error) => error?.code === "NODE_AGENT_RESPONSE_HEADER_TIMEOUT");
});

test("fleet aggregation serves node snapshots without waiting for a slow or reconnecting agent", async () => {
  const timestamp = new Date().toISOString();
  const runtime = {
    id: "runtime_cached",
    nodeId: "node_cached",
    name: "Cached Runtime",
    type: "docker",
    status: "online",
    accessStrategy: "direct-port",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let requests = 0;
  let slow = false;
  const client = new ControlPlaneNodeAgentClient({
    request: async () => {
      requests += 1;
      if (slow) return new Promise(() => undefined);
      return new Response(JSON.stringify({ data: [runtime] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const gateway = new ControlPlaneNodeAgentGateway(client, { fleetRequestTimeoutMs: 5 });
  const node = {
    id: "node_cached",
    connectionMode: "direct-http",
    status: "online",
    auth: { mode: "paired-hmac", keyId: "key_cached" },
    connectionPhase: "healthy",
  };

  const initial = await gateway.listFleetRuntimes([node]);
  assert.deepEqual(initial.items.map((item) => item.id), [runtime.id]);
  assert.deepEqual(initial.nodeErrors, []);

  slow = true;
  const startedAt = Date.now();
  const timedOut = await gateway.listFleetRuntimes([node]);
  assert.ok(Date.now() - startedAt < 100);
  assert.deepEqual(timedOut.items.map((item) => item.id), [runtime.id]);
  assert.equal(timedOut.nodeErrors[0].code, "NODE_AGENT_FLEET_TIMEOUT");

  const requestsBeforeReconnect = requests;
  const reconnecting = await gateway.listFleetRuntimes([{ ...node, status: "offline", connectionPhase: "reconnecting" }]);
  assert.equal(requests, requestsBeforeReconnect + 1);
  assert.deepEqual(reconnecting.items.map((item) => item.id), [runtime.id]);
  assert.equal(reconnecting.nodeErrors[0].code, "NODE_AGENT_FLEET_TIMEOUT");

  const replacedConnection = await gateway.listFleetRuntimes([{
    ...node,
    endpoint: "https://replacement-node.example",
    status: "offline",
    connectionPhase: "connecting",
  }]);
  assert.deepEqual(replacedConnection.items, []);
});

test("instance lookup consumes the current node fleet snapshot without another request", async () => {
  const timestamp = "2026-08-21T00:00:00.000Z";
  const instance = ControlledInstanceSchema.parse({
    id: "inst_cached",
    name: "Cached instance",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_cached_instance",
    runtimeId: "runtime_cached",
    target: { strategy: "node-proxy", status: "reachable", web: "http://127.0.0.1:32100", api: "http://127.0.0.1:32100/api" },
    runtime: { labels: {} },
    registrationToken: "instance-secret",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  let requests = 0;
  const client = new ControlPlaneNodeAgentClient({
    request: async () => {
      requests += 1;
      return new Response(JSON.stringify({ data: [instance] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const gateway = new ControlPlaneNodeAgentGateway(client);
  const node = {
    id: instance.nodeId,
    connectionMode: "direct-http",
    endpoint: "http://127.0.0.1:8091",
    status: "online",
    auth: { mode: "paired-hmac", keyId: "key_cached" },
    connectionPhase: "healthy",
  };

  await gateway.listFleetInstances([node]);
  assert.equal(requests, 1);
  assert.equal(gateway.instanceFromSnapshot([node], instance.id)?.id, instance.id);
  assert.equal(requests, 1);
  assert.equal(gateway.instanceFromSnapshot([{ ...node, endpoint: "http://127.0.0.1:8092" }], instance.id), undefined);
});

test("fleet snapshots expose each node as soon as that node finishes", async () => {
  const timestamp = "2026-08-22T00:00:00.000Z";
  const runtime = (nodeId) => ({
    id: `runtime_${nodeId}`,
    nodeId,
    name: nodeId,
    type: "docker",
    status: "online",
    accessStrategy: "direct-port",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  let resolveSlow;
  const slowResponse = new Promise((resolve) => { resolveSlow = resolve; });
  const observed = [];
  const client = new ControlPlaneNodeAgentClient({
    request: async (node) => node.id === "node_slow"
      ? slowResponse
      : new Response(JSON.stringify({ data: [runtime(node.id)] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const gateway = new ControlPlaneNodeAgentGateway(client, { onFleetStateChanged: (state) => observed.push(state) });
  const nodes = ["node_fast", "node_slow"].map((id) => ({
    id,
    connectionMode: "direct-http",
    endpoint: `http://${id}.test`,
    status: "online",
    auth: { mode: "paired-hmac", keyId: `key_${id}` },
    connectionPhase: "healthy",
  }));

  const refresh = gateway.refreshFleetRuntimes(nodes);
  await new Promise((resolve) => setImmediate(resolve));
  const partial = gateway.readFleetRuntimes(nodes);
  assert.deepEqual(partial.items.map((item) => item.nodeId), ["node_fast"]);
  assert.equal(partial.nodeStates.find((state) => state.nodeId === "node_fast").phase, "ready");
  assert.equal(partial.nodeStates.find((state) => state.nodeId === "node_slow").phase, "loading");

  resolveSlow(new Response(JSON.stringify({ data: [runtime("node_slow")] }), { status: 200, headers: { "content-type": "application/json" } }));
  await refresh;
  assert.deepEqual(gateway.readFleetRuntimes(nodes).items.map((item) => item.nodeId), ["node_fast", "node_slow"]);
  assert.ok(observed.some((state) => state.nodeId === "node_fast" && state.phase === "ready"));
});

test("scoped fleet reads preserve snapshots owned by nodes outside the requested scope", async () => {
  const timestamp = "2026-08-22T00:00:00.000Z";
  const runtime = (nodeId) => ({
    id: `runtime_${nodeId}`,
    nodeId,
    name: nodeId,
    type: "docker",
    status: "online",
    accessStrategy: "direct-port",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const client = new ControlPlaneNodeAgentClient({
    request: async (node) => new Response(JSON.stringify({ data: [runtime(node.id)] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const gateway = new ControlPlaneNodeAgentGateway(client);
  const nodes = ["node_a", "node_b"].map((id) => ({
    id,
    connectionMode: "direct-http",
    endpoint: `http://${id}.test`,
    status: "online",
    auth: { mode: "paired-hmac", keyId: `key_${id}` },
    connectionPhase: "healthy",
  }));

  await gateway.refreshFleetRuntimes(nodes);
  assert.deepEqual(gateway.readFleetRuntimes(nodes).items.map((item) => item.nodeId), ["node_a", "node_b"]);
  assert.deepEqual(gateway.readFleetRuntimes([nodes[0]]).items.map((item) => item.nodeId), ["node_a"]);
  assert.deepEqual(gateway.readFleetRuntimes(nodes).items.map((item) => item.nodeId), ["node_a", "node_b"]);
});

test("failed fleet refreshes retry with backoff without republishing identical failure states", async () => {
  let requests = 0;
  let available = false;
  const observed = [];
  const runtime = {
    id: "runtime_retry",
    nodeId: "node_retry",
    name: "Retry runtime",
    type: "docker",
    status: "online",
    accessStrategy: "direct-port",
    capabilities: {},
    labels: {},
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
  const client = new ControlPlaneNodeAgentClient({
    request: async () => {
      requests += 1;
      if (!available) throw Object.assign(new Error("node offline"), { code: "ECONNREFUSED" });
      return new Response(JSON.stringify({ data: [runtime] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const gateway = new ControlPlaneNodeAgentGateway(client, {
    fleetRetryBaseMs: 20,
    fleetRetryMaxMs: 20,
    onFleetStateChanged: (state) => observed.push(state),
  });
  const node = {
    id: "node_retry",
    connectionMode: "direct-http",
    endpoint: "http://node-retry.test",
    status: "online",
    auth: { mode: "paired-hmac", keyId: "key_retry" },
    connectionPhase: "healthy",
  };

  await gateway.refreshFleetRuntimes([node]);
  assert.equal(requests, 1);
  assert.deepEqual(observed.map((state) => state.phase), ["loading", "error"]);
  await gateway.refreshFleetRuntimes([node]);
  assert.equal(requests, 1);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests, 2);
  assert.deepEqual(observed.map((state) => state.phase), ["loading", "error"]);

  available = true;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests, 3);
  assert.deepEqual(observed.map((state) => state.phase), ["loading", "error", "ready"]);
  assert.deepEqual(gateway.readFleetRuntimes([node]).items.map((item) => item.id), [runtime.id]);
});

test("malformed fleet responses do not republish observation-only failure changes", async () => {
  let requests = 0;
  const observed = [];
  const client = new ControlPlaneNodeAgentClient({
    request: async () => {
      requests += 1;
      return new Response(JSON.stringify({ data: [{ id: "inst_malformed" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const gateway = new ControlPlaneNodeAgentGateway(client, {
    fleetRetryBaseMs: 20,
    fleetRetryMaxMs: 20,
    onFleetStateChanged: (state) => observed.push(state),
  });
  const node = {
    id: "node_malformed",
    connectionMode: "direct-http",
    endpoint: "http://node-malformed.test",
    status: "online",
    auth: { mode: "paired-hmac", keyId: "key_malformed" },
    connectionPhase: "healthy",
  };

  await gateway.refreshFleetInstances([node]);
  assert.equal(requests, 1);
  assert.deepEqual(observed.map((state) => state.phase), ["loading", "stale"]);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests, 2);
  assert.deepEqual(observed.map((state) => state.phase), ["loading", "stale"]);
  gateway.dispose();
});

test("v0.0.21 directory metadata without node states normalizes to an empty progressive state", () => {
  assert.deepEqual(ControlPlaneFleetDirectoryMetaSchema.parse({}), { nodeStates: [] });
});

test("node agent health response drops unknown cross-version fields", () => {
  const parsed = NodeAgentHealthSchema.parse({
    ok: true,
    futureTopLevel: true,
    capabilities: { modelEndpointProbe: true, futureProbe: true },
    build: { component: "node-agent", packageVersion: "1.2.3", futureBuildField: true },
    listener: { host: "127.0.0.1", port: 8091, futureListenerField: true },
    process: { pid: 42, startIdentity: "process-start", futureProcessField: true },
  });
  assert.deepEqual(parsed, {
    ok: true,
    capabilities: { modelEndpointProbe: true },
    build: { component: "node-agent", packageVersion: "1.2.3" },
    listener: { host: "127.0.0.1", port: 8091 },
    process: { pid: 42, startIdentity: "process-start" },
  });
});

test("direct event connection terminates a half-open socket and publishes reconnecting state", async (t) => {
  const clock = fakeClock();
  let pings = 0;
  const runtime = new NodeConnectionRuntime();
  const node = {
    id: "node_direct_events",
    connectionMode: "direct-http",
    connectionEnabled: true,
    endpoint: "http://127.0.0.1:18080",
    auth: { mode: "local-static-key", secret: "secret" },
  };
  const transport = {
    proxyWebSocket(_node, socket, route) {
      assert.equal(route, "/events?aiSessionTransient=1");
      queueMicrotask(() => socket.send(JSON.stringify({ type: "node-agent.events.connected" })));
      return { ping: () => { pings += 1; } };
    },
  };
  const subscriber = new ControlPlaneNodeEventSubscriber(
    { listNodes: () => [node], resolveNodeAgentTransport: () => transport },
    { handleMessage() {} },
    {
      connectionRuntime: runtime,
      connectTimeoutMs: 20,
      handshakeTimeoutMs: 20,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 5,
      stableThresholdMs: 50,
      ...clock,
    },
  );
  t.after(() => subscriber.stop());
  subscriber.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.observation(node.id).phase, "healthy");
  clock.advance(15);
  assert.equal(pings, 2);
  assert.equal(runtime.observation(node.id).phase, "reconnecting");
});

test("proxy node event subscriber opens the authoritative node-agent event stream through the shared transport", async (t) => {
  const hellos = [];
  const opened = [];
  const node = {
    id: "node_proxy_events",
    connectionMode: "control-plane-proxy",
    connectionEnabled: true,
    connectionPath: {
      kind: "control-plane-proxy",
      proxyId: "proxy.example.test",
      proxyBindingId: "binding_proxy_events",
      targetNodeId: "node_target_events",
    },
    auth: { mode: "paired-hmac" },
  };
  const transport = {
    proxyWebSocket(target, socket, route) {
      opened.push({ target, route });
      queueMicrotask(() => socket.send(JSON.stringify({
        type: "node-agent.streams.hello",
        instanceId: "inst_proxy_events",
        payload: {
          protocolVersion: 1,
          streams: [],
        },
      })));
    },
  };
  const subscriber = new ControlPlaneNodeEventSubscriber(
    {
      listNodes: () => [node],
      resolveNodeAgentTransport: () => transport,
    },
    new ControlPlaneNodeAgentTunnelTransport(undefined, {
      onStreamsHello: (instanceId, hello) => hellos.push({ instanceId, hello }),
      validateInstanceScope: () => true,
    }),
    { safetyIntervalMs: 60_000 },
  );
  t.after(() => subscriber.stop());

  subscriber.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(opened.length, 1);
  assert.equal(opened[0].target, node);
  assert.equal(opened[0].route, "/events?aiSessionTransient=1");
  assert.equal(hellos.length, 1);
  assert.equal(hellos[0].instanceId, "inst_proxy_events");
  assert.equal(subscriber.diagnostics().activeConnections, 1);
});

test("node event subscriber sends aggregated transient demand over the reused upstream", async (t) => {
  const sent = [];
  let failControlSend = false;
  const node = {
    id: "node_transient_events",
    connectionMode: "direct-http",
    connectionEnabled: true,
    endpoint: "http://127.0.0.1:18080",
    auth: { mode: "local-static-key", secret: "secret" },
  };
  const subscriber = new ControlPlaneNodeEventSubscriber(
    {
      listNodes: () => [node],
      resolveNodeAgentTransport: () => ({
        proxyWebSocket(_node, socket) {
          queueMicrotask(() => socket.send(JSON.stringify({ type: "node-agent.events.connected" })));
          return { send: (value) => {
            if (failControlSend) throw new Error("subscription transport failed");
            sent.push(JSON.parse(String(value)));
          } };
        },
      }),
    },
    { handleMessage() {} },
    { safetyIntervalMs: 60_000 },
  );
  t.after(() => subscriber.stop());
  subscriber.setAiSessionTransientDemand({
    legacyAll: false,
    messageDeltas: { allInstances: false, instanceIds: ["instance-card"] },
    timelineAllSessions: false,
    timelineSessions: [{ instanceId: "instance-detail", sessionId: "session-detail" }],
  });
  subscriber.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.at(-1).aiSessionTransient, {
    messageDeltas: { allInstances: false, instanceIds: ["instance-card"] },
    timelineAllSessions: false,
    timelineSessions: [{ instanceId: "instance-detail", sessionId: "session-detail" }],
  });
  failControlSend = true;
  assert.doesNotThrow(() => subscriber.setAiSessionTransientDemand({
    legacyAll: false,
    messageDeltas: { allInstances: false, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  }));
  assert.equal(subscriber.diagnostics().activeConnections, 0);
});
