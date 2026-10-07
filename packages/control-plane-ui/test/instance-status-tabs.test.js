import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSessionTabs } from "../src/apps/control-plane/useInstanceSessions.ts";
import { canShowInstanceAction, hasInstanceStatusPage, instanceRuntimeUnavailableLabel, instanceStatusDetail, instanceStatusTitle, isInstanceRuntimeUnavailable, isInstanceStatusPending } from "../src/apps/control-plane/useInstanceStatus.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const t = (key) => ({ "sessions.tabs.status": "Status", "sessions.title": "AI Sessions" })[key] || key;
const source = (path) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

function instance(status, runtimePhase) {
  return {
    id: "inst_status_tabs",
    status,
    runtimeVersion: runtimePhase ? {
      desiredVersion: "0.0.1",
      actualVersion: "0.0.1",
      phase: runtimePhase,
    } : undefined,
    apps: {
      sessions: [{ id: "app_terminal", appId: "terminal-tty", kind: "tty", status: "running" }],
    },
    aiSessions: {
      sessions: [{ id: "ai_active", status: "running" }],
    },
  };
}

test("status lifecycle exposes only the Status tab", () => {
  assert.deepEqual(buildSessionTabs(instance("stopped"), t), [{
    key: "overview",
    label: "Status",
    status: "stopped",
    kind: "status",
  }]);
});

test("status page exposes the lifecycle actions in the active pane", () => {
  const pane = source("apps/control-plane/instance-detail/SessionPaneContent.vue");
  const preview = source("apps/control-plane/instance-detail/SessionPreview.vue");
  const detail = source("apps/control-plane/instance-detail/InstanceDetail.vue");

  assert.match(pane, /canShowInstanceAction\(instance, 'start'\)[\s\S]*\$emit\('runAction', 'start', instance\)/);
  assert.match(pane, /canShowInstanceAction\(instance, 'retry-image'\)[\s\S]*\$emit\('runAction', 'retry-image', instance\)/);
  assert.match(pane, /class="session-status-overview"[\s\S]*?class="session-status-image-retry"[\s\S]*?\$emit\('runAction', 'retry-image', instance\)[\s\S]*?<\/div>\s*<ol class="image-preparation-steps"/);
  assert.match(preview, /@run-action="\(action, target\) => \$emit\('runAction', action, target\)"/);
  assert.match(detail, /@run-action="\(action, target\) => \$emit\('runAction', action, target\)"/);
});

test("running lifecycle exposes session tabs without Status", () => {
  const tabs = buildSessionTabs(instance("running"), t);
  assert.deepEqual(tabs.map((tab) => tab.kind), ["ai", "terminal"]);
});

test("active runtime convergence exposes the Status tab for a running instance", () => {
  for (const phase of ["draining", "installing", "restarting", "verifying"]) {
    const current = instance("running", phase);
    assert.equal(hasInstanceStatusPage(current), true, phase);
    assert.equal(isInstanceStatusPending(current), true, phase);
    assert.deepEqual(buildSessionTabs(current, t), [{
      key: "overview",
      label: "Status",
      status: "running",
      kind: "status",
    }], phase);
  }
});

test("non-active runtime convergence phases do not replace usable instance sessions", () => {
  for (const phase of ["pending", "matched", "failed"]) {
    const current = instance("running", phase);
    assert.equal(hasInstanceStatusPage(current), false, phase);
    assert.deepEqual(buildSessionTabs(current, t).map((tab) => tab.kind), ["ai", "terminal"], phase);
  }
});

test("runtime convergence Status page describes every active phase", () => {
  const translate = createControlPlaneI18nForTest("en-US").global.t;
  const details = {
    draining: /Stopping active processes/,
    installing: /Installing the new instance runtime/,
    restarting: /Restarting instance services/,
    verifying: /Verifying the runtime version and health/,
  };

  for (const [phase, expectedDetail] of Object.entries(details)) {
    const current = instance("running", phase);
    assert.equal(instanceStatusTitle(current, translate), "Updating instance runtime");
    assert.match(instanceStatusDetail(current, translate), expectedDetail, phase);
  }
});

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

test("failed start shows the recorded workspace reason instead of generic copy", () => {
  const reason = "Managed volume task-handoff-inst_status_tabs-workspace identity does not match instance inst_status_tabs.";
  const current = {
    ...instance("failed"),
    workspace: {
      mode: "git-clone",
      status: "ready",
      path: "/workspace",
      error: reason,
      gitProvisioning: { phase: "ready", generation: 0, remoteUrl: "https://git.example.test/team/repo.git" },
    },
  };
  assert.equal(instanceStatusDetail(current, english), reason);
  assert.equal(instanceStatusDetail(current, chinese), reason);
});

test("failed Git provisioning still prefers its own reason over the workspace error", () => {
  const current = {
    ...instance("failed"),
    workspace: {
      mode: "git-clone",
      status: "failed",
      path: "/workspace",
      error: "workspace fallback",
      gitProvisioning: { phase: "failed", generation: 0, remoteUrl: "https://git.example.test/team/repo.git", error: "Git clone failed" },
    },
  };
  assert.equal(instanceStatusDetail(current, english), "Git clone failed");
});

function dockerInstance(runtimeStatus, overrides = {}) {
  return {
    ...instance("running"),
    runtime: {
      id: "runtime_local_docker",
      nodeId: "node_local",
      name: "Local Docker",
      type: "docker",
      status: runtimeStatus,
      accessStrategy: "direct-port",
      capabilities: runtimeStatus === "offline"
        ? { daemon: { status: "offline", error: "dial unix docker.sock: connect: no such file or directory" } }
        : { daemon: { status: "online" } },
      labels: {},
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("an offline node runtime reports the runtime instead of pending instance work", () => {
  const current = dockerInstance("offline");
  assert.equal(isInstanceRuntimeUnavailable(current), true);
  assert.equal(isInstanceStatusPending(current), false);
  assert.equal(hasInstanceStatusPage(current), true);
  assert.equal(instanceStatusTitle(current, english), "Docker is not running");
  assert.equal(instanceStatusTitle(current, chinese), "Docker 未运行");
  assert.equal(instanceRuntimeUnavailableLabel(current, chinese), "Docker 未运行");
  assert.match(instanceStatusDetail(current, english), /not running on the node/);
  assert.match(instanceStatusDetail(current, english), /no such file or directory/);
  assert.match(instanceStatusDetail(current, chinese), /实例会自动恢复/);
  assert.match(instanceStatusDetail(current, chinese), /节点上的 Docker\/OrbStack 未运行/);

  // Lifecycle controls need the base runtime; only deletion stays available.
  assert.equal(canShowInstanceAction(current, "start"), false);
  assert.equal(canShowInstanceAction(current, "restart"), false);
  assert.equal(canShowInstanceAction(current, "delete"), true);
});

test("a stopped instance keeps its own lifecycle and an online runtime stays untouched", () => {
  const stopped = dockerInstance("offline", { status: "stopped" });
  assert.equal(isInstanceRuntimeUnavailable(stopped), false);
  assert.equal(instanceStatusTitle(stopped, english), "Instance stopped");

  const online = dockerInstance("online");
  assert.equal(isInstanceRuntimeUnavailable(online), false);
  assert.equal(isInstanceStatusPending(online), false);
  assert.equal(hasInstanceStatusPage(online), false);
  assert.equal(canShowInstanceAction(online, "restart"), true);
});
