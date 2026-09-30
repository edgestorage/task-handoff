import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

test("runtime step shows the workspace node without offering another selection", () => {
  assert.doesNotMatch(runtimeStep, /v-model="runtimeDraft\.nodeId"/);
  assert.match(runtimeStep, /<span v-if="nodeName">\{\{ t\("instances\.create\.node"\) \}\}<\/span>/);
  assert.match(runtimeStep, /nodeName: string;/);
});

test("new instance derives the runtime node from the workspace selection", () => {
  assert.match(newInstanceModal, /const workspaceNodeId = computed\(\(\) => sourceDraft\.mode === "project"/);
  assert.match(newInstanceModal, /selectedProject\.value\?\.defaultNodeId \|\| controlPlaneDefaultNodeId\.value/);
  assert.match(newInstanceModal, /:node-name="workspaceNodeName"/);
  assert.match(newInstanceModal, /watch\(\s*workspaceNodeId,/);
  assert.match(newInstanceModal, /runtimeDraft\.nodeId = nodeId;/);
});

test("instance name moves up to the left of the runtime selection", () => {
  const runtimeFields = runtimeStep.indexOf('class="step-fields runtime-fields"');
  const nameField = runtimeStep.indexOf('class="instance-name-field"');
  const runtimeSelect = runtimeStep.indexOf('v-model="runtimeDraft.runtimeId"');
  const environmentSource = runtimeStep.indexOf('class="environment-source-field"');
  assert.notEqual(runtimeFields, -1);
  assert.notEqual(nameField, -1);
  assert.notEqual(runtimeSelect, -1);
  assert.notEqual(environmentSource, -1);
  assert.ok(runtimeFields < nameField);
  assert.ok(nameField < runtimeSelect);
  assert.ok(runtimeSelect < environmentSource);
});
