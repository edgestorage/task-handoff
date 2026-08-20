import assert from "node:assert/strict";
import test from "node:test";
import { WebEventBus } from "./src/web/events.ts";

function socket() {
  const listeners = {};
  const sent = [];
  return {
    listeners,
    sent,
    value: {
      readyState: 1,
      OPEN: 1,
      send: (value) => sent.push(JSON.parse(String(value))),
      on: (event, listener) => { listeners[event] = listener; },
    },
  };
}

test("controlled instance emits list deltas broadly but timeline items only for demanded session details", () => {
  const events = new WebEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai-session.snapshot", "ai-session.message-delta", "ai-session.timeline-item"],
    aiSessionTransient: {
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [{ instanceId: "instance-a", sessionId: "session-open" }],
    },
  }));
  events.publish("ai-session.snapshot", { meta: { instanceId: "instance-a" } });
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-card" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-open" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-closed" });
  assert.deepEqual(client.sent.map((event) => event.type), [
    "ai-session.snapshot",
    "ai-session.message-delta",
    "ai-session.timeline-item",
  ]);
  assert.equal(client.sent[2].payload.sessionId, "session-open");
});

test("controlled instance preserves legacy full-topic subscription behavior", () => {
  const events = new WebEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["ai.sessions"] }));
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-a" });
  assert.equal(client.sent.length, 2);
});

test("controlled instance treats an explicit empty topic list as no subscription", () => {
  const events = new WebEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: [] }));
  events.publish("ai-session.snapshot", { instanceId: "instance-a" });
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a" });
  assert.equal(client.sent.length, 0);
});

test("controlled instance disconnects a slow event consumer before buffering more events", () => {
  const events = new WebEventBus();
  const client = socket();
  const closed = [];
  client.value.bufferedAmount = 16 * 1024 * 1024;
  client.value.close = (code, reason) => closed.push({ code, reason });
  events.connect(client.value);
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a" });
  assert.equal(client.sent.length, 0);
  assert.deepEqual(closed, [{ code: 1013, reason: "Event consumer is too slow." }]);
});

test("current controlled-instance clients start with zero transient demand and replay from the consumer cursor", () => {
  const events = new WebEventBus();
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  const missedDelta = events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a", delta: "missed" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-other" });
  const replaySince = new Date(Date.now() + 1_000).toISOString();
  assert.equal(client.sent.length, 0);

  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: {
      replaySince,
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [{ instanceId: "instance-a", sessionId: "session-a" }],
    },
  }));
  assert.deepEqual(client.sent.map((event) => event.id), [missedDelta.id]);
  assert.equal(client.sent[0].payload.delta, "missed");
  assert.equal(client.sent[0].replay, true);
});

test("a terminal authority event releases retained message replay", () => {
  const events = new WebEventBus();
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a", turnId: "turn-a", delta: "done" });
  events.publish("ai-session.snapshot", {
    snapshot: { sessions: [{ id: "session-a", status: "idle", turns: [{ id: "turn-a", status: "completed" }] }] },
  });
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: {
      replaySince: new Date(Date.now() + 1_000).toISOString(),
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [],
    },
  }));
  assert.equal(client.sent.length, 0);
});
