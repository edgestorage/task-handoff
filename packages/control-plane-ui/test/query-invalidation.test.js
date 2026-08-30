import assert from "node:assert/strict";
import test from "node:test";

import { controlPlaneQueryKeys } from "../src/api/queryKeys.ts";
import {
  controlPlaneDomainQueryKeys,
  invalidateControlPlaneDomains,
} from "../src/api/queryInvalidation.ts";
import { controlPlaneEventDomains } from "../src/apps/control-plane/eventInvalidation.ts";

const key = (value) => JSON.stringify(value);

const expectedDomains = {
  projects: [
    controlPlaneQueryKeys.projects,
    controlPlaneQueryKeys.instanceBoard,
  ],
  images: [
    controlPlaneQueryKeys.images,
    controlPlaneQueryKeys.imageOptions,
    controlPlaneQueryKeys.nodeImageCatalog(),
    controlPlaneQueryKeys.instanceBoard,
  ],
  market: [
    controlPlaneQueryKeys.marketCatalog,
    controlPlaneQueryKeys.imageOptions,
    controlPlaneQueryKeys.nodeImageCatalog(),
  ],
  models: [controlPlaneQueryKeys.models],
  nodeState: [controlPlaneQueryKeys.nodes],
  nodeTopology: [
    controlPlaneQueryKeys.nodes,
    controlPlaneQueryKeys.nodeRuntimes,
    controlPlaneQueryKeys.nodeLocalFolders(),
    controlPlaneQueryKeys.nodeImageCatalog(),
    controlPlaneQueryKeys.instanceBoard,
    controlPlaneQueryKeys.models,
  ],
  nodeRuntimeState: [
    controlPlaneQueryKeys.nodeRuntimes,
    controlPlaneQueryKeys.instanceBoard,
  ],
  nodeFolders: [controlPlaneQueryKeys.nodeLocalFolders()],
  controlPlaneProxy: [
    controlPlaneQueryKeys.controlPlaneProxyInvites,
    controlPlaneQueryKeys.controlPlaneProxyBindings,
    controlPlaneQueryKeys.controlPlaneProxyDiagnostics,
    controlPlaneQueryKeys.controlPlaneProxyPendingClaims,
  ],
  instances: [controlPlaneQueryKeys.instanceBoard, controlPlaneQueryKeys.instanceDirectory],
  chat: [controlPlaneQueryKeys.chatBridges, controlPlaneQueryKeys.chatStatus],
};

for (const [domain, expected] of Object.entries(expectedDomains)) {
  test(`${domain} invalidates its authoritative query projections`, () => {
    assert.deepEqual(controlPlaneDomainQueryKeys([domain]), expected);
  });
}

test("parameterized query factories expose domain prefixes when no id is provided", () => {
  assert.deepEqual(controlPlaneQueryKeys.nodeLocalFolders(), ["control-plane-node-local-folders"]);
  assert.deepEqual(controlPlaneQueryKeys.nodeImageCatalog(), ["node-image-catalog"]);
  assert.deepEqual(controlPlaneQueryKeys.nodeLocalFolders("node-1"), ["control-plane-node-local-folders", "node-1"]);
  assert.deepEqual(controlPlaneQueryKeys.nodeImageCatalog("node-1"), ["node-image-catalog", "node-1"]);
});

test("manual refresh covers every domain and manual-only query exactly once", () => {
  const actual = controlPlaneDomainQueryKeys(["manual"]);
  const expected = [
    controlPlaneQueryKeys.status,
    controlPlaneQueryKeys.settings,
    ...Object.values(expectedDomains).flat(),
  ];
  assert.deepEqual(new Set(actual.map(key)), new Set(expected.map(key)));
  assert.equal(actual.length, new Set(actual.map(key)).size);
});

test("combined domains invalidate overlapping query projections once", async () => {
  const invalidated = [];
  const queryClient = {
    invalidateQueries(options) {
      invalidated.push(options.queryKey);
      return Promise.resolve();
    },
  };

  await invalidateControlPlaneDomains(queryClient, ["projects", "images", "instances", "images"]);

  assert.deepEqual(invalidated, [
    controlPlaneQueryKeys.projects,
    controlPlaneQueryKeys.instanceBoard,
    controlPlaneQueryKeys.images,
    controlPlaneQueryKeys.imageOptions,
    controlPlaneQueryKeys.nodeImageCatalog(),
    controlPlaneQueryKeys.instanceDirectory,
  ]);
});

test("node.checked invalidates only Node state instead of the full topology", () => {
  assert.deepEqual(controlPlaneEventDomains([{ type: "node.checked", topic: "node.state" }]), ["nodeState"]);
  assert.deepEqual(
    controlPlaneDomainQueryKeys(controlPlaneEventDomains([{ type: "node.checked", topic: "node.state" }])),
    [controlPlaneQueryKeys.nodes],
  );
});

test("control-plane proxy events invalidate only proxy management projections", () => {
  assert.deepEqual(controlPlaneEventDomains([{ topic: "control-plane-proxy" }]), ["controlPlaneProxy"]);
  assert.deepEqual(
    controlPlaneDomainQueryKeys(controlPlaneEventDomains([{ topic: "control-plane-proxy" }])),
    expectedDomains.controlPlaneProxy,
  );
});

test("node joined events invalidate authoritative topology", () => {
  assert.deepEqual(controlPlaneEventDomains([{ type: "node.joined", topic: "nodes" }]), ["nodeTopology"]);
  assert.deepEqual(
    controlPlaneDomainQueryKeys(controlPlaneEventDomains([{ type: "node.joined", topic: "nodes" }])),
    expectedDomains.nodeTopology,
  );
});
