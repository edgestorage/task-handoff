import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("the control plane establishes its persisted theme and background before mounting", () => {
  const bootstrapIndex = index.indexOf('window.localStorage.getItem("task-handoff.theme")');
  const appScriptIndex = index.indexOf('<script type="module" src="/src/main.ts"></script>');

  assert.ok(bootstrapIndex >= 0);
  assert.ok(appScriptIndex > bootstrapIndex);
  assert.match(index, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(index, /html,[\s\S]*body,[\s\S]*#app \{[\s\S]*background: hsl\(195 45% 5%\);[\s\S]*color-scheme: dark;/);
  assert.match(index, /html\[data-theme="light"\][\s\S]*background: hsl\(190 24% 95%\);[\s\S]*color-scheme: light;/);
});
