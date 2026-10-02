import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneEnvironmentTemplatesApi } from "../src/environment-templates.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const TS = "2026-10-02T00:00:00.000Z";

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: "ent_0000000000001",
    name: "Template",
    sourceInstanceId: "cin_0000000000001",
    nodeId: "nod_0000000000001",
    status: "creating",
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
  return { api: createControlPlaneEnvironmentTemplatesApi(transport), requests };
}

test("environment template routes target node and instance owners", async () => {
  const { api, requests } = fixture((path, init) => {
    if (init?.method === "DELETE") return { data: { deleted: true, templateId: "ent_0000000000001" } };
    if (init?.method === "POST") return { data: template() };
    if (path.endsWith("/environment-templates")) return { data: [template()] };
    return { data: template() };
  });

  const list = await api.listForNode("nod/one");
  assert.equal(list[0].status, "creating");
  await api.get("nod_0000000000001", "ent/one");
  await api.createFromInstance("cin_0000000000001", { name: "Template" });
  const removed = await api.remove("nod_0000000000001", "ent_0000000000001");
  assert.deepEqual(removed, { deleted: true, templateId: "ent_0000000000001" });

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/nodes/nod%2Fone/environment-templates", undefined],
    ["/api/nodes/nod_0000000000001/environment-templates/ent%2Fone", undefined],
    ["/api/controlled-instances/cin_0000000000001/environment-templates", "POST"],
    ["/api/nodes/nod_0000000000001/environment-templates/ent_0000000000001", "DELETE"],
  ]);
});
