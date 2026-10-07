import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");
const sourceStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/SourceStep.vue", import.meta.url), "utf8");

test("runtime step shows the workspace node without offering another selection", () => {
  assert.doesNotMatch(runtimeStep, /v-model="runtimeDraft\.nodeId"/);
  assert.match(runtimeStep, /<span v-if="nodeName">\{\{ t\("instances\.create\.node"\) \}\}<\/span>/);
  assert.match(runtimeStep, /nodeName: string;/);
});

test("new instance derives the runtime node from the workspace selection", () => {
  assert.match(newInstanceModal, /const workspaceNodeId = computed\(\(\) => sourceDraft\.nodeId \|\| controlPlaneDefaultNodeId\.value\)/);
  assert.match(newInstanceModal, /:node-name="workspaceNodeName"/);
  assert.match(newInstanceModal, /watch\(\s*workspaceNodeId,/);
  assert.match(newInstanceModal, /runtimeDraft\.nodeId = nodeId;/);
});

test("workspace step selects the node before the workspace source", () => {
  const sectionHead = sourceStep.indexOf('class="section-head"');
  const nodeSelect = sourceStep.indexOf('v-model="sourceDraft.nodeId"');
  const choiceGrid = sourceStep.indexOf('class="choice-grid"');

  assert.notEqual(sectionHead, -1);
  assert.notEqual(nodeSelect, -1);
  assert.notEqual(choiceGrid, -1);
  assert.ok(sectionHead < nodeSelect);
  assert.ok(nodeSelect < choiceGrid);
});

test("git repository workspaces require a selected node", () => {
  const blockedReason = newInstanceModal.indexOf("const sourceBlockedReason = computed");
  const nodeCheck = newInstanceModal.indexOf("if (!sourceDraft.nodeId)", blockedReason);
  const repositoryCheck = newInstanceModal.indexOf('if (sourceDraft.mode === "project")', blockedReason);

  assert.notEqual(blockedReason, -1);
  assert.notEqual(nodeCheck, -1);
  assert.notEqual(repositoryCheck, -1);
  assert.ok(nodeCheck < repositoryCheck);
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
