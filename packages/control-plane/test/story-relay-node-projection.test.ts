import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerStoryRoutes } from "../src/control-plane/http/story-routes.ts";

const CONTROL_PLANE_NODE_ID = "node_05xrelaystory";
const MACHINE_NODE_ID = "node_machine_story_owner";
const STORY_ID = "story_05xrelaystory";
const timestamp = "2026-10-22T00:00:00.000Z";

function story(ownerNodeId: string) {
  return {
    id: STORY_ID,
    ownerNodeId,
    title: "Relay Story",
    documents: [],
    actions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("cloud-relay Story responses use the Control Plane local node identity", async () => {
  const node = {
    id: CONTROL_PLANE_NODE_ID,
    connectionMode: "cloud-relay",
    connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_05xrelaystory" },
  };
  const service = {
    listNodes: () => [node],
    requireNode: (nodeId: string) => {
      if (nodeId !== node.id) throw Object.assign(new Error("Node not found."), { statusCode: 404, code: "NODE_NOT_FOUND" });
      return node;
    },
    resolveNodeAgentTransport: () => ({
      async request(_node: unknown, route: string) {
        return new Response(JSON.stringify({
          data: route === "/stories" ? { stories: [story(MACHINE_NODE_ID)] } : story(MACHINE_NODE_ID),
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
  const app = Fastify();
  registerStoryRoutes(app, service as never);
  try {
    const list = await app.inject({ method: "GET", url: `/api/stories?nodeId=${encodeURIComponent(node.id)}` });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.stories[0].ownerNodeId, node.id);

    const detail = await app.inject({ method: "GET", url: `/api/stories/${encodeURIComponent(STORY_ID)}?nodeId=${encodeURIComponent(node.id)}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().data.ownerNodeId, node.id);
  } finally {
    await app.close();
  }
});
