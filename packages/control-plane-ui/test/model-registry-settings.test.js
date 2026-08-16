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
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  for (const contract of [
    /v-model="settingsModel\.locationScope"/,
    /t\("settings\.modelRegistry\.controlPlane"\)/,
    /t\("settings\.modelRegistry\.nodeLocation", \{ name: node\.name \}\)/,
    /model\.locations/,
    /referenceCount/,
    /nodeDiagnostics/,
    /model-node-diagnostics/,
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
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /t\("settings\.modelRegistry\.editAll"\)/);
  assert.match(settings, /t\("settings\.modelRegistry\.allLocations", \{ count: editingModelLocationCount \}\)/);
  assert.match(settings, /<DropdownMenuContent class="model-location-menu"/);
  assert.match(settings, /v-for="location in model\.locations/);
  assert.match(settings, /@select="removeModel\(model, location\)"/);
  assert.match(settings, /location\.type === 'node' && location\.referenceCount > 0/);
});

test("model settings discovers models into a searchable picker while preserving direct input and real endpoint testing", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const state = read("src/apps/control-plane/settings/useModelSettings.ts");
  assert.match(settings, /<ControlPlaneInput v-model="settingsModel\.model"/);
  assert.match(settings, /<PopoverContent[\s\S]*class="model-picker-popover"[\s\S]*:collision-padding="12"[\s\S]*:style="\{ width: 'min\(360px, var\(--reka-popover-content-available-width\)\)', padding: '4px' \}"/);
  assert.match(settings, /<Command class="model-picker-command"[\s\S]*<CommandInput class="model-picker-search-input" :placeholder="t\('settings\.modelRegistry\.searchModels'\)"/);
  assert.match(settings, /<ScrollArea class="model-picker-scroll" :horizontal="false">[\s\S]*<CommandList class="model-picker-list">/);
  assert.match(settings, /v-for="option in discoveredModels"/);
  assert.match(settings, /<span>\{\{ option\.id \}\}<\/span>[\s\S]*<Check :size="14"/);
  assert.match(settings, /:global\(\.model-picker-popover\) \{[\s\S]*grid-template-rows: minmax\(0, 1fr\);[\s\S]*height: min\(360px, var\(--reka-popover-content-available-height\)\);[\s\S]*overflow: hidden;[\s\S]*padding: 4px;/);
  assert.match(settings, /\.model-picker-command :deep\(\[cmdk-input-wrapper\]\) \{[\s\S]*height: 34px;[\s\S]*margin: 2px 2px 4px;[\s\S]*padding: 0 9px;/);
  assert.match(settings, /\.model-picker-scroll \{[\s\S]*min-height: 0;[\s\S]*max-height: none;/);
  assert.match(settings, /\.model-picker-group \{\s*padding: 0;\s*\}/);
  assert.match(settings, /\.model-picker-option:hover,[\s\S]*\.model-picker-option:focus-visible,[\s\S]*\.model-picker-option\[data-highlighted\] \{[\s\S]*background: var\(--surface-active\);/);
  assert.match(settings, /@click="fetchModelOptions"/);
  assert.match(settings, /@click="checkModel"/);
  assert.match(state, /discoverModels\(endpointDraft\(\), endpointNodeId\(\)\)/);
  assert.match(state, /testModel\(\{/);
  assert.match(state, /existingModelId: editingModelId\.value/);
});
