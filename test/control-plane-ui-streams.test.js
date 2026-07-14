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
const { createApp } = require("vue");
const { AiSessionEventType } = require("../packages/protocol/src/ai-sessions.ts");
const { AppSessionEventType } = require("../packages/protocol/src/app-sessions.ts");
const { useAiSessionStore } = require("../packages/control-plane-ui/src/apps/control-plane/useAiSessionStore.ts");
const { useAppSessionStore } = require("../packages/control-plane-ui/src/apps/control-plane/useAppSessionStore.ts");

function timestamp() {
  return new Date().toISOString();
}

function summary(id) {
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
  queryClient.setQueryData(["control-plane-ai-sessions"], {
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
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, apiLoader }));

  const recovery = store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId,
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.applySnapshotEvent(snapshotEvent(streamId, 3, [summary("live")]));

  let entry = queryClient.getQueryData(["control-plane-ai-sessions"]).instances[0];
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live"]);

  releaseDelta();
  await recovery;
  entry = queryClient.getQueryData(["control-plane-ai-sessions"]).instances[0];
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live"]);
});

test("AI recovery stops on a mismatched snapshot and adopts the next live stream reset", async () => {
  const queryClient = new QueryClient();
  const cached = snapshotEvent("cached-stream", 1, [summary("cached")]);
  const refreshed = snapshotEvent("new-stream", 2, [summary("refreshed")]);
  queryClient.setQueryData(["control-plane-ai-sessions"], {
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
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, apiLoader }));

  await store.recoverDescriptor({
    topic: "ai.sessions",
    instanceId: "instance-one",
    streamId: "advertised-old-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  assert.equal(requests, 1);
  assert.equal(queryClient.getQueryData(["control-plane-ai-sessions"]).instances[0].streamId, "cached-stream");

  store.applySnapshotEvent(snapshotEvent("new-stream", 3, [summary("live")]));
  const entry = queryClient.getQueryData(["control-plane-ai-sessions"]).instances[0];
  assert.equal(entry.streamId, "new-stream");
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.aiSessions.sessions.map((session) => session.id), ["live"]);
});

test("AI recovery stops when a delta request makes no progress", async () => {
  const queryClient = new QueryClient();
  const cached = snapshotEvent("ai-stream", 1, [summary("cached")]);
  queryClient.setQueryData(["control-plane-ai-sessions"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "ai-stream", revision: 1, lastEventAt: cached.meta.generatedAt, aiSessions: cached.snapshot }],
  });
  let requests = 0;
  const apiLoader = async () => {
    requests += 1;
    return { streamId: "ai-stream", instanceId: "instance-one", sinceRevision: 1, latestRevision: 1, earliestRetainedRevision: 2, syncRequired: false, events: [] };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAiSessionStore({ boardInstances: () => [], aiSessions: () => undefined, apiLoader }));

  await store.recoverDescriptor({ topic: "ai.sessions", instanceId: "instance-one", streamId: "ai-stream", latestRevision: 2, earliestRetainedRevision: 2 });
  assert.equal(requests, 1);
});

test("app recovery stops on a mismatched snapshot and adopts the next live stream reset", async () => {
  const queryClient = new QueryClient();
  const cached = appSnapshotEvent("cached-stream", 1, [{ id: "cached", appId: "codex", status: "running", bindings: [] }]);
  const refreshed = appSnapshotEvent("new-stream", 2, [{ id: "refreshed", appId: "codex", status: "running", bindings: [] }]);
  queryClient.setQueryData(["control-plane-app-sessions"], {
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

  await store.recoverDescriptor({
    topic: "app.sessions",
    instanceId: "instance-one",
    streamId: "advertised-old-stream",
    latestRevision: 2,
    earliestRetainedRevision: 2,
  });
  assert.equal(requests, 1);
  assert.equal(queryClient.getQueryData(["control-plane-app-sessions"]).instances[0].streamId, "cached-stream");

  store.applyEvent({ type: AppSessionEventType.Snapshot, payload: appSnapshotEvent("new-stream", 3, [{ id: "live", appId: "codex", status: "running", bindings: [] }]) });
  const entry = queryClient.getQueryData(["control-plane-app-sessions"]).instances[0];
  assert.equal(entry.streamId, "new-stream");
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.appSessions.sessions.map((session) => session.id), ["live"]);
});

test("app recovery stops when a delta request makes no progress", async () => {
  const queryClient = new QueryClient();
  const cached = appSnapshotEvent("app-stream", 1, [{ id: "cached", appId: "codex", status: "running", bindings: [] }]);
  queryClient.setQueryData(["control-plane-app-sessions"], {
    updatedAt: timestamp(),
    instances: [{ instanceId: "instance-one", streamId: "app-stream", revision: 1, lastEventAt: cached.meta.generatedAt, appSessions: cached.snapshot }],
  });
  let requests = 0;
  const apiLoader = async () => {
    requests += 1;
    return { streamId: "app-stream", instanceId: "instance-one", sinceRevision: 1, latestRevision: 1, earliestRetainedRevision: 2, syncRequired: false, events: [] };
  };
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const store = app.runWithContext(() => useAppSessionStore({ boardInstances: () => [], appSessions: () => undefined, apiLoader }));

  await store.recoverDescriptor({ topic: "app.sessions", instanceId: "instance-one", streamId: "app-stream", latestRevision: 2, earliestRetainedRevision: 2 });
  assert.equal(requests, 1);
});
