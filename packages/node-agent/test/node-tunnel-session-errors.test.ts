import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { NodeTunnelSessionServer, type NodeTunnelSessionSocket } from "../src/tunnel-session/server.ts";

class TestSocket extends EventEmitter implements NodeTunnelSessionSocket {
  static readonly OPEN = 1;
  readyState = TestSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string | Buffer) {
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

test("node tunnel websocket forwarding preserves application headers", async () => {
  const socket = new TestSocket();
  const auxiliary = new TestSocket();
  const receivedHeaders: Array<Record<string, string>> = [];
  const opened: Array<{ url: URL; protocols: string[] | undefined; headers: Record<string, string> }> = [];
  const session = new NodeTunnelSessionServer({
    nodeId: "node_a",
    socket,
    host: {
      log: { warn() {} },
      inject: async () => {
        throw new Error("not used");
      },
      currentListenerPort: () => 19_001,
    },
    openAuxSocket: async () => auxiliary,
    buildLocalHeaders: (_route, _method, _body, headers) => {
      receivedHeaders.push(headers);
      return { ...headers, authorization: "Bearer local" };
    },
    openLocalWebSocket: (url, protocols, headers) => {
      opened.push({ url, protocols, headers });
      return new TestSocket();
    },
    injectUrl: (route) => route,
    identifyOnOpen: false,
    labels: {
      topic: "cloud relay",
      displayName: "Cloud relay",
      injectFailureCode: "NODE_AGENT_CLOUD_RELAY_INJECT_FAILED",
    },
  });
  session.attach();

  socket.emit("message", JSON.stringify({
    type: "control-plane.websocket.open",
    streamId: "stream_1",
    route: "/instances/inst_1/remote-desktop/fallback/control",
    protocols: ["taskhandoff.remote-desktop.fallback.control.v1"],
    headers: {
      "x-task-handoff-desktop-viewer": "rdv_1",
      "x-task-handoff-desktop-generation": "fgen_1",
    },
  }), false);
  await new Promise((resolve) => setImmediate(resolve));

  const expected = {
    "x-task-handoff-desktop-viewer": "rdv_1",
    "x-task-handoff-desktop-generation": "fgen_1",
  };
  assert.deepEqual(receivedHeaders, [expected]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url.pathname, "/api/node-agent/instances/inst_1/remote-desktop/fallback/control");
  assert.deepEqual(opened[0].protocols, ["taskhandoff.remote-desktop.fallback.control.v1"]);
  assert.deepEqual(opened[0].headers, { ...expected, authorization: "Bearer local" });
  session.dispose("test complete");
});

test("node tunnel session accepts the identify acknowledgement and never echoes peer errors", () => {
  const socket = new TestSocket();
  const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
  const session = new NodeTunnelSessionServer({
    nodeId: "node_a",
    socket,
    host: {
      log: {
        warn(data, message) {
          warnings.push({ data, message });
        },
      },
      inject: async () => {
        throw new Error("not used");
      },
      currentListenerPort: () => 0,
    },
    openAuxSocket: async () => {
      throw new Error("not used");
    },
    buildLocalHeaders: () => ({}),
    injectUrl: (route) => route,
    identifyOnOpen: false,
    respondToUnsupportedMessages: true,
    labels: {
      topic: "cloud relay",
      displayName: "Cloud relay",
      injectFailureCode: "NODE_AGENT_CLOUD_RELAY_INJECT_FAILED",
    },
  });
  session.attach();

  socket.emit("message", JSON.stringify({ type: "control-plane.hello", nodeId: "node_a" }), false);
  const identify = JSON.parse(socket.sent[0]);
  assert.equal(identify.type, "node-agent.identify");
  assert.equal(identify.nodeId, "node_a");
  assert.match(identify.serverTime, /^\d{4}-\d{2}-\d{2}T/);

  socket.emit("message", JSON.stringify({ type: "control-plane.identified", nodeId: "node_a" }), false);
  socket.emit("message", JSON.stringify({ type: "control-plane.error", code: "UNSUPPORTED_MESSAGE" }), false);
  assert.equal(socket.sent.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.code, "UNSUPPORTED_MESSAGE");

  socket.emit("message", JSON.stringify({ type: "control-plane.unknown" }), false);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(JSON.parse(socket.sent[1]), { type: "node-agent.error", code: "UNSUPPORTED_MESSAGE" });
  session.dispose("test complete");
});

test("node tunnel session forwards the control-plane resource metric scope to the event output", () => {
  const socket = new TestSocket();
  const scopes: unknown[] = [];
  const session = new NodeTunnelSessionServer({
    nodeId: "node_a",
    socket,
    host: {
      log: { warn() {} },
      inject: async () => {
        throw new Error("not used");
      },
      currentListenerPort: () => 0,
      nodeAgentEventForwarder: {
        addOutput: () => () => undefined,
        setOutputSubscription(_socket, _input, _version, _hierarchy, metricInstanceIds) {
          scopes.push(metricInstanceIds);
          return true;
        },
      },
    },
    openAuxSocket: async () => {
      throw new Error("not used");
    },
    buildLocalHeaders: () => ({}),
    injectUrl: (route) => route,
    identifyOnOpen: false,
    labels: {
      topic: "cloud relay",
      displayName: "Cloud relay",
      injectFailureCode: "NODE_AGENT_CLOUD_RELAY_INJECT_FAILED",
    },
  });
  session.attach();

  socket.emit("message", JSON.stringify({
    type: "control-plane.event-subscribe",
    aiSessionTransient: {},
    metricInstanceIds: ["instance-a"],
  }), false);
  assert.deepEqual(scopes, [["instance-a"]]);
  session.dispose("test complete");
});
