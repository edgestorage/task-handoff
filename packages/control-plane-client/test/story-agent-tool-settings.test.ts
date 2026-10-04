import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneStoriesApi } from "../src/stories.ts";

const revision = "a".repeat(64);

test("Stories client owns Agent Tool settings routes and sanitizes responses", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport = {
    async request(path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) {
      requests.push({ path, init });
      return schema.parse({
        data: {
          policy: { content: true, actions: true, automations: false, aiSessions: false, decisions: false, future: true },
          revision,
          future: "ignored",
        },
      });
    },
  };
  const stories = createControlPlaneStoriesApi(transport as never);

  assert.deepEqual(await stories.agentToolSettings("story/one", "node one"), {
    policy: { content: true, actions: true, automations: false, aiSessions: false, decisions: false },
    revision,
  });
  await stories.updateAgentToolSettings("story/one", "node one", {
    content: false,
    actions: true,
    automations: true,
    aiSessions: false,
    decisions: false,
  });

  assert.equal(requests[0]?.path, "/api/stories/story%2Fone/settings/agent-tools?nodeId=node%20one");
  assert.equal(requests[1]?.path, "/api/stories/story%2Fone/settings/agent-tools");
  assert.equal(requests[1]?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    nodeId: "node one",
    input: { policy: { content: false, actions: true, automations: true, aiSessions: false, decisions: false } },
  });
});

test("Stories client rejects malformed Agent Tool settings", async () => {
  const stories = createControlPlaneStoriesApi({
    async request(_path: string, schema: { parse(value: unknown): unknown }) {
      return schema.parse({ data: { policy: { content: true }, revision } });
    },
  } as never);

  await assert.rejects(() => stories.agentToolSettings("story_one", "node_one"));
});

test("Stories client runs a preset Action through its Story owner node", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const stories = createControlPlaneStoriesApi({
    async request(path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) {
      requests.push({ path, init });
      return schema.parse({ data: { targetInstanceId: "instance_1", aiSessionId: "session_1" } });
    },
  } as never);

  assert.deepEqual(await stories.runAction("story/one", "action one", "node one", "request one"), {
    targetInstanceId: "instance_1",
    aiSessionId: "session_1",
  });
  assert.equal(requests[0]?.path, "/api/stories/story%2Fone/actions/action%20one/run");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    nodeId: "node one",
    input: { clientRequestId: "request one" },
  });
});

test("Stories client owns Story decision read and decision routes", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const decision = {
    id: "decision_1",
    storyId: "story_1",
    sessionId: "session_1",
    turnId: "turn_1",
    question: "Ship or hold?",
    options: [],
    allowFreeText: true,
    status: "pending",
    revision: 1,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
  const stories = createControlPlaneStoriesApi({
    async request(path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) {
      requests.push({ path, init });
      return schema.parse({ data: path.endsWith("/decisions?nodeId=node_one") ? { decisions: [decision] } : { ...decision, status: "decided", revision: 2 } });
    },
  } as never);

  assert.equal((await stories.listDecisions("story_1", "node_one")).decisions[0]?.id, "decision_1");
  assert.equal((await stories.decideStory("story_1", "decision_1", "node_one", { response: "ship", expectedRevision: 1 })).status, "decided");
  assert.equal((await stories.cancelDecision("story_1", "decision_1", "node_one", { expectedRevision: 1 })).status, "decided");

  assert.equal(requests[0]?.path, "/api/stories/story_1/decisions?nodeId=node_one");
  assert.equal(requests[1]?.path, "/api/stories/story_1/decisions/decision_1/decide");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { nodeId: "node_one", input: { response: "ship", expectedRevision: 1 } });
  assert.equal(requests[2]?.path, "/api/stories/story_1/decisions/decision_1/cancel");
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), { nodeId: "node_one", input: { expectedRevision: 1 } });
});
