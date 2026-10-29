import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";

const source = fs.readFileSync(new URL("../src/apps/control-plane/settings/useModelSettings.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(locations, options = {}) {
  const calls = [];
  const notices = [];
  const refreshes = [];
  const model = {
    id: "model-source", name: "Source", endpoint: "https://example.com/v1", model: "external",
    modelNames: [{ name: "external", upstreamName: "upstream", order: 100 }],
    mappings: [{ name: "review", upstreamName: "upstream", order: 100 }],
    protocols: ["openai-responses"], app: "codex", enabled: true, keySet: true, locations,
  };
  const exports = {};
  const modules = {
    vue,
    "@task-handoff/protocol/control-plane": { MODEL_REQUEST_MAPPING_PRESETS: [] },
    "../../../api/queries": {
      createModel: async (payload) => { calls.push({ method: "create", payload }); return { ...payload, id: "model-new" }; },
      copyModel: async (id, payload) => { calls.push({ method: "copy", id, payload }); return { ...payload, id: "model-copy" }; },
      discoverModels: async (payload) => { calls.push({ method: "discover", payload }); return { models: [], latencyMs: 1 }; },
      deleteNodeModel: async (nodeId, id) => {
        calls.push({ method: "delete-node", nodeId, id });
        await options.deleteNodeModel?.(nodeId, id);
        return { deleted: true };
      },
      deleteModel: async (id) => { calls.push({ method: "delete-control-plane", id }); return { deleted: true }; },
    },
    "../../../api/nodeCapabilities": { nodeSupportsModelRequestMappings: () => true },
    "../useControlPlaneToasts": {
      showControlPlaneToast: (message) => notices.push(message),
      showDelayedControlPlaneLoadingToast: () => ({ dismiss() {} }),
    },
    "../../../i18n/apiError.ts": { translateApiError: (error) => String(error) },
  };
  new Function("require", "exports", compiled)((name) => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  }, exports);
  const scope = vue.effectScope();
  const state = scope.run(() => exports.useModelSettings({
    errorText: String, models: () => [model], nodes: () => [], onModelDeleted() {},
    refreshModels: async () => { refreshes.push(true); await options.refreshModels?.(model); },
    translate: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
  }));
  state.copyModelDraft(model);
  return { model, state, calls, notices, refreshes, stop: () => scope.stop() };
}

test("node model copy requires a new key and creates from public configuration without a source credential", async (context) => {
  const { model, state, calls, stop } = setup([{ type: "node", nodeId: "node-a" }]);
  context.after(stop);
  assert.equal(state.settingsModel.key, "");
  assert.equal(state.settingsModel.locationScope, "control-plane");
  assert.equal(state.canInheritCopyCredential.value, false);
  assert.equal(state.canSaveModel.value, false);
  assert.equal(state.canDiscoverModels.value, false);
  assert.equal(await state.saveModel(), false);
  assert.deepEqual(calls, []);

  state.settingsModel.key = "new-copy-key";
  assert.equal(state.canSaveModel.value, true);
  await state.fetchModelOptions();
  assert.deepEqual(calls[0], { method: "discover", payload: { endpoint: model.endpoint, key: "new-copy-key" } });
  assert.equal(await state.saveModel(), true);
  assert.equal(calls[1].method, "create");
  assert.equal(calls[1].payload.key, "new-copy-key");
  assert.deepEqual(calls[1].payload.modelNames, model.modelNames);
  assert.deepEqual(calls[1].payload.mappings, model.mappings);
  assert.equal(model.name, "Source");
});

test("control-plane model copy can still inherit its credential even with node replicas", async (context) => {
  const { model, state, calls, stop } = setup([{ type: "node", nodeId: "node-a" }, { type: "control-plane" }]);
  context.after(stop);
  assert.equal(state.canInheritCopyCredential.value, true);
  assert.equal(state.canSaveModel.value, true);
  await state.fetchModelOptions();
  assert.equal(calls[0].payload.existingModelId, model.id);
  assert.equal(await state.saveModel(), true);
  assert.equal(calls[1].method, "copy");
  assert.equal(calls[1].id, model.id);
  assert.equal("key" in calls[1].payload, false);
});

test("delete all removes every node replica before the control-plane record", async (context) => {
  const { model, state, calls, refreshes, stop } = setup([
    { type: "control-plane" }, { type: "node", nodeId: "node-a", referenceCount: 0 }, { type: "node", nodeId: "node-b", referenceCount: 0 },
  ]);
  context.after(stop);
  state.editModel(model);
  assert.equal(await state.removeModelEverywhere(model), true);
  assert.deepEqual(calls, [
    { method: "delete-node", nodeId: "node-a", id: model.id },
    { method: "delete-node", nodeId: "node-b", id: model.id },
    { method: "delete-control-plane", id: model.id },
  ]);
  assert.equal(refreshes.length, 1);
  assert.equal(state.editingModelId.value, "");
  assert.equal(state.deletingModelId.value, "");
});

test("delete all refuses a model referenced on any node before deleting any location", async (context) => {
  const { model, state, calls, stop } = setup([
    { type: "control-plane" }, { type: "node", nodeId: "node-a", referenceCount: 1 },
  ]);
  context.after(stop);
  assert.equal(state.canDeleteModelEverywhere(model), false);
  assert.equal(await state.removeModelEverywhere(model), false);
  assert.deepEqual(calls, []);
});

test("partial deletion retains control-plane configuration, refreshes authority, and retries remaining locations", async (context) => {
  let offline = true;
  const { model, state, calls, notices, refreshes, stop } = setup([
    { type: "control-plane" }, { type: "node", nodeId: "node-a", referenceCount: 0 }, { type: "node", nodeId: "node-b", referenceCount: 0 },
  ], {
    deleteNodeModel: async (nodeId) => { if (offline && nodeId === "node-b") throw new Error("Node offline"); },
    refreshModels: async (model) => { model.locations = model.locations.filter((location) => location.nodeId !== "node-a"); },
  });
  context.after(stop);
  assert.equal(await state.removeModelEverywhere(model), false);
  assert.equal(calls.some((call) => call.method === "delete-control-plane"), false);
  assert.equal(refreshes.length, 1);
  assert.equal(state.deletingModelId.value, "");
  assert.match(notices[0], /deleteIncomplete.*"count":1,"total":3.*Node offline/);
  calls.length = 0;
  offline = false;
  assert.equal(await state.removeModelEverywhere(model), true);
  assert.deepEqual(calls, [
    { method: "delete-node", nodeId: "node-b", id: model.id },
    { method: "delete-control-plane", id: model.id },
  ]);
});

test("delete all also supports a node-only model", async (context) => {
  const { model, state, calls, stop } = setup([{ type: "node", nodeId: "node-a", referenceCount: 0 }]);
  context.after(stop);
  assert.equal(await state.removeModelEverywhere(model), true);
  assert.deepEqual(calls, [{ method: "delete-node", nodeId: "node-a", id: model.id }]);
});

test("single-location deletion retains other locations and the open model editor", async (context) => {
  const location = { type: "node", nodeId: "node-a", referenceCount: 0 };
  const { model, state, calls, stop } = setup([{ type: "control-plane" }, location]);
  context.after(stop);
  state.editModel(model);
  assert.equal(await state.removeModel(model, location), true);
  assert.deepEqual(calls, [{ method: "delete-node", nodeId: "node-a", id: model.id }]);
  assert.equal(state.editingModelId.value, model.id);
});
