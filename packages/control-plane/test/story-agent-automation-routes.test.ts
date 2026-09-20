import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerNodeStoryRoutes } from "../src/node-agent/stories/routes.ts";

const createdAt = "2026-09-19T00:00:00.000Z";
const updatedAt = "2026-09-19T00:01:00.000Z";
const automation = {
  id: "automation_1",
  storyId: "story_1",
  actionId: "action_1",
  schedule: { scheduleKind: "interval" as const, intervalMs: 60_000 },
  enabled: true,
  policy: { maxConcurrentRuns: 1, whenBusy: "queue" as const },
  createdAt,
  updatedAt,
};
const status = { automation, effectiveStatus: "scheduled" as const, currentRuns: [] };
const run = {
  id: "run_1",
  automationId: automation.id,
  eventType: "manual" as const,
  status: "queued" as const,
  scheduledFor: updatedAt,
  targetInstanceId: "instance_1",
  queuedAt: updatedAt,
};

function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const aiSessionRead = {
    list: (...args: unknown[]) => {
      calls.push({ method: "sessionList", args });
      return { sessions: [], pagination: { totalItems: 0 } };
    },
    async get(...args: unknown[]) {
      calls.push({ method: "sessionGet", args });
      return { ref: { instanceId: "instance_2", sessionId: "target_1" }, session: {}, turns: [], pagination: { totalItems: 0 } };
    },
    async turn(...args: unknown[]) {
      calls.push({ method: "sessionTurn", args });
      return {
        ref: { instanceId: "instance_2", sessionId: "target_1" },
        turn: { id: "turn_1" },
        items: [],
        pagination: { totalItems: 0 },
      };
    },
  };
  const scheduler = {
    async list(...args: unknown[]) { calls.push({ method: "list", args }); return [status]; },
    async create(...args: unknown[]) { calls.push({ method: "create", args }); return status; },
    async status(...args: unknown[]) { calls.push({ method: "status", args }); return status; },
    async update(...args: unknown[]) { calls.push({ method: "update", args }); return { ...status, automation: { ...automation, enabled: false, updatedAt: "2026-09-19T00:02:00.000Z" }, effectiveStatus: "disabled" }; },
    async delete(...args: unknown[]) { calls.push({ method: "delete", args }); return true; },
    async manualRun(...args: unknown[]) { calls.push({ method: "manualRun", args }); return run; },
    async runs(...args: unknown[]) { calls.push({ method: "runs", args }); return [run]; },
  };
  const instance = { id: "instance_1", nodeId: "node_1", aiSessions: { sessions: [{ id: "caller_1", storyId: "story_1" }] } };
  const state = {
    node: { id: "node_1" },
    authenticateInstance: () => instance,
    listInstances: () => [instance],
  };
  const store = {
    get: async (id: string) => id === "story_1" ? {
      id: "story_1", ownerNodeId: "node_1", title: "Story", documents: [],
      actions: [{ id: "action_1", title: "Run", promptTemplate: "x".repeat(600), targetInstanceId: "instance_1" }],
      createdAt, updatedAt,
    } : undefined,
  };
  const enabled: string[] = [];
  const app = Fastify();
  registerNodeStoryRoutes(app, state as never, store as never, {
    scheduler: scheduler as never,
    aiSessionRead: aiSessionRead as never,
    toolPolicy: { assertEnabled: async (_storyId: string, tool: string) => { enabled.push(tool); } } as never,
  });
  const invoke = (tool: string, input: unknown) => app.inject({
    method: "POST",
    url: `/api/node-agent/instances/instance_1/ai-sessions/caller_1/story-agent-tools/${tool}`,
    payload: { input },
  });
  return { app, calls, enabled, invoke };
}

test("Automation Agent tools adapt the caller Story to the authoritative scheduler", async () => {
  const { app, calls, enabled, invoke } = fixture();
  try {
    const actions = await invoke("story_list_actions", {});
    assert.equal(actions.statusCode, 200, actions.body);
    assert.equal(actions.json().data.actions[0].promptPreview.length, 500);
    assert.equal(actions.json().data.actions[0].promptTruncated, true);
    assert.equal(actions.json().data.actions[0].executable, true);
    assert.equal("promptTemplate" in actions.json().data.actions[0], false);
    assert.equal("targetInstanceId" in actions.json().data.actions[0], false);

    const list = await invoke("story_list_automations", {});
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.automations[0].id, "automation_1");
    assert.equal("storyId" in list.json().data.automations[0], false);
    assert.deepEqual(list.json().data.pagination, { totalItems: 1 });

    const create = await invoke("story_create_automation", {
      actionId: "action_1",
      schedule: { scheduleKind: "interval", intervalMs: 60_000 },
      enabled: true,
      policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
    });
    assert.equal(create.statusCode, 200, create.body);

    const update = await invoke("story_update_automation", {
      automationId: "automation_1",
      expectedUpdatedAt: updatedAt,
      enabled: false,
    });
    assert.equal(update.statusCode, 200, update.body);

    const manual = await invoke("story_run_automation", { automationId: "automation_1", clientRequestId: "request_1" });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.equal("executionInput" in manual.json().data, false);
    assert.equal("targetInstanceId" in manual.json().data, false);

    const runs = await invoke("story_list_automation_runs", { automationId: "automation_1" });
    assert.equal(runs.statusCode, 200, runs.body);
    assert.deepEqual(runs.json().data.runs, [{
      id: "run_1",
      eventType: "manual",
      status: "queued",
      scheduledFor: updatedAt,
    }]);
    assert.deepEqual(runs.json().data.pagination, { totalItems: 1 });

    const remove = await invoke("story_delete_automation", { automationId: "automation_1", expectedUpdatedAt: updatedAt });
    assert.equal(remove.statusCode, 200, remove.body);
    assert.deepEqual(remove.json().data, { deleted: true });

    assert.deepEqual(calls.find((call) => call.method === "create")?.args, [{ storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: true, policy: { maxConcurrentRuns: 1, whenBusy: "queue" } }]);
    assert.deepEqual(calls.find((call) => call.method === "update")?.args, ["automation_1", { enabled: false }, updatedAt]);
    assert.deepEqual(calls.find((call) => call.method === "manualRun")?.args, ["automation_1", { clientRequestId: "request_1" }]);
    assert.deepEqual(calls.find((call) => call.method === "delete")?.args, ["automation_1", updatedAt]);
    assert.deepEqual(enabled, [
      "story_list_actions", "story_list_automations", "story_create_automation", "story_update_automation",
      "story_run_automation", "story_list_automation_runs", "story_delete_automation",
    ]);
  } finally {
    await app.close();
  }
});

test("AI Session Agent tools pass the authenticated caller scope to the read service", async () => {
  const { app, calls, invoke } = fixture();
  const caller = { instanceId: "instance_1", sessionId: "caller_1", storyId: "story_1" };
  try {
    assert.equal((await invoke("story_list_ai_sessions", {})).statusCode, 200);
    assert.equal((await invoke("story_get_ai_session", { instanceId: "instance_2", sessionId: "target_1" })).statusCode, 200);
    assert.equal((await invoke("story_get_ai_session_turn", { instanceId: "instance_2", sessionId: "target_1", turnId: "turn_1" })).statusCode, 200);
    assert.deepEqual(calls.find((call) => call.method === "sessionList")?.args, [caller, 1, 20]);
    assert.deepEqual(calls.find((call) => call.method === "sessionGet")?.args, [caller, "instance_2", "target_1", 1, 10]);
    assert.deepEqual(calls.find((call) => call.method === "sessionTurn")?.args, [caller, "instance_2", "target_1", "turn_1", 1, 20, 8_000]);
  } finally {
    await app.close();
  }
});

test("Automation Agent tools reject an Automation from another Story", async () => {
  const foreign = { ...status, automation: { ...automation, storyId: "story_2" } };
  const app = Fastify();
  try {
    const instance = { id: "instance_1", aiSessions: { sessions: [{ id: "caller_1", storyId: "story_1" }] } };
    registerNodeStoryRoutes(app, { node: { id: "node_1" }, authenticateInstance: () => instance, listInstances: () => [instance] } as never, {
      get: async () => ({ id: "story_1", actions: [], documents: [], title: "Story", ownerNodeId: "node_1", createdAt, updatedAt }),
    } as never, {
      scheduler: { status: async () => foreign } as never,
      toolPolicy: { assertEnabled: async () => undefined } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/ai-sessions/caller_1/story-agent-tools/story_delete_automation",
      payload: { input: { automationId: "automation_1", expectedUpdatedAt: updatedAt } },
    });
    assert.equal(response.statusCode, 409, response.body);
  } finally {
    await app.close();
  }
});
