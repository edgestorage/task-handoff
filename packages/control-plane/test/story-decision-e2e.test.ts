import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { StoryDecisionCommandService } from "../src/node-agent/stories/decision-service.ts";
import { registerNodeStoryRoutes } from "../src/node-agent/stories/routes.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const createdAt = "2026-09-28T00:00:00.000Z";

async function fixture() {
  const database = await createStoryDatabaseFixture("task-handoff-story-decision-e2e-");
  await database.repository.stories.insert({
    id: "story_1",
    title: "Decision Story",
    createdAt,
    updatedAt: createdAt,
    maxIdleAiSessions: 5,
    nextDocumentSequence: 1,
  });
  const sends: Array<{ url: string; body: unknown }> = [];
  const events: Array<{ change: string; revision: number }> = [];
  const instance = {
    id: "instance_1",
    nodeId: "node_1",
    registrationToken: "token_1",
    // 新实例声明发送幂等能力，node-agent 直接把 decisionId 作为 clientRequestId 传递。
    capabilities: { features: { aiSessionSendIdempotency: true } },
    aiSessions: { sessions: [{ id: "caller_1", storyId: "story_1", activeTurnId: "turn_1", status: "idle" }] },
  };
  const state = {
    node: { id: "node_1" },
    authenticateInstance: () => instance,
    listInstances: () => [instance],
  };
  const store = {
    get: async (id: string) => id === "story_1"
      ? { id: "story_1", ownerNodeId: "node_1", title: "Decision Story", documents: [], actions: [], createdAt, updatedAt: createdAt }
      : undefined,
  };
  const decisions = new StoryDecisionCommandService(
    state as never,
    database.repository,
    (async (url: string | URL | Request, init?: RequestInit) => {
      sends.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ data: { sessionId: "caller_1", turnId: "turn_new" } });
    }) as typeof fetch,
    async () => "http://instance.test",
    (event) => events.push({ change: event.change, revision: event.revision }),
  );
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const validation = Array.isArray((error as { issues?: unknown[] }).issues);
    return reply.code(validation ? 400 : (error as { statusCode?: number }).statusCode || 500).send({
      error: { code: validation ? "VALIDATION_ERROR" : (error as { code?: string }).code || "INTERNAL_ERROR", message: error.message },
    });
  });
  registerNodeStoryRoutes(app, state as never, store as never, {
    decisions,
    toolPolicy: { assertEnabled: async () => {} } as never,
  });
  const invokeTool = (tool: string, input: unknown) => app.inject({
    method: "POST",
    url: `/api/node-agent/instances/instance_1/ai-sessions/caller_1/story-agent-tools/${tool}`,
    payload: { input },
  });
  const decide = (decisionId: string, input: unknown) => app.inject({
    method: "POST",
    url: `/api/node-agent/stories/story_1/decisions/${decisionId}/decide`,
    payload: input,
  });
  const list = () => app.inject({ method: "GET", url: "/api/node-agent/stories/story_1/decisions" });
  return { app, sends, events, instance, invokeTool, decide, list, close: async () => { await app.close(); await database.close(); } };
}

test("Agent tool call registers a decision and a human ruling continues the session as a new turn", async () => {
  const context = await fixture();
  try {
    // 1. Agent 调用终态工具登记决策：只返回 decisionId 与状态，不阻塞、不产生会话发送。
    const registered = await context.invokeTool("story_request_decision", { question: "Ship or hold?", options: [{ id: "ship", label: "Ship" }] });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.deepEqual(Object.keys(registered.json().data).sort(), ["decisionId", "status"]);
    assert.equal(registered.json().data.status, "pending");
    assert.equal(context.sends.length, 0);
    assert.deepEqual(context.events, [{ change: "created", revision: 1 }]);
    // 工具是 turn 终态动作：不把会话置为 waiting，也不复用 provider 审批的 approval 表示。
    assert.equal(context.instance.aiSessions.sessions[0]!.status, "idle");
    assert.equal("waiting" in registered.json().data, false);
    assert.equal("phase" in registered.json().data, false);

    const decisionId = registered.json().data.decisionId as string;

    // 2. 人工下达：复用既有发送链路，以 decisionId 作为 clientRequestId，记录派生 decidedTurnId。
    const decided = await context.decide(decisionId, { optionId: "ship", expectedRevision: 1 });
    assert.equal(decided.statusCode, 200, decided.body);
    assert.equal(decided.json().data.status, "decided");
    assert.equal(decided.json().data.decidedTurnId, "turn_new");
    assert.equal(context.sends.length, 1);
    assert.match(context.sends[0]!.url, /\/api\/internal\/node-agent\/ai-sessions\/caller_1\/messages$/);
    assert.deepEqual(context.sends[0]!.body, { message: "Selected decision option: Ship", clientRequestId: decisionId });
    assert.deepEqual(context.events, [{ change: "created", revision: 1 }, { change: "decided", revision: 2 }]);

    // 3. 重复下达幂等：返回同一 decidedTurnId，不产生第二个 turn。
    const repeated = await context.decide(decisionId, { optionId: "ship", expectedRevision: 1 });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().data.decidedTurnId, "turn_new");
    assert.equal(context.sends.length, 1);

    // 4. 列表与事件一致地反映权威状态。
    const listed = await context.list();
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().data.decisions.map((decision: { id: string; status: string }) => [decision.id, decision.status]), [[decisionId, "decided"]]);
  } finally {
    await context.close();
  }
});
