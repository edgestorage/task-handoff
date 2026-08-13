const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { QueryClient, VueQueryPlugin } = require("@tanstack/vue-query");
const { createApp, nextTick, ref } = require("vue");
const { AiSessionEventType } = require("../packages/protocol/src/ai-sessions.ts");
const { AppSessionEventType } = require("../packages/protocol/src/app-sessions.ts");
const { useAiSessionStore: createAiSessionStore } = require("../packages/control-plane-ui/src/apps/control-plane/useAiSessionStore.ts");
const { useStreamingMessagesStore } = require("../packages/control-plane-ui/src/apps/control-plane/useStreamingMessagesStore.ts");
const { useAppSessionStore: createAppSessionStore } = require("../packages/control-plane-ui/src/apps/control-plane/useAppSessionStore.ts");

function useAiSessionStore(input) {
  return createAiSessionStore({ queryKey: () => ["control-plane-ai-sessions", "*"], ...input });
}

function useAppSessionStore(input) {
  return createAppSessionStore({ queryKey: () => ["control-plane-app-sessions", "*"], ...input });
}

function aiSessionsApiFromLoader(apiLoader) {
  return {
    refresh: (signal) => apiLoader("ai-sessions?refresh=true", { signal }),
    delta: (instanceId, streamId, sinceRevision, signal) => apiLoader(
      `ai-sessions?instanceId=${encodeURIComponent(instanceId)}&streamId=${encodeURIComponent(streamId)}&sinceRevision=${encodeURIComponent(String(sinceRevision))}`,
      { signal },
    ),
  };
}

function timestamp() {
  return new Date().toISOString();
}

function summary(id, overrides = {}) {
  const now = timestamp();
  return {
    id,
    agent: "codex",
    appSessionId: `app_${id}`,
    appId: "codex",
    providerSessionId: `thread_${id}`,
    status: "idle",
    phase: "unknown",
    startedAt: now,
    updatedAt: now,
    queue: { pendingCount: 0, items: [] },
    ...overrides,
  };
}

function snapshotEvent(streamId, revision, sessions) {
  const generatedAt = timestamp();
  return {
    meta: {
      streamId,
      instanceId: "instance-one",
      revision,
      previousRevision: revision ? revision - 1 : undefined,
      traceId: `${streamId}_${revision}`,
      generatedAt,
      reason: "provider-event",
    },
    snapshot: { runningCount: 0, waitingCount: 0, staleCount: 0, sessions, updatedAt: generatedAt },
  };
}

function appSnapshotEvent(streamId, revision, sessions) {
  const generatedAt = timestamp();
  return {
    meta: {
      streamId,
      instanceId: "instance-one",
      revision,
      previousRevision: revision ? revision - 1 : undefined,
      traceId: `${streamId}_${revision}`,
      generatedAt,
      reason: "app-session-updated",
    },
    snapshot: {
      runningCount: sessions.filter((session) => session.status === "running").length,
      problemCount: sessions.filter((session) => session.status === "failed").length,
      sessions,
      updatedAt: generatedAt,
    },
  };
}

test("control-plane UI applies an authoritative AI snapshot while recovery is in flight", async () => {
  const queryClient = new QueryClient();
  const streamId = "ai-stream";
  const initial = snapshotEvent(streamId, 1, [summary("old")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  let releaseDelta;
  const deltaGate = new Promise((resolve) => { releaseDelta = resolve; });
  const apiLoader = async () => {
    await deltaGate;
    return {
      streamId,
      instanceId: "instance-one",
      sinceRevision: 1,
      latestRevision: 2,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [{ type: AiSessionEventType.Snapshot, payload: snapshotEvent(streamId, 2, [summary("recovered")]) }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, aiSessionsApi: aiSessionsApiFromLoader(apiLoader) }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId,
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.applySnapshotEvent(snapshotEvent(streamId, 3, [summary("live")]));

  let entry = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0];
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live"]);

  releaseDelta();
  await recovery;
  entry = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0];
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live"]);
});

test("a late AI recovery response cannot roll the advertised stream back", async () => {
  const queryClient = new QueryClient();
  const initial = snapshotEvent("old-stream", 1, [summary("old")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "old-stream", revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  let releaseDelta;
  const deltaGate = new Promise((resolve) => { releaseDelta = resolve; });
  const apiLoader = async () => {
    await deltaGate;
    return {
      streamId: "old-stream",
      instanceId: "instance-one",
      sinceRevision: 1,
      latestRevision: 2,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [{ type: AiSessionEventType.Snapshot, payload: snapshotEvent("old-stream", 2, [summary("late-old")]) }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, aiSessionsApi: aiSessionsApiFromLoader(apiLoader) }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId: "old-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.applySnapshotEvent(snapshotEvent("new-stream", 1, [summary("new")]));
  releaseDelta();
  await recovery;
  store.applyEvent({
    type: AiSessionEventType.Patch,
    payload: {
      meta: {
        streamId: "new-stream",
        instanceId: "instance-one",
        revision: 2,
        previousRevision: 1,
        traceId: "new-stream-patch",
        generatedAt: timestamp(),
        reason: "provider-event",
      },
      upserted: [summary("newer")],
      removed: ["new"],
    },
  });

  const entry = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0];
  assert.equal(entry.streamId, "new-stream");
  assert.equal(entry.revision, 2);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["newer"]);
});

test("an older AI refresh cannot overwrite a newer live snapshot on the same stream", async () => {
  const queryClient = new QueryClient();
  const cached = snapshotEvent("cached-stream", 1, [summary("cached")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "cached-stream", revision: 1, lastEventAt: cached.meta.generatedAt, aiSessions: cached.snapshot }],
  });
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const refreshed = snapshotEvent("target-stream", 2, [summary("stale-refresh")]);
  const apiLoader = async () => {
    await refreshGate;
    return {
      updatedAt: timestamp(),
      instances: [{ instanceId: "instance-one", streamId: "target-stream", revision: 2, lastEventAt: refreshed.meta.generatedAt, aiSessions: refreshed.snapshot }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, aiSessionsApi: aiSessionsApiFromLoader(apiLoader) }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId: "target-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.applySnapshotEvent(snapshotEvent("target-stream", 5, [summary("live-newer")]));
  releaseRefresh();
  await recovery;

  const entry = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0];
  assert.equal(entry.streamId, "target-stream");
  assert.equal(entry.revision, 5);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live-newer"]);
});

test("AI recovery retries a transient loader failure until the advertised revision converges", async () => {
  const queryClient = new QueryClient();
  const initial = snapshotEvent("failure-stream", 1, [summary("cached")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "failure-stream", revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  let calls = 0;
  const store = app.runWithContext(() => useAiSessionStore({
    boardInstances: () => [],
    aiSessions: () => undefined,
    recoveryRetry: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    aiSessionsApi: aiSessionsApiFromLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network unavailable");
      return {
        streamId: "failure-stream",
        instanceId: "instance-one",
        sinceRevision: 1,
        latestRevision: 2,
        earliestRetainedRevision: 2,
        syncRequired: false,
        events: [{ type: AiSessionEventType.Snapshot, payload: snapshotEvent("failure-stream", 2, [summary("recovered")]) }],
      };
    }),
  }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId: "failure-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await recovery;
  const entry = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0];
  assert.equal(calls, 2);
  assert.equal(entry.revision, 2);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["recovered"]);
});

test("a live AI event immediately wakes a recovery waiting in backoff", async () => {
  const queryClient = new QueryClient();
  const initial = snapshotEvent("wake-stream", 1, [summary("cached")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "wake-stream", revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  let calls = 0;
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({
    boardInstances: () => [],
    aiSessions: () => undefined,
    recoveryRetry: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 },
    aiSessionsApi: aiSessionsApiFromLoader(async () => {
      calls += 1;
      throw new Error("network unavailable");
    }),
  }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId: "wake-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.applySnapshotEvent(snapshotEvent("wake-stream", 2, [summary("live")]));
  await recovery;

  assert.equal(calls, 1);
  assert.equal(queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0].revision, 2);
});

test("control-plane UI preserves authoritative tool activity across snapshot and patch events", () => {
  const queryClient = new QueryClient();
  const streamId = "ai-tool-stream";
  const startedAt = timestamp();
  const initial = snapshotEvent(streamId, 1, [summary("tool", {
    status: "running",
    phase: "tool",
    currentTool: { id: "tool_1", kind: "commandExecution", name: "Command", inputPreview: "pnpm test", startedAt },
    toolCallsSinceLastMessage: 1,
  })]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined }));

  store.applyEvent({
    type: AiSessionEventType.Patch,
    payload: {
      meta: {
        streamId,
        instanceId: "instance-one",
        revision: 2,
        previousRevision: 1,
        traceId: "tool_patch_2",
        generatedAt: timestamp(),
        reason: "provider-event",
      },
      upserted: [summary("tool", {
        status: "running",
        phase: "thinking",
        toolCallsSinceLastMessage: 2,
      })],
      removed: [],
    },
  });

  const session = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0].aiSessions.sessions[0];
  assert.equal(session.currentTool, undefined);
  assert.equal(session.toolCallsSinceLastMessage, 2);
});

test("AI recovery cancels mismatched-stream backoff when the next live stream resets", async () => {
  const queryClient = new QueryClient();
  const cached = snapshotEvent("cached-stream", 1, [summary("cached")]);
  const refreshed = snapshotEvent("new-stream", 2, [summary("refreshed")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "cached-stream", revision: 1, lastEventAt: cached.meta.generatedAt, aiSessions: cached.snapshot }],
  });
  let requests = 0;
  const apiLoader = async () => {
    requests += 1;
    return {
      updatedAt: timestamp(),
      instances: [{ instanceId: "instance-one", streamId: "new-stream", revision: 2, lastEventAt: refreshed.meta.generatedAt, aiSessions: refreshed.snapshot }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, aiSessionsApi: aiSessionsApiFromLoader(apiLoader) }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId: "advertised-old-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0].streamId, "cached-stream");

  store.applySnapshotEvent(snapshotEvent("new-stream", 3, [summary("live")]));
  await recovery;
  const entry = queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0];
  assert.equal(entry.streamId, "new-stream");
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live"]);
});

test("AI recovery retries when a delta request makes no progress", async () => {
  const queryClient = new QueryClient();
  const cached = snapshotEvent("ai-stream", 1, [summary("cached")]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "ai-stream", revision: 1, lastEventAt: cached.meta.generatedAt, aiSessions: cached.snapshot }],
  });
  let requests = 0;
  const apiLoader = async () => {
    requests += 1;
    if (requests > 1) {
      return {
        streamId: "ai-stream",
        instanceId: "instance-one",
        sinceRevision: 1,
        latestRevision: 2,
        earliestRetainedRevision: 2,
        syncRequired: false,
        events: [{ type: AiSessionEventType.Snapshot, payload: snapshotEvent("ai-stream", 2, [summary("recovered")]) }],
      };
    }
    return { streamId: "ai-stream", instanceId: "instance-one", sinceRevision: 1, latestRevision: 1, earliestRetainedRevision: 2, syncRequired: false, events: [] };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({
    boardInstances: () => [],
    aiSessions: () => undefined,
    aiSessionsApi: aiSessionsApiFromLoader(apiLoader),
    recoveryRetry: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }));

  await store.recoverDescriptor({ topic: "ai.sessions", instanceId: "instance-one", streamId: "ai-stream", latestRevision: 2, earliestRetainedRevision: 2 });
  assert.equal(requests, 2);
  assert.equal(queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances[0].revision, 2);
});

test("AI full-snapshot recovery settles the normalized streaming store", async () => {
  const queryClient = new QueryClient();
  const streamId = "ai-recovery-stream";
  const running = summary("recovering", {
    status: "running",
    phase: "responding",
    activeTurnId: "turn-recovering",
    turns: [{ id: "turn-recovering", status: "running", revision: 1 }],
  });
  const initial = snapshotEvent(streamId, 1, [running]);
  const recovered = snapshotEvent(streamId, 2, [{
    ...running,
    status: "idle",
    phase: "unknown",
    activeTurnId: undefined,
    lastMessage: "authoritative response",
    lastMessageItemId: "item-recovering",
    turns: [{
      id: "turn-recovering",
      status: "completed",
      revision: 2,
      lastMessage: "authoritative response",
      lastMessageItemId: "item-recovering",
    }],
  }]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  const apiLoader = async (url) => url.includes("sinceRevision")
    ? { streamId, instanceId: "instance-one", sinceRevision: 1, latestRevision: 2, earliestRetainedRevision: 2, syncRequired: true, events: [] }
    : { updatedAt: timestamp(), instances: [{ instanceId: "instance-one", streamId, revision: 2, lastEventAt: recovered.meta.generatedAt, aiSessions: recovered.snapshot }] };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, aiSessionsApi: aiSessionsApiFromLoader(apiLoader) }));
  const streaming = useStreamingMessagesStore();
  streaming.clear();

  store.applyMessageDelta({
    instanceId: "instance-one",
    sessionId: "recovering",
    providerSessionId: "thread_recovering",
    turnId: "turn-recovering",
    itemId: "item-recovering",
    delta: "partial",
    generatedAt: timestamp(),
  });
  const active = streaming.activeMessage("instance-one", "recovering").value;

  await store.recoverDescriptor({ topic: "ai.sessions", instanceId: "instance-one", streamId, latestRevision: 2, earliestRetainedRevision: 2 });

  assert.equal(active.value.receivedText, "authoritative response");
  assert.equal(active.value.status, "complete");
  streaming.clear();
});

test("removing an authoritative instance releases its streaming projection before the same id is recreated", async () => {
  const queryClient = new QueryClient();
  const streamId = "ai-instance-lifecycle";
  const initial = snapshotEvent(streamId, 1, [summary("lifecycle", {
    status: "running",
    phase: "responding",
    activeTurnId: "turn-lifecycle",
    turns: [{ id: "turn-lifecycle", status: "running", revision: 1 }],
  })]);
  const authoritative = ref({
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], authoritative.value);
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => authoritative.value }));
  const streaming = useStreamingMessagesStore();
  streaming.clear();

  store.applyMessageDelta({
    instanceId: "instance-one",
    sessionId: "lifecycle",
    providerSessionId: "thread_lifecycle",
    turnId: "turn-lifecycle",
    itemId: "item-lifecycle",
    delta: "old text",
    generatedAt: timestamp(),
  });
  const previousActive = streaming.activeMessage("instance-one", "lifecycle");

  authoritative.value = { updatedAt: timestamp(), instances: [] };
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], authoritative.value);
  await nextTick();

  assert.equal(previousActive.value, undefined);
  assert.equal(streaming.size(), 0);

  authoritative.value = {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  };
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], authoritative.value);
  await nextTick();
  store.applyMessageDelta({
    instanceId: "instance-one",
    sessionId: "lifecycle",
    providerSessionId: "thread_lifecycle",
    turnId: "turn-lifecycle",
    itemId: "item-lifecycle",
    delta: "new text",
    generatedAt: timestamp(),
  });

  const recreatedActive = streaming.activeMessage("instance-one", "lifecycle");
  assert.notStrictEqual(recreatedActive, previousActive);
  assert.equal(recreatedActive.value.value.receivedText, "new text");
  streaming.clear();
});

test("removing an authoritative instance prevents an in-flight recovery from restoring it", async () => {
  const queryClient = new QueryClient();
  const streamId = "ai-instance-removal-recovery";
  const initial = snapshotEvent(streamId, 1, [summary("removed")]);
  const authoritative = ref({
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], authoritative.value);
  let releaseDelta;
  const deltaGate = new Promise((resolve) => { releaseDelta = resolve; });
  const apiLoader = async () => {
    await deltaGate;
    return {
      streamId,
      instanceId: "instance-one",
      sinceRevision: 1,
      latestRevision: 2,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [{ type: AiSessionEventType.Snapshot, payload: snapshotEvent(streamId, 2, [summary("restored")]) }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => authoritative.value, aiSessionsApi: aiSessionsApiFromLoader(apiLoader) }));
  const streaming = useStreamingMessagesStore();
  streaming.clear();

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId,
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));

  authoritative.value = { updatedAt: timestamp(), instances: [] };
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], authoritative.value);
  await nextTick();
  releaseDelta();
  await recovery;

  assert.deepEqual(queryClient.getQueryData(["control-plane-ai-sessions", "*"]).instances, []);
  assert.equal(streaming.size(), 0);
});

test("AI message deltas and authoritative snapshots drive the normalized streaming store", () => {
  const queryClient = new QueryClient();
  const streamId = "ai-streaming";
  const running = {
    ...summary("streaming"),
    status: "running",
    phase: "responding",
    activeTurnId: "turn-streaming",
    turns: [{ id: "turn-streaming", status: "running", revision: 1 }],
  };
  const initial = snapshotEvent(streamId, 1, [running]);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined }));
  const streaming = useStreamingMessagesStore();
  streaming.clear();
  const queryBeforeDelta = queryClient.getQueryData(["control-plane-ai-sessions", "*"]);
  const instanceBeforeDelta = queryBeforeDelta.instances[0];
  const sessionBeforeDelta = instanceBeforeDelta.aiSessions.sessions[0];
  let queryUpdates = 0;
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event?.query?.queryHash === '["control-plane-ai-sessions", "*"]' && event.type === "updated") queryUpdates += 1;
  });

  assert.equal(store.applyMessageDelta({
    instanceId: "instance-one",
    sessionId: "streaming",
    providerSessionId: "thread_streaming",
    turnId: "turn-streaming",
    itemId: "item-streaming",
    delta: "helo",
    generatedAt: timestamp(),
  }), true);
  const active = streaming.activeMessage("instance-one", "streaming").value;
  assert.equal(active.value.receivedText, "helo");
  assert.equal(active.value.status, "streaming");
  assert.strictEqual(queryClient.getQueryData(["control-plane-ai-sessions", "*"]), queryBeforeDelta);
  assert.strictEqual(queryBeforeDelta.instances[0], instanceBeforeDelta);
  assert.strictEqual(instanceBeforeDelta.aiSessions.sessions[0], sessionBeforeDelta);
  assert.equal(queryUpdates, 0);

  store.applySnapshotEvent(snapshotEvent(streamId, 2, [{
    ...running,
    status: "idle",
    activeTurnId: undefined,
    lastMessage: "hello",
    turns: [{ id: "turn-streaming", status: "completed", revision: 2, lastMessage: "hello" }],
  }]));
  assert.equal(active.value.receivedText, "hello");
  assert.equal(active.value.status, "complete");
  unsubscribe();
  streaming.clear();
});

test("the first post-refresh assistant item does not inherit the snapshot item text", () => {
  const queryClient = new QueryClient();
  const streamId = "ai-refresh-stream";
  const initial = snapshotEvent(streamId, 0, []);
  queryClient.setQueryData(["control-plane-ai-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 0, lastEventAt: initial.meta.generatedAt, aiSessions: initial.snapshot }],
  });
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined }));
  const streaming = useStreamingMessagesStore();
  streaming.clear();

  const running = summary("refreshing", {
    status: "running",
    phase: "tool",
    activeTurnId: "turn-refreshing",
    lastMessage: "message before refresh",
    lastMessageItemId: "item-before-refresh",
    turns: [{
      id: "turn-refreshing",
      status: "running",
      revision: 2,
      lastMessage: "message before refresh",
      lastMessageItemId: "item-before-refresh",
    }],
  });
  store.applySnapshotEvent(snapshotEvent(streamId, 1, [running]));

  assert.equal(store.applyMessageDelta({
    instanceId: "instance-one",
    sessionId: "refreshing",
    providerSessionId: "thread_refreshing",
    turnId: "turn-refreshing",
    itemId: "item-after-refresh",
    delta: "message after refresh",
    generatedAt: timestamp(),
  }), true);

  const active = streaming.activeMessage("instance-one", "refreshing").value;
  assert.equal(active.value.itemId, "item-after-refresh");
  assert.equal(active.value.receivedText, "message after refresh");
  streaming.clear();
});

test("app recovery cancels mismatched-stream backoff when the next live stream resets", async () => {
  const queryClient = new QueryClient();
  const cached = appSnapshotEvent("cached-stream", 1, [{ id: "cached", appId: "codex", status: "running", bindings: [] }]);
  const refreshed = appSnapshotEvent("new-stream", 2, [{ id: "refreshed", appId: "codex", status: "running", bindings: [] }]);
  queryClient.setQueryData(["control-plane-app-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "cached-stream", revision: 1, lastEventAt: cached.meta.generatedAt, appSessions: cached.snapshot }],
  });
  let requests = 0;
  const apiLoader = async () => {
    requests += 1;
    return {
      updatedAt: timestamp(),
      instances: [{ instanceId: "instance-one", streamId: "new-stream", revision: 2, lastEventAt: refreshed.meta.generatedAt, appSessions: refreshed.snapshot }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAppSessionStore({ boardInstances: () => [], appSessions: () => undefined, apiLoader }));

  const recovery = store.recoverDescriptor({
    topic: "app.sessions",
    instanceId: "instance-one",
    streamId: "advertised-old-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(queryClient.getQueryData(["control-plane-app-sessions", "*"]).instances[0].streamId, "cached-stream");

  store.applyEvent({ type: AppSessionEventType.Snapshot, payload: appSnapshotEvent("new-stream", 3, [{ id: "live", appId: "codex", status: "running", bindings: [] }]) });
  await recovery;
  const entry = queryClient.getQueryData(["control-plane-app-sessions", "*"]).instances[0];
  assert.equal(entry.streamId, "new-stream");
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.appSessions.sessions.map((session) => session.id), ["live"]);
});

test("app recovery retries when a delta request makes no progress", async () => {
  const queryClient = new QueryClient();
  const cached = appSnapshotEvent("app-stream", 1, [{ id: "cached", appId: "codex", status: "running", bindings: [] }]);
  queryClient.setQueryData(["control-plane-app-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "app-stream", revision: 1, lastEventAt: cached.meta.generatedAt, appSessions: cached.snapshot }],
  });
  let requests = 0;
  const apiLoader = async () => {
    requests += 1;
    if (requests > 1) {
      return {
        streamId: "app-stream",
        instanceId: "instance-one",
        sinceRevision: 1,
        latestRevision: 2,
        earliestRetainedRevision: 2,
        syncRequired: false,
        events: [{ type: AppSessionEventType.Snapshot, payload: appSnapshotEvent("app-stream", 2, [{ id: "recovered", appId: "codex", status: "running", bindings: [] }]) }],
      };
    }
    return { streamId: "app-stream", instanceId: "instance-one", sinceRevision: 1, latestRevision: 1, earliestRetainedRevision: 2, syncRequired: false, events: [] };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAppSessionStore({
    boardInstances: () => [],
    appSessions: () => undefined,
    apiLoader,
    recoveryRetry: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }));

  await store.recoverDescriptor({ topic: "app.sessions", instanceId: "instance-one", streamId: "app-stream", latestRevision: 2, earliestRetainedRevision: 2 });
  assert.equal(requests, 2);
  assert.equal(queryClient.getQueryData(["control-plane-app-sessions", "*"]).instances[0].revision, 2);
});

test("control-plane UI consumes the shared authoritative App Session projection without its own status filter", () => {
  const queryClient = new QueryClient();
  const streamId = "app-authoritative";
  const initial = appSnapshotEvent(streamId, 1, [{ id: "app", appId: "terminal-tty", status: "running", bindings: [] }]);
  queryClient.setQueryData(["control-plane-app-sessions", "*"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, appSessions: initial.snapshot }],
  });
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAppSessionStore({ boardInstances: () => [], appSessions: () => undefined, apiLoader: async () => undefined }));

  store.applyEvent({
    type: AppSessionEventType.Patch,
    payload: {
      meta: { ...initial.meta, revision: 2, previousRevision: 1, traceId: "app-authoritative-2" },
      session: { id: "app", appId: "terminal-tty", status: "stopped", bindings: [] },
    },
  });

  assert.deepEqual(queryClient.getQueryData(["control-plane-app-sessions", "*"]).instances[0].appSessions.sessions, []);
});

test("removing an authoritative app-session instance cancels its in-flight recovery", async () => {
  const queryClient = new QueryClient();
  const streamId = "app-instance-removal";
  const initial = appSnapshotEvent(streamId, 1, [{ id: "removed", appId: "codex", status: "running", bindings: [] }]);
  const authoritative = ref({
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId, revision: 1, lastEventAt: initial.meta.generatedAt, appSessions: initial.snapshot }],
  });
  queryClient.setQueryData(["control-plane-app-sessions", "*"], authoritative.value);
  let releaseDelta;
  const deltaGate = new Promise((resolve) => { releaseDelta = resolve; });
  const apiLoader = async () => {
    await deltaGate;
    return {
      streamId,
      instanceId: "instance-one",
      sinceRevision: 1,
      latestRevision: 2,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [{ type: AppSessionEventType.Snapshot, payload: appSnapshotEvent(streamId, 2, [{ id: "restored", appId: "codex", status: "running", bindings: [] }]) }],
    };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAppSessionStore({ boardInstances: () => [], appSessions: () => authoritative.value, apiLoader }));

  const recovery = store.recoverDescriptor({
    topic: "app.sessions",
    instanceId: "instance-one",
    streamId,
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  authoritative.value = { updatedAt: timestamp(), instances: [] };
  queryClient.setQueryData(["control-plane-app-sessions", "*"], authoritative.value);
  await nextTick();
  releaseDelta();
  await recovery;

  assert.deepEqual(queryClient.getQueryData(["control-plane-app-sessions", "*"]).instances, []);
});
