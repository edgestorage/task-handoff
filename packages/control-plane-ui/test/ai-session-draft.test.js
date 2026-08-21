import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
global.window = { localStorage: storage };
const {
  AI_SESSION_DRAFT_TTL_MS,
  aiSessionCreationDraftKey,
  loadAiSessionDraft,
  loadAiSessionDraftPayload,
  persistAiSessionDraft,
  persistAiSessionDraftPayload,
} = await import("../src/apps/control-plane/useAiSessionDraft.ts");

test("new-session draft keys are isolated by instance", () => {
  assert.equal(aiSessionCreationDraftKey("inst-a"), "new-session:inst-a");
  assert.notEqual(aiSessionCreationDraftKey("inst-a"), aiSessionCreationDraftKey("inst-b"));
});

test("AI session drafts are isolated by session id and expire", () => {
  const now = 1_000_000;
  persistAiSessionDraft("session-a", "draft A", now);
  persistAiSessionDraft("session-b", "draft B", now + 100);

  assert.equal(loadAiSessionDraft("session-a", now + 1), "draft A");
  assert.equal(loadAiSessionDraft("session-b", now + 1), "draft B");
  assert.equal(loadAiSessionDraft("session-a", now + AI_SESSION_DRAFT_TTL_MS), "");
  assert.equal(loadAiSessionDraft("session-b", now + AI_SESSION_DRAFT_TTL_MS - 1), "draft B");

  const persisted = JSON.parse(storage.getItem("task-handoff.control-plane.ai-session-drafts"));
  assert.deepEqual(Object.keys(persisted), ["session-b"]);
});

test("AI session draft storage drops malformed data", () => {
  storage.setItem("task-handoff.control-plane.ai-session-drafts", "not-json");
  assert.equal(loadAiSessionDraft("session-a"), "");
  assert.equal(storage.getItem("task-handoff.control-plane.ai-session-drafts"), null);
});

test("AI session drafts migrate text-only records and preserve valid bindings", () => {
  const now = Date.now();
  storage.setItem("task-handoff.control-plane.ai-session-drafts", JSON.stringify({
    legacy: { value: "@docs", updatedAt: now, future: true },
  }));
  assert.deepEqual(loadAiSessionDraftPayload("legacy", now + 1), { value: "@docs", bindings: [] });

  const bindings = [{
    id: "docs",
    token: "@docs",
    start: 0,
    end: 5,
    reference: { kind: "skill", name: "Docs", path: "/workspace/docs/SKILL.md" },
  }];
  persistAiSessionDraftPayload("modern", "@docs", bindings, now + 2);
  assert.deepEqual(loadAiSessionDraftPayload("modern", now + 3), { value: "@docs", bindings });
  persistAiSessionDraft("modern", "prefix @docs", now + 4);
  assert.deepEqual(loadAiSessionDraftPayload("modern", now + 5), { value: "prefix @docs", bindings });
});
