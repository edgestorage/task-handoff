import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionTabs } from "../src/apps/control-plane/useInstanceSessions.ts";

function instance(status) {
  return {
    id: "inst_status_tabs",
    status,
    apps: {
      sessions: [{ id: "app_terminal", appId: "terminal-tty", kind: "tty", status: "running" }],
    },
    aiSessions: {
      sessions: [{ id: "ai_active", status: "running" }],
    },
  };
}

test("status lifecycle exposes only the Status tab", () => {
  assert.deepEqual(buildSessionTabs(instance("stopped")), [{
    key: "overview",
    label: "Status",
    status: "stopped",
    kind: "status",
  }]);
});

test("running lifecycle exposes session tabs without Status", () => {
  const tabs = buildSessionTabs(instance("running"));
  assert.deepEqual(tabs.map((tab) => tab.kind), ["ai", "terminal"]);
});
