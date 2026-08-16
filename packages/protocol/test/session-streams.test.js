import assert from "node:assert/strict";
import test from "node:test";

import {
  AiSessionEventMetaSchema,
  AiSessionCreateInputSchema,
  AiSessionCreateRefInputSchema,
  AiSessionCreateResultSchema,
  AiSessionForkInputSchema,
  AiSessionForkResultSchema,
  AiSessionCloseInputSchema,
  AiSessionCloseResultSchema,
  AiSessionEventType,
  AiSessionDeltaResponseSchema,
  AiSessionHistoryIndexSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryItemSchema,
  AiSessionHistoryListSchema,
  AI_SESSION_HISTORY_MAX_LIMIT,
  AiSessionMessageDeltaEventSchema,
  AiSessionMentionCandidateSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionMessageInputSchema,
  AiSessionMessageRefInputSchema,
  AiSessionOpenAppInputSchema,
  AiSessionOpenAppResultSchema,
  AiSessionQueueEditInputSchema,
  AiSessionQueueReorderInputSchema,
  AiSessionReferenceSchema,
  AiSessionRealtimeInputSchema,
  AiSessionStatusSchema,
  AiSessionSummarySchema,
  AiSessionResumeResultSchema,
  AiSessionSubAgentSchema,
  AiSessionToolSchema,
  applyAiSessionStreamEvent,
  emptyAiSessionsSnapshot,
} from "../src/ai-sessions.ts";
import {
  AppSessionEventType,
  activeAppSessionsSnapshotFromRecords,
  appSessionAccessMode,
  applyAppSessionStreamEvent,
  emptyAppSessionsSnapshot,
} from "../src/app-sessions.ts";
import {
  SESSION_STREAM_PROTOCOL_VERSION,
  SessionStreamsHelloSchema,
} from "../src/events.ts";

const now = "2026-07-13T00:00:00.000Z";

test("app session access mode is derived from the authoritative session kind", () => {
  assert.equal(appSessionAccessMode({ kind: "tty" }), "tty");
  assert.equal(appSessionAccessMode({ kind: "gui" }), "vnc");
  assert.equal(appSessionAccessMode({ kind: "web" }), "web");
  assert.equal(appSessionAccessMode({ kind: "future-kind", appId: "terminal-tty" }), undefined);
});

test("AI session queue schemas expose revisioned edit and reorder inputs", () => {
  const session = AiSessionStatusSchema.parse({
    id: "session-a", agent: "codex", status: "idle", phase: "unknown", startedAt: now, updatedAt: now,
  });
  assert.deepEqual(session.queue, { revision: 0, pendingCount: 0, items: [] });
  assert.deepEqual(AiSessionQueueEditInputSchema.parse({ expectedRevision: 2, message: "  updated  " }), { expectedRevision: 2, message: "updated" });
  assert.deepEqual(AiSessionQueueReorderInputSchema.parse({ expectedRevision: 2, queueIds: ["q-2", "q-1"] }), { expectedRevision: 2, queueIds: ["q-2", "q-1"] });
  assert.equal(AiSessionQueueEditInputSchema.safeParse({ message: "missing revision" }).success, false);
  assert.equal(AiSessionQueueReorderInputSchema.safeParse({ expectedRevision: 2, queueIds: [], extra: true }).success, false);
});

test("AI session history schemas expose bounded strict summaries and resume results", () => {
  const item = {
    id: "ai-history-1",
    agent: "codex",
    creationSource: "app-session",
    providerSessionId: "11111111-1111-4111-8111-111111111111",
    title: "Continue the implementation",
    userPrompt: "Build AI session history",
    lastMessage: "The design is ready.",
    cwd: "/workspace",
    lastActiveAt: now,
    archivedAt: now,
  };
  assert.deepEqual(AiSessionHistoryItemSchema.parse(item), item);
  assert.equal(AiSessionHistoryItemSchema.safeParse({ ...item, transcriptPath: "/home/agent/.codex/session.jsonl" }).success, false);
  assert.equal(AiSessionHistoryItemSchema.safeParse({ ...item, agent: "other" }).success, false);
  assert.equal(AiSessionHistoryIndexSchema.safeParse({ schemaVersion: 1, items: Array.from({ length: AI_SESSION_HISTORY_MAX_LIMIT + 1 }, () => item) }).success, false);
  assert.equal(AiSessionHistoryListSchema.safeParse({ items: [item], extra: true }).success, false);
  assert.deepEqual(AiSessionHistoryDetailSchema.parse({
    item,
    turns: [{ id: "turn-history-1", userPrompt: "Build it", lastMessage: "Done", status: "completed", startedAt: now }],
  }).turns[0], {
    id: "turn-history-1",
    userPrompt: "Build it",
    lastMessage: "Done",
    status: "completed",
    startedAt: now,
  });
  assert.equal(AiSessionHistoryDetailSchema.safeParse({ item, turns: [{ id: "turn-history-1", status: "completed", currentTool: {} }] }).success, false);
  assert.equal(AiSessionHistoryDetailSchema.safeParse({ item, turns: Array.from({ length: 51 }, (_, index) => ({ id: `turn-${index}`, status: "completed" })) }).success, false);
  assert.deepEqual(AiSessionResumeResultSchema.parse({
    disposition: "resumed",
    aiSessionId: item.id,
    providerSessionId: item.providerSessionId,
    appSessionId: "app-1",
    creationSource: "app-session",
  }), {
    disposition: "resumed",
    aiSessionId: item.id,
    providerSessionId: item.providerSessionId,
    appSessionId: "app-1",
    creationSource: "app-session",
  });
});

test("AI session create, open-app, and close schemas keep trusted identities server-side", () => {
  const create = {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace/project" },
    cwdFolderId: "folder-1",
    message: "Implement the change",
    attachments: [],
    references: [],
    permissionMode: "auto-review",
    clientRequestId: "request-create-1",
  };
  assert.deepEqual(AiSessionCreateInputSchema.parse(create), create);
  assert.equal(AiSessionCreateInputSchema.safeParse({ ...create, cwd: { type: "runtime-path", path: "relative/path" } }).success, false);
  assert.equal(AiSessionCreateInputSchema.safeParse({ ...create, providerSessionId: "client-controlled" }).success, false);
  const { cwd: _cwd, ...createWithoutCwd } = create;
  assert.deepEqual(AiSessionCreateRefInputSchema.parse(createWithoutCwd), createWithoutCwd);
  assert.equal(AiSessionCreateRefInputSchema.safeParse(create).success, false);
  assert.deepEqual(AiSessionCreateResultSchema.parse({
    disposition: "created",
    aiSessionId: "ai-1",
    providerSessionId: "thread-1",
    creationSource: "ai-session",
  }).creationSource, "ai-session");

  const action = { clientRequestId: "request-action-1" };
  assert.deepEqual(AiSessionOpenAppInputSchema.parse(action), action);
  assert.deepEqual(AiSessionCloseInputSchema.parse(action), action);
  assert.equal(AiSessionOpenAppInputSchema.safeParse({ ...action, cwd: "/tmp" }).success, false);
  assert.equal(AiSessionCloseInputSchema.safeParse({ ...action, providerSessionId: "thread-1" }).success, false);
  assert.equal(AiSessionOpenAppResultSchema.parse({
    disposition: "opened",
    aiSessionId: "ai-1",
    providerSessionId: "thread-1",
    appSessionId: "app-1",
    creationSource: "ai-session",
  }).appSessionId, "app-1");
  assert.equal(AiSessionCloseResultSchema.parse({
    disposition: "closed",
    aiSessionId: "ai-1",
    providerSessionId: "thread-1",
    creationSource: "ai-session",
  }).disposition, "closed");
});

test("AI session Fork schemas are strict, minimal, and N-1 tolerant", () => {
  assert.deepEqual(AiSessionForkInputSchema.parse({ clientRequestId: "fork-request-1" }), {
    clientRequestId: "fork-request-1",
    workspace: { mode: "current" },
  });
  assert.deepEqual(AiSessionForkInputSchema.parse({
    clientRequestId: "fork-request-2",
    throughTurnId: "turn-2",
    workspace: { mode: "managed-worktree" },
  }), {
    clientRequestId: "fork-request-2",
    throughTurnId: "turn-2",
    workspace: { mode: "managed-worktree" },
  });
  assert.equal(AiSessionForkInputSchema.safeParse({ clientRequestId: "fork-request-3", cwd: "/workspace" }).success, false);
  assert.equal(AiSessionForkInputSchema.safeParse({ clientRequestId: "fork-request-3", workspace: { mode: "current", worktreeId: "private" } }).success, false);
  const result = { disposition: "created", aiSessionId: "ai-fork", providerSessionId: "thread-fork", creationSource: "ai-session" };
  assert.deepEqual(AiSessionForkResultSchema.parse(result), result);
  assert.equal(AiSessionForkResultSchema.safeParse({ ...result, lineage: { kind: "fork", parentProviderSessionId: "thread-source" } }).success, false);
  assert.equal(AiSessionForkResultSchema.safeParse({ ...result, cwd: "/workspace", worktreeId: "private" }).success, false);

  const status = AiSessionStatusSchema.parse({
    id: "ai-n-1",
    agent: "codex",
    status: "idle",
    phase: "unknown",
    actions: { send: true },
    startedAt: now,
    updatedAt: now,
  });
  assert.equal(status.actions?.fork, undefined);
});

test("AI session mention schemas enforce canonical references and safe file results", () => {
  const references = [
    { kind: "skill", name: "Docs", path: "/workspace/.agents/skills/docs/SKILL.md" },
    { kind: "app", name: "GitHub", path: "app://github" },
    { kind: "plugin", name: "Review", path: "plugin://review@curated" },
  ];
  assert.deepEqual(AiSessionMessageInputSchema.parse({ message: "Use mentions" }).references, []);
  assert.deepEqual(AiSessionMessageRefInputSchema.parse({ message: "Use mentions", references }).references, references);
  assert.equal(AiSessionReferenceSchema.safeParse({ kind: "app", name: "GitHub", path: "plugin://github" }).success, false);
  assert.equal(AiSessionReferenceSchema.safeParse({ kind: "skill", name: "Docs", path: "relative/SKILL.md" }).success, false);
  assert.equal(AiSessionReferenceSchema.safeParse({ ...references[0], extra: true }).success, false);
  assert.equal(AiSessionMessageInputSchema.safeParse({ message: "Too many", references: Array.from({ length: 21 }, (_, index) => ({ kind: "app", name: `App ${index}`, path: `app://app-${index}` })) }).success, false);

  assert.equal(AiSessionMentionCandidateSchema.safeParse({ kind: "file", name: "index.ts", path: "src/index.ts" }).success, true);
  assert.equal(AiSessionMentionCandidateSchema.safeParse({ kind: "file", name: "secret", path: "../secret" }).success, false);
  assert.equal(AiSessionMentionFileSearchSchema.safeParse({ sessionId: "s", cwd: "/workspace", query: "src", requestId: "r", candidates: [{ kind: "skill", name: "Bad", path: "/tmp/SKILL.md" }] }).success, false);
});

function session(overrides = {}) {
  return {
    id: "session-a",
    agent: "codex",
    creationSource: "app-session",
    startedAt: now,
    updatedAt: now,
    counters: {},
    queue: {},
    ...overrides,
  };
}

test("AI session tool activity schemas default and project the window count", () => {
  const status = AiSessionStatusSchema.parse(session());
  assert.equal(status.toolCallsSinceLastMessage, 0);
  const summary = { ...status };
  delete summary.counters;
  assert.equal(AiSessionSummarySchema.parse(summary).toolCallsSinceLastMessage, 0);

  const projected = AiSessionSummarySchema.parse({ ...summary,
    currentTool: { id: "item-1", kind: "commandExecution", name: "Command", inputPreview: "pnpm test" },
    toolCallsSinceLastMessage: 3,
  });
  assert.deepEqual(projected.currentTool, {
    id: "item-1",
    kind: "commandExecution",
    name: "Command",
    inputPreview: "pnpm test",
  });
  assert.equal(projected.toolCallsSinceLastMessage, 3);
});

test("AI session tool activity schemas remain strict and require atomic realtime values", () => {
  assert.equal(AiSessionToolSchema.safeParse({ name: "Command", providerOutput: "secret" }).success, false);
  assert.equal(AiSessionStatusSchema.safeParse(session({ unknownField: true })).success, false);

  const baseEvent = { type: "event", source: "realtime", sessionId: "session-a", kind: "tool-activity" };
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...baseEvent, currentTool: null, toolCallsSinceLastMessage: 2 }).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...baseEvent, currentTool: null }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...baseEvent, toolCallsSinceLastMessage: 2 }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({
    type: "event",
    source: "realtime",
    sessionId: "session-a",
    kind: "turn-started",
    currentTool: null,
    toolCallsSinceLastMessage: 0,
  }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({
    type: "event",
    source: "realtime",
    sessionId: "session-a",
    kind: "session-error",
    error: "Realtime transport failed.",
  }).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({
    type: "event",
    source: "realtime",
    sessionId: "session-a",
    kind: "session-error",
  }).success, false);
});

test("AI session sub-agent state defaults, stays strict, and updates atomically", () => {
  const status = AiSessionStatusSchema.parse(session());
  assert.deepEqual(status.subAgents, []);
  assert.equal(AiSessionSubAgentSchema.safeParse({
    threadId: "thread-child",
    path: "agent-a",
    status: "running",
    activity: "interacted",
    updatedAt: now,
  }).success, true);
  assert.equal(AiSessionSubAgentSchema.safeParse({
    threadId: "thread-child",
    status: "running",
    updatedAt: now,
    toolCount: 1,
  }).success, false);

  const event = {
    type: "event",
    source: "realtime",
    sessionId: "session-a",
    kind: "sub-agent-activity",
    subAgents: [{ threadId: "thread-child", status: "completed", updatedAt: now }],
  };
  assert.equal(AiSessionRealtimeInputSchema.safeParse(event).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...event, subAgents: undefined }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...event, kind: "turn-started" }).success, false);
});

test("AI session context compaction events are structured and turn-scoped", () => {
  const event = {
    type: "event",
    source: "realtime",
    sessionId: "session-a",
    kind: "context-compaction",
    activeTurnId: "turn-a",
    contextCompaction: { id: "compact-a", status: "completed", completedAt: now },
  };
  assert.equal(AiSessionRealtimeInputSchema.safeParse(event).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...event, contextCompaction: undefined }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...event, kind: "turn-started" }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({
    ...event,
    contextCompaction: { ...event.contextCompaction, providerOutput: "not allowed" },
  }).success, false);
});

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

test("app session authority removes terminal states and never restores event tombstones to the active snapshot", () => {
  const snapshot = activeAppSessionsSnapshotFromRecords([
    { id: "running", status: "running" },
    { id: "stopped", status: "stopped" },
    { id: "closed", status: "closed" },
  ], now);
  assert.deepEqual(snapshot.sessions.map((session) => session.id), ["running"]);

  const normalizedSnapshotEvent = applyAppSessionStreamEvent(undefined, {
    type: AppSessionEventType.Snapshot,
    payload: {
      meta: meta(),
      snapshot: {
        runningCount: 1,
        problemCount: 0,
        sessions: [{ id: "running", status: "running" }, { id: "stopped", status: "stopped" }],
        updatedAt: now,
      },
    },
  });
  assert.equal(normalizedSnapshotEvent.kind, "applied");
  assert.deepEqual(normalizedSnapshotEvent.projection.snapshot.sessions.map((session) => session.id), ["running"]);

  const initial = applyAppSessionStreamEvent(undefined, {
    type: AppSessionEventType.Snapshot,
    payload: { meta: meta(), snapshot },
  });
  assert.equal(initial.kind, "applied");
  const removed = applyAppSessionStreamEvent(initial.projection, {
    type: AppSessionEventType.Removed,
    payload: {
      meta: meta({ revision: 2, previousRevision: 1, reason: "app-session-updated" }),
      sessionId: "running",
      tombstone: { id: "running", status: "stopped", bindings: [] },
    },
  });
  assert.equal(removed.kind, "applied");
  assert.deepEqual(removed.projection.snapshot.sessions, []);

  const legacyStoppedPatch = applyAppSessionStreamEvent(initial.projection, {
    type: AppSessionEventType.Patch,
    payload: {
      meta: meta({ revision: 2, previousRevision: 1, reason: "app-session-updated" }),
      session: { id: "running", status: "stopped", bindings: [] },
    },
  });
  assert.equal(legacyStoppedPatch.kind, "applied");
  assert.deepEqual(legacyStoppedPatch.projection.snapshot.sessions, []);
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
  assert.equal(AiSessionMessageDeltaEventSchema.safeParse({
    instanceId: "instance-a",
    sessionId: "session-a",
    providerSessionId: "thread-a",
    delta: "without identity",
    generatedAt: now,
  }).success, false);
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
