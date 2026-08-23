import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("model queries preserve the federated registry and expose a flattened compatibility view", () => {
  const queries = read("src/api/queries.ts");
  assert.match(queries, /function useModelRegistryQuery/);
  assert.match(queries, /queryFn: \(\{ signal \}\) => fetchModelRegistry\(signal\)/);
  assert.match(queries, /select: modelConfigsFromRegistry/);
  assert.match(queries, /locations: group\.locations/);
  assert.match(queries, /referenceCount: group\.referenceCount/);
});

test("models settings exposes location scope, references, and node diagnostics", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  for (const contract of [
    /v-model="settingsModel\.locationScope"/,
    /t\("settings\.modelRegistry\.controlPlane"\)/,
    /t\("settings\.modelRegistry\.nodeLocation", \{ name: node\.name \}\)/,
    /model\.locations/,
    /referenceCount/,
    /nodeDiagnostics/,
    /model-diagnostics/,
  ]) assert.match(settings, contract);
});

test("model location operations route to the selected store and reset busy state after failures", () => {
  const settings = read("src/apps/control-plane/settings/useModelSettings.ts");
  assert.match(settings, /createNodeModel\(settingsModel\.locationScope/);
  assert.match(settings, /Promise\.allSettled\(locations\.map/);
  assert.match(settings, /updateNodeModel\(location\.nodeId, editingModelId\.value/);
  assert.match(settings, /updateModel\(editingModelId\.value/);
  assert.match(settings, /deleteNodeModel\(location\.nodeId/);
  assert.match(settings, /removeModel\(model: ModelConfig, location: ModelLocation\)/);
  assert.match(settings, /settingsModel\.locationScope === "control-plane"/);
  assert.match(settings, /finally \{\s*savingModelId\.value = ""/);
  assert.match(settings, /finally \{\s*deletingModelId\.value = ""/);
});

test("models settings edits aggregate entries and deletes explicit locations through a portal menu", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /t\("settings\.modelRegistry\.editDescription"/);
  assert.match(settings, /t\("settings\.modelRegistry\.allLocations", \{ count: editingModelLocationCount \}\)/);
  assert.match(settings, /<DropdownMenuSubContent class="model-delete-location-menu"/);
  assert.match(settings, /v-for="location in model\.locations/);
  assert.match(settings, /@select="requestDelete\(model, location\)"/);
  assert.match(settings, /location\.type === 'node' && location\.referenceCount > 0/);
});

test("model settings discovers models into a searchable picker while preserving direct input and real endpoint testing", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  const state = read("src/apps/control-plane/settings/useModelSettings.ts");
  assert.match(settings, /<ControlPlaneInput v-model="settingsModel\.model"/);
  assert.match(settings, /<PopoverContent class="model-picker-popover [^"]*p-1"[\s\S]*:collision-padding="12"/);
  assert.match(settings, /<Command class="model-picker-command"[\s\S]*<CommandInput class="model-picker-search-input [^"]*text-\[13px\]" :placeholder="t\('settings\.modelRegistry\.searchModels'\)"/);
  assert.match(settings, /<ScrollArea class="model-picker-scroll" :horizontal="false">[\s\S]*<CommandList class="model-picker-list max-h-none overflow-visible">/);
  assert.match(settings, /v-for="option in discoveredModels"/);
  assert.match(settings, /<span>\{\{ option\.id \}\}<\/span>[\s\S]*<Check :size="14"/);
  assert.match(settings, /:global\(\.model-picker-popover\) \{[\s\S]*height: min\(360px,var\(--reka-popover-content-available-height\)\);[\s\S]*overflow: hidden;[\s\S]*padding: 4px;/);
  assert.match(settings, /\.model-picker-command \{[\s\S]*grid-template-rows: auto minmax\(0,1fr\);/);
  assert.match(settings, /\.model-picker-scroll \{ min-height: 0; \}/);
  assert.match(settings, /:deep\(\[role="option"\]\) \{[^}]*font-size: 13px;/);
  assert.match(settings, /:deep\(\[role="group"\]\) \{ display: grid; gap: 2px; padding: 0; \}/);
  assert.doesNotMatch(settings, /\[cmdk-item\]/);
  assert.match(settings, /@click="fetchModelOptions"/);
  assert.match(settings, /@click="checkModel"/);
  assert.match(state, /discoverModels\(endpointDraft\(\), endpointNodeId\(\)\)/);
  assert.match(state, /testModel\(\{/);
  assert.match(state, /existingModelId: editingModelId\.value/);
  assert.match(state, /showControlPlaneToast\(t\("settings\.modelRegistry\.testSucceeded"[^;]+"success"\)/);
  assert.match(state, /showDelayedControlPlaneLoadingToast\(t\("settings\.modelRegistry\.testing"\)\)/);
  assert.match(state, /showDelayedControlPlaneLoadingToast\(t\("settings\.modelRegistry\.discovering"\)\)/);
  assert.doesNotMatch(settings, /modelEndpointFeedback/);
});

test("models settings uses a full-width directory and a guarded editor dialog", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /class="model-toolbar"/);
  assert.match(settings, /const filteredModels = computed/);
  assert.match(settings, /<Dialog :open="editorOpen"/);
  assert.match(settings, /<DialogHeader class="model-editor-head space-y-0">/);
  assert.match(settings, /modelDraftDirty/);
  assert.match(settings, /model-editor-dialog w-\[min\(680px,calc\(100vw-32px\)\)\] max-w-none gap-0 overflow-hidden p-0/);
  assert.match(settings, /closeConfirmationOpen/);
  assert.match(settings, /<AlertDialog :open="Boolean\(pendingDelete\)"/);
  assert.doesNotMatch(settings, /window\.confirm/);
});

test("model locations and references open portal popovers without expanding rows", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /<PopoverContent class="model-summary-popover [^"]*p-0"[\s\S]*settings\.modelRegistry\.locations/);
  assert.match(settings, /settings\.modelRegistry\.referenceDistribution/);
  assert.match(settings, /function referenceLocations\(model: ModelConfig\)/);
  assert.match(settings, /--reka-popover-content-available-height/);
  assert.doesNotMatch(settings, /expandedModelIds|model-location-panel/);
});
