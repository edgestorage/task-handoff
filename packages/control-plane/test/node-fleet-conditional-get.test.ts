import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  NodeModelPublicRecordSchema,
  NodeRuntimeSchema,
  type Node,
  type NodeModelPublicRecord,
  type NodeRuntime,
} from "@task-handoff/protocol/control-plane";
import { ControlPlaneNodeAgentClient } from "../src/control-plane/nodes/client.ts";
import { ControlPlaneNodeAgentGateway } from "../src/control-plane/nodes/gateway.ts";
import { registerNodeModelRoutes } from "../src/node-agent/models/routes.ts";
import type { NodeModelRegistry } from "../src/node-agent/models/registry.ts";
import { registerRuntimeRoutes } from "../src/node-agent/runtimes/routes.ts";

const timestamp = "2026-10-24T00:00:00.000Z";

function runtime(overrides: Record<string, unknown> = {}): NodeRuntime {
  return NodeRuntimeSchema.parse({
    id: "runtime_conditional",
    nodeId: "node_conditional",
    name: "Conditional runtime",
    type: "docker",
    status: "online",
    accessStrategy: "node-proxy",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function model(overrides: Record<string, unknown> = {}): NodeModelPublicRecord {
  return NodeModelPublicRecordSchema.parse({
    id: "model_conditional",
    name: "Conditional model",
    endpoint: "https://models.example/v1",
    model: "gpt-conditional",
    modelNames: [{ name: "gpt-conditional", order: 0 }],
    mappings: [],
    protocols: ["openai-responses"],
    app: "codex",
    enabled: true,
    order: 0,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    keyPreview: "sk-...al",
    keySet: true,
    referenceCount: 0,
    ...overrides,
  });
}

const unused = () => { throw new Error("not used"); };
const node: Node = {
  id: "node_conditional",
  connectionMode: "direct-http",
  endpoint: "http://node-conditional.test",
  status: "online",
  auth: { mode: "paired-hmac", keyId: "key_conditional" },
  connectionPhase: "healthy",
} as Node;

test("node runtime and model projections serve conditional GET responses", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let runtimes = [runtime()];
  let models = [model()];
  registerRuntimeRoutes(app, {
    listRuntimes: () => runtimes,
    createRuntime: unused,
    updateRuntime: unused,
    deleteRuntime: unused,
    checkRuntime: unused,
    listLocalFolders: unused,
    listFolderPlaces: unused,
    listFolderTree: unused,
    createLocalFolder: unused,
    updateLocalFolder: unused,
    deleteLocalFolder: unused,
  } as Parameters<typeof registerRuntimeRoutes>[1]);
  registerNodeModelRoutes(
    app,
    { list: () => models } as unknown as NodeModelRegistry,
    async () => undefined,
    async () => new Response(),
  );

  for (const [route, changed] of [
    ["/api/node-agent/runtimes", () => { runtimes = [runtime({ name: "Renamed runtime" })]; }],
    ["/api/node-agent/models", () => { models = [model({ name: "Renamed model" })]; }],
  ] as const) {
    const first = await app.inject({ method: "GET", url: route });
    assert.equal(first.statusCode, 200, first.body);
    const etag = first.headers.etag;
    assert.equal(typeof etag, "string");

    const unchanged = await app.inject({ method: "GET", url: route, headers: { "if-none-match": etag } });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, "");

    changed();
    const updated = await app.inject({ method: "GET", url: route, headers: { "if-none-match": etag } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.notEqual(updated.headers.etag, etag);
  }
});

test("fleet refreshes revalidate runtimes and models without dropping cached snapshots", async () => {
  const requestHeaders: Array<{ route: string; ifNoneMatch: string | null }> = [];
  const client = new ControlPlaneNodeAgentClient({
    request: async (_node, route, init) => {
      const headers = new Headers(init.headers);
      const ifNoneMatch = headers.get("if-none-match");
      requestHeaders.push({ route, ifNoneMatch });
      if (ifNoneMatch === `"${route}"`) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ data: route === "/runtimes" ? [runtime()] : [model()] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: `"${route}"` },
      });
    },
  });
  const gateway = new ControlPlaneNodeAgentGateway(client, { fleetSnapshotFreshMs: 0 });

  await gateway.refreshFleetRuntimes([node]);
  await gateway.refreshFleetModels([node]);
  await gateway.refreshFleetRuntimes([node]);
  await gateway.refreshFleetModels([node]);

  assert.deepEqual(requestHeaders, [
    { route: "/runtimes", ifNoneMatch: null },
    { route: "/models", ifNoneMatch: null },
    { route: "/runtimes", ifNoneMatch: '"/runtimes"' },
    { route: "/models", ifNoneMatch: '"/models"' },
  ]);
  assert.deepEqual(gateway.readFleetRuntimes([node]).items.map((item) => item.id), ["runtime_conditional"]);
  assert.deepEqual(gateway.readFleetModels([node]).items.map(({ model: item }) => item.id), ["model_conditional"]);
});
