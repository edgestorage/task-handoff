import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerStoryRoutes } from "../src/control-plane/http/story-routes.ts";

const revision = "b".repeat(64);
const timestamp = "2026-09-19T00:00:00.000Z";

function fixture(ownerNodeId = "node_one") {
  const requests: Array<{ route: string; init: RequestInit }> = [];
  const app = Fastify();
  const service = {
    requireNode(nodeId: string) {
      return { id: nodeId };
    },
    resolveNodeAgentTransport() {
      return {
        async request(_node: unknown, route: string, init: RequestInit = {}) {
          requests.push({ route, init });
          if (route === "/stories/story_one") {
            return new Response(JSON.stringify({ data: {
              id: "story_one",
              ownerNodeId,
              title: "Story",
              documents: [],
              actions: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            } }), { headers: { "content-type": "application/json" } });
          }
          if (route === "/stories/story_one/actions/action_one/run") {
            return new Response(JSON.stringify({ data: {
              targetInstanceId: "instance_one",
              aiSessionId: "session_one",
            } }), { headers: { "content-type": "application/json" } });
          }
          return new Response(JSON.stringify({ data: {
            policy: { content: true, actions: false, automations: false, aiSessions: false, future: true },
            revision,
            future: "ignored",
          } }), { headers: { "content-type": "application/json" } });
        },
      };
    },
  };
  registerStoryRoutes(app, service as never);
  return { app, requests };
}

test("Control Plane verifies Story ownership and normalizes Agent Tool settings", async () => {
  const { app, requests } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/stories/story_one/settings/agent-tools?nodeId=node_one" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: {
    policy: { content: true, actions: false, automations: false, aiSessions: false },
    revision,
  } });
  assert.deepEqual(requests.map(({ route }) => route), [
    "/stories/story_one",
    "/stories/story_one/settings/agent-tools",
  ]);
  await app.close();
});

test("Control Plane rejects mismatched Story node before forwarding settings", async () => {
  const { app, requests } = fixture("node_other");
  const response = await app.inject({ method: "GET", url: "/api/stories/story_one/settings/agent-tools?nodeId=node_one" });

  assert.equal(response.statusCode, 409);
  assert.equal(requests.length, 1);
  await app.close();
});

test("Control Plane forwards strict Agent Tool policy updates", async () => {
  const { app, requests } = fixture();
  const policy = { content: false, actions: true, automations: true, aiSessions: false };
  const response = await app.inject({
    method: "PUT",
    url: "/api/stories/story_one/settings/agent-tools",
    payload: { nodeId: "node_one", input: { policy } },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requests[1]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), { policy });
  await app.close();
});

test("Control Plane verifies Story ownership before forwarding Action execution", async () => {
  const { app, requests } = fixture();
  const response = await app.inject({
    method: "POST",
    url: "/api/stories/story_one/actions/action_one/run",
    payload: { nodeId: "node_one", input: { clientRequestId: "request_one" } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: { targetInstanceId: "instance_one", aiSessionId: "session_one" } });
  assert.deepEqual(requests.map(({ route }) => route), [
    "/stories/story_one",
    "/stories/story_one/actions/action_one/run",
  ]);
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), { clientRequestId: "request_one" });
  await app.close();
});
