import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { CONTROL_PLANE_PROTOCOL_VERSION, ControlledInstanceSchema, type ControlledInstance, type Node } from "@task-handoff/protocol/control-plane";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { ControlPlaneNodeAgentClient } from "../src/control-plane/nodes/client.ts";
import { ControlPlaneNodeAgentGateway } from "../src/control-plane/nodes/gateway.ts";
import { registerInstanceManagementRoutes } from "../src/node-agent/instances/routes.ts";
import { INSTANCE_DIRECTORY_PROJECTION, INSTANCE_PROJECTION_HEADER } from "../src/shared/instances/fleet-projection.ts";

function instance(overrides: Record<string, unknown> = {}): ControlledInstance {
  return ControlledInstanceSchema.parse({
    id: "inst_fleet_etag",
    name: "Fleet ETag instance",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_fleet_etag",
    runtimeId: "runtime_fleet_etag",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    runtime: { labels: {} },
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    lastHeartbeatAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  });
}

test("node instance fleet responses expose a heartbeat-insensitive ETag without hiding Session changes", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let instances = [instance()];
  const unused = () => { throw new Error("not used"); };
  const operations = {
    list: () => instances,
    create: unused,
    retryImageProvisioning: unused,
    retryGitProvisioning: unused,
    update: unused,
    register: unused,
    heartbeat: unused,
    sanitizeReport: (_id: string, _report: string, input: unknown) => input,
    afterCreate: () => undefined,
    afterImageRetry: () => undefined,
    afterGitRetry: () => undefined,
    afterUpdate: () => undefined,
    afterReport: () => undefined,
  } as Parameters<typeof registerInstanceManagementRoutes>[1];
  registerInstanceManagementRoutes(app, operations);

  const first = await app.inject({ method: "GET", url: "/api/node-agent/instances" });
  assert.equal(first.statusCode, 200);
  const etag = first.headers.etag;
  assert.equal(typeof etag, "string");
  assert.ok(etag);

  const unchanged = await app.inject({ method: "GET", url: "/api/node-agent/instances", headers: { "if-none-match": etag } });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, "");

  instances = [instance({
    stateRevision: 2,
    updatedAt: "2026-10-24T00:00:10.000Z",
    lastHeartbeatAt: "2026-10-24T00:00:10.000Z",
    aiSessions: {
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      sessions: [],
      updatedAt: "2026-10-24T00:00:10.000Z",
    },
  })];
  const heartbeatOnly = await app.inject({ method: "GET", url: "/api/node-agent/instances", headers: { "if-none-match": etag } });
  assert.equal(heartbeatOnly.statusCode, 304);

  instances = [instance({
    stateRevision: 3,
    updatedAt: "2026-10-24T00:00:20.000Z",
    lastHeartbeatAt: "2026-10-24T00:00:20.000Z",
    aiSessions: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      sessions: [{
        id: "session_fleet_etag",
        agent: "codex",
        status: "running",
        startedAt: "2026-10-24T00:00:20.000Z",
        updatedAt: "2026-10-24T00:00:20.000Z",
      }],
      updatedAt: "2026-10-24T00:00:20.000Z",
    },
  })];
  const sessionChanged = await app.inject({ method: "GET", url: "/api/node-agent/instances", headers: { "if-none-match": etag } });
  assert.equal(sessionChanged.statusCode, 200);
  assert.notEqual(sessionChanged.headers.etag, etag);

  instances = [instance({ name: "Renamed Fleet ETag instance" })];
  const changed = await app.inject({ method: "GET", url: "/api/node-agent/instances", headers: { "if-none-match": etag } });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, etag);
});

test("directory projections omit Session detail and ignore Session-only ETag changes", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: "session_directory",
    agent: "codex",
    creationSource: "app-session",
    lineage: { parentSessionId: undefined },
    status: "running",
    phase: "thinking",
    startedAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    userPrompt: "private prompt",
    ...overrides,
  });
  let instances = [instance({
    aiSessions: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      sessions: [session()],
      updatedAt: "2026-10-24T00:00:00.000Z",
    },
  })];
  const unused = () => { throw new Error("not used"); };
  registerInstanceManagementRoutes(app, {
    list: () => instances,
    create: unused,
    retryImageProvisioning: unused,
    retryGitProvisioning: unused,
    update: unused,
    register: unused,
    heartbeat: unused,
    sanitizeReport: (_id: string, _report: string, input: unknown) => input,
    afterCreate: () => undefined,
    afterImageRetry: () => undefined,
    afterGitRetry: () => undefined,
    afterUpdate: () => undefined,
    afterReport: () => undefined,
  } as Parameters<typeof registerInstanceManagementRoutes>[1]);

  const full = await app.inject({ method: "GET", url: "/api/node-agent/instances" });
  assert.equal(full.statusCode, 200);
  assert.equal(full.json().data[0].aiSessions.sessions.length, 1);

  const compactHeaders = { [INSTANCE_PROJECTION_HEADER]: INSTANCE_DIRECTORY_PROJECTION };
  const compact = await app.inject({ method: "GET", url: "/api/node-agent/instances", headers: compactHeaders });
  assert.equal(compact.statusCode, 200);
  const compactInstance = compact.json().data[0];
  assert.equal(compactInstance.aiSessions.runningCount, 1);
  assert.deepEqual(compactInstance.aiSessions.sessions, []);
  const etag = compact.headers.etag;
  assert.equal(typeof etag, "string");

  instances = [instance({
    aiSessions: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      sessions: [session({ title: "Renamed session", updatedAt: "2026-10-24T00:00:05.000Z" })],
      updatedAt: "2026-10-24T00:00:05.000Z",
    },
  })];
  const sessionOnlyChange = await app.inject({
    method: "GET",
    url: "/api/node-agent/instances",
    headers: { ...compactHeaders, "if-none-match": etag },
  });
  assert.equal(sessionOnlyChange.statusCode, 304);

  instances = [instance({
    aiSessions: {
      runningCount: 2,
      waitingCount: 0,
      staleCount: 0,
      sessions: [session({ id: "session_directory_2" })],
      updatedAt: "2026-10-24T00:00:10.000Z",
    },
  })];
  const countChange = await app.inject({
    method: "GET",
    url: "/api/node-agent/instances",
    headers: { ...compactHeaders, "if-none-match": etag },
  });
  assert.equal(countChange.statusCode, 200);
  assert.equal(countChange.json().data[0].aiSessions.runningCount, 2);
  assert.deepEqual(countChange.json().data[0].aiSessions.sessions, []);
});

test("Session bootstrap requests full summaries while the instance directory stays compact", async () => {
  const requests: Array<string | null> = [];
  const session = {
    id: "session_bootstrap",
    agent: "codex",
    creationSource: "app-session",
    status: "running",
    phase: "thinking",
    startedAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
  const directoryInstance = instance({
    aiSessions: { runningCount: 1, waitingCount: 0, staleCount: 0, sessions: [], updatedAt: "2026-10-24T00:00:00.000Z" },
  });
  const fullInstance = instance({
    aiSessions: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      sessions: [{ ...session, title: "Full Session title" }],
      updatedAt: "2026-10-24T00:00:00.000Z",
    },
  });
  const client = new ControlPlaneNodeAgentClient({
    request: async (_node, route, init) => {
      assert.equal(route, "/instances");
      const projection = new Headers(init.headers).get(INSTANCE_PROJECTION_HEADER);
      requests.push(projection);
      return new Response(JSON.stringify({ data: [projection === INSTANCE_DIRECTORY_PROJECTION ? directoryInstance : fullInstance] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: `"${projection || "full"}"` },
      });
    },
  });
  const gateway = new ControlPlaneNodeAgentGateway(client, { fleetSnapshotFreshMs: 0 });
  const node = {
    id: "node_bootstrap",
    connectionMode: "direct-http",
    endpoint: "http://node-bootstrap.test",
    status: "online",
    auth: { mode: "paired-hmac", keyId: "key_bootstrap" },
    connectionPhase: "healthy",
  } as Node;
  const service = Object.assign(Object.create(ControlPlaneService.prototype), {
    nodes: { list: () => [node] },
    nodeAgentGateway: gateway,
    logWarn: () => undefined,
    instanceRequest: async () => { throw new Error("offline bootstrap must not request the instance"); },
  });

  const directory = await service.listControlledInstances();
  const bootstrap = await service.bootstrapAiSessionsFromInstances();

  assert.deepEqual(requests, [INSTANCE_DIRECTORY_PROJECTION, null]);
  assert.deepEqual(directory[0].aiSessions.sessions, []);
  assert.equal(bootstrap.instances[0].aiSessions.sessions[0].title, "Full Session title");
});
