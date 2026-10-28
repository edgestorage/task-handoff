import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";
import {
  canShowInstanceAction,
  hasInstanceStatusPage,
  instancePendingStatusLabel,
  instanceStatusBadgeLabel,
  instanceStatusDetail,
  instanceStatusTitle,
  isInstanceNodeDisconnected,
} from "../src/apps/control-plane/useInstanceStatus.ts";

function instance(overrides = {}) {
  return {
    id: "inst_node_pause",
    name: "Node pause",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    ready: true,
    runtimeVersion: { phase: "matched" },
    access: { strategy: "control-plane-proxy", status: "reachable" },
    runtime: { id: "rt_1", type: "docker", status: "online" },
    workspace: { status: "ready" },
    node: { id: "node_pause", connectionEnabled: false },
    ...overrides,
  };
}

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

test("a disconnected node presents its running instances as unavailable", () => {
  const paused = instance();

  assert.equal(isInstanceNodeDisconnected(paused), true);
  assert.equal(hasInstanceStatusPage(paused), true);
  assert.equal(instancePendingStatusLabel(paused, english), undefined);
  assert.equal(instanceStatusTitle(paused, english), "Node disconnected");
  assert.equal(instanceStatusTitle(paused, chinese), "节点已断开");
  assert.match(instanceStatusDetail(paused, english), /instances keep running/);
  assert.match(instanceStatusDetail(paused, chinese), /实例不会被停止/);
  assert.equal(instanceStatusBadgeLabel(paused, english), "Node disconnected");
  assert.equal(instanceStatusBadgeLabel(paused, chinese), "节点已断开");
});

test("paused-node instances expose no lifecycle actions until the node reconnects", () => {
  for (const action of ["start", "stop", "restart", "retry-image", "retry-git", "delete"]) {
    assert.equal(canShowInstanceAction(instance(), action), false, action);
  }

  const connected = instance({ node: { id: "node_pause", connectionEnabled: true } });
  assert.equal(hasInstanceStatusPage(connected), false);
  assert.equal(instanceStatusBadgeLabel(connected, english), "Running");
  assert.equal(canShowInstanceAction(connected, "restart"), true);
});
