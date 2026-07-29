import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSessionTabs } from "../src/apps/control-plane/useInstanceSessions.ts";
import { hasInstanceStatusPage, instanceStatusDetail, instanceStatusTitle, isInstanceStatusPending } from "../src/apps/control-plane/useInstanceStatus.ts";
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
