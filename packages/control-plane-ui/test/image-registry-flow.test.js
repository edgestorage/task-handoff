import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canShowInstanceAction, hasInstanceStatusPage, imageProvisioningLabel, instanceStatusDetail, instanceStatusTitle } from "../src/apps/control-plane/useInstanceStatus.ts";
import { dockerInstallGuidance, nodePlatform } from "../src/apps/control-plane/new-instance/dockerRuntimeGuidance.ts";
import { ImagePullTerminalEventType } from "@task-handoff/protocol/control-plane";
import { useImagePullProgress } from "../src/apps/control-plane/useImagePullProgress.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const t = createControlPlaneI18nForTest("en-US").global.t;

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
  const queryKeys = read("src/api/queryKeys.ts");
  assert.match(queries, /queryKey: computed\(\(\) => controlPlaneQueryKeys\.nodeImageCatalog\(resolvedNodeId\.value\)\)/);
  assert.match(queryKeys, /nodeImageCatalog: \(nodeId\?: string\)/);
  assert.match(queries, /enabled: computed\(\(\) => Boolean\(resolvedNodeId\.value\)\)/);
});

test("instance image phases have user-facing progress and retry only after failure", () => {
  assert.equal(imageProvisioningLabel(instance("checking-image"), t), "Checking image");
  assert.equal(imageProvisioningLabel(instance("pulling-image"), t), "Pulling image");
  assert.equal(imageProvisioningLabel({
    ...instance("pulling-image"),
    imagePullProgress: {
      instanceId: "inst_1",
      generation: 1,
      requestedReference: "docker.io/example/app:v1",
      sequence: 1,
      observedAt: new Date().toISOString(),
      status: "pulling",
      layers: { total: 12, completed: 7, downloaded: 1, downloading: 2, extracting: 1 },
      percent: 63,
      message: "7/12 layers ready · 63%",
    },
  }, t), "Pulling image · 7 / 12 ready · 63%");
  assert.equal(imageProvisioningLabel(instance("resolving-image"), t), "Resolving image digest");
  const failed = instance("failed");
  assert.equal(imageProvisioningLabel(failed, t), "Image provisioning failed");
  assert.equal(canShowInstanceAction(failed, "retry-image"), true);
  assert.equal(canShowInstanceAction(instance("pulling-image"), "retry-image"), false);
});

test("image pull UI state accepts raw TTY before the first summary and restores a reconnect snapshot", () => {
  const pulls = useImagePullProgress();
  const identity = {
    instanceId: "inst_stream",
    generation: 3,
    requestedReference: "docker.io/example/app:v1",
    sequence: 1,
    observedAt: new Date().toISOString(),
  };
  assert.equal(pulls.applyEvent(ImagePullTerminalEventType.Output, { ...identity, data: "live output\r\n" }), true);
  assert.match(pulls.state(identity.instanceId).terminalTail, /live output/);
  assert.equal(pulls.applyEvent(ImagePullTerminalEventType.Snapshot, {
    ...identity,
    sequence: 2,
    status: "pulling",
    layers: { total: 2, completed: 1, downloaded: 0, downloading: 1, extracting: 0 },
    message: "1/2 layers",
    terminalTail: "restored output\r\n",
  }), true);
  assert.equal(pulls.state(identity.instanceId).terminalTail, "restored output\r\n");
});

test("image pull UI drops diagnostics from an older provisioning generation", () => {
  const pulls = useImagePullProgress();
  const observedAt = new Date().toISOString();
  pulls.applyEvent(ImagePullTerminalEventType.Output, {
    instanceId: "inst_retry",
    generation: 3,
    requestedReference: "docker.io/example/app:v1",
    sequence: 1,
    observedAt,
    data: "failed pull\r\n",
  });
  pulls.reconcileLifecycle({
    instanceId: "inst_retry",
    revision: 2,
    updatedAt: observedAt,
    status: "provisioning",
    health: "unknown",
    connectionStatus: "unknown",
    accessStatus: "endpoint-unreachable",
    imageProvisioning: {
      phase: "checking-image",
      requestedReference: "docker.io/example/app:v1",
      generation: 4,
      startedAt: observedAt,
      updatedAt: observedAt,
    },
    workspace: { status: "pending" },
    runtime: { labels: {} },
  });
  assert.equal(pulls.state("inst_retry"), undefined);
});

test("instance status page exists for every lifecycle state except running", () => {
  const statuses = ["created", "provisioning", "starting", "registering", "registered", "running", "stopping", "stopped", "failed", "unhealthy"];
  for (const status of statuses) {
    const value = {
      status,
      connectionStatus: status === "running" ? "unknown" : "online",
    };
    assert.equal(hasInstanceStatusPage(value), status !== "running", status);
  }
  const sessions = read("src/apps/control-plane/useInstanceSessions.ts");
  const preview = [
    read("src/apps/control-plane/instance-detail/SessionPreview.vue"),
    read("src/apps/control-plane/instance-detail/SessionPaneContent.vue"),
  ].join("\n");
  assert.match(sessions, /if \(hasInstanceStatusPage\(instance\)\) \{[\s\S]*return \[\{[\s\S]*kind: "status"/);
  assert.match(sessions, /key: "overview"[\s\S]*kind: "status"/);
  assert.match(preview, /v-if="hasInstanceStatusPage\(instance\)"/);
  assert.match(preview, /<ImagePullStatus/);
  assert.doesNotMatch(read("src/apps/control-plane/instance-detail/InstanceDetail.vue"), /ImagePullStatus/);
  assert.doesNotMatch(preview, /v-if="instanceConnecting"/);
  const activeSessions = read("src/apps/control-plane/instance-detail/useActiveInstanceSessions.ts");
  assert.match(activeSessions, /hasInstanceStatusPage\(activeInstance\.value\) \? "overview" : sessionKey/);
});

test("instance status page describes terminal lifecycle states", () => {
  assert.equal(instanceStatusTitle(instance("ready", { status: "created" }), t), "Instance created");
  assert.equal(instanceStatusTitle(instance("ready", { status: "stopping" }), t), "Stopping instance");
  assert.equal(instanceStatusTitle(instance("ready", { status: "stopped" }), t), "Instance stopped");
  assert.equal(instanceStatusTitle(instance("failed", { status: "failed" }), t), "Image preparation failed");
  assert.equal(instanceStatusTitle(instance("ready", { status: "unhealthy" }), t), "Instance unhealthy");
  const pulling = instance("pulling-image", {
    status: "starting",
    imagePullProgress: {
      instanceId: "inst_image",
      generation: 1,
      requestedReference: "docker.io/example/app:v1",
      sequence: 1,
      observedAt: new Date().toISOString(),
      status: "pulling",
      layers: { total: 21, completed: 1, downloaded: 4, downloading: 4, extracting: 0 },
      message: "1/21 layers ready",
    },
  });
  assert.equal(instanceStatusTitle(pulling, t), "Preparing instance");
  assert.equal(instanceStatusDetail(pulling, t), "The Docker image is being prepared before the container can start.");
});

test("registry profiles remain selectable for pull-required and unknown nodes", () => {
  const runtimeStep = read("src/apps/control-plane/new-instance/RuntimeStep.vue");
  assert.match(runtimeStep, /image\.origin === "market"/);
  assert.match(runtimeStep, /image\.origin === "custom"/);
  assert.match(runtimeStep, /v-for="image in group\.images"/);
  assert.match(runtimeStep, /@click="selectImage\(image\.id\)"/);
  assert.match(runtimeStep, /instances\.create\.availability\.available/);
  assert.match(runtimeStep, /instances\.create\.availability\.pullRequired/);
  assert.match(runtimeStep, /instances\.create\.availability\.unknown/);
  assert.doesNotMatch(runtimeStep, /:disabled="[^\"]*availability/);
});

test("Docker runtime creation guidance follows the selected node platform", () => {
  assert.equal(nodePlatform({ capabilities: { agent: { platform: "darwin" } } }), "darwin");
  assert.equal(nodePlatform({ capabilities: {} }), "unknown");
  assert.deepEqual(dockerInstallGuidance("darwin"), {
    kind: "mac",
    url: "https://orbstack.dev/download",
  });
  assert.match(dockerInstallGuidance("win32").url, /docker\.com\/desktop\/setup\/install\/windows-install/);
  assert.match(dockerInstallGuidance("linux").url, /docker\.com\/engine\/install/);

  const modal = read("src/apps/control-plane/NewInstanceModal.vue");
  const runtimeStep = read("src/apps/control-plane/new-instance/RuntimeStep.vue");
  assert.match(modal, /checkNodeRuntime/);
  assert.match(modal, /instances\.create\.blocked\.dockerUnavailable/);
  assert.match(modal, /created\.startOutcome\.status === "failed"/);
  assert.match(modal, /instances\.create\.feedback\.createdButStartFailed/);
  assert.match(runtimeStep, /instances\.create\.docker\.retry/);
});

test("image settings use registry creation and server-owned deletion conflicts", () => {
  const settings = read("src/apps/control-plane/settings/useImageSettings.ts");
  const section = read("src/apps/control-plane/settings/ImageSettingsSection.vue");
  assert.match(settings, /reference: settingsImage\.reference\.trim\(\)/);
  assert.match(settings, /pullPolicy: "if-not-present"/);
  assert.match(settings, /await deleteImage\(image\.id\)/);
  assert.doesNotMatch(settings, /imageInUse/);
  assert.doesNotMatch(settings, /window\.confirm/);
  assert.match(section, /useNodeImageAvailabilityQuery\(nodeId\)/);
  assert.match(section, /settings\.imageRegistry\.reference/);
  assert.match(section, /class="image-toolbar"/);
  assert.match(section, /class="image-directory"/);
  assert.match(section, /<AlertDialog :open="Boolean\(deleteTarget\)"/);
});

test("environment templates use the shared filtered directory pattern", () => {
  const section = read("src/apps/control-plane/settings/EnvironmentTemplatesSettings.vue");
  assert.match(section, /class="environment-template-toolbar"/);
  assert.match(section, /class="environment-template-directory"/);
  assert.match(section, /v-for="template in filteredTemplates"/);
  assert.match(section, /<DropdownMenu>[\s\S]*<DropdownMenuContent align="end"/);
  assert.match(section, /<AlertDialog :open="Boolean\(deleteTarget\)"/);
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
