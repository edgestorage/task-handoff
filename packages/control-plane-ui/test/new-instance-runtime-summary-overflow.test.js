import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");

const runtimeSummaryRule = runtimeStep.match(/\.runtime-summary\s*\{[^}]*\}/s)?.[0] ?? "";

test("runtime summary shrinks inside the wizard grid instead of stretching the modal", () => {
  assert.match(runtimeSummaryRule, /display:\s*flex;/);
  assert.match(runtimeSummaryRule, /min-width:\s*0;/);
});

test("runtime summary values truncate instead of widening the page", () => {
  const strongRule = runtimeStep.match(/\.runtime-summary strong\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(strongRule, /min-width:\s*0;/);
  assert.match(strongRule, /overflow:\s*hidden;/);
  assert.match(strongRule, /text-overflow:\s*ellipsis;/);
  assert.match(strongRule, /white-space:\s*nowrap;/);
});
