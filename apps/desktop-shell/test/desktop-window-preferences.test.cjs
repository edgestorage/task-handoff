const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createDesktopWindowPreferences,
  DEFAULT_INSTANCE_DETAIL_SIZE,
  sanitizeInstanceDetailSize,
} = require("../src/desktop-window-preferences.cjs");

test("desktop instance windows restore the last valid shared size", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-window-preferences-"));
  const file = path.join(directory, "desktop-window-preferences.json");
  const preferences = createDesktopWindowPreferences({ file });
  assert.deepEqual(preferences.instanceDetailSize(), DEFAULT_INSTANCE_DETAIL_SIZE);
  assert.equal(preferences.rememberInstanceDetailSize({ x: 20, y: 30, width: 940, height: 680 }), true);

  const restored = createDesktopWindowPreferences({ file });
  assert.deepEqual(restored.instanceDetailSize(), { width: 940, height: 680 });
});

test("desktop window size preferences sanitize historical and invalid JSON", () => {
  assert.deepEqual(sanitizeInstanceDetailSize({ width: 400, height: 520, unknown: true }), { width: 400, height: 520 });
  assert.equal(sanitizeInstanceDetailSize({ width: 399, height: 520 }), undefined);
  assert.equal(sanitizeInstanceDetailSize({ width: "940", height: 680 }), undefined);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-window-preferences-invalid-"));
  const file = path.join(directory, "desktop-window-preferences.json");
  fs.writeFileSync(file, "{not-json");
  assert.deepEqual(createDesktopWindowPreferences({ file }).instanceDetailSize(), DEFAULT_INSTANCE_DETAIL_SIZE);
});
