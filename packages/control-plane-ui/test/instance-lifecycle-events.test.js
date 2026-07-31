import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import { mergeInstanceBoardPayload } from "../src/api/instanceBoardMerge.ts";
import { applyInstanceLifecycle } from "../src/apps/control-plane/instanceLifecycleCache.ts";
import { controlPlaneQueryKeys } from "../src/api/queryKeys.ts";

function boardInstance(id, revision, status = "created") {
  return {
    id,
    stateRevision: revision,
    status,
    health: "unknown",
    connectionStatus: "unknown",
    imageProvisioning: undefined,
    workspace: { status: "unknown" },
    access: { strategy: "control-plane-proxy", status: "endpoint-unreachable" },
    runtime: { id: "runtime_local_docker", type: "docker" },
    ready: false,
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}

function lifecycle(revision, status) {
  return {
    instanceId: "inst_target",
    revision,
    updatedAt: `2026-07-25T00:00:0${revision}.000Z`,
    status,
    health: "unknown",
    connectionStatus: status === "registering" ? "online" : "unknown",
    accessStatus: status === "registering" ? "reachable" : "endpoint-unreachable",
    workspace: { status: "pending" },
    runtime: { containerId: `container-${revision}`, labels: {} },
    ready: status === "running",
  };
}

function runtimeVersion(phase) {
  return {
    desiredVersion: "0.0.1",
    actualVersion: "0.0.1",
    phase,
    attempt: 1,
  };
}

test("instance lifecycle snapshots patch one board item and reject stale revisions", () => {
  const queryClient = new QueryClient();
  const target = boardInstance("inst_target", 1);
  const untouched = boardInstance("inst_other", 4, "running");
  const meta = { nodeErrors: [{ nodeId: "node_offline", code: "OFFLINE", message: "offline", route: "/instances", method: "GET" }] };
  queryClient.setQueryData(controlPlaneQueryKeys.instanceBoard, { data: [target, untouched], meta });

  assert.equal(applyInstanceLifecycle(queryClient, lifecycle(2, "starting")), true);
  const updated = queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard);
  assert.equal(updated.data[0].status, "starting");
  assert.equal(updated.data[0].stateRevision, 2);
  assert.equal(updated.data[0].runtime.id, "runtime_local_docker", "node runtime projection must not be replaced by container runtime state");
  assert.equal(updated.data[1], untouched);
  assert.equal(updated.meta, meta, "lifecycle patches must preserve board diagnostics metadata");

  assert.equal(applyInstanceLifecycle(queryClient, lifecycle(1, "failed")), true);
  assert.equal(queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard).data[0].status, "starting");

  assert.equal(applyInstanceLifecycle(queryClient, { ...lifecycle(3, "registering"), connectionStatus: "online", accessStatus: "reachable" }), true);
  const registering = queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard).data[0];
  assert.equal(registering.status, "registering");
  assert.equal(registering.access.status, "reachable");
  assert.equal(registering.ready, false);
});

test("instance lifecycle snapshots converge runtime upgrade phases in the authoritative board cache", () => {
  const queryClient = new QueryClient();
  const target = {
    ...boardInstance("inst_target", 1, "running"),
    runtimeVersion: runtimeVersion("installing"),
  };
  queryClient.setQueryData(controlPlaneQueryKeys.instanceBoard, { data: [target], meta: { nodeErrors: [] } });

  assert.equal(applyInstanceLifecycle(queryClient, {
    ...lifecycle(2, "running"),
    runtimeVersion: runtimeVersion("restarting"),
  }), true);
  assert.equal(queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard).data[0].runtimeVersion.phase, "restarting");

  assert.equal(applyInstanceLifecycle(queryClient, {
    ...lifecycle(3, "running"),
    runtimeVersion: runtimeVersion("matched"),
  }), true);
  assert.equal(queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard).data[0].runtimeVersion.phase, "matched");

  assert.equal(applyInstanceLifecycle(queryClient, {
    ...lifecycle(4, "running"),
    runtimeVersion: undefined,
  }), true);
  assert.equal(queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard).data[0].runtimeVersion, undefined);
});

test("an in-flight stale board response cannot overwrite a newer lifecycle revision", async () => {
  const queryClient = new QueryClient();
  let resolveBoard;
  const boardResponse = new Promise((resolve) => {
    resolveBoard = resolve;
  });
  const target = boardInstance("inst_target", 1, "running");
  target.project = { id: "project_old", name: "Old project" };
  target.node = { id: "node_old", name: "Old node" };
  target.runtime = { id: "runtime_old", name: "Old runtime", type: "docker" };
  target.heartbeatAgeMs = 900;
  target.triggers = { configs: [], recentRuns: [{ id: "trigger_old" }], updatedAt: "2026-07-25T00:00:00.000Z" };
  const untouched = boardInstance("inst_other", 4, "running");

  const fetch = queryClient.fetchQuery({
    queryKey: controlPlaneQueryKeys.instanceBoard,
    queryFn: () => boardResponse,
    structuralSharing: mergeInstanceBoardPayload,
  });
  queryClient.setQueryData(controlPlaneQueryKeys.instanceBoard, {
    data: [target, untouched],
    meta: { nodeErrors: [] },
  });
  assert.equal(applyInstanceLifecycle(queryClient, lifecycle(2, "stopped")), true);

  const added = boardInstance("inst_added", 1, "created");
  const incomingTarget = {
    ...target,
    project: { id: "project_new", name: "New project" },
    node: { id: "node_new", name: "New node" },
    runtime: { id: "runtime_new", name: "New runtime", type: "docker" },
    heartbeatAgeMs: 10,
    triggers: { configs: [], recentRuns: [{ id: "trigger_new" }], updatedAt: "2026-07-25T00:00:02.000Z" },
    access: { ...target.access, strategy: "direct-port", web: "http://new.example" },
  };
  resolveBoard({
    data: [incomingTarget, untouched, added],
    meta: { nodeErrors: [{ nodeId: "node_slow", code: "TIMEOUT", message: "timeout", route: "/instances", method: "GET" }] },
  });
  await fetch;

  const updated = queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard);
  assert.equal(updated.data[0].stateRevision, 2);
  assert.equal(updated.data[0].status, "stopped");
  assert.equal(updated.data[0].project.name, "New project");
  assert.equal(updated.data[0].node.name, "New node");
  assert.equal(updated.data[0].runtime.name, "New runtime");
  assert.equal(updated.data[0].heartbeatAgeMs, 10);
  assert.equal(updated.data[0].triggers.recentRuns[0].id, "trigger_new");
  assert.equal(updated.data[0].access.strategy, "direct-port");
  assert.equal(updated.data[0].access.status, "endpoint-unreachable");
  assert.equal(updated.data[1], untouched, "unchanged instances should retain structural sharing");
  assert.equal(updated.data[2].id, "inst_added", "HTTP remains authoritative for board membership");
  assert.equal(updated.meta.nodeErrors[0].nodeId, "node_slow", "HTTP diagnostics should still refresh");
});

test("board HTTP merge accepts newer revisions and authoritative removals", () => {
  const previous = {
    data: [boardInstance("inst_target", 2, "stopped"), boardInstance("inst_removed", 3, "running")],
    meta: { nodeErrors: [] },
  };
  const incoming = {
    data: [boardInstance("inst_target", 3, "running")],
    meta: { nodeErrors: [] },
  };

  const merged = mergeInstanceBoardPayload(previous, incoming);
  assert.equal(merged.data.length, 1);
  assert.equal(merged.data[0].stateRevision, 3);
  assert.equal(merged.data[0].status, "running");
});
