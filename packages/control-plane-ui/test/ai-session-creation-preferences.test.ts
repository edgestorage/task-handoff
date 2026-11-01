import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAiSessionCreationAgent,
  persistAiSessionCreationAgent,
  preferredAiSessionCreationAgent,
} from "../src/apps/control-plane/instance-detail/aiSessionCreationPreferences.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("creation agent preference round-trips through storage", () => {
  const storage = fakeStorage();
  assert.equal(loadAiSessionCreationAgent(storage), "");
  persistAiSessionCreationAgent("claude", storage);
  assert.equal(loadAiSessionCreationAgent(storage), "claude");
});

test("creation agent prefers the requested agent, then storage, then the first available", () => {
  const storage = fakeStorage();
  persistAiSessionCreationAgent("claude", storage);
  assert.equal(preferredAiSessionCreationAgent("opencode", ["codex", "claude", "opencode"], storage), "opencode");
  assert.equal(preferredAiSessionCreationAgent("", ["codex", "claude"], storage), "claude");
  assert.equal(preferredAiSessionCreationAgent("missing", ["codex"], storage), "codex");
  assert.equal(preferredAiSessionCreationAgent("", [], storage), "");
});

test("creation agent ignores unavailable stored agents and unavailable storage", () => {
  const storage = fakeStorage();
  persistAiSessionCreationAgent("claude", storage);
  assert.equal(preferredAiSessionCreationAgent("", ["codex"], storage), "codex");
  const failing = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
  assert.equal(loadAiSessionCreationAgent(failing), "");
  assert.doesNotThrow(() => persistAiSessionCreationAgent("codex", failing));
  assert.equal(preferredAiSessionCreationAgent("claude", ["codex", "claude"], failing), "claude");
});
