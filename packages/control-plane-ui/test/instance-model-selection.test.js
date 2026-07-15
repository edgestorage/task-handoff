import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

test("new instances distinguish global default, no model, and an explicit model", () => {
  assert.match(runtimeStep, />Global default</);
  assert.match(runtimeStep, />No model</);
  assert.match(runtimeStep, /value === noModelValue \? null : value/);
  assert.match(newInstanceModal, /codexModelHash !== undefined/);
  assert.match(newInstanceModal, /claudeModelHash !== undefined/);
});
