import assert from "node:assert/strict";
import test from "node:test";

import { AppAccessService } from "../src/control-plane/instances/app-access-service.ts";
import { vncAccessFrameUrl } from "../src/control-plane/http/instance-proxy-routes.ts";

const now = "2026-08-08T00:00:00.000Z";

function snapshot(session) {
  return {
    instances: [{
      instanceId: "instance-1",
      appSessions: { runningCount: 1, problemCount: 0, sessions: [session], updatedAt: now },
    }],
  };
}

test("app access service derives a scoped VNC lease and revokes it", async () => {
  const service = new AppAccessService({
    requireInstance: async () => ({ id: "instance-1" }),
    listAppSessions: async () => snapshot({ id: "gui-1", kind: "gui", status: "running" }),
  });
  const access = await service.createSessionToken({ instanceId: "instance-1", sessionId: "gui-1" });
  assert.equal(access.mode, "vnc");
  assert.equal((await service.proxyTarget(access.token, "vnc")).path, "/api/apps/sessions/gui-1/web/");
  service.revokeToken(access.token, { instanceId: "instance-1", sessionId: "gui-1" });
  await assert.rejects(() => service.proxyTarget(access.token, "vnc"), { code: "APP_ACCESS_TOKEN_INVALID" });
});

test("app access service rejects non-GUI, stopped, and mismatched sessions", async () => {
  const tty = new AppAccessService({
    requireInstance: async () => ({ id: "instance-1" }),
    listAppSessions: async () => snapshot({ id: "tty-1", kind: "tty", status: "running" }),
  });
  await assert.rejects(() => tty.createSessionToken({ instanceId: "instance-1", sessionId: "tty-1" }), { code: "APP_SESSION_ACCESS_UNAVAILABLE" });

  const stopped = new AppAccessService({
    requireInstance: async () => ({ id: "instance-1" }),
    listAppSessions: async () => snapshot({ id: "gui-1", kind: "gui", status: "stopped" }),
  });
  await assert.rejects(() => stopped.createSessionToken({ instanceId: "instance-1", sessionId: "gui-1" }), { code: "APP_SESSION_NOT_RUNNING" });

  const access = tty.createToken({ instanceId: "instance-1", sessionId: "tty-1", mode: "tty" });
  assert.throws(() => tty.revokeToken(access.token, { instanceId: "other", sessionId: "tty-1" }), { code: "APP_ACCESS_TOKEN_INVALID" });
});

test("VNC frame URLs retain the lease in the proxy path for relative resources and websockets", () => {
  assert.equal(
    vncAccessFrameUrl("lease_token", "gui/session", { vnc: { backend: "kasmvnc" } }),
    "/apps/access/vnc/lease_token/proxy/api/apps/sessions/gui%2Fsession/web/",
  );
  const noVnc = new URL(vncAccessFrameUrl("lease_token", "gui/session", {}), "https://control.example.test");
  assert.equal(noVnc.pathname, "/apps/access/vnc/lease_token/proxy/api/novnc/vnc.html");
  assert.equal(noVnc.searchParams.get("path"), "apps/access/vnc/lease_token/proxy/api/apps/sessions/gui%2Fsession/vnc");
});
