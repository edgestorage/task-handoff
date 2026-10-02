import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneAdminApi } from "../src/control-plane-admin.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const TS = "2026-10-02T00:00:00.000Z";

function settings(overrides: Record<string, unknown> = {}) {
  return { updateChannel: "stable", mentionTrigger: "@", commandTrigger: "/", diagnosticLogs: false, ...overrides };
}

function cloud(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    serviceOrigin: "https://cloud.example.com",
    status: "active",
    remoteAccessEnabled: true,
    updatedAt: TS,
    identity: { controlPlaneId: "cp_1", algorithm: "Ed25519", publicKey: "key", fingerprint: "sha256:fp" },
    hasBackgroundCredential: true,
    ...overrides,
  };
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: "cpi_1",
    targetNodeId: "nod_1",
    status: "active",
    createdBy: "usr_1",
    expiresAt: TS,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function fixture(respond: (path: string, init?: RequestInit) => unknown) {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse(respond(path, init));
    },
  };
  return { api: createControlPlaneAdminApi(transport), requests };
}

test("control-plane admin status and settings routes", async () => {
  const { api, requests } = fixture((path, init) => {
    if (path === "/api/control-plane/status") return { data: { protocolVersion: "2026-10-02", storage: { dataDir: "/data" } } };
    if (init?.method === "PATCH") return { data: settings({ diagnosticLogs: true }) };
    return { data: settings() };
  });

  const status = await api.status();
  assert.equal(status.protocolVersion, "2026-10-02");
  const current = await api.getSettings();
  assert.equal(current.commandTrigger, "/");
  const updated = await api.updateSettings({ diagnosticLogs: true });
  assert.equal(updated.diagnosticLogs, true);

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/control-plane/status", undefined],
    ["/api/control-plane/settings", undefined],
    ["/api/control-plane/settings", "PATCH"],
  ]);
});

test("control-plane admin cloud routes", async () => {
  const { api, requests } = fixture((path) => {
    if (path.endsWith("/challenges")) {
      return {
        data: {
          challengeCode: "code",
          authorizationUrl: "https://cloud.example.com/authorize",
          payload: { controlPlaneId: "cp_1", publicKeyFingerprint: "sha256:fp", expiresAt: TS },
          signature: "sig",
        },
      };
    }
    return { data: cloud() };
  });

  await api.cloudConnectivity();
  const challenge = await api.createCloudChallenge();
  assert.equal(challenge.challengeCode, "code");
  await api.setCloudRemoteAccess(false);
  await api.disconnectCloud();

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/cloud-connectivity", undefined],
    ["/api/cloud-connectivity/challenges", "POST"],
    ["/api/cloud-connectivity/remote-access", "POST"],
    ["/api/cloud-connectivity/disconnect", "POST"],
  ]);
});

test("control-plane admin proxy routes", async () => {
  const binding = {
    id: "cpb_1",
    claimId: "cpc_1",
    sourceControlPlaneId: "cp_2",
    targetNodeId: "nod_1",
    bindingKeyId: "key_1",
    status: "active",
    revision: 1,
    createdAt: TS,
    updatedAt: TS,
  };
  const claim = {
    id: "cpc_1",
    claimId: "cpc_1",
    proxyOrigin: "https://proxy.example.com",
    sourceControlPlaneId: "cp_2",
    bindingKeyId: "key_1",
    status: "pending",
    createdAt: TS,
    updatedAt: TS,
    expiresAt: TS,
  };
  const { api, requests } = fixture((path, init) => {
    if (path.endsWith("/diagnostics")) return { data: [{ bindingId: "cpb_1", activeHttp: 0, activeStreams: 0, activeWebSockets: 0 }] };
    if (path.endsWith("/pending-claims")) return { data: [claim] };
    if (path.includes("/pending-claims/")) return { data: { ok: true } };
    if (path.endsWith("/invites")) return { data: init?.method === "POST" ? { invite: invite(), token: "t".repeat(24), proxyOrigin: "https://proxy.example.com", protocolVersion: "2026-10-02" } : [invite()] };
    if (path.includes("/invites/")) return { data: invite({ status: "revoked" }) };
    if (path.endsWith("/bindings")) return { data: [binding] };
    return { data: binding };
  });

  await api.proxyInvites();
  const created = await api.createProxyInvite({ targetNodeId: "nod_1" });
  assert.equal(created.invite.status, "active");
  await api.revokeProxyInvite("cpi_1");
  await api.proxyBindings();
  await api.revokeProxyBinding("cpb_1");
  await api.proxyDiagnostics();
  await api.pendingProxyClaims();
  await api.resumeProxyClaim("cpc_1");
  await api.cancelProxyClaim("cpc_1", { force: true });

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/control-plane-proxy/invites", undefined],
    ["/api/control-plane-proxy/invites", "POST"],
    ["/api/control-plane-proxy/invites/cpi_1", "DELETE"],
    ["/api/control-plane-proxy/bindings", undefined],
    ["/api/control-plane-proxy/bindings/cpb_1", "DELETE"],
    ["/api/control-plane-proxy/diagnostics", undefined],
    ["/api/control-plane-proxy/pending-claims", undefined],
    ["/api/control-plane-proxy/pending-claims/cpc_1/resume", "POST"],
    ["/api/control-plane-proxy/pending-claims/cpc_1?force=true", "DELETE"],
  ]);
});

test("diagnostic log export reports a capability error without binary transport support", async () => {
  const { api } = fixture(() => ({}));
  await assert.rejects(() => api.exportDiagnosticLogs(), (error: unknown) => (
    (error as { code?: string }).code === "CLIENT_BINARY_UNSUPPORTED"
  ));
});
