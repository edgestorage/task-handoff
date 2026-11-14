import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneRemoteDesktopApi } from "../src/remote-desktop.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const created = { data: { snapshot: { viewerSessionId: "rdv_1", sessionRevision: 1, phase: "starting", captureSelection: { sourceRef: "display" }, sessionExpiresAt: Date.now() + 60_000, idleExpiresAt: null, mediaPaused: false, reason: null }, signalUrl: "/signal", iceServers: [], iceCredentialsExpiresAt: null, ticketExpiresAt: Date.now() + 30_000, protocolVersion: "2026-11-11" } };
test("v0.0.51 missing options leaves session creation usable without additive wire fields", async () => {
  const bodies: any[] = [];
  const api = createControlPlaneRemoteDesktopApi({
    async request(_path, schema, init) {
      if (_path.endsWith("connection-options")) throw Object.assign(Error("missing"), { status: 404 });
      bodies.push(JSON.parse(String(init?.body))); return schema.parse(created);
    },
  } satisfies ControlPlaneClientTransport);
  assert.equal(await api.connectionOptions("inst"), null);
  await api.createSession("inst", { sourceRef: "display" }, "old-compatible");
  assert.deepEqual(bodies[0], { requestId: "old-compatible", selection: { sourceRef: "display" } });
  await api.createSession("inst", { sourceRef: "display" }, "custom-disabled", "none");
  assert.equal(bodies[1].turnSource, "none");
});
test("options ignore future fields while authorization and transient errors remain visible", async () => {
  let failure: Error | undefined;
  const api = createControlPlaneRemoteDesktopApi({
    async request(_path, schema) {
      if (failure) throw failure;
      return schema.parse({ data: { customTurn: { configured: true, future: 1 }, cloudTurn: { signedIn: true, available: false }, future: {} }, future: {} });
    },
  } satisfies ControlPlaneClientTransport);
  assert.deepEqual(await api.connectionOptions("inst"), { customTurn: { configured: true }, cloudTurn: { signedIn: true, available: false } });
  for (const status of [401, 403, 500]) {
    failure = Object.assign(Error("request failed"), { status });
    await assert.rejects(api.connectionOptions("inst"), { status });
  }
});
