const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AiSessionCloseCoordinator } = require("../packages/ai-session-runtime/src/ai-session-close.ts");
const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionHistoryStore } = require("../packages/ai-session-runtime/src/ai-session-history-store.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { projectOpenCodeSession } = require("../packages/ai-session-runtime/src/opencode/projector.ts");
const { createControlPlaneAiSessionsApi } = require("../packages/control-plane-client/src/ai-sessions.ts");
const { projectAiSessionAuthorityChange } = require("../packages/controlled-instance/src/web/ai-session-authority-events.ts");
const {
  aiSessionRetentionCandidates,
  deriveAiSessionForest,
  flattenAiSessionForest,
} = require("../packages/protocol/src/ai-session-hierarchy.ts");

const observedAt = "2026-09-10T00:00:00.000Z";
const observedAtMs = Date.parse(observedAt);

function openCodeSession(id, parentID) {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    title: id,
    directory: "/workspace",
    version: "1.18.29",
    time: { created: observedAtMs, updated: observedAtMs },
  };
}

test("OpenCode subagent hierarchy keeps one identity chain through lifecycle and UI projections", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-hierarchy-e2e-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
  const parentProjection = projectOpenCodeSession({
    session: openCodeSession("provider-parent"),
    permissions: [],
    messages: [],
  });
  const childProjection = projectOpenCodeSession({
    session: openCodeSession("provider-child", "provider-parent"),
    permissions: [],
    messages: [],
  });

  const parent = registry.applyAdapterSnapshot(parentProjection.snapshot);
  const parentSnapshot = registry.snapshot();
  const child = registry.applyAdapterSnapshot(childProjection.snapshot);
  const completeSnapshot = registry.snapshot();
  const authorityChange = projectAiSessionAuthorityChange(parentSnapshot, completeSnapshot);

  assert.deepEqual(childProjection.snapshot.lineage, {
    kind: "subagent",
    parentProviderSessionId: "provider-parent",
  });
  assert.deepEqual(registry.get(child.id).lineage, childProjection.snapshot.lineage);
  assert.equal(authorityChange.kind, "patch");
  assert.deepEqual(authorityChange.upserted.map((session) => ({
    id: session.id,
    providerSessionId: session.providerSessionId,
    lineage: session.lineage,
  })), [{
    id: child.id,
    providerSessionId: "provider-child",
    lineage: { kind: "subagent", parentProviderSessionId: "provider-parent" },
  }]);

  const response = {
    updatedAt: observedAt,
    instances: [{
      instanceId: "instance-e2e",
      streamId: "stream-e2e",
      revision: 2,
      lastEventAt: observedAt,
      aiSessions: completeSnapshot,
    }],
  };
  const requestedPaths = [];
  const api = createControlPlaneAiSessionsApi({
    async request(requestPath, schema) {
      requestedPaths.push(requestPath);
      return schema.parse({ data: response });
    },
  });
  const clientSnapshot = await api.list(undefined, "instance-e2e");
  const clientSessions = clientSnapshot.instances[0].aiSessions.sessions.map((session) => ({
    ...session,
    instanceId: "instance-e2e",
  }));
  const forest = deriveAiSessionForest(clientSessions);
  const rows = flattenAiSessionForest(forest, { expandedSessionIds: new Set([parent.id]) });
  const retention = aiSessionRetentionCandidates(forest);

  assert.match(requestedPaths[0], /hierarchy=subagents/);
  assert.deepEqual(rows.map((entry) => ({ id: entry.node.session.id, depth: entry.depth })), [
    { id: parent.id, depth: 0 },
    { id: child.id, depth: 1 },
  ]);
  assert.deepEqual(retention.map((candidate) => ({
    providerSessionId: candidate.root.providerSessionId,
    sessionIds: candidate.sessionIds,
  })), [{
    providerSessionId: "provider-parent",
    sessionIds: [child.id, parent.id],
  }]);

  const archivedProviderIds = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "opencode",
    async archiveSession(providerSessionId) { archivedProviderIds.push(providerSessionId); },
    async unsubscribeSession() {},
  });
  const history = new AiSessionHistoryStore({ dataDir: path.join(root, "history") });
  const coordinator = new AiSessionCloseCoordinator({ registry, controller, history, stopApp: () => {} });
  await coordinator.close(parent.id);

  assert.deepEqual(archivedProviderIds, ["provider-child", "provider-parent"]);
  assert.deepEqual(registry.all(), []);
  assert.deepEqual([parent.id, child.id].map((sessionId) => history.get(sessionId)?.providerSessionId), [
    "provider-parent",
    "provider-child",
  ]);
});
