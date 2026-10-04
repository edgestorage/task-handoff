import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerNodeStoryRoutes } from "../src/node-agent/stories/routes.ts";

const createdAt = "2026-09-28T00:00:00.000Z";

function fixture(options: { policy?: { assertEnabled: (storyId: string, tool: string) => Promise<void> }; withDecisions?: boolean } = {}) {
  const calls: Array<{ caller: unknown; input: unknown }> = [];
  const instance = {
    id: "instance_1",
    nodeId: "node_1",
    aiSessions: { sessions: [{ id: "caller_1", storyId: "story_1", activeTurnId: "turn_1" }] },
  };
  const state = {
    node: { id: "node_1" },
    authenticateInstance: () => instance,
    listInstances: () => [instance],
  };
  const store = {
    get: async (id: string) => id === "story_1" ? { id: "story_1", ownerNodeId: "node_1", title: "Story", documents: [], actions: [], createdAt, updatedAt: createdAt } : undefined,
  };
  const decisions = {
    async register(caller: unknown, input: unknown) {
      calls.push({ caller, input });
      return { id: "story_decision_1", status: "pending" };
    },
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const validation = Array.isArray((error as { issues?: unknown[] }).issues);
    return reply.code(validation ? 400 : (error as { statusCode?: number }).statusCode || 500).send({
      error: { code: validation ? "VALIDATION_ERROR" : (error as { code?: string }).code || "INTERNAL_ERROR", message: error.message },
    });
  });
  registerNodeStoryRoutes(app, state as never, store as never, {
    ...(options.withDecisions === false ? {} : { decisions: decisions as never }),
    toolPolicy: (options.policy ?? { assertEnabled: async () => {} }) as never,
  });
  const invoke = (tool: string, input: unknown) => app.inject({
    method: "POST",
    url: `/api/node-agent/instances/instance_1/ai-sessions/caller_1/story-agent-tools/${tool}`,
    payload: { input },
  });
  return { app, calls, invoke };
}

test("story_request_decision derives scope from the caller session and returns only the decision id and status", async () => {
  const { app, calls, invoke } = fixture();
  try {
    const response = await invoke("story_request_decision", { question: "Ship or hold?", options: [{ id: "ship", label: "Ship" }] });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data, { decisionId: "story_decision_1", status: "pending" });
    assert.deepEqual(calls, [{
      caller: { storyId: "story_1", sessionId: "caller_1", turnId: "turn_1" },
      input: { question: "Ship or hold?", options: [{ id: "ship", label: "Ship" }] },
    }]);
  } finally {
    await app.close();
  }
});

test("story_request_decision rejects caller-supplied identity fields through the strict wire model", async () => {
  const { app, calls, invoke } = fixture();
  try {
    const response = await invoke("story_request_decision", { question: "Ship?", sessionId: "other_session" });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("revoking the decisions policy rejects the next call without registering a decision", async () => {
  const { app, calls, invoke } = fixture({
    policy: { assertEnabled: async () => { throw Object.assign(new Error("Tool is disabled."), { code: "STORY_AGENT_TOOL_DISABLED", statusCode: 403 }); } },
  });
  try {
    const response = await invoke("story_request_decision", { question: "Ship?" });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "STORY_AGENT_TOOL_DISABLED");
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("a node-agent without the decisions domain returns a structured unavailable error", async () => {
  const { app, invoke } = fixture({ withDecisions: false });
  try {
    const response = await invoke("story_request_decision", { question: "Ship?" });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "STORY_DECISION_UNAVAILABLE");
  } finally {
    await app.close();
  }
});
