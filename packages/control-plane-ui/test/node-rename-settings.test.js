import assert from "node:assert/strict";
import test from "node:test";

import { NODE_NAME_MAX_LENGTH, useNodeRename } from "../src/apps/control-plane/settings/useNodeRename.ts";

function node(id = "node_rename", name = "Original node") {
  return {
    id,
    name,
    connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "key_rename" },
    status: "offline",
    health: "failed",
    capabilities: { inventory: true },
    labels: { zone: "west" },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function settingsHarness(overrides = {}) {
  const currentNodes = overrides.nodes || [node()];
  const notifications = [];
  const renamedNodes = [];
  const calls = [];
  const updateNodeAction = overrides.updateNodeAction || (async (id, input) => {
    calls.push({ id, input });
    return { ...currentNodes.find((item) => item.id === id), ...input, updatedAt: "2026-07-13T01:00:00.000Z" };
  });
  const settings = useNodeRename({
    errorText: (error) => error instanceof Error ? error.message : String(error),
    notify: (message, kind) => notifications.push({ message, kind }),
    onNodeRenamed: async (renamed) => {
      renamedNodes.push(renamed);
      const index = currentNodes.findIndex((item) => item.id === renamed.id);
      if (index >= 0) currentNodes[index] = renamed;
    },
    nodes: () => currentNodes,
    updateNode: async (id, input) => {
      if (overrides.updateNodeAction) calls.push({ id, input });
      return updateNodeAction(id, input);
    },
  });
  return { calls, currentNodes, notifications, renamedNodes, settings };
}

test("node rename state trims the name, locks the target, and prevents duplicate submission", async () => {
  let finishUpdate;
  const pending = new Promise((resolve) => { finishUpdate = resolve; });
  const harness = settingsHarness({
    updateNodeAction: async (id, input) => {
      await pending;
      return { ...node(id), ...input, updatedAt: "2026-07-13T01:00:00.000Z" };
    },
  });

  harness.settings.openNodeRename(node());
  harness.settings.updateNodeRenameDraft("  Renamed node  ");
  const first = harness.settings.submitNodeRename();
  const duplicate = harness.settings.submitNodeRename();

  assert.equal(harness.settings.renamingNodeId.value, "node_rename");
  assert.deepEqual(harness.calls, [{ id: "node_rename", input: { name: "Renamed node" } }]);
  await duplicate;
  finishUpdate();
  await first;

  assert.equal(harness.renamedNodes.length, 1);
  assert.equal(harness.renamedNodes[0].name, "Renamed node");
  assert.equal(harness.settings.nodeRenameOpen.value, false);
  assert.equal(harness.settings.nodeRenameDraft.value, "");
  assert.deepEqual(harness.notifications, [{ message: "Renamed node renamed.", kind: "success" }]);
});

test("node rename state validates blank, long, and unchanged names without a request", async () => {
  const harness = settingsHarness();
  harness.settings.openNodeRename(node());

  harness.settings.updateNodeRenameDraft("   ");
  await harness.settings.submitNodeRename();
  assert.equal(harness.settings.nodeRenameError.value, "Node name is required.");

  harness.settings.updateNodeRenameDraft("n".repeat(NODE_NAME_MAX_LENGTH + 1));
  await harness.settings.submitNodeRename();
  assert.equal(harness.settings.nodeRenameError.value, `Node name must be ${NODE_NAME_MAX_LENGTH} characters or fewer.`);

  harness.settings.updateNodeRenameDraft("  Original node  ");
  await harness.settings.submitNodeRename();
  assert.equal(harness.settings.nodeRenameError.value, "Enter a different node name.");
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.settings.canSubmitNodeRename.value, false);
});

test("node rename state retains the draft after failure and resets when the selected node changes", async () => {
  const harness = settingsHarness({
    nodes: [node(), node("node_other", "Other node")],
    updateNodeAction: async () => {
      throw new Error("Rename request failed");
    },
  });
  harness.settings.openNodeRename(node());
  harness.settings.updateNodeRenameDraft("Retry this name");

  await harness.settings.submitNodeRename();
  assert.equal(harness.settings.nodeRenameOpen.value, true);
  assert.equal(harness.settings.nodeRenameTargetId.value, "node_rename");
  assert.equal(harness.settings.nodeRenameDraft.value, "Retry this name");
  assert.equal(harness.settings.nodeRenameError.value, "Rename request failed");

  harness.settings.resetNodeRename();
  assert.equal(harness.settings.nodeRenameOpen.value, false);
  assert.equal(harness.settings.nodeRenameTargetId.value, "");
  assert.equal(harness.settings.nodeRenameDraft.value, "");
  assert.equal(harness.settings.nodeRenameError.value, "");
});
