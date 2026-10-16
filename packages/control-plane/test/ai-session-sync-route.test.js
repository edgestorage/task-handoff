import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSessionRoutes } from "../src/control-plane/http/session-routes.ts";

const at = "2026-08-05T00:00:00.000Z";

function instanceSnapshot(instanceId, streamId, revision) {
  return {
    instanceId,
    streamId,
    revision,
    lastEventAt: at,
    aiSessions: { updatedAt: at, runningCount: 0, waitingCount: 0, staleCount: 0, sessions: [] },
  };
}

function createApp(overrides = {}) {
  const calls = [];
  const descriptors = overrides.descriptors ?? [
    { topic: "ai.sessions", instanceId: "instance_a", streamId: "stream_a", latestRevision: 5, earliestRetainedRevision: 2 },
    { topic: "ai.sessions", instanceId: "instance_b", streamId: "stream_b", latestRevision: 3, earliestRetainedRevision: 3 },
    { topic: "ai.sessions", instanceId: "instance_c", streamId: "stream_c", latestRevision: 4, earliestRetainedRevision: 4 },
  ];
  const snapshots = overrides.snapshots ?? {
    instance_a: instanceSnapshot("instance_a", "stream_a", 5),
    instance_b: instanceSnapshot("instance_b", "stream_b", 3),
    instance_c: instanceSnapshot("instance_c", "stream_c", 4),
  };
  const service = {
    listControlledInstances: async () => Object.keys(snapshots).map((id) => ({ id, nodeId: `node_${id}` })),
    ...overrides.service,
  };
  const aiSessionAggregator = {
    streamDescriptors: async () => descriptors,
    list: async (options = {}) => ({
      updatedAt: at,
      instances: Object.values(snapshots).filter((entry) => !options.instanceId || entry.instanceId === options.instanceId),
    }),
    delta: async (input) => {
      calls.push({ name: "delta", ...input });
      if (overrides.delta) return overrides.delta(input);
      return {
        streamId: input.streamId,
        instanceId: input.instanceId,
        sinceRevision: input.sinceRevision,
        latestRevision: 3,
        earliestRetainedRevision: 3,
        syncRequired: false,
        events: [{ type: "ai-session.patch", payload: { meta: { streamId: input.streamId, instanceId: input.instanceId, revision: 3, previousRevision: 2, traceId: "trace", generatedAt: at, reason: "provider-event" }, upserted: [], removed: [] } }],
      };
    },
  };
  const app = Fastify();
  registerSessionRoutes({
    app,
    service,
    events: { publish: () => {} },
    appSessionAggregator: { list: async () => ({ instances: [] }) },
    aiSessionAggregator,
    aiSessionAttachments: {},
    aiSessionAttachmentCache: {},
  });
  return { app, calls };
}

test("reconnect sync answers only changed instances and reports dropped checkpoints", async () => {
  const { app, calls } = createApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/ai-sessions/sync?hierarchy=subagents",
      payload: { instances: [
        { instanceId: "instance_a", streamId: "stream_a", revision: 5 },
        { instanceId: "instance_b", streamId: "stream_b", revision: 2 },
        { instanceId: "instance_gone", streamId: "stream_gone", revision: 1 },
      ] },
    });
    assert.equal(response.statusCode, 200);
    const { data } = JSON.parse(response.body);
    // The up-to-date instance costs nothing: it is omitted instead of re-sent. The
    // instance the client never mentioned arrives as a full snapshot.
    assert.deepEqual(data.instances.map((entry) => entry.instanceId), ["instance_b", "instance_c"]);
    assert.equal(data.instances[0].delta.sinceRevision, 2);
    assert.equal(data.instances[0].delta.events.length, 1);
    assert.equal(data.instances[1].delta, undefined);
    assert.ok(data.instances[1].aiSessions);
    assert.deepEqual(data.removedInstanceIds, ["instance_gone"]);
    assert.deepEqual(calls, [{ name: "delta", instanceId: "instance_b", streamId: "stream_b", sinceRevision: 2 }]);
  } finally {
    await app.close();
  }
});

test("unknown instances, stale streams and sync-required deltas fall back to full instance snapshots", async () => {
  const { app } = createApp({
    delta: (input) => input.instanceId === "instance_b"
      ? { streamId: input.streamId, instanceId: input.instanceId, sinceRevision: input.sinceRevision, latestRevision: 3, earliestRetainedRevision: 3, syncRequired: true, events: [] }
      : undefined,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/ai-sessions/sync",
      payload: { instances: [
        { instanceId: "instance_b", streamId: "stream_b", revision: 1 },
        { instanceId: "instance_c", streamId: "stale_stream", revision: 4 },
      ] },
    });
    assert.equal(response.statusCode, 200);
    const { data } = JSON.parse(response.body);
    // instance_a was never mentioned, instance_c pinned a stale stream and instance_b
    // reported a gap, so every instance arrives as a full snapshot instead of a delta.
    assert.deepEqual(data.instances.map((entry) => [entry.instanceId, entry.aiSessions !== undefined]), [["instance_a", true], ["instance_b", true], ["instance_c", true]]);
    assert.deepEqual(data.removedInstanceIds, []);
  } finally {
    await app.close();
  }
});

test("reconnect sync hides instances the actor cannot see and never leaks their payload", async () => {
  const { app } = createApp({
    service: {
      listControlledInstances: async () => [
        { id: "instance_a", nodeId: "node_instance_a" },
        { id: "instance_c", nodeId: "node_instance_c" },
      ],
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/ai-sessions/sync",
      payload: { instances: [
        { instanceId: "instance_a", streamId: "stream_a", revision: 5 },
        { instanceId: "instance_b", streamId: "stream_b", revision: 1 },
      ] },
    });
    assert.equal(response.statusCode, 200);
    const { data } = JSON.parse(response.body);
    assert.deepEqual(data.instances.map((entry) => entry.instanceId), ["instance_c"]);
    assert.deepEqual(data.removedInstanceIds, ["instance_b"]);
  } finally {
    await app.close();
  }
});
