import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlledInstanceSchema,
  NodeSchema,
  type ControlledInstance,
  type Node,
} from "@task-handoff/protocol/control-plane";
import { InstanceBoardReader } from "../src/control-plane/instances/board-reader.ts";
import { publicInstanceDirectory } from "../src/control-plane/public-records.ts";

const timestamp = "2026-10-29T00:00:00.000Z";

function node(overrides: Record<string, unknown> = {}): Node {
  return NodeSchema.parse({
    id: "node_paused",
    name: "Paused node",
    connectionMode: "direct-http",
    connectionPath: { kind: "direct" },
    connectionEnabled: true,
    status: "online",
    health: "ok",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function instance(overrides: Record<string, unknown> = {}): ControlledInstance {
  return ControlledInstanceSchema.parse({
    id: "inst_paused_node",
    name: "Running on paused node",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_paused",
    runtimeId: "runtime_paused",
    runtime: { labels: {} },
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    ready: true,
    access: { strategy: "control-plane-proxy", status: "reachable" },
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function board(nodeRecord: Node, instanceRecord = instance()) {
  return new InstanceBoardReader().read({
    projects: [],
    images: [],
    nodes: [nodeRecord],
    runtimes: [],
    instances: [instanceRecord],
  }).items[0]!;
}

test("paused nodes project cached running instances as unavailable without rewriting lifecycle", () => {
  const item = board(node({ connectionEnabled: false }));

  assert.equal(item.status, "running");
  assert.equal(item.connectionStatus, "offline");
  assert.equal(item.ready, false);
  assert.equal(item.access.status, "endpoint-unreachable");
  assert.equal(item.node?.connectionEnabled, false);

  const directory = publicInstanceDirectory(item);
  assert.equal(directory.status, "running");
  assert.equal(directory.connectionStatus, "offline");
  assert.equal(directory.ready, false);
  assert.deepEqual(directory.availableActions, []);
});

test("reconnecting a node restores the instance connection projection and actions", () => {
  const item = board(node());

  assert.equal(item.connectionStatus, "online");
  assert.equal(item.ready, true);
  assert.equal(item.access.status, "reachable");
  assert.deepEqual(publicInstanceDirectory(item).availableActions, ["stop", "restart"]);
});
