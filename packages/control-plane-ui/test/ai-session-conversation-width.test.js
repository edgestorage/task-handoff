import assert from "node:assert/strict";
import test from "node:test";

const storageKey = "task-handoff.control-plane.ai-session-conversation-width";

function useTestStorage(context, localStorage) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
}

async function loadPreference(reloadKey) {
  const { useAiSessionConversationWidth } = await import(`../src/apps/control-plane/useAiSessionConversationWidth.ts?${reloadKey}`);
  return useAiSessionConversationWidth;
}

test("conversation width defaults to full and remembers an explicit choice across sessions and reloads", async (context) => {
  const storage = new Map();
  useTestStorage(context, {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  });
  const usePreference = await loadPreference("first-load");
  const firstSession = usePreference();
  const secondSession = usePreference();

  assert.equal(firstSession.conversationWidth.value, "full");
  firstSession.setConversationWidth("bounded");
  assert.equal(secondSession.conversationWidth.value, "bounded");
  assert.equal(storage.get(storageKey), "bounded");

  const reloaded = (await loadPreference("reload"))();
  assert.equal(reloaded.conversationWidth.value, "bounded");
  reloaded.setConversationWidth("");
  assert.equal(reloaded.conversationWidth.value, "bounded");
  reloaded.setConversationWidth("full");
  assert.equal(storage.get(storageKey), "full");

  storage.set(storageKey, "unknown");
  assert.equal((await loadPreference("unknown-value"))().conversationWidth.value, "full");
});

test("conversation width remains usable without browser storage", async (context) => {
  useTestStorage(context, {
    getItem: () => { throw new Error("Storage unavailable"); },
    setItem: () => { throw new Error("Storage unavailable"); },
  });
  const preference = (await loadPreference("unavailable-storage"))();
  assert.equal(preference.conversationWidth.value, "full");
  preference.setConversationWidth("bounded");
  assert.equal(preference.conversationWidth.value, "bounded");
});
