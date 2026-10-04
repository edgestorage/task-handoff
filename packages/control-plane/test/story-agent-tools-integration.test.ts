import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { NodeAgentRegistrationClient } from "@task-handoff/controlled-instance/web/node-agent-client";
import { registerNodeStoryRoutes } from "../src/node-agent/stories/routes.ts";
import { StoryAiSessionReadService } from "../src/node-agent/stories/ai-session-read-service.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";
import { StoryToolPolicyService } from "../src/node-agent/stories/tool-policy-service.ts";
import { defaultAgentOrchestrationId } from "@task-handoff/protocol/agent-orchestrations";
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

async function fixture(options: { deferAgentRunResult?: boolean } = {}) {
  const database = await createStoryDatabaseFixture("task-handoff-story-tools-integration-");
  await seedStoryAction(database.repository);
  const stories = new NodeStoryStore(database.paths, "node_1", database.repository);
  await stories.init();
  const policy = new StoryToolPolicyService(database.repository);
  database.repository.agents.definitions.insert({
    id: "agent_1",
    name: "Reviewer",
    description: "",
    appendedPrompt: "Review carefully",
    targetInstanceId: "instance_1",
    cwdFolderId: "folder_1",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  }, timestamp);
  database.repository.agents.orchestrations.insert({
    id: defaultAgentOrchestrationId("agent_1"),
    name: "Reviewer",
    agentIds: ["agent_1"],
    edges: [],
  }, timestamp);
  database.repository.agents.storyEntries.replace("story_1", [{ agentId: "agent_1", orchestrationId: defaultAgentOrchestrationId("agent_1") }], timestamp);
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
  const agentRunCalls: Array<Record<string, unknown>> = [];
  let resolveAgentRunResult: ((value: unknown) => void) | undefined;
  const deferredAgentRunResult = options.deferAgentRunResult
    ? new Promise((resolve) => { resolveAgentRunResult = resolve; })
    : undefined;
  registerNodeStoryRoutes(app, state as never, stories, {
    toolPolicy: policy,
    scheduler: scheduler as never,
    aiSessionRead,
    actionExecution: { run: async () => ({ targetInstanceId: "instance_1", aiSessionId: "created_session" }) } as never,
    onToolPolicyInvalidated: (event) => { registration?.invalidateStoryAgentTools(event); },
    agentRuns: {
      create: (input: Record<string, unknown>) => {
        agentRunCalls.push(input);
        return { runId: "run_1" };
      },
      waitForToolResult: async () => deferredAgentRunResult ?? ({ runId: "run_1", status: "completed", result: { text: "done", truncated: false } }),
    } as never,
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
    agentRunCalls,
    completeAgentRun: () => resolveAgentRunResult?.({ runId: "run_1", status: "completed", result: { text: "done", truncated: false } }),
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
    await context.policy.update("story_1", { content: false, actions: false, automations: false, aiSessions: false, decisions: false });
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

test("an accepted Agent Run continues after entry revocation and initiating Session deletion", async () => {
  const context = await fixture({ deferAgentRunResult: true });
  try {
    const responsePromise = context.app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/ai-sessions/caller_1/agent-runs",
      headers: { authorization: "Bearer token_1" },
      payload: { clientRequestId: "agent_tool_call_accepted", input: { agentId: "agent_1", prompt: "Review" } },
    });
    while (context.agentRunCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    context.database.repository.agents.storyEntries.replace("story_1", [], timestamp);
    context.state.listInstances()[0]!.aiSessions.sessions = [];
    context.completeAgentRun();
    const response = await responsePromise;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.status, "completed");
  } finally {
    await context.close();
  }
});

test("Agent invocation is session-bound, reauthorized at call time, and rejects model-owned provenance", async () => {
  const context = await fixture();
  try {
    const result = await context.registration.invokeAgentRun("caller_1", "agent_tool_call_1", {
      agentId: "agent_1",
      prompt: "Review this change",
    });
    assert.deepEqual(result, { runId: "run_1", status: "completed", result: { text: "done", truncated: false } });
    assert.deepEqual(context.agentRunCalls[0], {
      clientRequestId: "agent_tool_call_1",
      orchestrationId: defaultAgentOrchestrationId("agent_1"),
      entryAgentId: "agent_1",
      input: { prompt: "Review this change" },
      provenance: { initiatingInstanceId: "instance_1", initiatingAiSessionId: "caller_1", storyId: "story_1" },
      budget: undefined,
    });

    const injected = await context.app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/ai-sessions/caller_1/agent-runs",
      headers: { authorization: "Bearer token_1" },
      payload: {
        clientRequestId: "agent_tool_call_2",
        input: { agentId: "agent_1", prompt: "Review", provenance: { storyId: "story_other" } },
      },
    });
    assert.equal(injected.statusCode, 500);
    assert.equal(context.agentRunCalls.length, 1);

    context.database.repository.agents.storyEntries.replace("story_1", [], timestamp);
    const revoked = await context.app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/ai-sessions/caller_1/agent-runs",
      headers: { authorization: "Bearer token_1" },
      payload: { clientRequestId: "agent_tool_call_3", input: { agentId: "agent_1", prompt: "Review" } },
    });
    assert.equal(revoked.statusCode, 403);
    assert.equal(revoked.json().error.code, "STORY_AGENT_INVOCATION_FORBIDDEN");
    assert.equal(context.agentRunCalls.length, 1);
  } finally {
    await context.close();
  }
});

test("node-agent serves policy, Action, Automation, and AI Session reads with no Control Plane dependency", async () => {
  const context = await fixture();
  try {
    await context.policy.update("story_1", { content: true, actions: true, automations: true, aiSessions: true, decisions: true });
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
