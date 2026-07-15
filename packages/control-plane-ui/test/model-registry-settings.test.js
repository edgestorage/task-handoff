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
  assert.match(queries, /queryFn: fetchModelRegistry/);
  assert.match(queries, /select: modelConfigsFromRegistry/);
  assert.match(queries, /locations: group\.locations/);
  assert.match(queries, /referenceCount: group\.referenceCount/);
});

test("models settings exposes location scope, references, and node diagnostics", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  for (const contract of [
    /v-model="settingsModel\.locationScope"/,
    /Control plane/,
    /Node · \{\{ node\.name \}\}/,
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
  assert.match(settings, />Edit all</);
  assert.match(settings, /All \{\{ editingModelLocationCount \}\} locations/);
  assert.match(settings, /<DropdownMenuContent class="model-location-menu"/);
  assert.match(settings, /v-for="location in model\.locations/);
  assert.match(settings, /@select="removeModel\(model, location\)"/);
  assert.match(settings, /location\.type === 'node' && location\.referenceCount > 0/);
});
