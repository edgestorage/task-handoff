import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneGitCredentialsApi } from "../src/git-credentials.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const TS = "2026-10-02T00:00:00.000Z";

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: "gcr_0000000000001",
    name: "GitHub",
    kind: "https-token",
    scope: { scheme: "https", host: "github.com", pathPrefix: "/" },
    secretSet: true,
    status: "enabled",
    revision: 0,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: "cin_0000000000001",
    credentialId: "gcr_0000000000001",
    credentialRevision: 0,
    assignmentRevision: 0,
    status: "synced",
    authorizedAt: TS,
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
  return { api: createControlPlaneGitCredentialsApi(transport), requests };
}

test("git credential routes never surface secret material", async () => {
  const { api, requests } = fixture((path, init) => {
    if (path.endsWith("/git-credential-assignments")) return { data: init?.method === "POST" ? assignment() : [assignment()] };
    if (path.includes("/git-credential-assignments/")) return { data: { revoked: true } };
    if (init?.method === "DELETE") return { data: { deleted: true } };
    if (init?.method === "POST") return { data: credential({ name: "New" }) };
    if (init?.method === "PATCH") return { data: credential({ name: "Updated" }) };
    if (path === "/api/git-credentials") return { data: { items: [credential()] } };
    return { data: credential() };
  });

  const list = await api.listCredentials();
  assert.equal("token" in list.items[0], false);
  const detail = await api.getCredential("gcr/one");
  assert.equal("privateKey" in detail, false);
  await api.createCredential({ name: "New", kind: "https-token" });
  await api.updateCredential("gcr_0000000000001", { name: "Updated" });
  const removed = await api.removeCredential("gcr_0000000000001");
  assert.deepEqual(removed, { deleted: true });
  await api.listInstanceAssignments("cin/one");
  const assigned = await api.assignToInstance("cin_0000000000001", { credentialId: "gcr_0000000000001" });
  assert.equal(assigned.status, "synced");
  const unassigned = await api.unassignFromInstance("cin_0000000000001", "gcr/one");
  assert.deepEqual(unassigned, { revoked: true });

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/git-credentials", undefined],
    ["/api/git-credentials/gcr%2Fone", undefined],
    ["/api/git-credentials", "POST"],
    ["/api/git-credentials/gcr_0000000000001", "PATCH"],
    ["/api/git-credentials/gcr_0000000000001", "DELETE"],
    ["/api/controlled-instances/cin%2Fone/git-credential-assignments", undefined],
    ["/api/controlled-instances/cin_0000000000001/git-credential-assignments", "POST"],
    ["/api/controlled-instances/cin_0000000000001/git-credential-assignments/gcr%2Fone", "DELETE"],
  ]);
});

test("git credential client fails closed when a response carries secret fields", async () => {
  const { api } = fixture(() => ({ data: credential({ token: "leaked" }) }));
  await assert.rejects(() => api.getCredential("gcr_0000000000001"));
});
