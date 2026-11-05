import assert from "node:assert/strict";
import test from "node:test";
import { watchSyncEffect } from "vue";
import { initializeThemePreference, saveThemePreference, useThemePreference } from "../src/utils/theme.ts";

test("SVG renderers follow the applied DOM theme on startup, settings changes, and window sync", (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const classes = new Set();
  const storage = new Map([["task-handoff.theme", "light"]]);
  let onStorage;
  globalThis.document = {
    documentElement: {
      dataset: {},
      classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    },
  };
  globalThis.window = {
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    addEventListener: (event, listener) => { if (event === "storage") onStorage = listener; },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const theme = useThemePreference();
  initializeThemePreference();
  assert.equal(theme.value, "light");
  const changes = [];
  const stop = watchSyncEffect(() => changes.push([
    theme.value,
    document.documentElement.dataset.theme,
    classes.has("dark"),
  ]));
  t.after(stop);

  saveThemePreference("dark");
  assert.equal(storage.get("task-handoff.theme"), "dark");
  onStorage({ key: "task-handoff.theme", newValue: "light" });
  onStorage({ key: "task-handoff.theme", newValue: "invalid" });
  assert.deepEqual(changes, [
    ["light", "light", false],
    ["dark", "dark", true],
    ["light", "light", false],
  ]);
  assert.equal(useThemePreference().value, "light");
});
