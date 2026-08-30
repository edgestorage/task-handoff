import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import { controlPlaneQueryKeys } from "../src/api/queryKeys.ts";
import { removeInstanceTriggerBinding, upsertInstanceTriggerBinding } from "../src/apps/control-plane/instanceTriggerCache.ts";

const timestamp = "2026-08-27T13:18:47.000Z";

function instance(id) {
  return { id, triggers: { configs: [], recentRuns: [] } };
}

function mutation() {
  return {
    config: {
      configHash: "trg_0640cbcbb3653e9c9a0f0949",
      name: "test",
      source: { type: "schedule", scheduleKind: "interval", intervalMs: 3_600_000 },
      action: { promptTemplate: "continue" },
      policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    deployment: {
      configHash: "trg_0640cbcbb3653e9c9a0f0949",
      deploymentId: "deployment_1",
      instanceId: "inst_target",
      origin: "control-plane",
      enabled: true,
      target: { type: "ai-session", aiSessionId: "ais_target" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    runtime: {
      configHash: "trg_0640cbcbb3653e9c9a0f0949",
      deploymentId: "deployment_1",
      instanceId: "inst_target",
      status: "idle",
      runCount: 0,
      skippedCount: 0,
    },
  };
}

test("trigger mutations update global and scoped board caches idempotently", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(controlPlaneQueryKeys.instanceBoard, { data: [instance("inst_target")] });
  queryClient.setQueryData(controlPlaneQueryKeys.scopedInstanceBoard("inst_target"), { data: [instance("inst_target")] });

  upsertInstanceTriggerBinding(queryClient, "inst_target", mutation());
  upsertInstanceTriggerBinding(queryClient, "inst_target", mutation());

  for (const key of [controlPlaneQueryKeys.instanceBoard, controlPlaneQueryKeys.scopedInstanceBoard("inst_target")]) {
    const triggers = queryClient.getQueryData(key).data[0].triggers;
    assert.equal(triggers.configs.length, 1);
    assert.equal(triggers.configs[0].deployments.length, 1);
    assert.equal(triggers.configs[0].runtime.length, 1);
    assert.equal(triggers.updatedAt, timestamp);
  }
});

test("trigger removal deletes only the matching AI Session deployment", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(controlPlaneQueryKeys.instanceBoard, { data: [instance("inst_target")] });
  upsertInstanceTriggerBinding(queryClient, "inst_target", mutation());

  removeInstanceTriggerBinding(queryClient, "inst_target", "ais_target", mutation().config.configHash, "2026-08-27T13:18:48.000Z");

  const triggers = queryClient.getQueryData(controlPlaneQueryKeys.instanceBoard).data[0].triggers;
  assert.deepEqual(triggers.configs, []);
  assert.equal(triggers.updatedAt, "2026-08-27T13:18:48.000Z");
});
