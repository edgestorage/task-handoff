import assert from "node:assert/strict";
import test from "node:test";
import { defaultAiSessionModelSelection, deriveAiSessionModelGroups } from "../src/ai-session-model-catalog.ts";

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
