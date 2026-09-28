import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAgentOrchestrationRoutes, registerAgentRoutes } from "../src/control-plane/http/agent-routes.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";
import { ControlPlaneAgentAggregator } from "../src/control-plane/agents/agent-aggregator.ts";
import { defaultAgentOrchestrationId } from "@task-handoff/protocol/agent-orchestrations";

const AGENT_CAPABILITY = { agentExecution: { definitions: true, orchestration: { orchestrations: true } } };
const revision = "a".repeat(64);
const nextRevision = "b".repeat(64);

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent_one",
    revision,
    name: "Reviewer",
    description: "",
    appendedPrompt: "",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

function orchestration(overrides: Record<string, unknown> = {}) {
  return {
    id: defaultAgentOrchestrationId("agent_one"),
    revision,
    name: "Reviewer",
    agentIds: ["agent_one"],
    edges: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
}

function fixture(options: { failingNodeIds?: string[]; actor?: Record<string, unknown> } = {}) {
  const requests: Array<{ nodeId: string; route: string }> = [];
  const nodes = [
    { id: "node_capable", capabilities: { agent: { capabilities: AGENT_CAPABILITY } } },
    { id: "node_second", capabilities: { agent: { capabilities: AGENT_CAPABILITY } } },
    // N-1 Node: 没有 agentExecution，必须只关闭 Agent 功能域。
    { id: "node_legacy", capabilities: { agent: { capabilities: { stories: { enabled: true } } } } },
  ];
  const app = Fastify();
  if (options.actor) app.addHook("onRequest", async (request) => setControlPlaneRequestActor(request, options.actor as never));
  const service = {
    requireNode(nodeId: string) {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw Object.assign(new Error("Node not found."), { statusCode: 404, code: "NODE_NOT_FOUND" });
      return node;
    },
    listNodes: () => nodes,
    listControlledInstances: async () => [
      { id: "instance_capable", nodeId: "node_capable" },
      { id: "instance_one", nodeId: "node_second" },
    ],
    requireControlledInstance: async (instanceId: string) => {
      if (instanceId === "instance_capable") return { id: instanceId, nodeId: "node_capable" };
      if (instanceId === "instance_one") return { id: instanceId, nodeId: "node_second" };
      throw Object.assign(new Error("Instance not found."), { statusCode: 404, code: "INSTANCE_NOT_FOUND" });
    },
    resolveNodeAgentTransport(node: { id: string }) {
      return {
        async request(_node: unknown, route: string, init: RequestInit = {}) {
          requests.push({ nodeId: node.id, route });
          if (options.failingNodeIds?.includes(node.id)) throw new Error("node offline");
          if (route === "/agents" && (!init.method || init.method === "GET")) {
            // 两个 Node 故意返回同名 id：聚合身份必须是 (nodeId, agentId)，不能互相覆盖。
            return json({ agents: [definition({
              id: "agent_shared",
              targetInstanceId: node.id === "node_capable" ? "instance_capable" : "instance_one",
              futureField: "ignored",
            })] });
          }
          if (route === "/agents" && init.method === "POST") return json(definition(), 201);
          if (route === "/agent-orchestrations" && (!init.method || init.method === "GET")) return json({ orchestrations: [orchestration()] });
          if (route === "/agent-orchestrations" && init.method === "POST") return json(orchestration({ id: "orchestration_new" }), 201);
          if (init.method === "PATCH" && route.startsWith("/agent-orchestrations/")) return json(orchestration({ revision: nextRevision, name: "Updated" }));
          if (init.method === "DELETE" && route.startsWith("/agent-orchestrations/")) return json({ id: "orchestration_one", deleted: true });
          if (route.startsWith("/agent-orchestrations/")) return json(orchestration({ id: decodeURIComponent(route.split("/").pop()!) }));
          if (init.method === "PATCH" && route.startsWith("/agents/")) return json(definition({ revision: nextRevision, name: "Updated" }));
          if (init.method === "DELETE") return json({ id: "agent_one", deleted: true, deletedOrchestrationIds: [] });
          if (route.startsWith("/agents/")) return json(definition({
            targetInstanceId: node.id === "node_capable" ? "instance_capable" : "instance_one",
            unknown: true,
          }));
          return json({});
        },
      };
    },
  };
  registerAgentRoutes(app, service as never);
  registerAgentOrchestrationRoutes(app, service as never);
  app.setErrorHandler((error, _request, reply) => {
    // 与 controlPlaneErrorPayload 一致：Zod 入参错误是 400，其余按错误自带的结构化字段透传。
    if (error instanceof ZodError) {
      return void reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } });
    }
    const record = error as { code?: string; statusCode?: number; message: string; details?: unknown };
    reply.code(record.statusCode ?? 500).send({ error: { code: record.code ?? "CONTROL_PLANE_ERROR", message: record.message, ...(record.details ? { details: record.details } : {}) } });
  });
  return { app, requests };
}

test("Control Plane aggregates Agent definitions from capable Nodes only", async () => {
  const { app, requests } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/agents" });
  assert.equal(response.statusCode, 200);
  const body = response.json().data;
  assert.deepEqual(body.agents.map((entry: { nodeId: string }) => entry.nodeId).sort(), ["node_capable", "node_second"]);
  assert.deepEqual(body.agents.map((entry: { agent: { id: string } }) => entry.agent.id), ["agent_shared", "agent_shared"]);
  assert.deepEqual(body.unavailableNodeIds, []);
  // 定义本体不含 ownerNodeId，Node 身份只出现在聚合信封上。
  assert.equal(body.agents[0].agent.ownerNodeId, undefined);
  // 未知字段被忽略而不是让整条记录失败。
  assert.equal(body.agents[0].agent.futureField, undefined);
  assert.equal(requests.some((request) => request.nodeId === "node_legacy"), false);
  await app.close();
});

test("Control Plane reports offline Nodes as unavailable without failing the aggregate", async () => {
  const { app } = fixture({ failingNodeIds: ["node_second"] });
  const response = await app.inject({ method: "GET", url: "/api/agents" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.unavailableNodeIds, ["node_second"]);
  await app.close();
});

test("Control Plane keeps the last in-memory Agent snapshot when a Node goes offline", async () => {
  const aggregator = new ControlPlaneAgentAggregator();
  aggregator.replaceDefinitions("node_second", [definition({ id: "agent_cached", targetInstanceId: "instance_one" })]);
  const { app } = fixture({ failingNodeIds: ["node_second"] });
  // The fixture registers routes itself, so use a focused app to inject the shared projection.
  await app.close();

  const offlineApp = Fastify();
  const service = {
    requireNode: () => ({ id: "node_second", capabilities: { agent: { capabilities: AGENT_CAPABILITY } } }),
    listNodes: () => [{ id: "node_second", capabilities: { agent: { capabilities: AGENT_CAPABILITY } } }],
    listControlledInstances: async () => [{ id: "instance_one", nodeId: "node_second" }],
    resolveNodeAgentTransport: () => ({ request: async () => { throw new Error("offline"); } }),
  };
  registerAgentRoutes(offlineApp, service as never, aggregator);
  const response = await offlineApp.inject({ method: "GET", url: "/api/agents" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.agents[0].agent.id, "agent_cached");
  assert.deepEqual(response.json().data.unavailableNodeIds, ["node_second"]);
  await offlineApp.close();
});

test("Control Plane replaces an offline Agent snapshot after the source Node reconnects", async () => {
  const aggregator = new ControlPlaneAgentAggregator();
  const app = Fastify();
  let state: "online-a" | "offline" | "online-b" = "online-a";
  const service = {
    requireNode: () => ({ id: "node_one", capabilities: { agent: { capabilities: AGENT_CAPABILITY } } }),
    listNodes: () => [{ id: "node_one", capabilities: { agent: { capabilities: AGENT_CAPABILITY } } }],
    listControlledInstances: async () => [{ id: "instance_one", nodeId: "node_one" }],
    resolveNodeAgentTransport: () => ({
      request: async () => {
        if (state === "offline") throw new Error("offline");
        return json({ agents: [definition({ id: state === "online-a" ? "agent_a" : "agent_b" })] });
      },
    }),
  };
  registerAgentRoutes(app, service as never, aggregator);

  const initial = await app.inject({ method: "GET", url: "/api/agents" });
  assert.deepEqual(initial.json().data.agents.map((entry: { agent: { id: string } }) => entry.agent.id), ["agent_a"]);
  state = "offline";
  const offline = await app.inject({ method: "GET", url: "/api/agents" });
  assert.deepEqual(offline.json().data.agents.map((entry: { agent: { id: string } }) => entry.agent.id), ["agent_a"]);
  assert.deepEqual(offline.json().data.unavailableNodeIds, ["node_one"]);
  state = "online-b";
  const recovered = await app.inject({ method: "GET", url: "/api/agents" });
  assert.deepEqual(recovered.json().data.agents.map((entry: { agent: { id: string } }) => entry.agent.id), ["agent_b"]);
  assert.deepEqual(recovered.json().data.unavailableNodeIds, []);
  await app.close();
});

test("Control Plane rejects Agent requests for Nodes without the capability", async () => {
  const { app, requests } = fixture();
  const list = await app.inject({ method: "GET", url: "/api/agents?nodeId=node_legacy" });
  assert.equal(list.statusCode, 409);
  assert.equal(list.json().error.code, "AGENT_DEFINITIONS_UNSUPPORTED");
  const create = await app.inject({ method: "POST", url: "/api/agents", payload: { nodeId: "node_legacy", input: { name: "A", targetInstanceId: "instance_one", cwdFolderId: "folder_one", providerId: "codex" } } });
  assert.equal(create.statusCode, 409);
  assert.deepEqual(requests, []);
  await app.close();
});

test("Control Plane Agent routes honor the request Node and Instance scopes before proxying", async () => {
  const { app, requests } = fixture({
    actor: {
      type: "user",
      userId: "user_limited",
      identityId: "identity_limited",
      roleIds: [],
      permissionIds: [],
      nodeScope: { kind: "selected", nodeIds: ["node_capable"] },
      instanceScope: { kind: "selected", instanceIds: [] },
      authorizationRevision: 1,
      requiresPasswordChange: false,
    },
  });

  const list = await app.inject({ method: "GET", url: "/api/agents" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().data.agents, []);
  assert.deepEqual(requests, [{ nodeId: "node_capable", route: "/agents" }]);

  const hiddenNode = await app.inject({ method: "GET", url: "/api/agents/agent_one?nodeId=node_second" });
  assert.equal(hiddenNode.statusCode, 404);
  assert.equal(hiddenNode.json().error.code, "CONTROL_PLANE_RESOURCE_NOT_VISIBLE");

  const hiddenInstance = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { nodeId: "node_capable", input: { name: "Reviewer", targetInstanceId: "instance_one", cwdFolderId: "folder_one", providerId: "codex" } },
  });
  assert.equal(hiddenInstance.statusCode, 404);
  assert.equal(hiddenInstance.json().error.code, "CONTROL_PLANE_RESOURCE_NOT_VISIBLE");
  assert.deepEqual(requests, [{ nodeId: "node_capable", route: "/agents" }]);
  await app.close();
});

test("Control Plane routes Agent writes to the owning Node and forwards structured errors", async () => {
  const { app, requests } = fixture();
  const created = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { nodeId: "node_second", input: { name: "Reviewer", targetInstanceId: "instance_one", cwdFolderId: "folder_one", providerId: "codex" } },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().data.id, "agent_one");

  const patched = await app.inject({
    method: "PATCH",
    url: "/api/agents/agent_one",
    payload: { nodeId: "node_second", input: { expectedRevision: revision, name: "Updated" } },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().data.revision, nextRevision);

  const fetched = await app.inject({ method: "GET", url: "/api/agents/agent_one?nodeId=node_second" });
  assert.equal(fetched.json().data.unknown, undefined);

  const missingNode = await app.inject({ method: "GET", url: "/api/agents/agent_one" });
  assert.equal(missingNode.statusCode, 400);

  const removed = await app.inject({ method: "DELETE", url: "/api/agents/agent_one?nodeId=node_capable" });
  assert.deepEqual(removed.json().data, { id: "agent_one", deleted: true, deletedOrchestrationIds: [] });

  const removedWithOrchestrations = await app.inject({
    method: "DELETE",
    url: "/api/agents/agent_one?nodeId=node_capable&referencingOrchestrations=delete",
  });
  assert.deepEqual(removedWithOrchestrations.json().data, { id: "agent_one", deleted: true, deletedOrchestrationIds: [] });

  assert.deepEqual(requests.map((request) => [request.nodeId, request.route]), [
    ["node_second", "/agents"],
    ["node_second", "/agents/agent_one"],
    ["node_second", "/agents/agent_one"],
    ["node_second", "/agents/agent_one"],
    ["node_capable", "/agents/agent_one"],
    ["node_capable", "/agents/agent_one"],
    ["node_capable", "/agents/agent_one"],
    ["node_capable", "/agents/agent_one?referencingOrchestrations=delete"],
  ]);
  await app.close();
});

test("Control Plane forwards Node error details such as orchestration cycles", async () => {
  const app = Fastify();
  const capabilities = { agentExecution: { definitions: true, orchestration: { orchestrations: true } } };
  const service = {
    requireNode: () => ({ id: "node_capable", capabilities: { agent: { capabilities } } }),
    listNodes: () => [],
    listControlledInstances: async () => [{ id: "instance_one", nodeId: "node_capable" }],
    requireControlledInstance: async () => ({ id: "instance_one", nodeId: "node_capable" }),
    resolveNodeAgentTransport: () => ({
      async request(_node: unknown, route: string, init: RequestInit = {}) {
        if (route === "/agents") return json({ agents: [definition({ id: "agent_a" }), definition({ id: "agent_b" })] });
        if (route.startsWith("/agent-orchestrations/") && init.method !== "PATCH") {
          return json(orchestration({ id: "orchestration_one", agentIds: ["agent_a", "agent_b"], edges: [{ fromAgentId: "agent_a", toAgentId: "agent_b" }] }));
        }
        return new Response(JSON.stringify({ error: { code: "AGENT_ORCHESTRATION_CYCLE", message: "cycle", details: { code: "AGENT_ORCHESTRATION_CYCLE", cycle: ["agent_a", "agent_b", "agent_a"] } } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  registerAgentOrchestrationRoutes(app, service as never);
  app.setErrorHandler((error, _request, reply) => {
    // 与 controlPlaneErrorPayload 一致：Zod 入参错误是 400，其余按错误自带的结构化字段透传。
    if (error instanceof ZodError) {
      return void reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } });
    }
    const record = error as { code?: string; statusCode?: number; message: string; details?: unknown };
    reply.code(record.statusCode ?? 500).send({ error: { code: record.code ?? "CONTROL_PLANE_ERROR", message: record.message, ...(record.details ? { details: record.details } : {}) } });
  });
  const response = await app.inject({
    method: "PATCH",
    url: "/api/agent-orchestrations/orchestration_one",
    payload: { nodeId: "node_capable", input: { expectedRevision: revision, edges: [{ fromAgentId: "agent_b", toAgentId: "agent_a" }] } },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json().error.details.cycle, ["agent_a", "agent_b", "agent_a"]);
  await app.close();
});

test("Control Plane gates Story entry and Run proxies on additive Node capabilities", async () => {
  const { app, requests } = fixture();
  const entries = await app.inject({ method: "GET", url: "/api/stories/story_one/agent-entries?nodeId=node_capable" });
  assert.equal(entries.statusCode, 409);
  assert.equal(entries.json().error.code, "STORY_AGENT_ENTRY_AUTHORIZATION_UNSUPPORTED");
  const runs = await app.inject({ method: "GET", url: "/api/agent-runs?nodeId=node_capable" });
  assert.equal(runs.statusCode, 409);
  assert.equal(runs.json().error.code, "AGENT_RUNS_UNSUPPORTED");
  assert.deepEqual(requests, []);
  await app.close();
});

test("Control Plane proxies orchestration CRUD to the owning Node and gates it on capability", async () => {
  const { app, requests } = fixture();
  const listed = await app.inject({ method: "GET", url: "/api/agent-orchestrations?nodeId=node_capable" });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().data.orchestrations.map((entry: { nodeId: string; orchestration: { id: string } }) => [entry.nodeId, entry.orchestration.id]), [
    ["node_capable", defaultAgentOrchestrationId("agent_one")],
  ]);

  const created = await app.inject({
    method: "POST",
    url: "/api/agent-orchestrations",
    payload: { nodeId: "node_capable", input: { name: "Release", agentIds: ["agent_one"], edges: [] } },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.id, "orchestration_new");

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/agent-orchestrations/${encodeURIComponent(defaultAgentOrchestrationId("agent_one"))}`,
    payload: { nodeId: "node_capable", input: { expectedRevision: revision, name: "Updated" } },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().data.revision, nextRevision);

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/agent-orchestrations/${encodeURIComponent(defaultAgentOrchestrationId("agent_one"))}?nodeId=node_capable`,
  });
  assert.deepEqual(removed.json().data, { id: "orchestration_one", deleted: true });

  // N-1 Node 缺少 orchestration capability 时整个编排域关闭，不影响 Agent 定义代理。
  const unsupported = await app.inject({ method: "GET", url: "/api/agent-orchestrations?nodeId=node_legacy" });
  assert.equal(unsupported.statusCode, 409);
  assert.equal(unsupported.json().error.code, "AGENT_ORCHESTRATIONS_UNSUPPORTED");
  assert.equal(requests.some((request) => request.nodeId === "node_legacy"), false);
  await app.close();
});

test("Control Plane preserves dangling Story entries and authorizes newly referenced live Agents", async () => {
  const app = Fastify();
  const requests: Array<{ route: string; init: RequestInit }> = [];
  const capabilities = { agentExecution: { definitions: true, orchestration: { storyEntryAuthorization: true } } };
  const service = {
    requireNode: () => ({ id: "node_one", capabilities: { agent: { capabilities } } }),
    listNodes: () => [],
    listControlledInstances: async () => [{ id: "instance_one", nodeId: "node_one" }],
    requireControlledInstance: async () => ({ id: "instance_one", nodeId: "node_one" }),
    resolveNodeAgentTransport: () => ({
      async request(_node: unknown, route: string, init: RequestInit = {}) {
        requests.push({ route, init });
        if (route === "/stories/story_one") return json({ id: "story_one", ownerNodeId: "node_one", title: "Story", documents: [], actions: [], createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" });
        if (route === "/stories/story_one/agent-entries" && init.method === "PUT") {
          return json({ storyId: "story_one", revision: nextRevision, entries: [
            { agentId: "agent_missing", orchestrationId: defaultAgentOrchestrationId("agent_missing"), status: "missing-reference" },
            { agentId: "agent_one", orchestrationId: defaultAgentOrchestrationId("agent_one"), status: "available" },
          ] });
        }
        if (route === "/stories/story_one/agent-entries") return json({ storyId: "story_one", revision, entries: [
          { agentId: "agent_missing", orchestrationId: defaultAgentOrchestrationId("agent_missing"), status: "missing-reference" },
        ] });
        if (route === "/agents/agent_one") return json(definition({ targetInstanceId: "instance_one" }));
        return json({});
      },
    }),
  };
  registerAgentRoutes(app, service as never);
  const response = await app.inject({
    method: "PUT",
    url: "/api/stories/story_one/agent-entries",
    payload: { nodeId: "node_one", input: { expectedRevision: revision, entries: [
      { agentId: "agent_missing", orchestrationId: defaultAgentOrchestrationId("agent_missing") },
      { agentId: "agent_one", orchestrationId: defaultAgentOrchestrationId("agent_one") },
    ] } },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.entries, [
    { agentId: "agent_missing", orchestrationId: defaultAgentOrchestrationId("agent_missing"), status: "missing-reference" },
    { agentId: "agent_one", orchestrationId: defaultAgentOrchestrationId("agent_one"), status: "available" },
  ]);
  assert.deepEqual(requests.map(({ route }) => route), [
    "/stories/story_one",
    "/stories/story_one/agent-entries",
    "/agents/agent_one",
    "/stories/story_one/agent-entries",
  ]);
  await app.close();
});

test("Control Plane authorizes every Run instance before returning or cancelling it", async () => {
  const app = Fastify();
  const requests: Array<{ route: string; init: RequestInit }> = [];
  const capabilities = { agentExecution: { definitions: true, runs: true, orchestration: { runMembers: true } } };
  const run = {
    runId: "run_one",
    clientRequestId: "request_one",
    revision: 0,
    status: "running",
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "session_one", storyId: "story_one" },
    orchestrationId: defaultAgentOrchestrationId("agent_one"),
    rootMemberId: "member_one",
    budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 1 },
    members: [{
      memberId: "member_one",
      runId: "run_one",
      agentId: "agent_one",
      instanceId: "instance_hidden",
      role: "root",
      depth: 0,
      status: "running",
      executionSnapshot: {
        agentRevision: revision,
        targetInstanceId: "instance_hidden",
        cwdFolderId: "folder_one",
        appendedPrompt: "",
        providerId: "codex",
        executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
      },
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z",
    }],
    timeline: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
  const service = {
    requireNode: () => ({ id: "node_one", capabilities: { agent: { capabilities } } }),
    listNodes: () => [],
    requireControlledInstance: async (instanceId: string) => ({ id: instanceId, nodeId: "node_one" }),
    resolveNodeAgentTransport: () => ({
      async request(_node: unknown, route: string, init: RequestInit = {}) {
        requests.push({ route, init });
        return json(run);
      },
    }),
  };
  app.addHook("onRequest", async (request) => setControlPlaneRequestActor(request, {
    type: "user",
    userId: "user_one",
    identityId: "identity_one",
    roleIds: [],
    permissionIds: [],
    nodeScope: { kind: "selected", nodeIds: ["node_one"] },
    instanceScope: { kind: "selected", instanceIds: ["instance_one"] },
    authorizationRevision: 1,
    requiresPasswordChange: false,
  } as never));
  registerAgentRoutes(app, service as never);
  app.setErrorHandler((error, _request, reply) => {
    const record = error as { code?: string; statusCode?: number; message: string };
    reply.code(record.statusCode ?? 500).send({ error: { code: record.code ?? "CONTROL_PLANE_ERROR", message: record.message } });
  });

  const response = await app.inject({ method: "POST", url: "/api/agent-runs/run_one/cancel", payload: { nodeId: "node_one", input: {} } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "CONTROL_PLANE_RESOURCE_NOT_VISIBLE");
  assert.deepEqual(requests.map(({ route }) => route), ["/agent-runs/run_one"]);
  await app.close();
});

test("Control Plane derives manual Run provenance from the authenticated user", async () => {
  const app = Fastify();
  const requests: Array<{ route: string; init: RequestInit }> = [];
  const capabilities = {
    agentExecution: {
      definitions: true,
      runs: true,
      orchestration: { orchestrations: true, runMembers: true, manualRuns: true },
    },
  };
  const run = {
    runId: "run_manual",
    clientRequestId: "request_manual",
    revision: 0,
    status: "queued",
    input: { prompt: "Run the release checks" },
    orchestrationId: defaultAgentOrchestrationId("agent_one"),
    provenance: {
      source: "control-plane",
      authorizationSubject: { kind: "control-plane-user", subjectId: "user_one", authorizationRevision: 7 },
    },
    rootMemberId: "member_one",
    budget: { maxMembers: 16, maxDepth: 4, maxConcurrency: 4 },
    members: [{
      memberId: "member_one",
      runId: "run_manual",
      agentId: "agent_one",
      instanceId: "instance_one",
      role: "root",
      depth: 0,
      status: "queued",
      input: { prompt: "Run the release checks" },
      executionSnapshot: {
        agentRevision: revision,
        targetInstanceId: "instance_one",
        cwdFolderId: "folder_one",
        appendedPrompt: "",
        providerId: "codex",
        executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
      },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    }],
    timeline: [],
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const service = {
    requireNode: () => ({ id: "node_one", capabilities: { agent: { capabilities } } }),
    listNodes: () => [],
    listControlledInstances: async () => [{ id: "instance_one", nodeId: "node_one" }],
    requireControlledInstance: async () => ({ id: "instance_one", nodeId: "node_one" }),
    resolveNodeAgentTransport: () => ({
      async request(_node: unknown, route: string, init: RequestInit = {}) {
        requests.push({ route, init });
        if (route === "/agents/agent_one") return json(definition({ targetInstanceId: "instance_one" }));
        if (route === "/agent-orchestrations") return json({ orchestrations: [orchestration()] });
        if (route.startsWith("/agent-orchestrations/")) return json(orchestration());
        if (route === "/agents") return json({ agents: [definition({ targetInstanceId: "instance_one" })] });
        if (route === "/agent-runs" && init.method === "POST") return json(run, 201);
        return json({});
      },
    }),
  };
  app.addHook("onRequest", async (request) => setControlPlaneRequestActor(request, {
    type: "user",
    userId: "user_one",
    identityId: "identity_one",
    roleIds: [],
    permissionIds: [],
    nodeScope: { kind: "all" },
    authorizationRevision: 7,
    requiresPasswordChange: false,
  }));
  registerAgentRoutes(app, service as never);

  const response = await app.inject({
    method: "POST",
    url: "/api/agent-runs/manual",
    payload: {
      nodeId: "node_one",
      input: { clientRequestId: "request_manual", orchestrationId: defaultAgentOrchestrationId("agent_one"), input: { prompt: "Run the release checks" } },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.runId, "run_manual");
  const forwarded = JSON.parse(String(requests.find(({ route, init }) => route === "/agent-runs" && init.method === "POST")?.init.body));
  assert.deepEqual(forwarded.provenance, {
    source: "control-plane",
    authorizationSubject: { kind: "control-plane-user", subjectId: "user_one", authorizationRevision: 7 },
  });
  assert.equal(forwarded.provenance.initiatingAiSessionId, undefined);
  await app.close();
});
