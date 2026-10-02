import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneNodeAdminApi } from "../src/node-admin.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const TS = "2026-10-02T00:00:00.000Z";

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "nod_0000000000001",
    name: "Node",
    auth: { mode: "local-static-key", secret: "s3cret-value" },
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    id: "nrt_0000000000001",
    nodeId: "nod_0000000000001",
    name: "Docker",
    type: "docker",
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: "nlf_0000000000001",
    nodeId: "nod_0000000000001",
    name: "workspace",
    path: "/workspace",
    labels: {},
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
  return { api: createControlPlaneNodeAdminApi(transport), requests };
}

test("node admin routes never surface node auth secrets", async () => {
  const { api, requests } = fixture((path, init) => {
    if (path.endsWith("/check")) return { data: { id: "nod_0000000000001", status: "online", checkedAt: TS, agent: { version: "1" } } };
    if (init?.method === "DELETE") return { data: { deleted: true, revoke: { mode: "not-proxied", orphanRisk: false } } };
    return { data: node() };
  });

  const created = await api.createNode({ name: "Node" });
  assert.equal("secret" in (created.auth as Record<string, unknown>), false);
  await api.updateNode("nod/one", { name: "Renamed" });
  await api.checkNode("nod_0000000000001");
  const removed = await api.removeNode("nod_0000000000001", { force: true });
  assert.equal(removed.revoke.mode, "not-proxied");

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/nodes", "POST"],
    ["/api/nodes/nod%2Fone", "PATCH"],
    ["/api/nodes/nod_0000000000001/check", "POST"],
    ["/api/nodes/nod_0000000000001?force=true", "DELETE"],
  ]);
});

test("node admin folder and runtime routes preserve query parameters", async () => {
  const { api, requests } = fixture((path, init) => {
    if (path.includes("/folders/tree")) return { data: [{ name: "workspace", path: "/workspace", children: [] }] };
    if (path.endsWith("/folders/places")) return { data: [{ kind: "home", name: "Home", path: "/home/agent" }] };
    if (path.includes("/runtimes/")) return { data: runtime() };
    if (path.endsWith("/runtimes")) return { data: [runtime()] };
    if (path.endsWith("/local-folders")) return { data: init?.method === undefined ? [folder()] : folder() };
    return { data: folder() };
  });

  const folders = await api.listFolders("nod_0000000000001");
  assert.equal(folders[0].path, "/workspace");
  await api.listFolderTree("nod_0000000000001", { path: "/workspace", depth: 2 });
  await api.listFolderPlaces("nod_0000000000001");
  await api.createFolder("nod_0000000000001", { name: "w", path: "/w" });
  await api.removeFolder("nod_0000000000001", "nlf/one");
  await api.listRuntimes("nod_0000000000001");
  await api.checkRuntime("nod_0000000000001", "nrt_0000000000001");

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/nodes/nod_0000000000001/local-folders", undefined],
    ["/api/nodes/nod_0000000000001/folders/tree?path=%2Fworkspace&depth=2", undefined],
    ["/api/nodes/nod_0000000000001/folders/places", undefined],
    ["/api/nodes/nod_0000000000001/local-folders", "POST"],
    ["/api/nodes/nod_0000000000001/local-folders/nlf%2Fone", "DELETE"],
    ["/api/nodes/nod_0000000000001/runtimes", undefined],
    ["/api/nodes/nod_0000000000001/runtimes/nrt_0000000000001/check", "POST"],
  ]);
});

test("node admin settings, updates, pairing and join routes", async () => {
  const { api, requests } = fixture((path) => {
    if (path.endsWith("/settings/external-listener")) return { data: { bindScope: "loopback", host: "127.0.0.1", port: 4711, status: "listening", source: "bootstrap" } };
    if (path.endsWith("/settings/model-relay")) return { data: { enabled: true, source: "persisted" } };
    if (path.endsWith("/updates/jobs")) return { data: [] };
    if (path.endsWith("/updates/check")) return { data: { source: "npm", channel: "stable", availableVersion: "1.2.3", impact: { runningInstanceCount: 0, stoppedInstanceCount: 0, activeInstanceCount: 0, restartInstanceCount: 0 }, updateAvailable: true, supported: true, checkedAt: TS } };
    if (path.endsWith("/updates/apply")) return { data: updateJob() };
    if (path.endsWith("/pairing/invites")) return { data: { nodeId: "nod_0000000000001", joinToken: "token", expiresAt: TS } };
    if (path.endsWith("/control-plane-pairings")) return { data: [{ id: "cpk_1", keyId: "key_1", pairedAt: TS, updatedAt: TS, current: true }] };
    if (path.endsWith("/control-plane-connections")) return { data: [] };
    if (path.includes("/api/node-join/invites/")) return { data: { id: "nji_1", status: "pending" } };
    if (path.endsWith("/api/node-join/invites")) return { data: { id: "nji_1", joinToken: "join-token", expiresAt: TS } };
    if (path.endsWith("/api/node-join/complete")) return { data: node() };
    return { data: { deleted: true } };
  });

  await api.getExternalListener("nod_0000000000001");
  await api.updateExternalListener("nod_0000000000001", { bindScope: "all-ipv4", port: 4711 });
  await api.getModelRelay("nod_0000000000001");
  await api.updateModelRelay("nod_0000000000001", { enabled: true });
  await api.updateJobs("nod_0000000000001");
  await api.checkUpdate("nod_0000000000001", { channel: "stable" });
  await api.applyUpdate("nod_0000000000001", { channel: "stable", targetVersion: "1.2.3", preflightToken: "preflight-token-1234" });
  await api.createPairingInvite("nod_0000000000001");
  await api.listControlPlanePairings("nod_0000000000001");
  await api.removeControlPlanePairing("nod_0000000000001", "key/one");
  await api.listControlPlaneConnections("nod_0000000000001");
  await api.removeControlPlaneConnection("nod_0000000000001", "conn/one");
  const invite = await api.createJoinInvite({ nodeName: "N" });
  assert.equal(invite.joinToken, "join-token");
  const status = await api.joinInviteStatus("nji_1");
  assert.equal(status.status, "pending");
  await api.completeJoin({ joinToken: "join-token", nodeId: "nod_0000000000001" });

  assert.deepEqual(requests.slice(0, 6).map((entry) => entry.path), [
    "/api/nodes/nod_0000000000001/settings/external-listener",
    "/api/nodes/nod_0000000000001/settings/external-listener",
    "/api/nodes/nod_0000000000001/settings/model-relay",
    "/api/nodes/nod_0000000000001/settings/model-relay",
    "/api/nodes/nod_0000000000001/updates/jobs",
    "/api/nodes/nod_0000000000001/updates/check",
  ]);
  assert.deepEqual(requests.map((entry) => entry.path).slice(7), [
    "/api/nodes/nod_0000000000001/pairing/invites",
    "/api/nodes/nod_0000000000001/control-plane-pairings",
    "/api/nodes/nod_0000000000001/control-plane-pairings/key%2Fone",
    "/api/nodes/nod_0000000000001/control-plane-connections",
    "/api/nodes/nod_0000000000001/control-plane-connections/conn%2Fone",
    "/api/node-join/invites",
    "/api/node-join/invites/nji_1",
    "/api/node-join/complete",
  ]);
});

test("node admin fleet runtimes keep the data and meta envelope", async () => {
  const { api, requests } = fixture(() => ({
    data: [runtime()],
    meta: { nodeErrors: [], nodeStates: [] },
  }));
  const payload = await api.listAllRuntimes({ progressive: true });
  assert.equal(payload.data.length, 1);
  assert.deepEqual(requests[0].path, "/api/node-runtimes?progressive=true");
});

function updateJob() {
  return {
    id: "nuj_1",
    nodeId: "nod_0000000000001",
    source: "npm",
    channel: "stable",
    toVersion: "1.2.3",
    impact: { runningInstanceCount: 0, stoppedInstanceCount: 0, activeInstanceCount: 0, restartInstanceCount: 0 },
    rollout: {
      phase: "queued",
      desiredVersion: "1.2.3",
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
    },
    status: "queued",
    createdAt: TS,
    updatedAt: TS,
  };
}
