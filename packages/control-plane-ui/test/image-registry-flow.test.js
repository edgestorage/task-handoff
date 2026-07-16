import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canShowInstanceAction, imageProvisioningLabel } from "../src/apps/control-plane/useInstanceStatus.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function instance(phase, overrides = {}) {
  return {
    id: "inst_image",
    name: "Image instance",
    status: phase === "failed" ? "failed" : "provisioning",
    connectionStatus: "unknown",
    access: { status: "unknown" },
    imageProvisioning: {
      phase,
      requestedReference: "docker.io/example/app:v1",
      generation: 0,
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("node image availability queries are isolated by node id", () => {
  const queries = read("src/api/queries.ts");
  assert.match(queries, /queryKey: computed\(\(\) => \["node-image-catalog", resolvedNodeId\.value\]\)/);
  assert.match(queries, /enabled: computed\(\(\) => Boolean\(resolvedNodeId\.value\)\)/);
});

test("instance image phases have user-facing progress and retry only after failure", () => {
  assert.equal(imageProvisioningLabel(instance("checking-image")), "Checking image");
  assert.equal(imageProvisioningLabel(instance("pulling-image")), "Pulling image");
  assert.equal(imageProvisioningLabel(instance("resolving-image")), "Resolving image digest");
  const failed = instance("failed");
  assert.equal(imageProvisioningLabel(failed), "Image provisioning failed");
  assert.equal(canShowInstanceAction(failed, "retry-image"), true);
  assert.equal(canShowInstanceAction(instance("pulling-image"), "retry-image"), false);
});

test("registry profiles remain selectable for pull-required and unknown nodes", () => {
  const runtimeStep = read("src/apps/control-plane/new-instance/RuntimeStep.vue");
  assert.match(runtimeStep, /v-for="image in images"/);
  assert.match(runtimeStep, /status === "available" \? "Available" : status === "pull-required" \? "Will be pulled" : "Availability unknown"/);
  assert.doesNotMatch(runtimeStep, /:disabled="[^\"]*availability/);
});

test("image settings use registry creation and server-owned deletion conflicts", () => {
  const settings = read("src/apps/control-plane/settings/useImageSettings.ts");
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /reference: settingsImage\.reference\.trim\(\)/);
  assert.match(settings, /pullPolicy: "if-not-present"/);
  assert.match(settings, /await deleteImage\(image\.id\)/);
  assert.doesNotMatch(settings, /imageInUse/);
  assert.match(modal, /useNodeImageAvailabilityQuery\(\(\) => imageCatalogNodeId\.value\)/);
  assert.match(modal, /Image reference/);
});

test("instance list, board, and detail expose image failure retry", () => {
  for (const file of [
    "src/apps/control-plane/instance-list/InstanceList.vue",
    "src/apps/control-plane/board/InstanceBoardView.vue",
    "src/apps/control-plane/instance-detail/InstanceDetail.vue",
  ]) {
    const source = read(file);
    assert.match(source, /imageProvisioning/);
    assert.match(source, /retry-image/);
  }
});
