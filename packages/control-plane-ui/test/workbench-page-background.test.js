import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("dark workbench pages use the same solid workspace background as Story", () => {
  const darkTheme = appStyles.match(/:root\.dark,\s*:root\[data-theme="dark"\]\s*\{(?<rules>[\s\S]*?)\}/)?.groups?.rules;

  assert.ok(darkTheme);
  for (const token of [
    "control-plane-cockpit-background",
    "control-plane-settings-background",
    "instance-board-background",
    "ai-board-background",
  ]) {
    assert.match(darkTheme, new RegExp(`--${token}: var\\(--workspace-bg\\);`));
  }
  assert.doesNotMatch(darkTheme, /gradient\(/);
});
