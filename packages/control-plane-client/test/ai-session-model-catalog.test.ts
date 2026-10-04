import assert from "node:assert/strict";
import test from "node:test";
import { aiSessionModelSelectionAllowed, aiSessionProviderSelectionAllowed, defaultAiSessionModelSelection, deriveAiSessionModelGroups } from "../src/ai-session-model-catalog.ts";

const entities = [
  { id: "one", name: "One", model: "fallback", enabled: true, order: 1, protocols: ["openai-responses"], modelNames: [{ name: "large", order: 2 }, { name: "small", order: 1 }], locations: [{ type: "control-plane" as const, enabled: true }] },
  { id: "two", name: "Two", model: "same", enabled: true, order: 2, protocols: ["openai-responses", "openai-chat-completions"], modelNames: [{ name: "same", order: 1 }], locations: [{ type: "node" as const, nodeId: "node-1", enabled: true }] },
];

test("derives create choices in assignment and model-name order", () => {
  const groups = deriveAiSessionModelGroups({ entities, assignment: { modelEntityIds: ["two", "one"] }, agent: "codex", nodeId: "node-1", mode: "create", capability: { selectModelAtCreate: true, selectProviderAtCreate: true } });
  assert.deepEqual(groups.map((group) => [group.modelEntityId, group.models.map((model) => model.modelName)]), [["two", ["same"]], ["one", ["small", "large"]]]);
  assert.deepEqual(defaultAiSessionModelSelection(groups), { modelEntityId: "two", modelName: "same" });
});

test("restricts existing Codex choices to the current provider", () => {
  const groups = deriveAiSessionModelGroups({ entities, assignment: { modelEntityIds: ["one", "two"] }, agent: "codex", nodeId: "node-1", mode: "existing", currentSelection: { modelEntityId: "one", modelName: "small" }, capability: { switchModelWithinProvider: true, switchProviderDuringSession: false } });
  assert.deepEqual(groups.map((group) => group.modelEntityId), ["one"]);
});

test("allows a native cross-provider adapter to expose every compatible provider", () => {
  const groups = deriveAiSessionModelGroups({ entities, assignment: { modelEntityIds: ["one", "two"] }, agent: "opencode", nodeId: "node-1", mode: "existing", currentSelection: { modelEntityId: "two", modelName: "same" }, capability: { switchModelWithinProvider: true, switchProviderDuringSession: true } });
  assert.deepEqual(groups.map((group) => group.modelEntityId), ["two"]);
});

test("derives resume choices independently from active-session switching", () => {
  const groups = deriveAiSessionModelGroups({ entities, assignment: { modelEntityIds: ["one", "two"] }, agent: "codex", nodeId: "node-1", mode: "resume", currentSelection: { modelEntityId: "one", modelName: "small" }, capability: { selectModelAtResume: true, selectProviderAtResume: true, switchProviderDuringSession: false } });
  assert.deepEqual(groups.map((group) => group.modelEntityId), ["one", "two"]);
});

test("resolves a node replica under the same stable entity id on every node", () => {
  const replicated = [{
    id: "mdl_stable", name: "Replicated", model: "replicated-model", enabled: true, order: 1,
    protocols: ["openai-responses"],
    modelNames: [{ name: "replicated-model", order: 100 }],
    locations: [
      { type: "control-plane" as const, enabled: true },
      { type: "node" as const, nodeId: "node-1", enabled: true },
    ],
  }];
  const capability = { selectModelAtCreate: true, selectProviderAtCreate: true };
  const instanceGroups = deriveAiSessionModelGroups({
    entities: replicated, assignment: { modelEntityIds: ["mdl_stable"] }, agent: "codex", nodeId: "node-1", mode: "create", capability,
  });
  assert.deepEqual(instanceGroups.map((group) => group.modelEntityId), ["mdl_stable"]);
  assert.deepEqual(instanceGroups[0]?.models.map((model) => model.modelEntityId), ["mdl_stable"]);
  const otherNodeGroups = deriveAiSessionModelGroups({
    entities: replicated, assignment: { modelEntityIds: ["mdl_stable"] }, agent: "codex", nodeId: "node-2", mode: "create", capability,
  });
  assert.deepEqual(otherNodeGroups.map((group) => group.modelEntityId), ["mdl_stable"]);
  // A retired content-hash id is not a resolvable entity id any more.
  const legacyGroups = deriveAiSessionModelGroups({
    entities: replicated, assignment: { modelEntityIds: ["mdl_projection"] }, agent: "codex", nodeId: "node-1", mode: "create", capability,
  });
  assert.deepEqual(legacyGroups, []);
});

test("gates model and provider selection per catalog mode", () => {
  assert.equal(aiSessionModelSelectionAllowed({ selectModelAtCreate: true }, "create"), true);
  assert.equal(aiSessionModelSelectionAllowed({ selectModelAtCreate: true }, "existing"), false);
  assert.equal(aiSessionModelSelectionAllowed({ selectModelAtResume: true }, "resume"), true);
  assert.equal(aiSessionModelSelectionAllowed({ switchModelWithinProvider: true }, "existing"), true);
  assert.equal(aiSessionModelSelectionAllowed(undefined, "existing"), false);
  assert.equal(aiSessionProviderSelectionAllowed({ selectProviderAtCreate: true }, "create"), true);
  assert.equal(aiSessionProviderSelectionAllowed({ selectProviderAtResume: true }, "resume"), true);
  assert.equal(aiSessionProviderSelectionAllowed({ switchProviderDuringSession: true }, "existing"), true);
  assert.equal(aiSessionProviderSelectionAllowed({ selectProviderAtCreate: true }, "existing"), false);
});

test("an instance that only supports create-time selection derives no in-session choices", () => {
  const capability = { selectModelAtCreate: true, selectProviderAtCreate: true };
  const groups = deriveAiSessionModelGroups({ entities, assignment: { modelEntityIds: ["one"] }, agent: "codex", nodeId: "node-1", mode: "existing", currentSelection: { modelEntityId: "one", modelName: "small" }, capability });
  assert.deepEqual(groups, []);
});
