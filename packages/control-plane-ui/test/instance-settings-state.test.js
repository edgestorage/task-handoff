import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveInstanceModel,
  invalidInstanceModelSelection,
  selectableInstanceModels,
} from "../src/apps/control-plane/instance-settings/instanceSettingsState.ts";

const timestamp = "2026-07-15T00:00:00.000Z";
function model(id, app, overrides = {}) {
  return {
    id,
    name: id,
    endpoint: "https://models.invalid",
    model: `${id}-model`,
    app,
    enabled: true,
    order: 0,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

test("instance model choices preserve app and location boundaries", () => {
  const models = [
    model("global-codex", "codex", { locations: [{ type: "control-plane", name: "global", enabled: true, order: 0 }] }),
    model("node-a-codex", "codex", { locations: [{ type: "node", nodeId: "node-a", name: "a", enabled: true, order: 0, referenceCount: 0 }] }),
    model("node-b-codex", "codex", { locations: [{ type: "node", nodeId: "node-b", name: "b", enabled: true, order: 0, referenceCount: 0 }] }),
    model("global-claude", "claude", { locations: [{ type: "control-plane", name: "global", enabled: true, order: 0 }] }),
    model("disabled-codex", "codex", { locations: [{ type: "control-plane", name: "disabled", enabled: false, order: 0 }] }),
  ];

  assert.deepEqual(selectableInstanceModels(models, "codex", "node-a").map((item) => item.id), ["global-codex", "node-a-codex"]);
  assert.equal(invalidInstanceModelSelection(models, "codex", "node-a", "node-b-codex"), true);
  assert.equal(invalidInstanceModelSelection(models, "codex", "node-a", "global-claude"), true);
  assert.equal(invalidInstanceModelSelection(models, "codex", "node-a", "disabled-codex"), true);
  assert.equal(invalidInstanceModelSelection(models, "codex", "node-a", "node-a-codex"), false);
});

test("global default resolves only to an enabled control-plane model", () => {
  const models = [
    model("node-local", "codex", { order: -1, locations: [{ type: "node", nodeId: "node-a", name: "local", enabled: true, order: -1, referenceCount: 0 }] }),
    model("global-default", "codex", { order: 2, locations: [{ type: "control-plane", name: "global", enabled: true, order: 2 }] }),
  ];

  assert.equal(effectiveInstanceModel(models, "codex", "node-a")?.id, "global-default");
  assert.equal(effectiveInstanceModel(models, "codex", "node-a", "node-local")?.id, "node-local");
  assert.equal(effectiveInstanceModel(models, "codex", "node-a", null), undefined);
  assert.equal(invalidInstanceModelSelection(models, "codex", "node-a", null), false);
  assert.equal(effectiveInstanceModel(models, "codex", "node-a", "missing"), undefined);
});
