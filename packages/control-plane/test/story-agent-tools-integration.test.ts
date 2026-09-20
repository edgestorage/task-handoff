import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { NodeAgentRegistrationClient } from "../../controlled-instance/src/web/node-agent-client.ts";
import { registerNodeStoryRoutes } from "../src/node-agent/stories/routes.ts";
import { StoryAiSessionReadService } from "../src/node-agent/stories/ai-session-read-service.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";
import { StoryToolPolicyService } from "../src/node-agent/stories/tool-policy-service.ts";
import { createStoryDatabaseFixture, seedStoryAction } from "./story-database-fixture.ts";

const timestamp = "2026-09-20T00:00:00.000Z";
const revision = 1;

function session(id: string, input: Record<string, unknown> = {}) {
  return {
    id,
    agent: "codex",
    storyId: "story_1",
    status: "idle",
    startedAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}

async function fixture() {
  const database = await createStoryDatabaseFixture("task-handoff-story-tools-integration-");
  await seedStoryAction(database.repository);
  const stories = new NodeStoryStore(database.paths, "node_1", database.repository);
  await stories.init();
  const policy = new StoryToolPolicyService(database.repository);
  const caller = session("caller_1");
  const target = session("target_1", { title: "Target session", updatedAt: "2026-09-20T00:01:00.000Z" });
  const instances = [
    { id: "instance_1", nodeId: "node_1", registrationToken: "token_1", aiSessions: { sessions: [caller] } },
    { id: "instance_2", nodeId: "node_1", registrationToken: "token_2", aiSessions: { sessions: [target] } },
  ];
  const state = {
    node: { id: "node_1" },
    authenticateInstance(id: string, token?: string) {
      const instance = instances.find((candidate) => candidate.id === id);
      if (!instance || token !== instance.registrationToken) {
        throw Object.assign(new Error("Invalid registration credential."), { code: "INSTANCE_REGISTRATION_TOKEN_INVALID", statusCode: 403 });
      }
      return instance;
    },
    requireInstance(id: string) {
      const instance = instances.find((candidate) => candidate.id === id);
      if (!instance) throw Object.assign(new Error("Instance not found."), { code: "NODE_INSTANCE_NOT_FOUND", statusCode: 404 });
      return instance;
    },
    listInstances: () => instances,
  };
  const automation = {
    id: "automation_1",
    storyId: "story_1",
    actionId: "action_1",
    schedule: { scheduleKind: "interval" as const, intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "queue" as const },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let automationStatus = { automation, effectiveStatus: "scheduled" as const, currentRuns: [] };
  const scheduler = {
    async list(storyId: string) { return storyId === "story_1" ? [automationStatus] : []; },
    async create(input: typeof automation) {
      automationStatus = { automation: { ...automation, ...input }, effectiveStatus: input.enabled ? "scheduled" : "disabled", currentRuns: [] } as typeof automationStatus;
      return automationStatus;
    },
    async status() { return automationStatus; },
    async update() { return automationStatus; },
    async delete() { return true; },
    async manualRun() { return undefined; },
    async runs() { return []; },
  };
  const downstreamRequests: string[] = [];
  const instanceFetch = (async (url: string | URL | Request) => {
    downstreamRequests.push(String(url));
    return new Response(JSON.stringify({ data: {
      detail: { id: "target_1", cwd: "/workspace" },
      turnIndex: { sessionId: "target_1", revision: "index_1", turns: [] },
    } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const aiSessionRead = new StoryAiSessionReadService(state as never, instanceFetch, async (instance) => `http://${instance.id}`);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => reply.code(error.statusCode || 500).send({
    error: { code: error.code || "INTERNAL_ERROR", message: error.message },
  }));
  let registration: NodeAgentRegistrationClient | undefined;
  registerNodeStoryRoutes(app, state as never, stories, {
    toolPolicy: policy,
    scheduler: scheduler as never,
    aiSessionRead,
    actionExecution: { run: async () => ({ targetInstanceId: "instance_1", aiSessionId: "created_session" }) } as never,
    onToolPolicyInvalidated: (event) => { registration?.invalidateStoryAgentTools(event); },
  });
  const transportEvents: string[] = [];
  const nodeAgentFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    transportEvents.push(`node-agent:${init?.method || "GET"}:${parsed.pathname}`);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await app.inject({
      method: (init?.method || "GET") as "GET",
      url: `${parsed.pathname}${parsed.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: JSON.parse(init.body) } : {}),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": response.headers["content-type"] || "application/json" },
    });
  }) as typeof fetch;
  registration = new NodeAgentRegistrationClient({
    controlMode: "controlled",
    nodeAgentUrl: "http://node-agent.test",
    registrationToken: "token_1",
    instanceId: "instance_1",
    heartbeatIntervalMs: 10_000,
  }, async () => ({}) as never, nodeAgentFetch);

  return {
    app,
    database,
    policy,
    stories,
    state,
    scheduler,
    registration,
    transportEvents,
    downstreamRequests,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

test("new node-agent revokes Content calls from a v0.0.32 controlled instance without changing its base Session", async () => {
  const context = await fixture();
  try {
    const before = structuredClone(context.state.listInstances()[0]!.aiSessions.sessions[0]);
    await context.policy.update("story_1", { content: false, actions: false, automations: false, aiSessions: false });
    const response = await context.app.inject({
      method: "GET",
      url: "/api/node-agent/instances/instance_1/ai-sessions/caller_1/story-content?page=1&pageSize=20",
      headers: { authorization: "Bearer token_1" },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "STORY_AGENT_TOOL_DISABLED");
    assert.deepEqual(context.state.listInstances()[0]!.aiSessions.sessions[0], before);
    assert.equal(context.state.authenticateInstance("instance_1", "token_1").id, "instance_1");
  } finally {
    await context.close();
  }
});

test("node-agent serves policy, Action, Automation, and AI Session reads with no Control Plane dependency", async () => {
  const context = await fixture();
  try {
    await context.policy.update("story_1", { content: true, actions: true, automations: true, aiSessions: true });
    const access = await context.registration.resolveStoryAgentToolsForStory("story_1");
    assert.equal(access.source, "node-agent");

    const actions = await context.registration.invokeStoryAgentTool("caller_1", "story_list_actions", {});
    assert.equal(actions.actions[0]?.id, "action_1");
    const actionRun = await context.registration.invokeStoryAgentTool("caller_1", "story_run_action", { actionId: "action_1", clientRequestId: "action_run" });
    assert.deepEqual(actionRun, { session: { instanceId: "instance_1", sessionId: "created_session" } });

    const automations = await context.registration.invokeStoryAgentTool("caller_1", "story_list_automations", {});
    assert.equal(automations.automations[0]?.id, "automation_1");
    const created = await context.registration.invokeStoryAgentTool("caller_1", "story_create_automation", {
      actionId: "action_1",
      schedule: { scheduleKind: "interval", intervalMs: 60_000 },
      enabled: true,
      policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
    });
    assert.equal(created.id, "automation_1");
    assert.equal("storyId" in created, false);

    const sessions = await context.registration.invokeStoryAgentTool("caller_1", "story_list_ai_sessions", {});
    assert.deepEqual(sessions.sessions.map((entry) => entry.sessionId), ["target_1"]);
    const detail = await context.registration.invokeStoryAgentTool("caller_1", "story_get_ai_session", { instanceId: "instance_2", sessionId: "target_1" });
    assert.equal("id" in detail.session, false);
    assert.deepEqual(detail.pagination, { totalItems: 0 });
    assert.equal("revision" in detail, false);
    assert.equal(context.downstreamRequests.length, 1);
    assert.ok(context.transportEvents.every((entry) => entry.startsWith("node-agent:")));
  } finally {
    await context.close();
  }
});
