import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("instance detail consumes resource snapshots in the existing footer", () => {
  const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const preview = read("src/apps/control-plane/instance-detail/SessionPreview.vue");
  const events = read("src/apps/control-plane/useControlPlaneEvents.ts");

  assert.match(workbench, /<InstanceDetail[\s\S]*?:resource-metrics="activeInstanceResourceMetrics"/);
  assert.match(workbench, /:resource-metrics-error="activeInstanceResourceMetricsError"/);
  assert.match(detail, /:resource-metrics="resourceMetrics"/);
  assert.match(preview, /CPU \$\{formatPercent/);
  assert.match(preview, /Memory \$\{formatBytes/);
  assert.match(preview, /Resources starting/);
  assert.match(preview, /Resources stale/);
  assert.match(preview, /Resources unavailable/);
  assert.match(workbench, /activeInstance\.value\?\.runtime\?\.type === "docker"/);
  assert.match(workbench, /if \(!currentIds\.has\(instanceId\)\) delete resourceMetricsByInstanceId\[instanceId\]/);
  assert.match(events, /InstanceResourceMetricsEventType\.Snapshot/);
  assert.match(events, /InstanceResourceMetricsSchema\.safeParse/);
  assert.match(events, /event\.scope\?\.instanceId !== metrics\.data\.instanceId/);
  assert.doesNotMatch(events, /input\.refresh/);
  assert.match(events, /queueInvalidation\(\["instance-board"\]\)/);
  assert.match(events, /queueInvalidation\(\["control-plane-triggers"\]\)/);
});
