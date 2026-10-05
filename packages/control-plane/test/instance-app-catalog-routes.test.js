import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerInstanceRoutes } from "../src/control-plane/http/instance-routes.ts";
import { routeAuthorization } from "../src/control-plane/http/server.ts";

function createApp() {
  const calls = [];
  const service = {
    instanceAppCatalog: async (instanceId) => {
      calls.push({ name: "catalog", instanceId });
      return { items: [{ id: "codex", name: "Codex", kind: "tty" }] };
    },
    instanceCustomAppCatalog: async (instanceId) => {
      calls.push({ name: "custom-catalog", instanceId });
      return { schemaVersion: 1, items: [{ id: "notepad", name: "Notepad", kind: "gui", command: "notepad" }] };
    },
    updateInstanceCustomAppCatalog: async (instanceId, input) => {
      calls.push({ name: "update-custom-catalog", instanceId, input });
      return { schemaVersion: 1, items: input.items };
    },
  };
  const app = Fastify();
  registerInstanceRoutes({
    app,
    service,
    events: { publish: () => {} },
    operationApprovals: {},
    auth: {},
  });
  return { app, calls };
}

test("instance app catalog routes expose the catalog and replace the custom catalog", async () => {
  const { app, calls } = createApp();
  try {
    const catalog = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/apps/catalog" });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().data.items, [{ id: "codex", name: "Codex", kind: "tty" }]);

    const custom = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/apps/catalog/custom" });
    assert.equal(custom.statusCode, 200);
    assert.equal(custom.json().data.items[0].id, "notepad");

    const item = { id: "calc", name: "Calculator", kind: "gui", command: "calc" };
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/controlled-instances/instance_fake001/apps/catalog/custom",
      headers: { "content-type": "application/json" },
      payload: { items: [item] },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().data.items, [item]);
    assert.deepEqual(calls.at(-1), { name: "update-custom-catalog", instanceId: "instance_fake001", input: { items: [item] } });
  } finally {
    await app.close();
  }
});

test("custom app catalog reads and writes require instance update permission", () => {
  assert.deepEqual(routeAuthorization("GET", "/api/controlled-instances/instance_fake001/apps/catalog/custom"), {
    action: "update",
    resource: { type: "instance" },
  });
  assert.deepEqual(routeAuthorization("PATCH", "/api/controlled-instances/instance_fake001/apps/catalog/custom"), {
    action: "update",
    resource: { type: "instance" },
  });
  assert.deepEqual(routeAuthorization("GET", "/api/controlled-instances/instance_fake001/apps/catalog"), {
    action: "read",
    resource: { type: "instance" },
  });
});
