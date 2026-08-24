const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");

const { NodeAgentInstanceEventForwarder } = require("../packages/control-plane/src/node-agent/events.ts");
const { projectAiSessionAuthorityChange } = require("../packages/controlled-instance/src/web/ai-session-authority-events.ts");
const { AiSessionEventType, emptyAiSessionsSnapshot } = require("../packages/protocol/src/ai-sessions.ts");
const { AppSessionEventType, emptyAppSessionsSnapshot } = require("../packages/protocol/src/app-sessions.ts");

const now = "2026-08-24T00:00:00.000Z";

function summary(id, status = "idle") {
  return {
    id,
    agent: "codex",
    appSessionId: `app_${id}`,
    appId: "codex",
    providerSessionId: `thread_${id}`,
    status,
    phase: "unknown",
    startedAt: now,
    updatedAt: now,
    queue: { pendingCount: 0, items: [] },
  };
}

function snapshot(sessions) {
  return {
    runningCount: sessions.filter((session) => session.status === "running").length,
    waitingCount: sessions.filter((session) => session.status === "waiting").length,
    staleCount: 0,
    sessions,
    updatedAt: now,
  };
}

function meta(revision, previousRevision) {
  return {
    streamId: "ais_stream",
    instanceId: "inst_authority",
    revision,
    ...(previousRevision === undefined ? {} : { previousRevision }),
    traceId: `trace_${revision}`,
    generatedAt: now,
    reason: revision === 1 ? "startup" : "provider-event",
  };
}

function envelope(type, payload, revision) {
  return JSON.stringify({
    v: 1,
    id: `event_${revision}`,
    seq: revision,
    type,
    topic: type.startsWith("app-session.") ? "app.sessions" : "ai.sessions",
    createdAt: now,
    payload,
  });
}

test("AI session authority emits one initial snapshot and routine minimal deltas", () => {
  const initial = snapshot([summary("one"), summary("two")]);
  assert.equal(projectAiSessionAuthorityChange(undefined, initial).kind, "snapshot");

  const changed = snapshot([summary("one", "running"), summary("two")]);
  assert.deepEqual(projectAiSessionAuthorityChange(initial, changed), {
    kind: "patch",
    upserted: [summary("one", "running")],
    removed: [],
  });

  const removed = snapshot([summary("one", "running")]);
  assert.deepEqual(projectAiSessionAuthorityChange(changed, removed), {
    kind: "removed",
    sessionIds: ["two"],
  });

  assert.deepEqual(projectAiSessionAuthorityChange(initial, snapshot([...initial.sessions].reverse())), {
    kind: "unchanged",
  });
});

test("node agent collapses backpressured AI authority events into the latest snapshot", () => {
  const timers = [];
  let connectedUrl;
  class TestSocket extends EventEmitter {
    constructor(readyState = WebSocket.CONNECTING) {
      super();
      this.readyState = readyState;
      this.bufferedAmount = 0;
      this.sent = [];
    }
    send(value) { this.sent.push(JSON.parse(String(value))); }
    close() {}
  }

  const input = new TestSocket();
  const forwarder = new NodeAgentInstanceEventForwarder(
    { listInstances: () => [{ id: "inst_authority", target: { api: "http://127.0.0.1:19001" } }] },
    undefined,
    {
      createSocket: (url) => {
        connectedUrl = url;
        return input;
      },
      setIntervalFn: () => ({ kind: "interval" }),
      clearIntervalFn: () => undefined,
      setTimeoutFn: (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: () => undefined,
    },
  );
  const output = new TestSocket(WebSocket.OPEN);
  output.bufferedAmount = 300 * 1024;
  forwarder.addOutput(output, { expectsTransientSubscription: true });
  assert.equal(new URL(connectedUrl).searchParams.get("aiSessionAuthoritySnapshot"), "1");
  input.readyState = WebSocket.OPEN;
  input.emit("open");

  input.emit("message", envelope(AiSessionEventType.Snapshot, {
    meta: meta(1),
    snapshot: emptyAiSessionsSnapshot(now),
  }, 1));
  input.emit("message", envelope(AiSessionEventType.Patch, {
    meta: meta(2, 1),
    upserted: [],
    removed: [],
  }, 2));
  input.emit("message", envelope(AiSessionEventType.Patch, {
    meta: meta(3, 2),
    upserted: [],
    removed: [],
  }, 3));

  assert.equal(output.sent.length, 0);
  assert.equal(timers.length, 1);
  const congestedHealth = forwarder.eventTransportHealth();
  assert.equal(congestedHealth.status, "congested");
  assert.equal(congestedHealth.activeOutputs, 1);
  assert.equal(congestedHealth.bufferedBytes, 300 * 1024);
  assert.equal(congestedHealth.peakBufferedBytes, 300 * 1024);
  assert.equal(congestedHealth.coalescedEvents, 3);
  assert.match(congestedHealth.congestedSince, /^\d{4}-/);
  assert.match(congestedHealth.lastCongestedAt, /^\d{4}-/);
  output.bufferedAmount = 0;
  timers.shift().callback();

  assert.equal(output.sent.length, 1);
  assert.equal(output.sent[0].event.type, AiSessionEventType.Snapshot);
  assert.equal(output.sent[0].event.payload.meta.revision, 3);
  assert.equal(output.sent[0].event.payload.snapshot.sessions.length, 0);
  assert.equal(forwarder.eventTransportHealth().status, "recovering");
  assert.equal(forwarder.eventTransportHealth().bufferedBytes, 0);
  forwarder.stop();
});

test("node agent replays stream descriptors and latest authority snapshots to a reconnected output", () => {
  class TestSocket extends EventEmitter {
    constructor(readyState = WebSocket.CONNECTING) {
      super();
      this.readyState = readyState;
      this.bufferedAmount = 0;
      this.sent = [];
    }
    send(value) { this.sent.push(JSON.parse(String(value))); }
    close() {}
  }

  const instanceId = "inst_reconnected_output";
  const input = new TestSocket();
  const forwarder = new NodeAgentInstanceEventForwarder(
    { listInstances: () => [{ id: instanceId, target: { api: "http://127.0.0.1:19001" } }] },
    undefined,
    {
      createSocket: () => input,
      setIntervalFn: () => ({ kind: "interval" }),
      clearIntervalFn: () => undefined,
    },
  );
  const initialOutput = new TestSocket(WebSocket.OPEN);
  forwarder.addOutput(initialOutput, { expectsTransientSubscription: true });
  input.readyState = WebSocket.OPEN;
  input.emit("open");
  input.emit("message", JSON.stringify({
    type: "streams.hello",
    payload: {
      protocolVersion: 1,
      streams: [
        { topic: "ai.sessions", instanceId, streamId: "ais_reconnect", latestRevision: 1, earliestRetainedRevision: 1 },
        { topic: "app.sessions", instanceId, streamId: "aps_reconnect", latestRevision: 3, earliestRetainedRevision: 3 },
      ],
    },
  }));
  input.emit("message", envelope(AiSessionEventType.Snapshot, {
    meta: { ...meta(1), instanceId, streamId: "ais_reconnect" },
    snapshot: emptyAiSessionsSnapshot(now),
  }, 1));
  input.emit("message", envelope(AiSessionEventType.Patch, {
    meta: { ...meta(2, 1), instanceId, streamId: "ais_reconnect" },
    upserted: [summary("session-running", "running")],
    removed: [],
  }, 2));
  input.emit("message", envelope(AppSessionEventType.Snapshot, {
    meta: {
      streamId: "aps_reconnect",
      instanceId,
      revision: 4,
      traceId: "aps_trace_4",
      generatedAt: now,
      reason: "startup",
    },
    snapshot: emptyAppSessionsSnapshot(now),
  }, 4));

  initialOutput.emit("close");
  const reconnectedOutput = new TestSocket(WebSocket.OPEN);
  forwarder.addOutput(reconnectedOutput, { legacyFallbackMs: 1_000 });
  assert.equal(reconnectedOutput.sent.some((message) => message.type === "node-agent.streams.hello"), false);
  assert.equal(forwarder.setOutputSubscription(reconnectedOutput, {}), true);

  const hello = reconnectedOutput.sent.find((message) => message.type === "node-agent.streams.hello");
  assert.deepEqual(hello.payload.streams.map((stream) => [stream.topic, stream.latestRevision]), [
    ["ai.sessions", 2],
    ["app.sessions", 4],
  ]);
  const authority = reconnectedOutput.sent
    .filter((message) => message.type === "node-agent.event.forwarded")
    .map((message) => message.event);
  const aiSnapshot = authority.find((event) => event.type === AiSessionEventType.Snapshot);
  assert.equal(aiSnapshot.payload.meta.revision, 2);
  assert.deepEqual(aiSnapshot.payload.snapshot.sessions.map((session) => session.id), ["session-running"]);
  const appSnapshot = authority.find((event) => event.type === AppSessionEventType.Snapshot);
  assert.equal(appSnapshot.payload.meta.revision, 4);
  assert.equal(appSnapshot.payload.snapshot.sessions.length, 0);

  const replayedMessageCount = reconnectedOutput.sent.length;
  assert.equal(forwarder.setOutputSubscription(reconnectedOutput, { timelineAllSessions: true }), true);
  assert.equal(reconnectedOutput.sent.length, replayedMessageCount);
  forwarder.stop();
});
