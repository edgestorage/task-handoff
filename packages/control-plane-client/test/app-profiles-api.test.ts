import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneAppProfilesApi } from "../src/app-profiles.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "brp_default",
    name: "默认",
    isDefault: true,
    diskUsageBytes: 1024,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
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
  return { api: createControlPlaneAppProfilesApi(transport), requests };
}

test("browser profile client targets the instance app profile routes", async () => {
  const { api, requests } = fixture((path, init) => {
    if (init?.method === "POST" && path.endsWith("/default")) return { data: profile({ id: "brp_work", isDefault: true }) };
    if (init?.method === "POST") return { data: profile({ id: "brp_work", name: JSON.parse(String(init.body)).name, isDefault: false }) };
    if (init?.method === "PATCH") return { data: profile({ id: "brp_work", name: JSON.parse(String(init.body)).name, isDefault: false }) };
    if (init?.method === "DELETE") return { data: { removed: true } };
    return {
      data: {
        appId: "chromium",
        defaultProfileId: "brp_default",
        profiles: [profile()],
        observedAt: "2026-10-02T00:00:00.000Z",
      },
    };
  });

  const list = await api.list("inst one", "chromium");
  assert.equal(list.defaultProfileId, "brp_default");
  assert.deepEqual(requests[0], { path: "/api/controlled-instances/inst%20one/apps/chromium/profiles", init: { method: "GET", signal: undefined } });

  const created = await api.create("inst_one", "chromium", "工作");
  assert.equal(created.name, "工作");
  const renamed = await api.rename("inst_one", "chromium", "brp/work", "工作 2");
  assert.equal(renamed.name, "工作 2");
  const updatedDefault = await api.setDefault("inst_one", "chromium", "brp_work");
  assert.equal(updatedDefault.isDefault, true);
  const removed = await api.remove("inst_one", "chromium", "brp_work");
  assert.deepEqual(removed, { removed: true });

  assert.deepEqual(requests.slice(1).map((entry) => [entry.path, entry.init?.method]), [
    ["/api/controlled-instances/inst_one/apps/chromium/profiles", "POST"],
    ["/api/controlled-instances/inst_one/apps/chromium/profiles/brp%2Fwork", "PATCH"],
    ["/api/controlled-instances/inst_one/apps/chromium/profiles/brp_work/default", "POST"],
    ["/api/controlled-instances/inst_one/apps/chromium/profiles/brp_work", "DELETE"],
  ]);
});

test("browser profile client tolerates N-1 responses without optional profile fields", async () => {
  const { api } = fixture(() => ({
    data: {
      appId: "chromium",
      defaultProfileId: "brp_default",
      profiles: [{ id: "brp_default", name: "默认", isDefault: true, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
      observedAt: "2026-10-02T00:00:00.000Z",
    },
  }));
  const list = await api.list("inst_one", "chromium");
  assert.equal(list.profiles[0]?.diskUsageBytes, undefined);
  assert.equal(list.profiles[0]?.runningSessionId, undefined);
});
