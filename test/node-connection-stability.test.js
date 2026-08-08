const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

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
  assert.deepEqual(timeouts, ["heartbeat"]);
  assert.equal(supervisor.phase, "failed");
  assert.equal(stable, 0);
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

test("runtime projection rejects stale generations while direct HTTP health remains authoritative", () => {
  const runtime = new NodeConnectionRuntime();
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
  assert.equal(runtime.project(node).status, "online");
  const first = runtime.begin(node.id, "direct-http");
  assert.equal(runtime.project(node).connectionPhase, "connecting");
  const second = runtime.begin(node.id, "direct-http");
  assert.equal(runtime.connected(node.id, first), false);
  assert.equal(runtime.connected(node.id, second), true);
  assert.equal(runtime.project(node).status, "online");
  assert.equal(runtime.project(node).connectionPhase, "healthy");
  runtime.disconnected(node.id, second, { error: "closed" });
  assert.equal(runtime.project(node).status, "online");
  assert.equal(runtime.project(node).connectionPhase, "offline");
});

test("reverse tunnel becomes healthy only after identify and ignores a replaced generation", () => {
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.sent = [];
    }
    send(value) { this.sent.push(String(value)); }
    ping() {}
    terminate() { this.readyState = 3; this.emit("close", 1006, Buffer.alloc(0)); }
    close(code = 1000, reason = "") { this.readyState = 3; this.emit("close", code, Buffer.from(reason)); }
  }
  const runtime = new NodeConnectionRuntime();
  const transport = new ControlPlaneNodeAgentTunnelTransport(undefined, { connectionRuntime: runtime });
  const ingress = new NodeTunnelIngress(transport);
  const first = new Socket();
  ingress.attachMain("node_reverse", first);
  assert.equal(runtime.observation("node_reverse").phase, "handshaking");
  first.emit("message", JSON.stringify({ type: "node-agent.identify" }));
  assert.equal(runtime.observation("node_reverse").phase, "healthy");

  const second = new Socket();
  ingress.attachMain("node_reverse", second);
  assert.equal(runtime.observation("node_reverse").phase, "handshaking");
  first.emit("close", 1006, Buffer.alloc(0));
  assert.equal(runtime.observation("node_reverse").phase, "handshaking");
  second.emit("message", JSON.stringify({ type: "node-agent.identify" }));
  assert.equal(runtime.observation("node_reverse").phase, "healthy");
  second.emit("close", 1006, Buffer.alloc(0));
  assert.equal(runtime.observation("node_reverse").phase, "offline");
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

test("direct event connection terminates a half-open socket and publishes reconnecting state", async (t) => {
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      this.pings = 0;
    }
    ping() { this.pings += 1; }
    terminate() { this.readyState = 3; this.emit("close", 1006, Buffer.alloc(0)); }
    close() { this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
  }
  const socket = new Socket();
  const runtime = new NodeConnectionRuntime();
  const node = {
    id: "node_direct_events",
    connectionMode: "direct-http",
    connectionEnabled: true,
    endpoint: "http://127.0.0.1:18080",
    auth: { mode: "local-static-key", secret: "secret" },
  };
  const subscriber = new ControlPlaneNodeEventSubscriber(
    { listNodes: () => [node] },
    { handleMessage() {} },
    {
      connectionRuntime: runtime,
      connectTimeoutMs: 20,
      handshakeTimeoutMs: 20,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 5,
      stableThresholdMs: 50,
      createSocket: () => socket,
    },
  );
  t.after(() => subscriber.stop());
  subscriber.start();
  socket.readyState = 1;
  socket.emit("open");
  socket.emit("message", JSON.stringify({ type: "node-agent.events.connected" }));
  assert.equal(runtime.observation(node.id).phase, "healthy");
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.equal(socket.pings, 1);
  assert.equal(runtime.observation(node.id).phase, "reconnecting");
});
