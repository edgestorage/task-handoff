const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { decodePersistedAiSession, encodePersistedAiSession } = require("../packages/ai-session-runtime/src/ai-session/persistence.ts");

const now = "2026-11-25T00:00:00.000Z";
const completedTurn = (id = "turn_1") => ({
  id,
  userPrompt: "问题",
  status: "completed",
  summary: "回答",
  lastMessage: "回答",
  completedAt: "2026-11-25T00:00:30.000Z",
  updatedAt: "2026-11-25T00:00:30.000Z",
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-next-input-persistence-"));
  return createAiSessionRegistry({ dir });
}

function idleSession(registry, turns = [completedTurn()], extra = {}) {
  return registry.start({ agent: "codex", providerSessionId: "thread", status: "idle", turns, ...extra }, { timestamp: now });
}

const suggestion = (text = "继续补齐测试") => ({ text, turnId: "turn_1", generatedAt: "2026-11-25T00:01:00.000Z" });

test("suggestion patches preserve updatedAt and conversation revisions while reaching the summary", () => {
  const registry = setup();
  const session = idleSession(registry);
  const before = registry.snapshot().sessions[0];
  let changes = 0;
  registry.onChange(() => { changes += 1; });
  const updated = registry.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion: suggestion() });
  const after = registry.snapshot().sessions[0];
  assert.deepEqual(updated.nextInputSuggestion, suggestion());
  assert.deepEqual(after.nextInputSuggestion, suggestion());
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.detailRevision, before.detailRevision);
  assert.equal(after.turnsRevision, before.turnsRevision);
  assert.equal(changes, 1);

  registry.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion: null });
  assert.equal(registry.get(session.id).nextInputSuggestion, undefined);
  assert.equal(registry.snapshot().sessions[0].nextInputSuggestion, undefined);
});

test("user activity and lifecycle transitions clear an existing suggestion", () => {
  const registry = setup();
  const events = [
    { kind: "user-message", userPrompt: "新问题", activeTurnId: "turn_2", status: "running" },
    { kind: "turn-started", activeTurnId: "turn_2", status: "running" },
    { kind: "lifecycle", status: "running" },
    { kind: "lifecycle", status: "waiting" },
    { kind: "approval-requested", summary: "审批" },
    { kind: "assistant-message", text: "回复" },
    { kind: "session-error", error: "失败" },
    { kind: "send-ack", activeTurnId: "turn_3", userPrompt: "确认" },
  ];
  for (const event of events) {
    const session = idleSession(registry);
    registry.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion: suggestion() });
    assert.ok(registry.get(session.id).nextInputSuggestion, `suggestion should exist before ${event.kind}-${event.status || ""}`);
    registry.applyRealtimeEvent(session.id, event);
    assert.equal(registry.get(session.id).nextInputSuggestion, undefined, `suggestion should clear on ${event.kind}-${event.status || ""}`);
  }
});

test("suggestions reject a stale turn, pending queue, and subagent lineage", () => {
  const registry = setup();
  const stale = idleSession(registry);
  registry.applyRealtimeEvent(stale.id, { kind: "next-input-suggestion", suggestion: { ...suggestion(), turnId: "turn_other" } });
  assert.equal(registry.get(stale.id).nextInputSuggestion, undefined);

  const queued = idleSession(registry);
  registry.patch(queued.id, {
    queue: {
      revision: 1,
      pendingCount: 1,
      items: [{ id: "q1", message: "排队", status: "queued", createdAt: now, updatedAt: now }],
    },
  });
  registry.applyRealtimeEvent(queued.id, { kind: "next-input-suggestion", suggestion: suggestion() });
  assert.equal(registry.get(queued.id).nextInputSuggestion, undefined);

  const child = idleSession(registry, [completedTurn()], { providerSessionId: "thread-child", lineage: { kind: "subagent", parentProviderSessionId: "thread" } });
  registry.applyRealtimeEvent(child.id, { kind: "next-input-suggestion", suggestion: suggestion() });
  assert.equal(registry.get(child.id).nextInputSuggestion, undefined);
});

test("persisted suggestions are sanitized against corruption, stale turns, and state", () => {
  const registry = setup();
  const session = idleSession(registry);
  registry.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion: suggestion() });
  const encoded = encodePersistedAiSession(registry.get(session.id));
  assert.deepEqual(decodePersistedAiSession(encoded).nextInputSuggestion, suggestion());

  const corrupt = (patch) => decodePersistedAiSession({
    ...encoded,
    nextInputSuggestion: { ...encoded.nextInputSuggestion, ...patch },
  });
  assert.equal(corrupt({ text: "a\nb" }).nextInputSuggestion, undefined);
  assert.equal(corrupt({ text: " " }).nextInputSuggestion, undefined);
  assert.equal(corrupt({ text: "字".repeat(161) }).nextInputSuggestion, undefined);
  assert.equal(corrupt({ turnId: "turn_other" }).nextInputSuggestion, undefined);
  assert.equal(corrupt({ generatedAt: "yesterday" }).nextInputSuggestion, undefined);
  assert.equal(corrupt({ extra: true }).nextInputSuggestion, undefined);
  assert.equal(decodePersistedAiSession({ ...encoded, status: "running" }).nextInputSuggestion, undefined);
  assert.equal(decodePersistedAiSession({
    ...encoded,
    queue: {
      revision: 1,
      pendingCount: 1,
      items: [{ id: "q1", message: "排队", status: "queued", createdAt: now, updatedAt: now }],
    },
  }).nextInputSuggestion, undefined);
  assert.equal(decodePersistedAiSession({ ...encoded, lineage: { kind: "subagent", parentProviderSessionId: "root" } }).nextInputSuggestion, undefined);
  assert.equal(decodePersistedAiSession({ ...encoded, nextInputSuggestion: "bad" }).nextInputSuggestion, undefined);
  assert.equal(decodePersistedAiSession({ ...encoded, nextInputSuggestion: undefined }).nextInputSuggestion, undefined);
});

test("a completed turn clears the previous suggestion before a new one is published", () => {
  const registry = setup();
  const session = idleSession(registry);
  registry.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion: suggestion() });
  registry.applyRealtimeEvent(session.id, { kind: "user-message", userPrompt: "新问题", activeTurnId: "turn_2", status: "running" });
  registry.applyRealtimeEvent(session.id, { kind: "turn-completed", activeTurnId: "turn_2", status: "idle", observedAt: "2026-11-25T00:02:00.000Z" });
  assert.equal(registry.get(session.id).nextInputSuggestion, undefined);
  assert.equal(registry.snapshot().sessions[0].nextInputSuggestion, undefined);
});
