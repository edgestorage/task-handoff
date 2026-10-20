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
    scopes: { deviceAccess: true, nodeRelay: false },
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
          payload: { controlPlaneId: "cp_1", publicKeyFingerprint: "sha256:fp", expiresAt: TS, hostname: "studio-box" },
          signature: "sig",
        },
      };
    }
    if (path === "/api/cloud-account") {
      return { data: { signedIn: false, pendingRequest: { requestId: "request_a", scope: "account:sign-in", expiresAt: TS, authorizationUrl: `https://cloud.example.com/authorize/control-plane?request=request_a` } } };
    }
    if (path === "/api/cloud-account/sign-in-requests") return { data: { requestId: "request_a", scope: "account:sign-in", expiresAt: TS, authorizationUrl: "https://cloud.example.com/authorize/control-plane?request=request_a" } };
    if (path === "/api/cloud-connectivity/binding-requests") return { data: { requestId: "request_b", scope: "control-plane:bind", expiresAt: TS, authorizationUrl: "https://cloud.example.com/authorize/control-plane?request=request_b" } };
    if (path === "/api/cloud-account/sign-out") return { data: { signedIn: false } };
    return { data: cloud() };
  });

  const account = {
    signedIn: false,
    pendingRequest: { requestId: "request_a", scope: "account:sign-in", expiresAt: TS, authorizationUrl: "https://cloud.example.com/authorize/control-plane?request=request_a" },
  };

  await api.cloudConnectivity();
  const challenge = await api.createCloudChallenge();
  assert.equal(challenge.challengeCode, "code");
  assert.equal(challenge.payload.hostname, "studio-box");
  await api.setCloudRemoteAccess(false);
  assert.deepEqual((await api.setCloudScopes({ deviceAccess: false, nodeRelay: true })).scopes, { deviceAccess: true, nodeRelay: false });
  await api.disconnectCloud();
  assert.equal((await api.cloudAccount()).pendingRequest?.scope, "account:sign-in");
  assert.equal((await api.createCloudSignInRequest()).scope, "account:sign-in");
  assert.equal((await api.createCloudBindingRequest()).scope, "control-plane:bind");
  assert.equal((await api.signOutCloudAccount()).signedIn, false);

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/cloud-connectivity", undefined],
    ["/api/cloud-connectivity/challenges", "POST"],
    ["/api/cloud-connectivity/remote-access", "POST"],
    ["/api/cloud-connectivity/remote-access", "POST"],
    ["/api/cloud-connectivity/disconnect", "POST"],
    ["/api/cloud-account", undefined],
    ["/api/cloud-account/sign-in-requests", "POST"],
    ["/api/cloud-connectivity/binding-requests", "POST"],
    ["/api/cloud-account/sign-out", "POST"],
  ]);
});

test("control-plane admin node relay account routes", async () => {
  const node = {
    nodeHandle: "nrh_node_alpha",
    displayName: "Alpha box",
    publicKeyFingerprint: "sha256:fp",
    status: "active",
    revision: 1,
    createdAt: TS,
    updatedAt: TS,
    access: { kind: "shared", shareId: "shr_node_alpha", revision: 2, role: "use", expiresAt: TS },
  };
  const relayState = {
    channels: [{ nodeHandle: "nrh_node_alpha", nodeId: "node_nrh_node_alpha", allocationId: "alloc_a", connectedAt: TS, connected: true }],
    claims: [],
    errors: [],
    onboarding: [{ nodeHandle: "nrh_node_alpha", tokenId: "nrb_1", at: TS }],
  };
  const { api, requests } = fixture((path, init) => {
    if (path === "/api/cloud-connectivity/account-nodes") return { data: { signedIn: true, nodeRelay: { ...relayState, channels: [], onboarding: [] }, items: [node] } };
    if (path.endsWith("/claim") && init?.method === "POST") return { data: { claimed: true, nodeHandle: "nrh_node_alpha", controlPlaneId: "cp_1", status: "active", revision: 1 } };
    if (path.endsWith("/claim") && init?.method === "DELETE") return { data: { nodeHandle: "nrh_node_alpha", status: "revoked", revision: 2 } };
    if (path === "/api/cloud-connectivity/node-binding-tokens") return { data: { tokenId: "nrb_1", expiresAt: TS, command: "sudo task-handoff-node-agent cloud-bind", installCommand: "curl -fsSL https://cp.example.com/install-node-agent.sh | sudo sh -s --" } };
    if (path.endsWith("/node-binding-tokens/nrb_1")) return { data: { tokenId: "nrb_1", cancelled: true } };
    if (path === "/api/nodes/nod_1/cloud-relay-binding") return { data: { bound: true, nodeHandle: "nrh_node_alpha", accountId: "account_a", tokenId: "nrb_2", expiresAt: TS } };
    return { data: relayState };
  });

  const directory = await api.cloudAccountNodes();
  assert.equal(directory.signedIn, true);
  assert.equal(directory.items[0]?.displayName, "Alpha box");
  assert.equal(directory.items[0]?.access?.kind, "shared");
  assert.equal((await api.claimCloudAccountNode("nrh_node_alpha")).claimed, true);
  assert.equal((await api.releaseCloudAccountNodeClaim("nrh_node_alpha")).status, "revoked");
  const token = await api.createCloudNodeBindingToken({ displayName: "Alpha box" });
  assert.equal(token.tokenId, "nrb_1");
  assert.ok(token.installCommand.includes("/install-node-agent.sh"));
  assert.equal((await api.cancelCloudNodeBindingToken("nrb_1")).cancelled, true);
  const state = await api.cloudNodeRelayState();
  assert.equal(state.channels[0]?.connected, true);
  const bound = await api.bindCloudRelayNode("nod_1");
  assert.equal(bound.bound, true);
  assert.equal(bound.nodeHandle, "nrh_node_alpha");

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/cloud-connectivity/account-nodes", undefined],
    ["/api/cloud-connectivity/account-nodes/nrh_node_alpha/claim", "POST"],
    ["/api/cloud-connectivity/account-nodes/nrh_node_alpha/claim", "DELETE"],
    ["/api/cloud-connectivity/node-binding-tokens", "POST"],
    ["/api/cloud-connectivity/node-binding-tokens/nrb_1", "DELETE"],
    ["/api/cloud-connectivity/node-relay", undefined],
    ["/api/nodes/nod_1/cloud-relay-binding", "POST"],
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
