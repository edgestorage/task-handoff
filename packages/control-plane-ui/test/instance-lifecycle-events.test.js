import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import { applyInstanceLifecycle } from "../src/apps/control-plane/instanceLifecycleCache.ts";

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
  };
}

test("instance lifecycle snapshots patch one board item and reject stale revisions", () => {
  const queryClient = new QueryClient();
  const target = boardInstance("inst_target", 1);
  const untouched = boardInstance("inst_other", 4, "running");
  queryClient.setQueryData(["instance-board"], [target, untouched]);
  queryClient.setQueryData(["instance-board-payload"], { data: [target, untouched], meta: { nodeErrors: [] } });

  assert.equal(applyInstanceLifecycle(queryClient, lifecycle(2, "starting")), true);
  const updated = queryClient.getQueryData(["instance-board"]);
  assert.equal(updated[0].status, "starting");
  assert.equal(updated[0].stateRevision, 2);
  assert.equal(updated[0].runtime.id, "runtime_local_docker", "node runtime projection must not be replaced by container runtime state");
  assert.equal(updated[1], untouched);
  assert.equal(queryClient.getQueryData(["instance-board-payload"]).data[0].status, "starting");

  assert.equal(applyInstanceLifecycle(queryClient, lifecycle(1, "failed")), true);
  assert.equal(queryClient.getQueryData(["instance-board"])[0].status, "starting");

  assert.equal(applyInstanceLifecycle(queryClient, { ...lifecycle(3, "registering"), connectionStatus: "online", accessStatus: "reachable" }), true);
  const registering = queryClient.getQueryData(["instance-board"])[0];
  assert.equal(registering.status, "registering");
  assert.equal(registering.access.status, "reachable");
});
