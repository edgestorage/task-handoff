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
  assert.match(index, /html,[\s\S]*body,[\s\S]*#app \{[\s\S]*background: var\(--workspace-bg, hsl\(195 45% 5%\)\);[\s\S]*color-scheme: dark;/);
  assert.match(index, /html\[data-theme="light"\][\s\S]*background: var\(--workspace-bg, hsl\(190 24% 95%\)\);[\s\S]*color-scheme: light;/);
});

test("full-page auth shells paint the same workspace background as the app page", () => {
  for (const [file, selector] of [
    ["../src/apps/control-plane/AuthGate.vue", ".auth-shell"],
    ["../src/apps/control-plane/cli-authorize/CliAuthorizeView.vue", ".cli-authorize-shell"],
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const shell = source.match(new RegExp(`\\${selector} \\{(?<rules>[\\s\\S]*?)\\}`))?.groups?.rules;

    assert.ok(shell, `${selector} must exist in ${file}`);
    assert.match(shell, /background: var\(--workspace-bg\);/);
  }
});
