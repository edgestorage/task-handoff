const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  AiSessionReconciliationService,
  betterCanonicalSession,
  sessionIdentityKey,
} = require("../packages/ai-session-runtime/src/ai-session/reconciliation-service.ts");

function session(id, patch = {}) {
  return {
    id,
    agent: "codex",
    status: "idle",
    phase: "unknown",
    counters: { messages: 0, tools: 0 },
    queue: { items: [] },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

test("AI session reconciliation preserves canonical identity and activity preference", () => {
  const sparse = session("sparse", {
    providerSessionId: "provider-1",
    updatedAt: "2026-01-03T00:00:00.000Z",
  });
  const active = session("active", {
    providerSessionId: "provider-1",
    userPrompt: "hello",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });

  assert.equal(sessionIdentityKey(active), "codex:provider:provider-1");
  assert.equal(betterCanonicalSession(sparse, active).id, "active");
  assert.deepEqual(new AiSessionReconciliationService().canonicalSessions([sparse, active]).map(({ id }) => id), ["active"]);
});

test("AI session canonical identity prefers provider threads over shared app bindings", () => {
  const service = new AiSessionReconciliationService();
  const sessions = [
    session("fork-a", { appSessionId: "shared-app", providerSessionId: "thread-a" }),
    session("fork-b", { appSessionId: "shared-app", providerSessionId: "thread-b" }),
    session("legacy-a", { appSessionId: "legacy-app" }),
    session("legacy-b", { appSessionId: "legacy-app", updatedAt: "2026-01-02T00:00:00.000Z" }),
  ];

  const canonical = service.canonicalSessions(sessions);
  assert.deepEqual(canonical.filter((item) => item.providerSessionId).map((item) => item.id).sort(), ["fork-a", "fork-b"]);
  assert.equal(canonical.filter((item) => item.appSessionId === "legacy-app").length, 1);
});

test("AI session app binding reconciliation hides, expires, and restores orphans", () => {
  const service = new AiSessionReconciliationService();
  const sessions = [session("bound", { appSessionId: "app-1" }), session("free")];

  const hidden = service.reconcileAppSessionBindings({
    sessions,
    appSessions: [],
    now: 1_000,
    orphanRetentionMs: 500,
  });
  assert.deepEqual(hidden.visibleSessionIds, ["free"]);
  assert.deepEqual(hidden.hiddenSessionIds, ["bound"]);
  assert.deepEqual(hidden.removeSessionIds, []);
  assert.deepEqual(hidden.orphanStateChanges, [{ kind: "marked", sessionId: "bound", orphanedAt: 1_000 }]);

  const expired = service.reconcileAppSessionBindings({
    sessions,
    appSessions: [],
    now: 1_500,
    orphanRetentionMs: 500,
  });
  assert.deepEqual(expired.removeSessionIds, ["bound"]);
  assert.deepEqual(expired.orphanStateChanges, [{ kind: "cleared", sessionId: "bound" }]);

  const present = service.reconcileAppSessionBindings({
    sessions,
    appSessions: [{ id: "app-1", status: "running" }],
    now: 2_000,
    orphanRetentionMs: 500,
  });
  assert.deepEqual(present.visibleSessionIds, ["bound", "free"]);
  assert.deepEqual(present.hiddenSessionIds, []);
});

test("AI session adapter reconciliation removes only unmatched identified sessions", () => {
  const service = new AiSessionReconciliationService();
  const sessions = [
    session("app", { appSessionId: "app-1" }),
    session("provider", { providerSessionId: "provider-1" }),
    session("short", { providerMeta: { short: "short-1" } }),
    session("unidentified"),
    session("claude", { agent: "claude", providerSessionId: "claude-1" }),
  ];
  const result = service.reconcileAdapterSessions({
    sessions,
    agent: "codex",
    appSessionIds: new Set(["app-1"]),
    providerShorts: new Set(["short-1"]),
  });

  assert.deepEqual(result.removeSessionIds, ["provider"]);
  assert.deepEqual(result.visibleSessionIds, ["app", "short", "unidentified", "claude"]);
});

test("AI session prune separates duplicate and retention decisions", () => {
  const service = new AiSessionReconciliationService();
  const result = service.prune({
    sessions: [
      session("canonical", { providerSessionId: "provider-1", userPrompt: "hello" }),
      session("duplicate", { providerSessionId: "provider-1" }),
      session("expired", { updatedAt: "2025-12-01T00:00:00.000Z" }),
      session("running", { status: "running", updatedAt: "2025-12-01T00:00:00.000Z" }),
    ],
    now: Date.parse("2026-01-02T00:00:00.000Z"),
    retentionMs: 24 * 60 * 60 * 1_000,
  });

  assert.deepEqual(result.duplicateSessionIds, ["duplicate"]);
  assert.deepEqual(result.expiredSessionIds, ["expired"]);
  assert.deepEqual(result.removeSessionIds, ["duplicate", "expired"]);
});
