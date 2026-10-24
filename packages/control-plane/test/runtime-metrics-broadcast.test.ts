import assert from "node:assert/strict";
import test from "node:test";
import type { InstanceResourceMetrics } from "@task-handoff/protocol/control-plane";
import { createThrottledResourceMetricsPublisher } from "../src/node-agent/runtime-metrics.ts";

test("resource metrics broadcasts are throttled per instance without delaying state changes", () => {
  let now = 0;
  const published: InstanceResourceMetrics[] = [];
  const publish = createThrottledResourceMetricsPublisher((metrics) => published.push(metrics), { now: () => now });

  assert.equal(publish(metrics("inst_one", "available")), true);
  now = 3_000;
  assert.equal(publish(metrics("inst_one", "available")), false);
  now = 9_999;
  assert.equal(publish(metrics("inst_one", "available")), false);
  now = 10_000;
  assert.equal(publish(metrics("inst_one", "available")), true);
  now = 10_500;
  assert.equal(publish(metrics("inst_one", "stopped")), true);
  now = 11_000;
  assert.equal(publish(metrics("inst_one", "available")), true);
  assert.deepEqual(published.map((entry) => entry.state), ["available", "available", "stopped", "available"]);
});

test("resource metrics throttling keeps independent clocks for each instance", () => {
  let now = 0;
  const published: string[] = [];
  const publish = createThrottledResourceMetricsPublisher((metrics) => published.push(metrics.instanceId), { now: () => now });

  assert.equal(publish(metrics("inst_one", "available")), true);
  assert.equal(publish(metrics("inst_two", "available")), true);
  now = 3_000;
  assert.equal(publish(metrics("inst_one", "available")), false);
  assert.equal(publish(metrics("inst_two", "available")), false);
  assert.deepEqual(published, ["inst_one", "inst_two"]);
});

function metrics(instanceId: string, state: InstanceResourceMetrics["state"]): InstanceResourceMetrics {
  return {
    instanceId,
    runtimeKind: "docker",
    state,
    sampledAt: new Date(0).toISOString(),
  };
}
