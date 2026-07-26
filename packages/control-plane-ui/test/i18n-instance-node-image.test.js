import assert from "node:assert/strict";
import test from "node:test";

import { nodeDetailActionState } from "../src/apps/control-plane/settings/nodeDetailActions.ts";
import { imageProvisioningLabel, instanceStatusTitle } from "../src/apps/control-plane/useInstanceStatus.ts";
import { nodeRuntimeStatusKeys, translateStatus } from "../src/i18n/status.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

const instance = {
  id: "inst_i18n",
  name: "Localized instance",
  status: "provisioning",
  health: "unknown",
  connectionStatus: "unknown",
  access: { status: "unknown" },
  imageProvisioning: {
    phase: "pulling-image",
    requestedReference: "docker.io/example/app:v1",
    generation: 1,
    startedAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  imagePullProgress: {
    instanceId: "inst_i18n",
    generation: 1,
    requestedReference: "docker.io/example/app:v1",
    sequence: 2,
    observedAt: "2026-07-26T00:00:01.000Z",
    status: "pulling",
    layers: { total: 8, completed: 3, downloaded: 1, downloading: 2, extracting: 0 },
    percent: 42,
    message: "server-owned raw summary",
  },
};

function nodeActions(t) {
  return nodeDetailActionState({
    nodeId: "node_i18n",
    isBuiltinNode: false,
    checkingNodeId: "node_i18n",
    creatingPairingInviteNodeId: "",
    deletingNodeId: "",
    renamingNodeId: "",
  }, t);
}

test("instance lifecycle and image progress render from the selected locale without changing raw state", () => {
  assert.equal(instanceStatusTitle(instance, english), "Preparing instance");
  assert.equal(instanceStatusTitle(instance, chinese), "正在准备实例");
  assert.equal(imageProvisioningLabel(instance, english), "Pulling image · 3 / 8 ready · 42%");
  assert.equal(imageProvisioningLabel(instance, chinese), "正在拉取镜像 · 3 / 8 已就绪 · 42%");
  assert.equal(instance.status, "provisioning");
  assert.equal(instance.imagePullProgress.status, "pulling");
  assert.equal(instance.imagePullProgress.message, "server-owned raw summary");
});

test("node actions and runtime status render in English and Simplified Chinese", () => {
  assert.equal(nodeActions(english).check.label, "Checking connection");
  assert.equal(nodeActions(chinese).check.label, "正在检查连接");
  assert.equal(translateStatus(nodeRuntimeStatusKeys, "degraded", english), "Degraded");
  assert.equal(translateStatus(nodeRuntimeStatusKeys, "degraded", chinese), "异常");
});
