import assert from "node:assert/strict";
import test from "node:test";

import { useNodeStorageFolderPicker } from "../src/apps/control-plane/settings/useNodeStorageFolderPicker.ts";

function entry(name, path, children = []) {
  return { name, path, children };
}

function setup(overrides = {}) {
  const creates = [];
  let refreshes = 0;
  const picker = useNodeStorageFolderPicker({
    createFolder: async (nodeId, input) => {
      creates.push([nodeId, input]);
      return { id: "folder_1", nodeId, name: input.name, path: input.path };
    },
    errorText: (error) => error instanceof Error ? error.message : String(error),
    loadFolders: async (_nodeId, input) => input.depth === 0
      ? [entry("workspace", "/workspace")]
      : [entry("workspace", "/workspace", [entry("project", "/workspace/project")])],
    refresh: async () => {
      refreshes += 1;
    },
    ...overrides,
  });
  return { creates, picker, refreshes: () => refreshes };
}

test("selection stays temporary until confirmation", async () => {
  const { creates, picker, refreshes } = setup();
  await picker.openForNode({ id: "node_remote", name: "Remote build host" });
  await picker.selectFolder(picker.rows.value[0]);

  assert.equal(picker.dialogOpen.value, true);
  assert.equal(picker.selectedPath.value, "/workspace");
  assert.deepEqual(creates, []);
  assert.equal(refreshes(), 0);

  assert.equal(await picker.confirm(), true);
  assert.deepEqual(creates, [["node_remote", { name: "workspace", path: "/workspace" }]]);
  assert.equal(refreshes(), 1);
  assert.equal(picker.dialogOpen.value, false);
  assert.equal(picker.selectedPath.value, "");
});

test("cancel resets temporary selection without persistence", async () => {
  const { creates, picker, refreshes } = setup();
  await picker.openForNode({ id: "node_local", name: "Local Node" });
  await picker.selectFolder(picker.rows.value[0]);
  picker.close();

  assert.deepEqual(creates, []);
  assert.equal(refreshes(), 0);
  assert.equal(picker.dialogOpen.value, false);
  assert.deepEqual(picker.rows.value, []);
  assert.equal(picker.selectedPath.value, "");
});

test("registration errors preserve selection and allow retry", async () => {
  let attempts = 0;
  const { picker, refreshes } = setup({
    createFolder: async (nodeId, input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("folder already registered");
      return { id: "folder_1", nodeId, name: input.name, path: input.path };
    },
  });
  await picker.openForNode({ id: "node_remote", name: "Remote" });
  await picker.selectFolder(picker.rows.value[0]);

  assert.equal(await picker.confirm(), false);
  assert.equal(picker.dialogOpen.value, true);
  assert.equal(picker.selectedPath.value, "/workspace");
  assert.equal(picker.submitError.value, "folder already registered");
  assert.equal(refreshes(), 0);

  assert.equal(await picker.confirm(), true);
  assert.equal(attempts, 2);
  assert.equal(refreshes(), 1);
  assert.equal(picker.dialogOpen.value, false);
});
