import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nodeDetailActionState } from "../src/apps/control-plane/settings/nodeDetailActions.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t = createControlPlaneI18nForTest("en-US").global.t;

function state(overrides = {}) {
  return nodeDetailActionState({
    nodeId: "node_selected",
    isBuiltinNode: false,
    connectionEnabled: true,
    creatingPairingInviteNodeId: "",
    deletingNodeId: "",
    renamingNodeId: "",
    ...overrides,
  }, t);
}

test("remote node detail exposes delete while builtin node detail omits it", () => {
  assert.equal(state().canDelete, true);
  assert.equal(state({ isBuiltinNode: true }).canDelete, false);
  assert.deepEqual(state().menu, { busy: false, disabled: false, label: "More node actions" });
});

test("selected node action state reports busy labels and prevents duplicate actions", () => {
  const actions = state({
    connectionAction: "check",
    creatingPairingInviteNodeId: "node_selected",
    deletingNodeId: "node_selected",
    renamingNodeId: "node_selected",
  });

  assert.deepEqual(actions.check, { busy: true, disabled: true, label: "Checking connection" });
  assert.deepEqual(actions.menu, { busy: true, disabled: true, label: "Node action in progress" });
  assert.deepEqual(actions.rename, { busy: true, disabled: true, label: "Renaming" });
  assert.deepEqual(actions.pairingInvite, { busy: true, disabled: true, label: "Generating join token" });
  assert.deepEqual(actions.remove, { busy: true, disabled: true, label: "Deleting node" });
});

test("an action running on another node disables duplicates without showing the selected node as busy", () => {
  const actions = state({
    creatingPairingInviteNodeId: "node_other",
    deletingNodeId: "node_other",
    renamingNodeId: "node_other",
  });

  assert.deepEqual(actions.check, { busy: false, disabled: false, label: "Check connection" });
  assert.deepEqual(actions.menu, { busy: false, disabled: false, label: "More node actions" });
  assert.deepEqual(actions.rename, { busy: false, disabled: true, label: "Rename" });
  assert.deepEqual(actions.pairingInvite, { busy: false, disabled: true, label: "Generate join token" });
  assert.deepEqual(actions.remove, { busy: false, disabled: true, label: "Delete node" });
});

test("the exposed menu trigger stays visibly busy while a selected menu action is running", () => {
  assert.deepEqual(state({ creatingPairingInviteNodeId: "node_selected" }).menu, {
    busy: true,
    disabled: false,
    label: "Node action in progress",
  });
  assert.deepEqual(state({ deletingNodeId: "node_selected" }).menu, {
    busy: true,
    disabled: false,
    label: "Node action in progress",
  });
  assert.deepEqual(state({ renamingNodeId: "node_selected" }).menu, {
    busy: false,
    disabled: false,
    label: "More node actions",
  });
});

test("node detail connection actions follow the control-plane connection switch", () => {
  assert.deepEqual(state().connection, { busy: false, disabled: false, label: "Disconnect" });
  assert.deepEqual(state({ connectionEnabled: false }).connection, { busy: false, disabled: false, label: "Reconnect" });
  assert.deepEqual(state({ connectionEnabled: false }).check, { busy: false, disabled: true, label: "Check connection" });
  assert.deepEqual(state({ connectionAction: "disconnect" }).connection, { busy: true, disabled: true, label: "Disconnecting" });
  assert.deepEqual(state({ connectionAction: "disconnect" }).menu, { busy: true, disabled: true, label: "Node action in progress" });
  assert.equal(state({ connectionAction: "disconnect" }).rename.disabled, true);
  assert.equal(state({ connectionAction: "disconnect" }).pairingInvite.disabled, true);
  assert.equal(state({ connectionAction: "disconnect" }).remove.disabled, true);
});

test("node detail actions use icon, title, and description menu items", () => {
  const source = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/NodeDetailPanel.vue"), "utf8");
  const menu = source.match(/<DropdownMenuContent class="node-detail-action-menu"[\s\S]*?<\/DropdownMenuContent>/)?.[0] || "";

  assert.match(menu, /settings\.nodeDetail\.renameDescription/);
  assert.match(menu, /settings\.nodeDetail\.pairingDescription/);
  assert.match(menu, /settings\.nodeDetail\.removeDescription/);
  assert.equal((menu.match(/<strong>/g) || []).length, 3);
  assert.equal((menu.match(/<small>/g) || []).length, 3);
});

test("node detail places projects and inventory directly after overview", () => {
  const source = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/NodeDetailPanel.vue"), "utf8");
  const tabs = source.match(/const tabs = computed\(\(\) => \[([\s\S]*?)\]\s+satisfies/)?.[1] || "";
  const values = [...tabs.matchAll(/value: "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(values, ["overview", "storage", "inventory", "runtimes", "updates", "remote"]);
});
