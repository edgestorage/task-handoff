import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");
const modelEntitySelection = fs.readFileSync(new URL("../src/components/models/ModelEntitySelection.vue", import.meta.url), "utf8");
const instanceSettings = fs.readFileSync(new URL("../src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue", import.meta.url), "utf8");

test("new instances default to no model while preserving ordered explicit choices", () => {
  assert.match(runtimeStep, /<ModelEntitySelection v-model="instanceDraft\.modelEntityIds"/);
  assert.match(newInstanceModal, /modelEntityIds: \[\]/);
  assert.match(newInstanceModal, /modelSelection: \{ modelEntityIds: \[\.\.\.instanceDraft\.modelEntityIds\] \}/);
  assert.match(newInstanceModal, /instanceDraft\.modelEntityIds = \[\]/);
});

test("instance model providers share animated drag ordering and a fallback move menu", () => {
  assert.match(runtimeStep, /<ModelEntitySelection v-model="instanceDraft\.modelEntityIds"/);
  assert.match(instanceSettings, /<ModelEntitySelection v-model="modelEntityIds"/);
  assert.match(modelEntitySelection, /<TransitionGroup[\s\S]*name="model-entity-row"[\s\S]*@dragover\.prevent="previewDrag"[\s\S]*@drop\.prevent="commitDrag"/);
  assert.match(modelEntitySelection, /class="model-entity-drag-handle"[\s\S]*:draggable="!disabled"/);
  assert.match(modelEntitySelection, /@dragstart="startDrag\(\$event, model\.id\)"/);
  assert.match(modelEntitySelection, /event\.clientX - bounds\.left[\s\S]*event\.clientY - bounds\.top[\s\S]*setDragImage\(row, offsetX, offsetY\)/);
  assert.match(modelEntitySelection, /<DropdownMenuContent align="end"[\s\S]*moveUpAction[\s\S]*moveDownAction/);
  assert.match(modelEntitySelection, /:open="openModelMenuId === model\.id"[\s\S]*@click="toggleModelMenu\(\$event, model\.id\)"/);
  assert.match(modelEntitySelection, /dragSlots = \[\.\.\.rows\]\.map[\s\S]*centerY: bounds\.top \+ bounds\.height \/ 2/);
  assert.match(modelEntitySelection, /function previewDrag\(event: DragEvent\)[\s\S]*event\.clientY >= dragSlots\[sourceIndex\]\.centerY[\s\S]*dragTargetModelId\.value = dragSlots\[targetIndex\]\.id/);
  assert.doesNotMatch(modelEntitySelection, /@dragover\.prevent="previewDrag\(\$event, model\.id\)"/);
  assert.match(modelEntitySelection, /function dragStyle\(index: number\)/);
  assert.match(modelEntitySelection, /\.model-entity-row-move \{[\s\S]*transition: transform 180ms ease/);
  assert.doesNotMatch(modelEntitySelection, /<Button[^>]*moveUp/);
  assert.doesNotMatch(modelEntitySelection, /<Button[^>]*moveDown/);
});

test("empty model selection guides to control plane settings and notes later edits", () => {
  assert.match(modelEntitySelection, /!eligibleModels\.length[\s\S]*class="model-entity-empty"/);
  assert.match(modelEntitySelection, /instances\.modelEntities\.emptyHint/);
  assert.match(modelEntitySelection, /instances\.modelEntities\.openSettings/);
  assert.match(modelEntitySelection, /context === 'create'[\s\S]*instances\.modelEntities\.emptyCreateHint/);
  assert.match(modelEntitySelection, /@click="emit\('open-model-settings'\)"/);
  assert.match(runtimeStep, /context="create"[\s\S]*@open-model-settings="\$emit\('open-model-settings'\)"/);
  assert.match(newInstanceModal, /@open-model-settings="\$emit\('open-model-settings'\)"/);
  assert.match(instanceSettings, /@open-model-settings="emit\('open-model-settings'\)"/);
});

test("the workbench routes empty model selection to the control plane model settings", () => {
  const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
  assert.match(workbench, /@open-model-settings="openControlPlaneModelSettings"/);
  assert.match(
    workbench,
    /function openControlPlaneModelSettings\(\)\s*\{[\s\S]*instanceSettingsId\.value = "";[\s\S]*newInstanceOpen\.value = false;[\s\S]*openSettings\("models"\);[\s\S]*t\("instances\.modelEntities\.openedSettings"\)/,
  );
  assert.match(workbench, /function openControlPlaneModelSettings\(\)[\s\S]*standaloneMode\.value[\s\S]*openControlPlaneRootWindow\(\)/);
});

test("the Chinese locale translates provider terminology in the model selector", () => {
  const zhInstances = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/instances.ts", import.meta.url), "utf8");
  const zhSessions = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/sessions.ts", import.meta.url), "utf8");
  assert.match(zhInstances, /available: "可用提供方"/);
  assert.match(zhInstances, /selected: "已选模型提供方"/);
  assert.doesNotMatch(zhInstances, /可用 Provider/);
  assert.match(zhSessions, /provider: "提供方"/);
});
