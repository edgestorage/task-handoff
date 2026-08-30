const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");

const { NodeAgentInstanceEventForwarder } = require("../packages/control-plane/src/node-agent/events.ts");

class TestSocket extends EventEmitter {
  constructor(readyState = WebSocket.CONNECTING) {
    super();
    this.readyState = readyState;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(String(value)));
  }

  close() {}
}

test("node agent logs each app-session output boundary with the authoritative trace", () => {
  const input = new TestSocket();
  const logs = [];
  const forwarder = new NodeAgentInstanceEventForwarder(
    { listInstances: () => [{ id: "inst_app_diagnostic", target: { api: "http://127.0.0.1:19000" } }] },
    undefined,
    {
      logger: {
        info: (data, message) => logs.push({ level: "info", data, message }),
        warn: (data, message) => logs.push({ level: "warn", data, message }),
      },
      createSocket: () => input,
      setIntervalFn: () => ({ kind: "interval" }),
      clearIntervalFn: () => undefined,
    },
  );
  const reverseTunnel = new TestSocket(WebSocket.OPEN);
  const proxiedEvents = new TestSocket(WebSocket.OPEN);
  forwarder.addOutput(reverseTunnel, { legacyFallbackMs: 1_000 });
  forwarder.addOutput(proxiedEvents, { expectsTransientSubscription: true });
  input.readyState = WebSocket.OPEN;
  input.emit("open");

  input.emit("message", JSON.stringify({
    v: 1,
    id: "evt_app_diagnostic",
    seq: 11,
    type: "app-session.patch",
    topic: "app.sessions",
    createdAt: "2026-08-23T00:00:00.000Z",
    scope: { instanceId: "inst_app_diagnostic" },
    payload: {
      meta: {
        instanceId: "inst_app_diagnostic",
        streamId: "aps_app_diagnostic",
        revision: 11,
        previousRevision: 10,
        traceId: "aps_evt_app_diagnostic",
        generatedAt: "2026-08-23T00:00:00.000Z",
        reason: "app-session-created",
      },
      session: { id: "app_diagnostic", appId: "terminal-tty", status: "running", bindings: [] },
    },
  }));

  const queued = logs.filter((entry) => entry.message === "app-session.event.output.queued");
  assert.deepEqual(queued.map((entry) => entry.data.kind).sort(), ["events-websocket", "reverse-tunnel"]);
  for (const entry of queued) {
    assert.equal(entry.data.traceId, "aps_evt_app_diagnostic");
    assert.equal(entry.data.streamId, "aps_app_diagnostic");
    assert.equal(entry.data.revision, 11);
    assert.equal(entry.data.outcome, "queued");
  }
  assert.equal(reverseTunnel.sent.at(-1).event.payload.meta.traceId, "aps_evt_app_diagnostic");
  assert.equal(proxiedEvents.sent.at(-1).event.payload.meta.traceId, "aps_evt_app_diagnostic");
  forwarder.stop();
});
