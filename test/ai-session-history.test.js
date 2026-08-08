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
  AiSessionHistoryStore,
  sanitizeAiSessionHistoryIndex,
} = require("../packages/ai-session-runtime/src/ai-session-history-store.ts");
const { AiSessionHistoryLifecycle } = require("../packages/ai-session-runtime/src/ai-session-history-lifecycle.ts");
const { AiSessionResumeCoordinator } = require("../packages/ai-session-runtime/src/ai-session-resume.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { sanitizePersistedAiSession } = require("../packages/ai-session-runtime/src/ai-session/persistence.ts");

function historyItem(index, overrides = {}) {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `ai-${index}`,
    agent: index % 2 ? "claude" : "codex",
    creationSource: "app-session",
    providerSessionId: `provider-${index}`,
    title: `Session ${index}`,
    userPrompt: `Prompt ${index}`,
    lastMessage: `Answer ${index}`,
    cwd: "/workspace",
    lastActiveAt: timestamp,
    archivedAt: timestamp,
    ...overrides,
  };
}

test("AI session history store persists atomically and isolates instance data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-"));
  const first = new AiSessionHistoryStore({ dataDir: path.join(root, "instance-a") });
  const second = new AiSessionHistoryStore({ dataDir: path.join(root, "instance-b") });

  first.upsert(historyItem(1));

  assert.deepEqual(first.list().map((item) => item.id), ["ai-1"]);
  assert.deepEqual(new AiSessionHistoryStore({ dataDir: path.join(root, "instance-a") }).list().map((item) => item.id), ["ai-1"]);
  assert.deepEqual(second.list(), []);
  assert.equal(fs.statSync(first.path()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(first.path())).filter((name) => name !== "index.json"), []);
});

test("AI session history store keeps the newest 50 Task Handoff entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-limit-"));
  const store = new AiSessionHistoryStore({ dataDir: root });

  for (let index = 0; index < 51; index += 1) store.upsert(historyItem(index), [{ id: `turn-${index}`, status: "completed", lastMessage: `Answer ${index}` }]);

  const items = store.list();
  assert.equal(items.length, 50);
  assert.equal(items[0].id, "ai-50");
  assert.equal(items.at(-1).id, "ai-1");
  assert.equal(items.some((item) => item.id === "ai-0"), false);
  assert.equal(fs.readdirSync(path.join(path.dirname(store.path()), "details")).length, 50);
});

test("AI session history details persist normalized turns and isolate damaged files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-details-"));
  const warnings = [];
  const store = new AiSessionHistoryStore({ dataDir: root }, { onWarning: (warning) => warnings.push(warning) });
  const item = historyItem(11);
  store.upsert(item, Array.from({ length: 51 }, (_, index) => ({
    id: `turn-${index}`,
    userPrompt: `Prompt ${index}`,
    lastMessage: `Answer ${index}`,
    status: "completed",
  })));

  const reopened = new AiSessionHistoryStore({ dataDir: root }, { onWarning: (warning) => warnings.push(warning) });
  assert.equal(reopened.detail(item.id).turns.length, 50);
  assert.equal(reopened.detail(item.id).turns[0].id, "turn-1");
  const detailDir = path.join(path.dirname(store.path()), "details");
  const detailPath = path.join(detailDir, fs.readdirSync(detailDir)[0]);
  fs.writeFileSync(detailPath, JSON.stringify({ item, turns: [
    { id: "valid", status: "completed", lastMessage: "Kept", future: true },
    { broken: true },
  ], future: true }));
  assert.deepEqual(reopened.detail(item.id).turns, [{ id: "valid", status: "completed", lastMessage: "Kept" }]);
  assert.ok(warnings.some((warning) => warning.kind === "detail" && warning.reason.includes("invalid turn")));

  fs.unlinkSync(detailPath);
  assert.deepEqual(reopened.detail(item.id).turns, []);
  assert.equal(reopened.get(item.id).id, item.id);
});

test("AI session history store deduplicates AI and provider identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-dedupe-"));
  const store = new AiSessionHistoryStore({ dataDir: root });
  store.upsert(historyItem(1));
  store.upsert(historyItem(2, { id: "ai-1", agent: "claude", providerSessionId: "provider-new" }));
  store.upsert(historyItem(3, { id: "ai-new", agent: "claude", providerSessionId: "provider-new" }));

  assert.deepEqual(store.list().map((item) => [item.id, item.providerSessionId]), [["ai-new", "provider-new"]]);
  assert.equal(store.removeIdentity("claude", "provider-new"), true);
  assert.deepEqual(store.list(), []);
});

test("AI session history sanitation isolates invalid entries and ignores unknown fields", () => {
  const warnings = [];
  const valid = { ...historyItem(4), futureField: true };
  const index = sanitizeAiSessionHistoryIndex({ schemaVersion: 9, items: [valid, { id: "bad" }], futureIndex: true }, (warning) => warnings.push(warning));

  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.items, [historyItem(4)]);
  assert.ok(warnings.some((warning) => warning.kind === "item" && warning.id === "ai-4" && warning.reason.includes("unknown")));
  assert.ok(warnings.some((warning) => warning.kind === "item" && warning.id === "bad" && warning.reason.includes("removed")));
  assert.ok(warnings.some((warning) => warning.kind === "index" && warning.reason.includes("unknown")));
});

test("AI session persistence migrates creation source and ignores cross-version fields", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const legacy = sanitizePersistedAiSession({
      id: "ai-legacy",
      agent: "codex",
      appSessionId: "app-legacy",
      providerSessionId: "thread-legacy",
      status: "idle",
      phase: "unknown",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      counters: {},
      queue: {},
      futureField: true,
    });
    assert.equal(legacy.creationSource, "app-session");
    assert.equal("futureField" in legacy, false);
    assert.ok(warnings.some((warning) => warning.includes("futureField")));

    const direct = sanitizePersistedAiSession({ ...legacy, creationSource: "ai-session", appSessionId: undefined });
    assert.equal(direct.creationSource, "ai-session");
  } finally {
    console.warn = originalWarn;
  }

  const migratedHistory = sanitizeAiSessionHistoryIndex({
    schemaVersion: 1,
    items: [{ ...historyItem(14), creationSource: undefined }],
  });
  assert.equal(migratedHistory.items[0].creationSource, "app-session");
});

test("AI session creation source is first-write-wins across later App bindings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-source-"));
  const registry = createAiSessionRegistry({ dir: root });
  const direct = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "thread-direct",
    cwd: "/workspace",
    status: "idle",
  });
  const bound = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "app-session",
    appId: "codex",
    appSessionId: "app-direct",
    providerSessionId: "thread-direct",
    cwd: "/workspace",
    status: "idle",
  });
  assert.equal(direct.creationSource, "ai-session");
  assert.equal(bound.creationSource, "ai-session");
  assert.equal(bound.appSessionId, "app-direct");
});

test("AI session history store rewrites sanitized persisted data and tolerates unreadable JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-sanitize-"));
  const warnings = [];
  const store = new AiSessionHistoryStore({ dataDir: root }, { onWarning: (warning) => warnings.push(warning) });
  fs.mkdirSync(path.dirname(store.path()), { recursive: true });
  fs.writeFileSync(store.path(), JSON.stringify({ schemaVersion: 1, items: [{ ...historyItem(5), futureField: "ignored" }, { broken: true }] }));

  assert.deepEqual(store.list(), [historyItem(5)]);
  const rewritten = JSON.parse(fs.readFileSync(store.path(), "utf8"));
  assert.deepEqual(rewritten, { schemaVersion: 1, items: [historyItem(5)] });
  assert.ok(warnings.length >= 2);

  fs.writeFileSync(store.path(), "{not-json");
  assert.deepEqual(store.list(), []);
  assert.ok(warnings.some((warning) => warning.reason.includes("unreadable")));
});

test("AI session lifecycle archives stopped bindings before prune and activates them only after a running binding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-lifecycle-"));
  const store = new AiSessionHistoryStore({ dataDir: root });
  const lifecycle = new AiSessionHistoryLifecycle(store);
  const session = {
    id: "ai-lifecycle",
    agent: "codex",
    creationSource: "app-session",
    appSessionId: "app-lifecycle",
    appId: "codex",
    providerSessionId: "provider-lifecycle",
    title: "Lifecycle session",
    cwd: "/workspace",
    userPrompt: "Keep this session",
    lastMessage: "Saved",
    turns: [{
      id: "turn-lifecycle",
      userPrompt: "Keep this session",
      lastMessage: "Saved",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
      revision: 1,
    }],
    status: "idle",
    phase: "unknown",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    counters: { toolCalls: 0, edits: 0, approvals: 0 },
    queue: { pendingCount: 0, items: [] },
    toolCallsSinceLastMessage: 0,
    subAgents: [],
  };

  lifecycle.reconcile([session], [{ id: session.appSessionId, status: "running" }], "2026-01-03T00:00:00.000Z");
  assert.deepEqual(store.list(), []);

  lifecycle.reconcile([session], [{ id: session.appSessionId, status: "stopped" }], "2026-01-03T00:00:00.000Z");
  assert.deepEqual(store.list().map((item) => [item.id, item.archivedAt]), [[session.id, "2026-01-03T00:00:00.000Z"]]);
  assert.deepEqual(store.detail(session.id).turns.map((turn) => [turn.id, turn.userPrompt, turn.lastMessage]), [["turn-lifecycle", "Keep this session", "Saved"]]);

  const recovered = new AiSessionHistoryLifecycle(new AiSessionHistoryStore({ dataDir: root }));
  recovered.reconcile([session], [], "2026-01-04T00:00:00.000Z");
  assert.equal(store.list()[0].archivedAt, "2026-01-03T00:00:00.000Z");

  recovered.reconcile([session], [{ id: session.appSessionId, status: "running" }], "2026-01-04T00:00:00.000Z");
  assert.deepEqual(store.list(), []);
  assert.equal(store.detail(session.id), undefined);
});

test("AI session lifecycle ignores sessions without a resumable provider identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-unresumable-"));
  const store = new AiSessionHistoryStore({ dataDir: root });
  const lifecycle = new AiSessionHistoryLifecycle(store);
  const base = {
    id: "ai-unresumable",
    agent: "codex",
    creationSource: "app-session",
    appSessionId: "app-unresumable",
    cwd: "/workspace",
    status: "idle",
    phase: "unknown",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    counters: { toolCalls: 0, edits: 0, approvals: 0 },
    queue: { pendingCount: 0, items: [] },
    toolCallsSinceLastMessage: 0,
    subAgents: [],
  };

  lifecycle.reconcile([base, { ...base, id: "other-agent", agent: "other", providerSessionId: "provider-other" }], []);
  assert.deepEqual(store.list(), []);
});

test("AI session resume coordinator preserves identity and deduplicates concurrent starts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-resume-"));
  const history = new AiSessionHistoryStore({ dataDir: root });
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const item = historyItem(7, { id: "ai-resume", agent: "codex", providerSessionId: "provider-resume" });
  history.upsert(item);
  let starts = 0;
  let release;
  const coordinator = new AiSessionResumeCoordinator({
    history,
    registry,
    appSessions: () => [],
    startApp: async () => {
      starts += 1;
      await new Promise((resolve) => { release = resolve; });
      return { id: "app-resumed", status: "running" };
    },
  });

  const first = coordinator.resume(item.id);
  const second = coordinator.resume(item.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { disposition: "resumed", aiSessionId: item.id, providerSessionId: item.providerSessionId, appSessionId: "app-resumed", creationSource: "app-session" },
    { disposition: "resumed", aiSessionId: item.id, providerSessionId: item.providerSessionId, appSessionId: "app-resumed", creationSource: "app-session" },
  ]);
  assert.equal(registry.get(item.id).providerSessionId, item.providerSessionId);
  assert.equal(history.get(item.id).id, item.id);
});

test("AI session resume coordinator reuses an authoritative running binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-open-"));
  const history = new AiSessionHistoryStore({ dataDir: root });
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const item = historyItem(8, { id: "ai-open", agent: "claude", providerSessionId: "provider-open" });
  history.upsert(item);
  registry.restoreHistory(item);
  registry.applyAdapterSnapshot({
    agent: item.agent,
    appId: item.agent,
    appSessionId: "app-open",
    providerSessionId: item.providerSessionId,
    cwd: item.cwd,
    status: "idle",
  });
  const coordinator = new AiSessionResumeCoordinator({
    history,
    registry,
    appSessions: () => [{ id: "app-open", status: "running" }],
    startApp: () => { throw new Error("must not start"); },
  });

  assert.deepEqual(await coordinator.resume(item.id), {
    disposition: "already-open",
    aiSessionId: item.id,
    providerSessionId: item.providerSessionId,
    appSessionId: "app-open",
    creationSource: "app-session",
  });
});

test("AI session resume coordinator restores Direct history without launching an App", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-direct-resume-"));
  const history = new AiSessionHistoryStore({ dataDir: root });
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const item = historyItem(15, { id: "ai-direct-resume", creationSource: "ai-session" });
  history.upsert(item);
  let providerResumes = 0;
  const coordinator = new AiSessionResumeCoordinator({
    history,
    registry,
    appSessions: () => [],
    startApp: () => { throw new Error("must not start an App"); },
    resumeProvider: async (entry) => {
      providerResumes += 1;
      assert.equal(entry.providerSessionId, item.providerSessionId);
    },
  });

  assert.deepEqual(await coordinator.resume(item.id), {
    disposition: "resumed",
    aiSessionId: item.id,
    providerSessionId: item.providerSessionId,
    creationSource: "ai-session",
  });
  assert.equal(providerResumes, 1);
  assert.equal(registry.get(item.id).creationSource, "ai-session");
  assert.equal(registry.get(item.id).appSessionId, undefined);
  assert.equal(history.get(item.id), undefined);
});

test("AI session resume coordinator retains history and permits retry after provider failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-retry-"));
  const history = new AiSessionHistoryStore({ dataDir: root });
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const item = historyItem(9, { id: "ai-retry", providerSessionId: "provider-retry" });
  history.upsert(item);
  let attempts = 0;
  const coordinator = new AiSessionResumeCoordinator({
    history,
    registry,
    appSessions: () => [],
    startApp: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider session missing");
      return { id: "app-retry", status: "running" };
    },
  });

  await assert.rejects(coordinator.resume(item.id), (error) => error.code === "AI_SESSION_RESUME_UNAVAILABLE" && error.statusCode === 409);
  assert.equal(history.get(item.id).id, item.id);
  assert.equal(registry.get(item.id), undefined);
  assert.equal((await coordinator.resume(item.id)).appSessionId, "app-retry");
  assert.equal(attempts, 2);
});
