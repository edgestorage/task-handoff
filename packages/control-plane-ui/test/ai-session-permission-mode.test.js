import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
global.window = { localStorage: storage };
const {
  AI_SESSION_PERMISSION_TTL_MS,
  aiSessionPermissionKey,
  clearAiSessionPermissionMode,
  historyAiSessionPermissionKey,
  loadAiSessionPermissionMode,
  persistAiSessionPermissionMode,
  useAiSessionPermissionMode,
} = await import("../src/apps/control-plane/useAiSessionPermissionMode.ts");

test("AI session permission modes use instance-scoped composer keys and expire", () => {
  const now = 1_000_000;
  const sessionKey = aiSessionPermissionKey("instance-a", "session-a");
  const otherInstanceKey = aiSessionPermissionKey("instance-b", "session-a");
  assert.equal(sessionKey, "session:instance-a:session-a");
  assert.equal(historyAiSessionPermissionKey("instance-a", "history-a"), "history:instance-a:history-a");
  assert.notEqual(
    aiSessionPermissionKey("instance:a", "session"),
    aiSessionPermissionKey("instance", "a:session"),
  );

  persistAiSessionPermissionMode(sessionKey, "full-access", now);
  persistAiSessionPermissionMode(otherInstanceKey, "ask", now + 1);
  assert.equal(loadAiSessionPermissionMode(sessionKey, now + 2), "full-access");
  assert.equal(loadAiSessionPermissionMode(otherInstanceKey, now + 2), "ask");
  assert.equal(loadAiSessionPermissionMode(sessionKey, now + AI_SESSION_PERMISSION_TTL_MS), undefined);
});

test("session composer permission state initializes from the instance default and is shared by session key", () => {
  const key = aiSessionPermissionKey("instance-shared", "session-shared");
  clearAiSessionPermissionMode(key);
  const first = useAiSessionPermissionMode(() => key, () => "full-access");
  assert.equal(first.value, "full-access");
  first.value = "auto-review";

  const second = useAiSessionPermissionMode(() => key, () => "ask");
  assert.equal(second.value, "auto-review");
  assert.equal(loadAiSessionPermissionMode(key), "auto-review");
});

test("starting a session copies the instance default into session-scoped permission state", () => {
  const createNewSession = panel.match(/async function createNewSession[\s\S]*?\n}\n\nfunction canInterrupt/)?.[0] || "";
  assert.match(createNewSession, /persistAiSessionPermissionMode\(aiSessionPermissionKey\(props\.instance\.id, session\.id\), permissionMode\)/);
  assert.doesNotMatch(panel, /newAiSessionPermissionKey|new-session:/);
});

test("AI session permission storage drops malformed records", () => {
  storage.setItem("task-handoff.control-plane.ai-session-permissions", JSON.stringify({
    invalid: { permissionMode: "unsafe", updatedAt: Date.now() },
  }));
  assert.equal(loadAiSessionPermissionMode("invalid"), undefined);
  assert.equal(storage.getItem("task-handoff.control-plane.ai-session-permissions"), null);
});
