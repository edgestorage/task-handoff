import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";
import { createNodeConnectionActions, isNodeConnectionEnabled } from "../src/apps/control-plane/nodeConnectionActions.ts";

const instanceList = readFileSync(new URL("../src/apps/control-plane/instance-list/InstanceList.vue", import.meta.url), "utf8");
const workbench = readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const settingsModal = readFileSync(new URL("../src/apps/control-plane/settings/SettingsModal.vue", import.meta.url), "utf8");
const nodeDetailPanel = readFileSync(new URL("../src/apps/control-plane/settings/NodeDetailPanel.vue", import.meta.url), "utf8");
const nodeSettings = readFileSync(new URL("../src/apps/control-plane/settings/useNodeSettings.ts", import.meta.url), "utf8");
const nodeResourceSettings = readFileSync(new URL("../src/apps/control-plane/settings/useNodeResourceSettings.ts", import.meta.url), "utf8");

test("node groups expose disconnect, reconnect, and connection check actions", () => {
  assert.match(instanceList, /<ContextMenu v-if="groupByNode">[\s\S]*?<ContextMenuTrigger as-child :disabled="!group\.node">[\s\S]*?class="instance-group-label"/);
  assert.match(instanceList, /@select="requestNodeConnection\(group\.node, true\)"/);
  assert.match(instanceList, /@select="requestNodeConnection\(group\.node, false\)"/);
  assert.match(instanceList, /@select="requestNodeCheck\(group\.node\)"/);
  assert.match(instanceList, /setNodeConnection: \[node: Node, enabled: boolean\]/);
  assert.match(instanceList, /checkNode: \[node: Node\]/);
});

test("disabled nodes hide transport failures behind the authoritative local connection state", () => {
  assert.match(instanceList, /const disconnected = node\.connectionEnabled === false/);
  assert.match(instanceList, /const connectionLabel = disconnected[\s\S]*?t\("instances\.list\.nodeDisconnected"\)/);
  assert.match(instanceList, /const hasPendingNodes = computed\(\(\) => props\.nodes\.some\(\(node\) => \{\n  if \(node\.connectionEnabled === false\) return false;/);
  assert.match(instanceList, /busy: Boolean\(pendingAction\) \|\| \(!disconnected && connectionSpinning\)/);
  assert.match(instanceList, /:data-connection="group\.disconnected \? 'disabled' : 'enabled'"/);
  assert.match(instanceList, /:disabled="group\.disconnected \|\| group\.busy"/);
});

test("the workbench drives the existing node update and check APIs", () => {
  assert.match(workbench, /:node-action="instanceNodeAction"/);
  assert.match(workbench, /@set-node-connection="setInstanceNodeConnection"/);
  assert.match(workbench, /@check-node="checkInstanceNodeConnection"/);
  assert.match(workbench, /useNodeConnectionActions\(\{/);
  assert.doesNotMatch(workbench, /async function setInstanceNodeConnection/);
});

test("node detail exposes the same connection actions and authoritative disabled state", () => {
  assert.match(nodeDetailPanel, /actions\.setNodeConnection\(selectedNode, selectedNode\.connectionEnabled === false\)/);
  assert.match(nodeDetailPanel, /headerActionState\.check\.disabled/);
  assert.match(nodeDetailPanel, /:disabled="headerActionState\.menu\.disabled"/);
  assert.match(settingsModal, /setNodeConnection,/);
  assert.match(settingsModal, /connectionAction: nodeConnectionAction\(selectedNode\.value\?\.id \|\| ""\)/);
  assert.match(settingsModal, /if \(node\?\.connectionEnabled === false\) return "disconnected"/);
  assert.match(settingsModal, /nodeStatusValue\(nodeId\) === "disconnected"[\s\S]*?instances\.list\.nodeDisconnected/);
  assert.match(settingsModal, /\.node-status-dot\.status-disconnected/);
});

test("node detail connection changes use the existing node update API", () => {
  assert.match(nodeSettings, /useNodeConnectionActions\(\{/);
  assert.match(nodeSettings, /refresh: refreshNodeTopology/);
  assert.match(nodeSettings, /onNodeUpdated/);
  assert.doesNotMatch(nodeSettings, /async function setNodeConnection/);
});

test("paused nodes do not auto-load live detail resources", () => {
  assert.equal(isNodeConnectionEnabled({ connectionEnabled: false }), false);
  assert.equal(isNodeConnectionEnabled({ connectionEnabled: true }), true);
  assert.equal(isNodeConnectionEnabled({}), true);
  assert.match(nodeSettings, /isNodeConnectionEnabled\(nodes\(\)\.find\(\(node\) => node\.id === id\)\)/);
  assert.match(nodeSettings, /isNodeConnectionEnabled\(nodes\(\)\.find\(\(node\) => node\.id === nodeId\)\)/);
  assert.match(nodeResourceSettings, /useNodeLocalFoldersQuery\(\(\) => selectedNodeId\.value, selectedNodeConnectionEnabled\)/);
  assert.match(settingsModal, /!isNodeConnectionEnabled\(node\) \|\| !isControlPlaneBuiltinNode\(node\)/);
  assert.match(settingsModal, /!isNodeConnectionEnabled\(node\) \|\| !nodeSupportsModelRelay\(node\)/);
  assert.match(settingsModal, /nodeLocalFolders\.error\.value && isNodeConnectionEnabled\(selectedNode\.value\)/);
  assert.match(nodeDetailPanel, /selectedNode\.connectionEnabled === false \|\| busy\.checkingUpdateNodeId/);
  assert.match(nodeDetailPanel, /selectedNode\.connectionEnabled === false \|\| busy\.loadingRemoteKeysNodeId/);
});

test("successful node updates do not become failures when projection refresh fails", async () => {
  const updated = { id: "node_connection", name: "Node", connectionEnabled: false, status: "offline" };
  const notifications = [];
  const updates = [];
  let applied = false;
  const actions = createNodeConnectionActions({
    confirmDisconnect: () => true,
    notify: (message, kind) => {
      if (kind === "success") assert.equal(applied, true);
      notifications.push({ message, kind });
    },
    onNodeUpdated: () => { applied = true; },
    refresh: async () => { throw new Error("projection refresh failed"); },
    translate: createControlPlaneI18nForTest("en-US").global.t,
    translateError: (error) => error instanceof Error ? error.message : String(error),
    updateNode: async (id, input) => {
      updates.push({ id, input });
      return updated;
    },
  });

  assert.equal(await actions.setNodeConnection({ id: "node_connection", name: "Node", connectionEnabled: true }, false), true);
  assert.deepEqual(updates, [{ id: "node_connection", input: { connectionEnabled: false } }]);
  assert.deepEqual(notifications, [{ message: "Disconnected from Node. Its instances and configuration were kept.", kind: "success" }]);
  assert.equal(actions.actionFor("node_connection"), undefined);
  await Promise.resolve();
});

test("node update failures remain errors and skip projection refresh", async () => {
  const notifications = [];
  let refreshCalls = 0;
  const actions = createNodeConnectionActions({
    confirmDisconnect: () => true,
    notify: (message, kind) => notifications.push({ message, kind }),
    refresh: async () => { refreshCalls += 1; },
    translate: createControlPlaneI18nForTest("en-US").global.t,
    translateError: (error) => error instanceof Error ? error.message : String(error),
    updateNode: async () => { throw new Error("update failed"); },
  });

  assert.equal(await actions.setNodeConnection({ id: "node_connection", name: "Node", connectionEnabled: true }, false), false);
  assert.deepEqual(notifications, [{ message: "update failed", kind: "error" }]);
  assert.equal(refreshCalls, 0);
});

test("the shared action state prevents duplicate updates for the same node", async () => {
  let resolveUpdate;
  let updateCalls = 0;
  const pendingUpdate = new Promise((resolve) => { resolveUpdate = resolve; });
  const actions = createNodeConnectionActions({
    confirmDisconnect: () => true,
    notify: () => undefined,
    refresh: async () => undefined,
    translate: createControlPlaneI18nForTest("en-US").global.t,
    translateError: (error) => error instanceof Error ? error.message : String(error),
    updateNode: async () => {
      updateCalls += 1;
      return pendingUpdate;
    },
  });
  const node = { id: "node_connection", name: "Node", connectionEnabled: true };

  const first = actions.setNodeConnection(node, false);
  await Promise.resolve();
  assert.equal(actions.actionFor(node.id), "disconnect");
  assert.equal(await actions.setNodeConnection(node, false), false);
  resolveUpdate({ ...node, connectionEnabled: false });
  assert.equal(await first, true);
  assert.equal(updateCalls, 1);
});

test("node connection actions and feedback are localized", () => {
  const english = createControlPlaneI18nForTest("en-US").global.t;
  const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

  assert.equal(english("instances.nodeConnection.disconnect"), "Disconnect");
  assert.equal(english("instances.nodeConnection.reconnect"), "Reconnect");
  assert.equal(english("instances.nodeConnection.check"), "Check connection");
  assert.equal(chinese("instances.nodeConnection.disconnect"), "断开连接");
  assert.equal(chinese("instances.nodeConnection.reconnect"), "重新连接");
  assert.equal(chinese("instances.list.nodeDisconnected"), "已断开");
});
