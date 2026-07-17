import assert from "node:assert/strict";
import test from "node:test";

import {
  AiSessionEventMetaSchema,
  AiSessionEventType,
  AiSessionDeltaResponseSchema,
  AiSessionMessageDeltaEventSchema,
  applyAiSessionStreamEvent,
  emptyAiSessionsSnapshot,
} from "../src/ai-sessions.ts";
import {
  AppSessionEventType,
  applyAppSessionStreamEvent,
  emptyAppSessionsSnapshot,
} from "../src/app-sessions.ts";
import {
  SESSION_STREAM_PROTOCOL_VERSION,
  SessionStreamsHelloSchema,
} from "../src/events.ts";

const now = "2026-07-13T00:00:00.000Z";

function meta(overrides = {}) {
  return {
    streamId: "stream-a",
    instanceId: "instance-a",
    revision: 1,
    traceId: "trace-a",
    generatedAt: now,
    reason: "startup",
    ...overrides,
  };
}

test("AI session reducer applies snapshots, continuous patches, duplicates, and gaps", () => {
  const snapshot = { type: AiSessionEventType.Snapshot, payload: { meta: meta(), snapshot: emptyAiSessionsSnapshot(now) } };
  const initial = applyAiSessionStreamEvent(undefined, snapshot);
  assert.equal(initial.kind, "applied");
  assert.equal(initial.projection.streamId, "stream-a");

  const patch = {
    type: AiSessionEventType.Patch,
    payload: { meta: meta({ revision: 2, previousRevision: 1, reason: "provider-event" }), upserted: [], removed: [] },
  };
  const applied = applyAiSessionStreamEvent(initial.projection, patch);
  assert.equal(applied.kind, "applied");
  assert.equal(applied.projection.revision, 2);
  assert.equal(applyAiSessionStreamEvent(applied.projection, patch).kind, "duplicate");

  const gap = applyAiSessionStreamEvent(applied.projection, {
    ...patch,
    payload: { ...patch.payload, meta: meta({ revision: 4, previousRevision: 3, reason: "provider-event" }) },
  });
  assert.deepEqual({ kind: gap.kind, expected: gap.expectedRevision, received: gap.receivedRevision }, { kind: "gap", expected: 3, received: 4 });
});

test("AI session reducer requires a snapshot for an unknown stream and accepts its snapshot epoch", () => {
  const currentResult = applyAiSessionStreamEvent(undefined, {
    type: AiSessionEventType.Snapshot,
    payload: { meta: meta({ revision: 50 }), snapshot: emptyAiSessionsSnapshot(now) },
  });
  assert.equal(currentResult.kind, "applied");
  const unknownPatch = applyAiSessionStreamEvent(currentResult.projection, {
    type: AiSessionEventType.Patch,
    payload: { meta: meta({ streamId: "stream-b", revision: 1, reason: "provider-event" }), upserted: [], removed: [] },
  });
  assert.equal(unknownPatch.kind, "snapshot-required");
  const replacement = applyAiSessionStreamEvent(currentResult.projection, {
    type: AiSessionEventType.Snapshot,
    payload: { meta: meta({ streamId: "stream-b", revision: 1 }), snapshot: emptyAiSessionsSnapshot(now) },
  });
  assert.equal(replacement.kind, "applied");
  assert.equal(replacement.projection.streamId, "stream-b");
  assert.equal(replacement.projection.revision, 1);
});

test("app session reducer applies a strict continuous patch", () => {
  const initial = applyAppSessionStreamEvent(undefined, {
    type: AppSessionEventType.Snapshot,
    payload: { meta: meta(), snapshot: emptyAppSessionsSnapshot(now) },
  });
  assert.equal(initial.kind, "applied");
  const applied = applyAppSessionStreamEvent(initial.projection, {
    type: AppSessionEventType.Patch,
    payload: {
      meta: meta({ revision: 2, previousRevision: 1, reason: "app-session-created" }),
      session: { id: "app-1", status: "running", bindings: [] },
    },
  });
  assert.equal(applied.kind, "applied");
  assert.equal(applied.projection.snapshot.runningCount, 1);
});

test("stream schemas reject legacy metadata and describe retained recovery history", () => {
  assert.equal(AiSessionEventMetaSchema.safeParse({
    instanceId: "instance-a",
    snapshotRevision: 1,
    eventSeq: 1,
    traceId: "trace-a",
    generatedAt: now,
    reason: "startup",
  }).success, false);

  const hello = SessionStreamsHelloSchema.parse({
    protocolVersion: SESSION_STREAM_PROTOCOL_VERSION,
    streams: [{ topic: "ai.sessions", instanceId: "instance-a", streamId: "stream-a", latestRevision: 3, earliestRetainedRevision: 2 }],
  });
  assert.equal(hello.streams[0].earliestRetainedRevision, 2);

  assert.equal(AiSessionDeltaResponseSchema.safeParse({
    instanceId: "instance-a",
    sinceRevision: 1,
    latestRevision: 1,
    syncRequired: false,
    events: [],
  }).success, false);
});

test("AI session message delta is an ephemeral event outside revision recovery", () => {
  const payload = AiSessionMessageDeltaEventSchema.parse({
    instanceId: "instance-a",
    sessionId: "session-a",
    providerSessionId: "thread-a",
    turnId: "turn-a",
    itemId: "item-a",
    delta: "hello",
    generatedAt: now,
  });
  assert.equal(AiSessionEventType.MessageDelta, "ai-session.message-delta");
  assert.equal(payload.delta, "hello");
  assert.equal(AiSessionDeltaResponseSchema.safeParse({
    streamId: "stream-a",
    instanceId: "instance-a",
    sinceRevision: 1,
    latestRevision: 1,
    earliestRetainedRevision: 1,
    syncRequired: false,
    events: [{ type: AiSessionEventType.MessageDelta, payload }],
  }).success, false);
});
