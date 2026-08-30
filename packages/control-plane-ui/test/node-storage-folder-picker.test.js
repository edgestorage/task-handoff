import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { useNodeStorageFolderPicker } from "../src/apps/control-plane/settings/useNodeStorageFolderPicker.ts";

const dialog = fs.readFileSync(new URL("../src/apps/control-plane/settings/NodeStorageFolderPickerDialog.vue", import.meta.url), "utf8");
const tree = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/NodeFolderTree.vue", import.meta.url), "utf8");

function entry(name, path, children = []) {
  return { name, path, children };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      : input.path === "/workspace"
        ? [entry("workspace", "/workspace", [entry("project", "/workspace/project")])]
        : [entry("project", "/workspace/project")],
    loadPlaces: async () => [{ kind: "home", name: "workspace", path: "/workspace" }, { kind: "root", name: "/", path: "/" }],
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
  assert.equal(picker.selectedPath.value, "/workspace/project");
  assert.deepEqual(creates, []);
  assert.equal(refreshes(), 0);

  assert.equal(await picker.confirm(), true);
  assert.deepEqual(creates, [["node_remote", { name: "project", path: "/workspace/project" }]]);
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
  assert.equal(picker.selectedPath.value, "/workspace/project");
  assert.equal(picker.submitError.value, "folder already registered");
  assert.equal(refreshes(), 0);

  assert.equal(await picker.confirm(), true);
  assert.equal(attempts, 2);
  assert.equal(refreshes(), 1);
  assert.equal(picker.dialogOpen.value, false);
});

test("late quick locations do not override navigation performed while the dialog initializes", async () => {
  const places = deferred();
  const { picker } = setup({ loadPlaces: () => places.promise });
  const opening = picker.openForNode({ id: "node_remote", name: "Remote" });
  while (picker.currentPath.value !== "/workspace") await Promise.resolve();

  await picker.navigateTo("/workspace/project");
  places.resolve([{ kind: "home", name: "workspace", path: "/workspace" }]);
  await opening;

  assert.equal(picker.currentPath.value, "/workspace/project");
  assert.equal(picker.selectedPath.value, "/workspace/project");
});

test("a stale open request cannot populate a reopened dialog for the same node", async () => {
  const firstPlaces = deferred();
  let placesCall = 0;
  const { picker } = setup({
    loadPlaces: () => ++placesCall === 1
      ? firstPlaces.promise
      : Promise.resolve([{ kind: "home", name: "current", path: "/workspace/project" }]),
  });
  const staleOpening = picker.openForNode({ id: "node_remote", name: "Remote" });
  while (picker.currentPath.value !== "/workspace") await Promise.resolve();
  picker.close();
  await picker.openForNode({ id: "node_remote", name: "Remote" });

  firstPlaces.resolve([{ kind: "home", name: "stale", path: "/stale" }]);
  await staleOpening;

  assert.deepEqual(picker.places.value, [{ kind: "home", name: "current", path: "/workspace/project" }]);
  assert.equal(picker.currentPath.value, "/workspace/project");
});

test("node folder dialog exposes quick locations and current-directory navigation", () => {
  assert.match(dialog, /<NodeFolderTree[\s\S]*directory[\s\S]*:places="places"[\s\S]*@navigate="\$emit\('navigate', \$event\)"[\s\S]*@up="\$emit\('up'\)"/);
  assert.doesNotMatch(dialog, /node-storage-folder-selection/);
  assert.match(tree, /class="node-folder-places"/);
  assert.match(tree, /place\.kind === "home" \? t\("instances\.create\.folders\.home"\)/);
  assert.match(tree, /class="node-folder-navigation"/);
  assert.match(tree, /class="node-folder-address"/);
  assert.match(tree, /@click="beginPathEdit"/);
  assert.match(tree, /v-if="editingPath"[\s\S]*@keydown\.enter\.prevent="commitPathEdit"[\s\S]*@keydown\.esc\.prevent="cancelPathEdit"/);
  assert.match(tree, /v-for="\(crumb, index\) in breadcrumbs"/);
  assert.match(tree, /:aria-current="index === breadcrumbs\.length - 1 \? 'page' : undefined"/);
  assert.match(tree, /pathNavigation\.value\?\.scrollTo/);
  assert.match(tree, /folderListContent\.value\?\.parentElement\?\.scrollTo\(\{ top: 0, left: 0 \}\)/);
  assert.match(tree, /grid-template-columns: 180px minmax\(0, 1fr\)/);
});
