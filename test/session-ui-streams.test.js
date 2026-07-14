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

const { QueryClient } = require("@tanstack/vue-query");
const { AiSessionEventType } = require("../packages/protocol/src/ai-sessions.ts");
const { AppSessionEventType } = require("../packages/protocol/src/app-sessions.ts");
const {
  advertiseSessionStream,
  applyDomainEvent,
  configureSessionStreamApiLoader,
  resetSessionStreamRuntime,
  sessionStreamRuntimeState,
} = require("../packages/controlled-instance-ui/src/stores/events.ts");

function meta(streamId, revision, previousRevision, reason = "provider-event") {
  return {
    streamId,
    instanceId: "standalone",
    revision,
    previousRevision,
    traceId: `${streamId}_${revision}`,
    generatedAt: new Date().toISOString(),
    reason,
  };
}

function aiSnapshot(streamId, revision, sessions = []) {
  const generatedAt = new Date().toISOString();
  return {
    id: `event-ai-${revision}`,
    type: AiSessionEventType.Snapshot,
    createdAt: generatedAt,
    payload: {
      meta: meta(streamId, revision, revision ? revision - 1 : undefined),
      snapshot: { runningCount: 0, waitingCount: 0, staleCount: 0, sessions, updatedAt: generatedAt },
    },
  };
}

function aiPatch(streamId, revision, id) {
  const generatedAt = new Date().toISOString();
  return {
    type: AiSessionEventType.Patch,
    payload: {
      meta: meta(streamId, revision, revision - 1),
      upserted: [{ id, agent: "codex", status: "idle", phase: "unknown", startedAt: generatedAt, updatedAt: generatedAt, queue: { pendingCount: 0, items: [] } }],
      removed: [],
    },
  };
}

function appSnapshot(streamId, revision, sessions = []) {
  const generatedAt = new Date().toISOString();
  return {
    id: `event-app-${revision}`,
    type: AppSessionEventType.Snapshot,
    createdAt: generatedAt,
    payload: {
      meta: meta(streamId, revision, revision ? revision - 1 : undefined, "startup"),
      snapshot: { runningCount: sessions.length, problemCount: 0, sessions, updatedAt: generatedAt },
    },
  };
}

function appPatch(streamId, revision, id) {
  return {
    id: `event-app-${revision}`,
    type: AppSessionEventType.Patch,
    createdAt: new Date().toISOString(),
    payload: {
      meta: meta(streamId, revision, revision - 1, "app-session-updated"),
      session: { id, appId: "terminal-tty", status: "running", bindings: [] },
    },
  };
}

test("controlled UI applies connected session events without list HTTP refetch", async (t) => {
  t.after(resetSessionStreamRuntime);
  resetSessionStreamRuntime();
  const queryClient = new QueryClient();
  let requests = 0;
  configureSessionStreamApiLoader(async () => {
    requests += 1;
    throw new Error("live current streams must not issue HTTP requests");
  });

  assert.equal(applyDomainEvent(queryClient, aiSnapshot("ai-live", 1)), true);
  assert.equal(applyDomainEvent(queryClient, appSnapshot("app-live", 1)), true);
  await Promise.all([
    advertiseSessionStream({ topic: "ai.sessions", instanceId: "standalone", streamId: "ai-live", latestRevision: 1, earliestRetainedRevision: 1 }, queryClient),
    advertiseSessionStream({ topic: "app.sessions", instanceId: "standalone", streamId: "app-live", latestRevision: 1, earliestRetainedRevision: 1 }, queryClient),
  ]);
  assert.equal(applyDomainEvent(queryClient, { id: "event-ai-2", createdAt: new Date().toISOString(), ...aiPatch("ai-live", 2, "ai-live-session") }), true);
  assert.equal(applyDomainEvent(queryClient, appPatch("app-live", 2, "app-live-session")), true);

  assert.equal(requests, 0);
  assert.equal(sessionStreamRuntimeState().recovering.length, 0);
  assert.equal(sessionStreamRuntimeState().aiProjection.revision, 2);
  assert.equal(sessionStreamRuntimeState().appProjection.revision, 2);
  assert.equal(queryClient.getQueryData(["ai-sessions"]).sessions[0].id, "ai-live-session");
  assert.equal(queryClient.getQueryData(["app-sessions"])[0].id, "app-live-session");
});

test("controlled UI recovers AI independently while app events remain live", async (t) => {
  t.after(resetSessionStreamRuntime);
  resetSessionStreamRuntime();
  const queryClient = new QueryClient();
  applyDomainEvent(queryClient, aiSnapshot("ai-recover", 1));
  applyDomainEvent(queryClient, appSnapshot("app-live", 1));
  let releaseDelta;
  const deltaReady = new Promise((resolve) => { releaseDelta = resolve; });
  const requested = [];
  configureSessionStreamApiLoader(async (path) => {
    requested.push(path);
    await deltaReady;
    return {
      streamId: "ai-recover",
      instanceId: "standalone",
      sinceRevision: 1,
      latestRevision: 2,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [aiPatch("ai-recover", 2, "ai-recovered")],
    };
  });

  const aiRecovery = advertiseSessionStream({ topic: "ai.sessions", instanceId: "standalone", streamId: "ai-recover", latestRevision: 2, earliestRetainedRevision: 2 }, queryClient);
  await advertiseSessionStream({ topic: "app.sessions", instanceId: "standalone", streamId: "app-live", latestRevision: 1, earliestRetainedRevision: 1 }, queryClient);
  assert.equal(applyDomainEvent(queryClient, appPatch("app-live", 2, "app-during-ai-recovery")), true);
  assert.equal(queryClient.getQueryData(["app-sessions"])[0].id, "app-during-ai-recovery");
  assert.equal(requested.length, 1);
  releaseDelta();
  await aiRecovery;
  assert.equal(queryClient.getQueryData(["ai-sessions"]).sessions[0].id, "ai-recovered");
});

test("controlled UI keeps same-stream live high-water until authoritative recovery catches up", async (t) => {
  t.after(resetSessionStreamRuntime);
  resetSessionStreamRuntime();
  const queryClient = new QueryClient();
  applyDomainEvent(queryClient, aiSnapshot("ai-high-water", 1));
  let releaseFirstDelta;
  const firstDeltaReady = new Promise((resolve) => { releaseFirstDelta = resolve; });
  const requested = [];
  configureSessionStreamApiLoader(async (path) => {
    requested.push(path);
    if (requested.length === 1) {
      await firstDeltaReady;
      return {
        streamId: "ai-high-water",
        instanceId: "standalone",
        sinceRevision: 1,
        latestRevision: 2,
        earliestRetainedRevision: 2,
        syncRequired: false,
        events: [aiPatch("ai-high-water", 2, "ai-two")],
      };
    }
    return {
      streamId: "ai-high-water",
      instanceId: "standalone",
      sinceRevision: 2,
      latestRevision: 3,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [aiPatch("ai-high-water", 3, "ai-three")],
    };
  });

  const recovery = advertiseSessionStream({ topic: "ai.sessions", instanceId: "standalone", streamId: "ai-high-water", latestRevision: 2, earliestRetainedRevision: 2 }, queryClient);
  await new Promise((resolve) => setImmediate(resolve));
  applyDomainEvent(queryClient, { id: "event-ai-3", createdAt: new Date().toISOString(), ...aiPatch("ai-high-water", 3, "discarded-live-payload") });
  releaseFirstDelta();
  await recovery;

  assert.equal(requested.length, 2);
  assert.equal(sessionStreamRuntimeState().aiProjection.revision, 3);
  assert.deepEqual(queryClient.getQueryData(["ai-sessions"]).sessions.map((session) => session.id).sort(), ["ai-three", "ai-two"]);
});

test("controlled UI ignores obsolete stream revisions while recovering the advertised stream", async (t) => {
  t.after(resetSessionStreamRuntime);
  resetSessionStreamRuntime();
  const queryClient = new QueryClient();
  applyDomainEvent(queryClient, aiSnapshot("ai-current", 1));
  let releaseDelta;
  const deltaReady = new Promise((resolve) => { releaseDelta = resolve; });
  let requests = 0;
  configureSessionStreamApiLoader(async () => {
    requests += 1;
    await deltaReady;
    return {
      streamId: "ai-current",
      instanceId: "standalone",
      sinceRevision: 1,
      latestRevision: 2,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [aiPatch("ai-current", 2, "ai-current-two")],
    };
  });

  const recovery = advertiseSessionStream({ topic: "ai.sessions", instanceId: "standalone", streamId: "ai-current", latestRevision: 2, earliestRetainedRevision: 2 }, queryClient);
  await new Promise((resolve) => setImmediate(resolve));
  applyDomainEvent(queryClient, { id: "event-ai-old", createdAt: new Date().toISOString(), ...aiPatch("ai-obsolete", 50, "obsolete") });
  releaseDelta();
  await recovery;

  assert.equal(requests, 1);
  assert.equal(sessionStreamRuntimeState().aiProjection.streamId, "ai-current");
  assert.equal(sessionStreamRuntimeState().aiProjection.revision, 2);
});
