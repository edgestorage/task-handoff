import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

test("new instances default to no model while preserving global default and explicit choices", () => {
  assert.match(runtimeStep, /instances\.create\.globalDefault/);
  assert.match(runtimeStep, /instances\.create\.noModel/);
  assert.ok(runtimeStep.indexOf('t("instances.create.noModel")') < runtimeStep.indexOf('t("instances.create.globalDefault")'));
  assert.match(runtimeStep, /value === noModelValue \? null : value/);
  assert.match(newInstanceModal, /codexModelHash: null/);
  assert.match(newInstanceModal, /claudeModelHash: null/);
  assert.match(newInstanceModal, /instanceDraft\.codexModelHash = null/);
  assert.match(newInstanceModal, /instanceDraft\.claudeModelHash = null/);
  assert.match(newInstanceModal, /codexModelHash !== undefined/);
  assert.match(newInstanceModal, /claudeModelHash !== undefined/);
});
