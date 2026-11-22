import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerEmbeddedBrowserControlRoutes } from "../src/control-plane/http/embedded-browser-control-routes.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";

const actor = {
  type: "user" as const,
  userId: "user_1",
  identityId: "identity_1",
  roleIds: ["owner"],
  permissionIds: ["instances:interactive"] as never,
  nodeScope: { kind: "all" as const },
  instanceScope: { kind: "inherit-node-scope" as const },
  authorizationRevision: 1,
  requiresPasswordChange: false,
};

function targetCdpInstance(targetCdp = true) {
  return {
    id: "inst_1",
    nodeId: "node_1",
    capabilities: {
      features: {
        embeddedBrowserChannel: {
          supported: true,
          transports: ["reverse-websocket"],
          streamKinds: ["control"],
          drivers: ["electron-page-cdp"],
          pageHosts: ["renderer-webview", "main-page-pool"],
          targetCdp,
        },
      },
    },
  };
}

function jsonResponse(data: unknown, status = 200) {
  const response = new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
  return { status, headers: Object.fromEntries(response.headers), body: response.body };
}

function errorResponse(error: Record<string, unknown>, status = 409) {
  const response = new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  return { status, headers: Object.fromEntries(response.headers), body: response.body };
}

async function harness(capabilities = targetCdpInstance(), downstream?: (route: string, init: Record<string, unknown>) => unknown) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const record = error as { statusCode?: number; code?: string; message?: string; details?: unknown };
    return reply.code(record.statusCode || 500).send({
      error: {
        code: record.code || "CONTROL_PLANE_ERROR",
        message: record.message || "failed",
        ...(record.details ? { details: record.details } : {}),
      },
    });
  });
  app.addHook("onRequest", async (request) => setControlPlaneRequestActor(request, actor));
  const calls: Array<{ route: string; init: Record<string, unknown> }> = [];
  const service = {
    async requireControlledInstance() {
      return capabilities;
    },
    proxyPrivateStore: { controlPlaneId: () => "cp_1" },
    async proxyInstanceHttp(_instanceId: string, route: string, init: Record<string, unknown>) {
      calls.push({ route, init });
      return downstream ? downstream(route, init) : jsonResponse({});
    },
  };
  registerEmbeddedBrowserControlRoutes({
    app,
    service: service as never,
    auth: { enabled: () => false } as never,
    authorizationConnections: { track: () => () => undefined } as never,
    events: { on: () => undefined } as never,
  });
  await app.ready();
  return { app, calls };
}

test("creation context GET forwards the caller source and verifies targetCdp capability", async (t) => {
  const snapshot = {
    revision: 3,
    defaultContext: { sourceRef: "bsr_a", browserContextId: "bsr_a" },
    panels: [
      { sourceRef: "bsr_a", panelLabel: "MacBook", hostLabel: "A", pageHost: "main-page-pool", canCreate: true, isDefault: true, canClaim: true },
      { sourceRef: "bsr_b", panelLabel: "Mac mini", hostLabel: "B", pageHost: "renderer-webview", canCreate: true, isDefault: false, canClaim: false },
    ],
  };
  const { app, calls } = await harness(targetCdpInstance(), () => jsonResponse(snapshot));
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/controlled-instances/inst_1/browser-control/creation-context?sourceRef=bsr_a" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, snapshot);
  assert.equal(calls[0].route, "/api/browser-control/creation-context?sourceRef=bsr_a");
  assert.equal(calls[0].init.headers["x-task-handoff-control-plane-id"], "cp_1");
  assert.equal(calls[0].init.headers["x-task-handoff-user-id"], "user_1");
});

test("creation context PUT and DELETE carry sourceRef and expectedRevision with structured errors", async (t) => {
  let conflict = false;
  const { app, calls } = await harness(targetCdpInstance(), (route, init) => {
    if (conflict) return errorResponse({ code: "BROWSER_DEFAULT_CONTEXT_CONFLICT", message: "Default context changed.", revision: 5, defaultBrowserContextId: "bsr_b" });
    if (init.method === "DELETE") return jsonResponse({ revision: 4 });
    return jsonResponse({ sourceRef: "bsr_b", browserContextId: "bsr_b", revision: 4 });
  });
  t.after(() => app.close());

  const put = await app.inject({
    method: "PUT",
    url: "/api/controlled-instances/inst_1/browser-control/creation-context",
    payload: { sourceRef: "bsr_b", expectedRevision: 3 },
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().data, { sourceRef: "bsr_b", browserContextId: "bsr_b", revision: 4 });
  assert.equal(calls[0].route, "/api/browser-control/creation-context?sourceRef=bsr_b&expectedRevision=3");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { sourceRef: "bsr_b", expectedRevision: 3 });

  const remove = await app.inject({
    method: "DELETE",
    url: "/api/controlled-instances/inst_1/browser-control/creation-context",
    payload: { sourceRef: "bsr_b", expectedRevision: 4 },
  });
  assert.equal(remove.statusCode, 200);
  assert.deepEqual(remove.json().data, { revision: 4 });
  assert.equal(calls[1].route, "/api/browser-control/creation-context?sourceRef=bsr_b&expectedRevision=4");

  conflict = true;
  const failed = await app.inject({
    method: "PUT",
    url: "/api/controlled-instances/inst_1/browser-control/creation-context",
    payload: { sourceRef: "bsr_b", expectedRevision: 3 },
  });
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.json().error.code, "BROWSER_DEFAULT_CONTEXT_CONFLICT");
  assert.deepEqual(failed.json().error.details, { revision: 5, defaultBrowserContextId: "bsr_b" });
});

test("creation context is hidden from instances without targetCdp", async (t) => {
  const { app, calls } = await harness(targetCdpInstance(false));
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/controlled-instances/inst_1/browser-control/creation-context" });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "BROWSER_OPERATION_UNSUPPORTED");
  assert.equal(calls.length, 0);
});
