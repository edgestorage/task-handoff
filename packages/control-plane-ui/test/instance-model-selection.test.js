import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

test("new instances default to no model while preserving ordered explicit choices", () => {
  assert.match(runtimeStep, /<ModelEntitySelection v-model="instanceDraft\.modelEntityIds"/);
  assert.match(newInstanceModal, /modelEntityIds: \[\]/);
  assert.match(newInstanceModal, /modelSelection: instanceDraft\.modelEntityIds\.length \? \{ modelEntityIds: instanceDraft\.modelEntityIds \} : \{\}/);
  assert.match(newInstanceModal, /instanceDraft\.modelEntityIds = \[\]/);
});
