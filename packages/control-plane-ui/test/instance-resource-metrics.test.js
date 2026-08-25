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
  const eventInvalidation = read("src/apps/control-plane/eventInvalidation.ts");

  assert.match(workbench, /<InstanceDetail[\s\S]*?:resource-metrics="activeInstanceResourceMetrics"/);
  assert.match(workbench, /:resource-metrics-error="activeInstanceResourceMetricsError"/);
  assert.match(detail, /:resource-metrics="resourceMetrics"/);
  assert.match(preview, /translate\("sessions\.tabs\.cpu", \{ value: metrics\.cpu \? formatPercent/);
  assert.match(preview, /translate\("sessions\.tabs\.memory", \{ value: `\$\{formatBytes/);
  assert.match(preview, /translate\("sessions\.tabs\.resourcesStarting"\)/);
  assert.match(preview, /translate\("sessions\.tabs\.resourcesStale"\)/);
  assert.match(preview, /translate\("sessions\.tabs\.resourcesUnavailable"\)/);
  assert.match(workbench, /activeInstance\.value\?\.runtime\?\.type === "docker"/);
  assert.match(workbench, /if \(!currentIds\.has\(instanceId\)\) delete resourceMetricsByInstanceId\[instanceId\]/);
  assert.match(events, /InstanceResourceMetricsEventType\.Snapshot/);
  assert.match(events, /safeParseResponse\(InstanceResourceMetricsSchema/);
  assert.match(events, /event\.scope\?\.instanceId !== metrics\.data\.instanceId/);
  assert.match(events, /metricInstanceIds: toValue\(input\.resourceMetricInstanceIds \|\| \[\]\)/);
  assert.match(workbench, /resourceMetricEventInstanceIds = computed\(\(\) => activeInstance\.value\?\.runtime\?\.type === "docker" \? \[activeInstance\.value\.id\] : \[\]\)/);
  assert.match(workbench, /resourceMetricInstanceIds: resourceMetricEventInstanceIds/);
  assert.match(workbench, /watch\(\s*\[\s*\(\) => activeInstanceId\.value,[\s\S]*?\(\) => activeInstance\.value\?\.runtime\?\.containerName,\s*\],\s*\(\) => void loadActiveInstanceResourceMetrics\(\)/);
  assert.doesNotMatch(workbench, /watch\(\s*\(\) => \[\s*activeInstanceId\.value,[\s\S]*?loadActiveInstanceResourceMetrics/);
  assert.doesNotMatch(events, /input\.refresh/);
  assert.match(eventInvalidation, /topics\.has\("instances"\)\) domains\.push\("instances"\)/);
  assert.match(events, /controlPlaneDomainQueryKeys\(controlPlaneEventDomains\(events\)\)/);
  assert.match(events, /queueInvalidation\(\["control-plane-triggers"\]\)/);
});
