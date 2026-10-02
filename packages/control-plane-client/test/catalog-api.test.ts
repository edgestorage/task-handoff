import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneCatalogApi } from "../src/catalog.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const TS = "2026-10-02T00:00:00.000Z";

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "prj_0000000000001",
    name: "Project",
    source: { type: "git-repository", url: "https://example.com/repo.git" },
    workspacePolicy: { mode: "git-clone" },
    labels: {},
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function publicModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "mdl_0000000000001",
    name: "Model",
    endpoint: "https://api.example.com/v1",
    model: "gpt",
    app: "codex",
    enabled: true,
    order: 100,
    keyPreview: "sk-…",
    keySet: true,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function selectableImage(overrides: Record<string, unknown> = {}) {
  return {
    id: "img_0000000000001",
    origin: "custom",
    name: "Image",
    cover: { kind: "builtin", key: "cover" },
    repository: "alpine",
    availableTags: [],
    reference: "alpine:3.20",
    capabilities: [],
    optionalApps: [],
    defaultEnv: {},
    labels: {},
    readOnly: false,
    ...overrides,
  };
}

function marketCatalogSnapshot() {
  return {
    protocolVersion: "2026-10-02",
    catalogId: "mkt_0000000000001",
    revision: "1",
    source: "remote",
    generatedAt: TS,
    items: [],
  };
}

function marketCatalogStatus() {
  return { source: "remote", state: "ready", revision: "1", updatedAt: TS };
}

function fixture(respond: (path: string, init?: RequestInit) => unknown) {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse(respond(path, init));
    },
  };
  return { api: createControlPlaneCatalogApi(transport), requests };
}

test("catalog project routes target control-plane project endpoints", async () => {
  const { api, requests } = fixture((_path, init) => {
    if (init?.method === "DELETE") return { data: { deleted: true } };
    if (init?.method === "POST") return { data: project({ id: "prj_created" }) };
    if (init?.method === "PATCH") return { data: project({ name: "Updated" }) };
    return { data: _path === "/api/projects" ? [project()] : project() };
  });

  const list = await api.listProjects();
  assert.equal(list[0].id, "prj_0000000000001");
  await api.getProject("prj/one");
  await api.createProject({ name: "New" });
  await api.updateProject("prj_0000000000001", { name: "Updated" });
  const removed = await api.removeProject("prj_0000000000001");
  assert.deepEqual(removed, { deleted: true });

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/projects", undefined],
    ["/api/projects/prj%2Fone", undefined],
    ["/api/projects", "POST"],
    ["/api/projects/prj_0000000000001", "PATCH"],
    ["/api/projects/prj_0000000000001", "DELETE"],
  ]);
});

test("catalog model routes preserve query and encode node paths", async () => {
  const { api, requests } = fixture((path, init) => {
    if (path.startsWith("/api/models/reorder")) return { data: [publicModel()] };
    if (init?.method === "DELETE") return { data: { deleted: true } };
    if (path.startsWith("/api/nodes/")) return { data: publicModel({ referenceCount: 2 }) };
    if (path.endsWith("/sync")) return { data: { model: publicModel(), locations: [] } };
    if (init?.method === "POST") return { data: publicModel({ id: "mdl_created" }) };
    if (path.includes("progressive=true")) return { data: { models: [], nodeDiagnostics: [], updatedAt: TS } };
    return { data: publicModel() };
  });

  await api.listModels({ progressive: true });
  await api.getModel("mdl/one");
  await api.syncModel("mdl_0000000000001");
  await api.reorderModels(["mdl_a", "mdl_b"]);
  await api.createModelOnNode("node/one", { name: "Node model" });
  await api.removeModelOnNode("node_1", "mdl_1");

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/models?progressive=true", undefined],
    ["/api/models/mdl%2Fone", undefined],
    ["/api/models/mdl_0000000000001/sync", "POST"],
    ["/api/models/reorder", "POST"],
    ["/api/nodes/node%2Fone/models", "POST"],
    ["/api/nodes/node_1/models/mdl_1", "DELETE"],
  ]);
  assert.deepEqual(JSON.parse(String(requests[3].init?.body)), { ids: ["mdl_a", "mdl_b"] });
});

test("catalog market and image routes read public projections", async () => {
  const { api, requests } = fixture((path) => {
    if (path === "/api/image-options") return { data: [selectableImage()] };
    if (path === "/api/market/catalog") {
      return {
        data: {
          catalog: marketCatalogSnapshot(),
          status: marketCatalogStatus(),
        },
      };
    }
    if (path === "/api/market/refresh") {
      return {
        data: {
          catalog: marketCatalogSnapshot(),
          status: marketCatalogStatus(),
        },
      };
    }
    return { data: { deleted: true } };
  });

  const catalog = await api.marketCatalog();
  assert.equal(catalog.status.state, "ready");
  assert.equal(catalog.catalog.revision, "1");
  const options = await api.imageOptions();
  assert.equal(options[0].id, "img_0000000000001");
  const refreshed = await api.refreshMarketCatalog();
  assert.equal(refreshed.catalog.revision, "1");
  const removed = await api.removeImage("img/one");
  assert.deepEqual(removed, { deleted: true });

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/market/catalog", undefined],
    ["/api/image-options", undefined],
    ["/api/market/refresh", "POST"],
    ["/api/images/img%2Fone", "DELETE"],
  ]);
});
