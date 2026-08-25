import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";

function socket() {
  const listeners = {};
  const sent = [];
  let pingCount = 0;
  return {
    listeners,
    sent,
    pingCount: () => pingCount,
    value: {
      readyState: 1,
      OPEN: 1,
      send: (value) => sent.push(JSON.parse(value)),
      ping: () => { pingCount += 1; },
      on: (event, listener) => { listeners[event] = listener; },
    },
  };
}

test("event bus keeps browser sockets alive with server transport pings", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  context.mock.timers.tick(20_000);
  assert.equal(client.pingCount(), 1);
  client.listeners.close();
  context.mock.timers.tick(20_000);
  assert.equal(client.pingCount(), 1);
});

test("event bus answers browser keepalives on the existing socket", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ v: 1, type: "ping", sentAt: "2026-08-25T04:00:00.000Z" }));
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].v, 1);
  assert.equal(client.sent[0].type, "pong");
  assert.equal(client.sent[0].sentAt, "2026-08-25T04:00:00.000Z");
  assert.match(client.sent[0].receivedAt, /^2026-/);
});

test("event bus preserves v0.0.21 all-instance behavior when no scope is requested", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  events.publish("instance.updated", {}, { scope: { instanceId: "a" } });
  events.publish("instance.updated", {}, { scope: { instanceId: "b" } });
  assert.deepEqual(client.sent.map((event) => event.scope.instanceId), ["a", "b"]);
});

test("event bus combines topic and optional instance subscription filters", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["instances"], instanceIds: ["a"] }));
  events.publish("instance.updated", {}, { topic: "instances", scope: { instanceId: "a" } });
  events.publish("instance.updated", {}, { topic: "instances", scope: { instanceId: "b" } });
  events.publish("project.updated", {}, { topic: "projects" });
  assert.deepEqual(client.sent.map((event) => event.scope.instanceId), ["a"]);
});

test("resource metrics use an independent active-instance scope without hiding lifecycle events", () => {
  const events = new ControlPlaneEventBus();
  const legacy = socket();
  const activeOnly = socket();
  const disabled = socket();
  events.connect(legacy.value);
  events.connect(activeOnly.value);
  events.connect(disabled.value);
  activeOnly.listeners.message(JSON.stringify({ type: "subscribe", topics: ["*"], metricInstanceIds: ["a"] }));
  disabled.listeners.message(JSON.stringify({ type: "subscribe", topics: ["*"], metricInstanceIds: [] }));

  events.publish("instance.metrics.snapshot", { instanceId: "a" }, { scope: { instanceId: "a" } });
  events.publish("instance.metrics.snapshot", { instanceId: "b" }, { scope: { instanceId: "b" } });
  events.publish("instance.lifecycle.snapshot", { instanceId: "b" }, { scope: { instanceId: "b" } });

  assert.deepEqual(legacy.sent.map((event) => event.type), [
    "instance.metrics.snapshot",
    "instance.metrics.snapshot",
    "instance.lifecycle.snapshot",
  ]);
  assert.deepEqual(activeOnly.sent.map((event) => [event.type, event.scope.instanceId]), [
    ["instance.metrics.snapshot", "a"],
    ["instance.lifecycle.snapshot", "b"],
  ]);
  assert.deepEqual(disabled.sent.map((event) => event.type), ["instance.lifecycle.snapshot"]);
});

test("new metric-scoped clients receive no snapshots before their subscription frame", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, { expectsMetricSubscription: true });
  events.publish("instance.metrics.snapshot", { instanceId: "a" }, { scope: { instanceId: "a" } });
  assert.equal(client.sent.length, 0);

  client.listeners.message(JSON.stringify({ type: "subscribe", metricInstanceIds: ["a"] }));
  events.publish("instance.metrics.snapshot", { instanceId: "a" }, { scope: { instanceId: "a" } });
  assert.equal(client.sent.length, 1);
});

test("global events without instance scope remain visible to scoped clients", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, { instanceIds: ["a"] });
  events.publish("system.updated", {}, { topic: "system" });
  assert.equal(client.sent.length, 1);
});

test("new clients receive message deltas only while their list scope is demanded", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["*"],
    aiSessionTransient: {
      messageDeltas: { allInstances: false, instanceIds: ["instance-a"] },
      timelineSessions: [],
    },
  }));
  events.publish("ai-session.snapshot", { meta: { instanceId: "instance-b" } }, { scope: { instanceId: "instance-b" } });
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a", delta: "a" }, { scope: { instanceId: "instance-a" } });
  events.publish("ai-session.message-delta", { instanceId: "instance-b", sessionId: "session-b", delta: "b" }, { scope: { instanceId: "instance-b" } });
  assert.deepEqual(client.sent.map((event) => event.type), ["ai-session.snapshot", "ai-session.message-delta"]);
  assert.equal(client.sent[1].payload.sessionId, "session-a");
});

test("timeline items are filtered to open session details and aggregate across frontends", () => {
  const events = new ControlPlaneEventBus();
  const first = socket();
  const second = socket();
  const demands = [];
  events.onAiSessionTransientDemand((demand) => demands.push(demand));
  events.connect(first.value);
  events.connect(second.value);
  first.listeners.message(JSON.stringify({
    type: "subscribe",
    aiSessionTransient: {
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineSessions: [{ instanceId: "instance-a", sessionId: "session-a" }],
    },
  }));
  second.listeners.message(JSON.stringify({
    type: "subscribe",
    aiSessionTransient: {
      messageDeltas: { allInstances: false, instanceIds: ["instance-b"] },
      timelineSessions: [{ instanceId: "instance-b", sessionId: "session-b" }],
    },
  }));
  const demand = events.aiSessionTransientDemand();
  assert.equal(demand.messageDeltas.allInstances, true);
  assert.deepEqual(demand.timelineSessions, [
    { instanceId: "instance-a", sessionId: "session-a" },
    { instanceId: "instance-b", sessionId: "session-b" },
  ]);
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-a" }, { scope: { instanceId: "instance-a" } });
  events.publish("ai-session.timeline-item", { instanceId: "instance-a", sessionId: "session-other" }, { scope: { instanceId: "instance-a" } });
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0);
  first.listeners.close();
  assert.deepEqual(events.aiSessionTransientDemand().timelineSessions, [{ instanceId: "instance-b", sessionId: "session-b" }]);
  assert.ok(demands.length >= 4);
});

test("v0.0.21 clients without transient subscription retain the full stream", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["*"] }));
  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a", delta: "legacy" }, { scope: { instanceId: "instance-a" } });
  assert.equal(client.sent.length, 1);
  assert.equal(events.aiSessionTransientDemand().legacyAll, true);
});

test("new clients do not create a legacy-full demand spike before their first subscription frame", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  assert.deepEqual(events.aiSessionTransientDemand(), {
    legacyAll: false,
    messageDeltas: { allInstances: false, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  });

  events.publish("ai-session.message-delta", { instanceId: "instance-a", sessionId: "session-a" }, { scope: { instanceId: "instance-a" } });
  assert.equal(client.sent.length, 0);
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: { messageDeltas: { allInstances: false, instanceIds: ["instance-a"] } },
  }));
  assert.deepEqual(events.aiSessionTransientDemand().messageDeltas, { allInstances: false, instanceIds: ["instance-a"] });
});

test("legacy clients subscribed only to non-AI topics do not activate transient AI demand", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["nodes", "instances"] }));
  assert.deepEqual(events.aiSessionTransientDemand(), {
    legacyAll: false,
    messageDeltas: { allInstances: false, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  });

  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["ai.sessions"] }));
  assert.equal(events.aiSessionTransientDemand().legacyAll, true);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["nodes"] }));
  assert.equal(events.aiSessionTransientDemand().legacyAll, false);
});

test("an explicit empty browser topic list means no events or transient demand", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: [] }));
  events.publish("node.updated", {}, { topic: "nodes" });
  events.publish("ai-session.message-delta", { instanceId: "instance-a" }, { scope: { instanceId: "instance-a" } });
  assert.equal(client.sent.length, 0);
  assert.equal(events.aiSessionTransientDemand().legacyAll, false);
  assert.equal(events.aiSessionTransientDemand().messageDeltas.allInstances, false);
});

test("a slow browser event consumer is disconnected and removed from transient demand", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  const closed = [];
  client.value.bufferedAmount = 16 * 1024 * 1024;
  client.value.close = (code, reason) => closed.push({ code, reason });
  events.connect(client.value);
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: { messageDeltas: { allInstances: true, instanceIds: [] } },
  }));
  assert.equal(events.aiSessionTransientDemand().messageDeltas.allInstances, true);
  events.publish("ai-session.message-delta", { instanceId: "instance-a" }, { scope: { instanceId: "instance-a" } });
  assert.deepEqual(closed, [{ code: 1013, reason: "Event consumer is too slow." }]);
  assert.equal(events.aiSessionTransientDemand().messageDeltas.allInstances, false);
});

test("one failing transient demand listener does not block the remaining transports", () => {
  const events = new ControlPlaneEventBus();
  const received = [];
  let fail = false;
  events.onAiSessionTransientDemand(() => { if (fail) throw new Error("transport failed"); });
  events.onAiSessionTransientDemand((demand) => received.push(demand));
  fail = true;
  const client = socket();
  assert.doesNotThrow(() => events.connect(client.value));
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: { messageDeltas: { allInstances: true, instanceIds: [] } },
  }));
  assert.equal(received.at(-1).messageDeltas.allInstances, true);
});

test("legacy cloud consumers keep full transient demand until their lease closes", () => {
  const events = new ControlPlaneEventBus();
  const stop = events.registerLegacyAiSessionTransientDemand(["ai.sessions"]);
  assert.deepEqual(events.aiSessionTransientDemand(), {
    legacyAll: true,
    messageDeltas: { allInstances: true, instanceIds: [] },
    timelineAllSessions: true,
    timelineSessions: [],
  });
  stop();
  assert.deepEqual(events.aiSessionTransientDemand(), {
    legacyAll: false,
    messageDeltas: { allInstances: false, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  });
});

test("legacy relay topic demand distinguishes an explicit empty list from a missing wildcard default", () => {
  const events = new ControlPlaneEventBus();
  const stopEmpty = events.registerLegacyAiSessionTransientDemand([]);
  assert.equal(events.aiSessionTransientDemand().legacyAll, false);
  assert.equal(events.aiSessionTransientDemand().messageDeltas.allInstances, false);
  assert.equal(events.aiSessionTransientDemand().timelineAllSessions, false);

  const stopDelta = events.registerLegacyAiSessionTransientDemand(["ai-session.message-delta"]);
  assert.equal(events.aiSessionTransientDemand().legacyAll, false);
  assert.equal(events.aiSessionTransientDemand().messageDeltas.allInstances, true);
  assert.equal(events.aiSessionTransientDemand().timelineAllSessions, false);
  stopDelta();

  const stopTimeline = events.registerLegacyAiSessionTransientDemand(["ai-session.timeline-item"]);
  assert.equal(events.aiSessionTransientDemand().messageDeltas.allInstances, false);
  assert.equal(events.aiSessionTransientDemand().timelineAllSessions, true);
  stopTimeline();
  stopEmpty();
});

test("control-plane forwarding preserves transient source identity and replay metadata", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, { expectsTransientSubscription: true });
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["ai.sessions"],
    aiSessionTransient: { messageDeltas: { allInstances: true, instanceIds: [] } },
  }));
  events.publish("ai-session.message-delta", { instanceId: "instance-a" }, {
    scope: { instanceId: "instance-a" },
    sourceEvent: { id: "source-event-a", createdAt: "2026-08-21T00:00:00.000Z", replay: true },
  });
  assert.equal(client.sent[0].id, "source-event-a");
  assert.equal(client.sent[0].createdAt, "2026-08-21T00:00:00.000Z");
  assert.equal(client.sent[0].replay, true);
});

test("control-plane public v2 events omit internal routing and provider identities", () => {
  const events = new ControlPlaneEventBus();
  const legacy = socket();
  const compact = socket();
  events.connect(legacy.value);
  events.connect(compact.value);
  const demand = {
    messageDeltas: { allInstances: true, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  };
  legacy.listeners.message(JSON.stringify({ type: "subscribe", topics: ["ai.sessions"], aiSessionTransient: demand }));
  compact.listeners.message(JSON.stringify({ type: "subscribe", eventEnvelopeVersion: "2026-08-25", topics: ["ai.sessions"], aiSessionTransient: demand }));
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
  events.publish("ai-session.message-delta", payload, { scope: { nodeId: "node-a", instanceId: "instance-a" } });

  assert.equal(legacy.sent[0].v, 1);
  assert.deepEqual(legacy.sent[0].scope, { nodeId: "node-a", instanceId: "instance-a" });
  assert.deepEqual(legacy.sent[0].payload, payload);
  assert.equal(compact.sent[0].v, "2026-08-25");
  assert.equal(compact.sent[0].seq, undefined);
  assert.equal(compact.sent[0].topic, undefined);
  assert.deepEqual(compact.sent[0].scope, { instanceId: "instance-a" });
  assert.deepEqual(compact.sent[0].payload, {
    sessionId: "session-a",
    turnId: "turn-a",
    itemId: "item-a",
    delta: "hello",
    generatedAt: "2026-08-25T00:00:00.000Z",
  });
});

test("user event authorization cannot be widened by a subscribe frame", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, {
    authorization: {
      userId: "user-a",
      authorizationRevision: 3,
      permissionIds: ["nodes:read", "instances:read", "ai-sessions:read"],
      allowedNodeIds: new Set(["node-a"]),
      allowedInstanceIds: new Set(["instance-a"]),
    },
  });
  client.listeners.message(JSON.stringify({
    type: "subscribe",
    topics: ["*"],
    instanceIds: ["instance-a", "instance-b"],
    aiSessionTransient: { messageDeltas: { allInstances: true, instanceIds: [] } },
  }));
  events.publish("node.updated", {}, { topic: "nodes", scope: { nodeId: "node-a" } });
  events.publish("node.updated", {}, { topic: "nodes", scope: { nodeId: "node-b" } });
  events.publish("instance.updated", {}, { topic: "instances", scope: { instanceId: "instance-a" } });
  events.publish("instance.updated", {}, { topic: "instances", scope: { instanceId: "instance-b" } });
  events.publish("instance.updated", {}, { topic: "instances" });
  events.publish("ai-session.message-delta", { instanceId: "instance-a" }, { scope: { instanceId: "instance-a" } });
  events.publish("ai-session.message-delta", { instanceId: "instance-b" }, { scope: { instanceId: "instance-b" } });
  assert.deepEqual(client.sent.map((event) => event.scope), [
    { nodeId: "node-a" },
    { instanceId: "instance-a" },
    { instanceId: "instance-a" },
  ]);
  assert.deepEqual(events.aiSessionTransientDemand().messageDeltas, { allInstances: false, instanceIds: ["instance-a"] });
});

test("user authorization revision invalidation closes the bound event connection", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  const closed = [];
  client.value.close = (code, reason) => closed.push({ code, reason });
  events.connect(client.value, {
    authorization: {
      userId: "user-a",
      authorizationRevision: 3,
      permissionIds: ["nodes:read"],
      allowedNodeIds: new Set(["node-a"]),
      allowedInstanceIds: new Set(["instance-a"]),
    },
  });
  events.invalidateUserAuthorization("user-a", 4);
  events.publish("node.updated", {}, { topic: "nodes", scope: { nodeId: "node-a" } });
  assert.deepEqual(closed, [{ code: 4001, reason: "Authorization changed. Reconnect for a current snapshot." }]);
  assert.equal(client.sent.length, 0);
});

test("viewer event connections cannot read global trigger template events", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, {
    authorization: {
      userId: "user-a",
      authorizationRevision: 1,
      permissionIds: ["triggers:read"],
      allowedNodeIds: new Set(["node-a"]),
      allowedInstanceIds: new Set(),
    },
  });
  events.publish("trigger.updated", {}, { topic: "triggers" });
  assert.equal(client.sent.length, 0);
});

test("restricted user legacy subscribe demand is reduced to authorized instances", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, {
    authorization: {
      userId: "user-a",
      authorizationRevision: 1,
      permissionIds: ["ai-sessions:read"],
      allowedNodeIds: new Set(["node-a"]),
      allowedInstanceIds: new Set(["instance-a"]),
    },
  });
  assert.equal(events.aiSessionTransientDemand().legacyAll, false);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["ai.sessions"] }));
  assert.deepEqual(events.aiSessionTransientDemand().messageDeltas, {
    allInstances: false,
    instanceIds: ["instance-a"],
  });
});

test("event envelope derives routing scope from authoritative producer payload", () => {
  const events = new ControlPlaneEventBus();
  const allowed = socket();
  const denied = socket();
  events.connect(allowed.value, {
    authorization: {
      userId: "user-a",
      authorizationRevision: 1,
      permissionIds: ["instances:read", "ai-sessions:read"],
      allowedNodeIds: new Set(["node-a"]),
      allowedInstanceIds: new Set(["instance-a"]),
    },
  });
  events.connect(denied.value, {
    authorization: {
      userId: "user-b",
      authorizationRevision: 1,
      permissionIds: ["instances:read", "ai-sessions:read"],
      allowedNodeIds: new Set(["node-b"]),
      allowedInstanceIds: new Set(["instance-b"]),
    },
  });
  events.publish("instance.updated", { instanceId: "instance-a" }, { topic: "instances" });
  assert.deepEqual(allowed.sent[0].scope, { instanceId: "instance-a" });
  assert.equal(denied.sent.length, 0);

  events.publish("ai-session.snapshot", { meta: { instanceId: "instance-a" } });
  assert.deepEqual(allowed.sent[1].scope, { instanceId: "instance-a" });
  assert.equal(denied.sent.length, 0);
});

test("unscoped node-derived events fail closed for restricted members and remain diagnosable", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, {
    authorization: {
      userId: "user-a",
      authorizationRevision: 1,
      permissionIds: ["instances:read"],
      allowedNodeIds: new Set(["node-a"]),
      allowedInstanceIds: new Set(["instance-a"]),
    },
  });
  events.publish("instance.updated", { opaque: true }, { topic: "instances" });
  assert.equal(client.sent.length, 0);
  assert.deepEqual(events.authorizationDiagnostics(), {
    droppedUnscopedNodeEvents: 1,
    lastUnscopedNodeEvent: {
      type: "instance.updated",
      topic: "instances",
      createdAt: events.authorizationDiagnostics().lastUnscopedNodeEvent.createdAt,
    },
  });
});
