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
    topics: ["ai-session.snapshot", "ai-session.message-delta", "ai-session.timeline-item", "ai-session.timeline-item-delta"],
    aiSessionTransient: {
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [{ instanceId: "instance-a", sessionId: "session-open" }],
    },
  }));
  events.publish("ai-session.snapshot", { meta: { instanceId: "instance-a" } });
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-card" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-open" });
  events.publish("ai-session.timeline-item-delta", { instanceId: "instance-a", sessionId: "session-open" });
  events.publish("ai-session.timeline-item-delta", { instanceId: "instance-a", sessionId: "session-closed" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-closed" });
  assert.deepEqual(client.sent.map((event) => event.type), [
    "ai-session.snapshot",
    "ai-session.message-delta",
    "ai-session.timeline-item",
    "ai-session.timeline-item-delta",
  ]);
  assert.equal(client.sent[2].payload.sessionId, "session-open");
  assert.equal(client.sent[3].payload.sessionId, "session-open");
});

test("controlled instance preserves legacy full-topic subscription behavior", () => {
  const events = new WebEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["ai.sessions"] }));
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a" });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-a" });
  events.publish("ai-session.timeline-item-delta", { instanceId: "instance-a", sessionId: "session-a" });
  assert.equal(client.sent.length, 3);
});

test("controlled instance sends compact deltas only after explicit projection negotiation", () => {
  const events = new WebEventBus();
  const legacy = socket();
  const compact = socket();
  events.connect(legacy.value);
  events.connect(compact.value);
  legacy.listeners.message(JSON.stringify({ type: "subscribe", topics: ["ai.sessions"] }));
  compact.listeners.message(JSON.stringify({ type: "subscribe", eventEnvelopeVersion: "2026-08-25", topics: ["ai.sessions"] }));
  const payload = {
    instanceId: "instance-a",
    nodeId: "node-a",
    sessionId: "session-a",
    providerSessionId: "provider-a",
    turnId: "turn-a",
    itemId: "item-a",
    delta: "hello",
    generatedAt: "2026-08-25T00:00:00.000Z",
  };
  events.publish("ai-session.message-delta", payload);

  assert.equal(legacy.sent[0].v, 1);
  assert.deepEqual(legacy.sent[0].payload, payload);
  assert.equal(compact.sent[0].v, "2026-08-25");
  assert.equal(compact.sent[0].seq, undefined);
  assert.equal(compact.sent[0].topic, undefined);
  assert.deepEqual(compact.sent[0].payload, {
    sessionId: "session-a",
    turnId: "turn-a",
    itemId: "item-a",
    delta: "hello",
    generatedAt: "2026-08-25T00:00:00.000Z",
  });
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

function transcriptSubscription(sessionId, replaySince) {
  return JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: {
      ...(replaySince ? { replaySince } : {}),
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [{ instanceId: "instance-a", sessionId }],
    },
  });
}

test("a settled timeline activity never enters the transient replay buffer", () => {
  const events = new WebEventBus();
  events.publish("ai-session.timeline-item", {
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-a", turnId: "turn-a", type: "activity", activityKind: "commandExecution", title: "Command", status: "running", input: "ls" },
  });
  events.publish("ai-session.timeline-item-delta", { instanceId: "instance-a", sessionId: "session-a", turnId: "turn-a", itemId: "item-a", delta: "more output" });
  events.publish("ai-session.timeline-item", {
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-a", turnId: "turn-a", type: "activity", activityKind: "commandExecution", title: "Command", status: "completed", output: "done" },
  });
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  client.listeners.message(transcriptSubscription("session-a"));
  assert.deepEqual(client.sent, []);
});

test("transient replay only covers the recent recovery window", () => {
  let now = Date.parse("2026-08-25T00:00:00.000Z");
  const events = new WebEventBus(() => now);
  events.publish("ai-session.timeline-item", {
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-old", turnId: "turn-a", type: "activity", activityKind: "commandExecution", title: "Command", status: "running" },
  });
  const staleClient = socket();
  events.connect(staleClient.value, { expectsTransientSubscription: true });
  staleClient.listeners.message(transcriptSubscription("session-a", new Date(now - 1_000).toISOString()));
  assert.equal(staleClient.sent.length, 1);
  assert.equal(staleClient.sent[0].replay, true);

  // A cursor that stayed connected long enough to age past the recovery window
  // must not drag finished history over the Relay again.
  const staleCursor = new Date(now - 10 * 60_000).toISOString();
  now += 10 * 60_000;
  events.publish("ai-session.timeline-item", {
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-new", turnId: "turn-b", type: "activity", activityKind: "commandExecution", title: "Command", status: "running" },
  });
  const freshClient = socket();
  events.connect(freshClient.value, { expectsTransientSubscription: true });
  freshClient.listeners.message(transcriptSubscription("session-a", staleCursor));
  assert.deepEqual(freshClient.sent.map((event) => event.payload.item.id), ["item-new"]);
});

test("a settled turn releases retained timeline replay but keeps the running turn", () => {
  const events = new WebEventBus();
  events.publish("ai-session.timeline-item", {
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-settled", turnId: "turn-done", type: "ai-message", text: "finished" },
  });
  events.publish("ai-session.timeline-item", {
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-running", turnId: "turn-live", type: "activity", activityKind: "commandExecution", title: "Command", status: "running" },
  });
  events.publish("ai-session.patch", {
    meta: { instanceId: "instance-a" },
    upserted: [{ id: "session-a", status: "running", turns: [{ id: "turn-done", status: "completed" }, { id: "turn-live", status: "running" }] }],
    removed: [],
  });
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  client.listeners.message(transcriptSubscription("session-a", new Date(Date.now() - 1_000).toISOString()));
  assert.deepEqual(client.sent.map((event) => event.payload.item.id), ["item-running"]);
});

test("a replayed timeline item is retained once per item, not once per publish", () => {
  const events = new WebEventBus();
  const userMessage = () => ({
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-user", turnId: "turn-a", type: "user-message", text: "hello" },
  });
  events.publish("ai-session.timeline-item", userMessage());
  events.publish("ai-session.timeline-item", userMessage());
  events.publish("ai-session.timeline-item", userMessage());
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  client.listeners.message(transcriptSubscription("session-a", new Date(Date.now() - 1_000).toISOString()));
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].payload.item.id, "item-user");
});

test("a snapshot under a streamed delta is kept while the snapshot that follows it is collapsed", () => {
  const events = new WebEventBus();
  const snapshot = (output) => ({
    instanceId: "instance-a",
    sessionId: "session-a",
    item: { id: "item-a", turnId: "turn-a", type: "activity", activityKind: "commandExecution", title: "Command", status: "running", output },
  });
  events.publish("ai-session.timeline-item", snapshot("partial"));
  events.publish("ai-session.timeline-item-delta", { instanceId: "instance-a", sessionId: "session-a", turnId: "turn-a", itemId: "item-a", delta: "more" });
  events.publish("ai-session.timeline-item", snapshot("partial more"));
  events.publish("ai-session.timeline-item", snapshot("partial more again"));
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  client.listeners.message(transcriptSubscription("session-a", new Date(Date.now() - 1_000).toISOString()));
  assert.deepEqual(
    client.sent.map((event) => event.payload.item?.output ?? event.payload.delta),
    ["partial", "more", "partial more again"],
  );
});
