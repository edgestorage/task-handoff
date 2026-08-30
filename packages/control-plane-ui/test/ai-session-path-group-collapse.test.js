import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCollapsedAiSessionPathGroups,
  persistCollapsedAiSessionPathGroups,
} from "../src/apps/control-plane/instance-detail/aiSessionPathGroupCollapse.ts";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("AI session collapsed path groups persist by instance and list mode", () => {
  const storage = memoryStorage();

  persistCollapsedAiSessionPathGroups("instance/a", "current", { "/workspace/a": true }, storage);
  persistCollapsedAiSessionPathGroups("instance/a", "history", { "/workspace/history": true }, storage);
  persistCollapsedAiSessionPathGroups("instance/b", "current", { "/workspace/b": true }, storage);

  assert.deepEqual(loadCollapsedAiSessionPathGroups("instance/a", "current", storage), { "/workspace/a": true });
  assert.deepEqual(loadCollapsedAiSessionPathGroups("instance/a", "history", storage), { "/workspace/history": true });
  assert.deepEqual(loadCollapsedAiSessionPathGroups("instance/b", "current", storage), { "/workspace/b": true });
});

test("AI session collapsed path groups ignore malformed storage", () => {
  const storage = memoryStorage({
    "task-handoff.control-plane.ai-session-collapsed-path-groups.instance.current": JSON.stringify(["valid", 1, "", null]),
    "task-handoff.control-plane.ai-session-collapsed-path-groups.broken.current": "{",
  });

  assert.deepEqual(loadCollapsedAiSessionPathGroups("instance", "current", storage), { valid: true });
  assert.deepEqual(loadCollapsedAiSessionPathGroups("broken", "current", storage), {});
});

test("AI session collapsed path groups remove empty preferences", () => {
  const storage = memoryStorage();
  persistCollapsedAiSessionPathGroups("instance", "current", { folder: true }, storage);
  persistCollapsedAiSessionPathGroups("instance", "current", { folder: false }, storage);

  assert.deepEqual(loadCollapsedAiSessionPathGroups("instance", "current", storage), {});
  assert.equal(storage.values.size, 0);
});
