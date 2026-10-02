import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { instancePendingStatusLabel } from "../src/apps/control-plane/useInstanceStatus.ts";

const read = (relative) => fs.readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");
const translate = (key) => `t:${key}`;

function instance(overrides = {}) {
  return {
    id: "inst_1",
    name: "Flash",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    ready: true,
    runtimeVersion: { phase: "matched" },
    access: { strategy: "control-plane-proxy", status: "reachable" },
    runtime: { id: "rt_1", type: "docker", status: "online" },
    target: { strategy: "direct-port", status: "reachable" },
    workspace: { status: "ready" },
    ...overrides,
  };
}

test("instance list surfaces authoritative in-progress lifecycle copy", () => {
  assert.equal(instancePendingStatusLabel(instance({ status: "starting" }), translate), "t:instances.lifecycle.starting");
  assert.equal(instancePendingStatusLabel(instance({ status: "provisioning" }), translate), "t:instances.lifecycle.preparingRuntime");
  assert.equal(instancePendingStatusLabel(instance({ status: "registering" }), translate), "t:instances.lifecycle.connecting");
  assert.equal(instancePendingStatusLabel(instance({ status: "registered" }), translate), "t:instances.lifecycle.connecting");
  assert.equal(instancePendingStatusLabel(instance({ status: "stopping" }), translate), "t:instances.lifecycle.stopping");
  assert.equal(instancePendingStatusLabel(instance({ runtimeVersion: { phase: "restarting" } }), translate), "t:instances.lifecycle.updatingRuntime");
});

test("settled and runtime-blocked states keep the regular row presentation", () => {
  assert.equal(instancePendingStatusLabel(instance(), translate), undefined);
  assert.equal(instancePendingStatusLabel(instance({ status: "stopped", connectionStatus: "offline" }), translate), undefined);
  assert.equal(instancePendingStatusLabel(instance({ status: "failed", health: "failed" }), translate), undefined);
  assert.equal(instancePendingStatusLabel(instance({ status: "unhealthy", health: "degraded" }), translate), undefined);
  assert.equal(instancePendingStatusLabel(instance({ status: "created" }), translate), undefined);
  assert.equal(instancePendingStatusLabel(instance({ status: "starting", runtime: { id: "rt_1", type: "docker", status: "offline" } }), translate), undefined);
});

test("instance rows render pending copy instead of the source label", () => {
  const instanceList = read("apps/control-plane/instance-list/InstanceList.vue");
  assert.match(instanceList, /<small v-if="instanceRowStatus\(instance\)" class="instance-row-status">[\s\S]*?<LoaderCircle :size="11" aria-hidden="true" \/>[\s\S]*?<span>{{ instanceRowStatus\(instance\) }}<\/span>/);
  assert.match(instanceList, /<small v-else>{{ instanceSourceLabel\(instance, t\) }}<\/small>/);
  assert.match(instanceList, /return instancePendingStatusLabel\(instance, t\) \?\? props\.activeInstanceActionLabel\?\.\(instance\);/);
  assert.match(instanceList, /\.instance-row-main \.instance-row-status \{[\s\S]*?font-size: 12px;/);
  assert.match(instanceList, /\.instance-row-main \.instance-row-status svg \{[\s\S]*?animation: instance-pending-spin/);
  assert.match(instanceList, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.instance-row-main \.instance-row-status svg/);
});

test("row pending copy is wired to the in-flight instance action", () => {
  const instanceList = read("apps/control-plane/instance-list/InstanceList.vue");
  const workbench = read("apps/control-plane/ControlPlaneWorkbench.vue");
  const actions = read("apps/control-plane/useInstanceActions.ts");

  assert.match(instanceList, /activeInstanceActionLabel\?: \(instance: InstanceBoardItem\) => string \| undefined;/);
  assert.equal((instanceList.match(/@active-instance-action-label="activeInstanceActionLabel"|:active-instance-action-label="activeInstanceActionLabel"/g) || []).length, 1);
  assert.match(workbench, /<InstanceList[\s\S]*?:active-instance-action-label="activeInstanceActionLabel"/);
  assert.match(workbench, /const \{\n  activeActionLabel,\n  activeInstanceActionLabel,/);
  assert.match(actions, /function activeInstanceActionLabel\(instance: InstanceBoardItem\) \{\n    if \(activeInstanceActionId\.value !== instance\.id \|\| !activeInstanceAction\.value\) return undefined;\n    return t\(actionLoadingKeys\[activeInstanceAction\.value\]\);/);
  assert.match(actions, /return t\(actionLoadingKeys\[action\]\);/);
});
