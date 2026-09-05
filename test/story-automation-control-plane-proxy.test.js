const assert = require("node:assert/strict");
const test = require("node:test");
const Fastify = require("fastify");

const { registerStoryRoutes } = require("../packages/control-plane/src/control-plane/http/story-routes.ts");

const timestamp = "2026-09-05T00:00:00.000Z";
const automationStatus = {
  automation: {
    id: "automation_1",
    storyId: "story_1",
    actionId: "action_1",
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  effectiveStatus: "scheduled",
  currentRuns: [],
};

function fixture(responseData = automationStatus) {
  const requests = [];
  const node = { id: "node_1" };
  const service = {
    requireNode(id) {
      assert.equal(id, node.id);
      return node;
    },
    resolveNodeAgentTransport() {
      return {
        async request(target, route, init = {}) {
          requests.push({ target, route, init });
          return new Response(JSON.stringify({ data: responseData }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  };
  const app = Fastify({ logger: false });
  registerStoryRoutes(app, service);
  return { app, requests };
}

test("Control Plane strictly proxies Story Automation updates to the selected Node", async (t) => {
  const { app, requests } = fixture({
    ...automationStatus,
    automation: { ...automationStatus.automation, enabled: false },
    effectiveStatus: "disabled",
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: "/api/stories/story_1/automations/automation_1",
    payload: { nodeId: "node_1", input: { enabled: false } },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.effectiveStatus, "disabled");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, "/stories/story_1/automations/automation_1");
  assert.equal(requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].init.body), { enabled: false });

  const ownershipChange = await app.inject({
    method: "PATCH",
    url: "/api/stories/story_1/automations/automation_1",
    payload: { nodeId: "node_1", input: { storyId: "story_2" } },
  });
  assert.equal(ownershipChange.statusCode, 500);
  assert.equal(requests.length, 1);
});

test("Control Plane rejects invalid Story Automation responses from a Node", async (t) => {
  const { app } = fixture({ ...automationStatus, privateState: true });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/stories/story_1/automations/automation_1?nodeId=node_1",
  });

  assert.equal(response.statusCode, 500);
});

test("Control Plane proxies combined Action and Automation creation as one command", async (t) => {
  const { app, requests } = fixture();
  t.after(() => app.close());
  const input = {
    action: { id: "action_1", title: "Deploy", promptTemplate: "Deploy", targetInstanceId: "instance_1" },
    automation: { schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: true, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } },
  };
  const response = await app.inject({
    method: "POST",
    url: "/api/stories/story_1/automations/with-action",
    payload: { nodeId: "node_1", input },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, "/stories/story_1/automations/with-action");
  assert.deepEqual(JSON.parse(requests[0].init.body), input);
});
