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
