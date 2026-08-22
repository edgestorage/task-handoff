import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instanceList = readFileSync(new URL("../src/apps/control-plane/instance-list/InstanceList.vue", import.meta.url), "utf8");
const workbench = readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

test("node-grouped instance list consumes the authoritative node connection phase", () => {
  assert.match(workbench, /<InstanceList[\s\S]*?:nodes="nodes\.data\.value \|\| \[\]"/);
  assert.match(instanceList, /node\.connectionPhase === "connecting" \|\| node\.connectionPhase === "handshaking"/);
  assert.match(instanceList, /node\.connectionPhase === "reconnecting"/);
  assert.match(instanceList, /class="instance-group-status"/);
});

test("a connecting node has a visible group even before its instances respond", () => {
  assert.match(instanceList, /for \(const node of props\.nodes\)[\s\S]*?groups\.set\(node\.id,[\s\S]*?instances: \[\]/);
  assert.match(instanceList, /v-if="loading && !nodes\.length"/);
  assert.match(instanceList, /v-if="!instances\.length && !loading"/);
  assert.match(instanceList, /\.instance-group-status \{[\s\S]*?font-size: 12px/);
});

test("node fleet resources load independently after the node directory appears", () => {
  assert.match(instanceList, /instanceNodeStates = computed/);
  assert.match(instanceList, /phase === "uninitialized" \|\| phase === "loading"/);
  assert.match(instanceList, /v-if="loading && !nodes\.length"/);
  assert.match(instanceList, /v-if="hasPendingNodes && !groupByNode"[\s\S]*instances\.list\.nodesStillLoading/);
});
