import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerStoryRoutes } from "../src/control-plane/http/story-routes.ts";

const timestamp = "2026-11-26T00:00:00.000Z";

function fixture(options: { ownerNodeId?: string; contextSettings?: boolean; contextResponse?: unknown } = {}) {
  const requests: Array<{ route: string; init: RequestInit }> = [];
  const app = Fastify();
  const ownerNodeId = options.ownerNodeId ?? "node_one";
  const service = {
    requireNode(nodeId: string) {
      return {
        id: nodeId,
        capabilities: {
          agent: {
            capabilities: {
              stories: {
                enabled: true,
                ...(options.contextSettings === false ? {} : { contextSettings: { settings: true, projects: true, sessionPrompting: true } }),
              },
            },
          },
        },
      };
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
          return new Response(JSON.stringify({ data: options.contextResponse ?? {
            storyId: "story_one",
            revision: 3,
            projectFolderIds: ["folder_one"],
            appendedPrompt: "Keep context",
            updatedAt: timestamp,
            future: "ignored",
          } }), { headers: { "content-type": "application/json" } });
        },
      };
    },
  };
  registerStoryRoutes(app, service as never);
  return { app, requests };
}

test("Control Plane proxies Story context settings with sanitized authoritative responses", async () => {
  const { app, requests } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/stories/story_one/settings/context?nodeId=node_one" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: {
    storyId: "story_one",
    revision: 3,
    projectFolderIds: ["folder_one"],
    appendedPrompt: "Keep context",
    updatedAt: timestamp,
  } });
  assert.deepEqual(requests.map(({ route }) => route), [
    "/stories/story_one",
    "/stories/story_one/settings/context",
  ]);
  await app.close();
});

test("Control Plane rejects old Nodes with a structured context-settings unsupported error", async () => {
  const { app, requests } = fixture({ contextSettings: false });
  const response = await app.inject({ method: "GET", url: "/api/stories/story_one/settings/context?nodeId=node_one" });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "STORY_CONTEXT_SETTINGS_UNSUPPORTED");
  assert.deepEqual(requests.map(({ route }) => route), ["/stories/story_one"]);
  await app.close();
});

test("Control Plane forwards strict Story context updates only to the owner Node", async () => {
  const { app, requests } = fixture();
  const response = await app.inject({
    method: "PUT",
    url: "/api/stories/story_one/settings/context",
    payload: {
      nodeId: "node_one",
      input: { expectedRevision: 2, projectFolderIds: ["folder_one"], appendedPrompt: "Updated" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.revision, 3);
  assert.equal(requests[1]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
    expectedRevision: 2,
    projectFolderIds: ["folder_one"],
    appendedPrompt: "Updated",
  });
  await app.close();
});

test("Control Plane never forwards context settings for a mismatched Story owner", async () => {
  const { app, requests } = fixture({ ownerNodeId: "node_other" });
  const response = await app.inject({
    method: "PUT",
    url: "/api/stories/story_one/settings/context",
    payload: { nodeId: "node_one", input: { expectedRevision: 0, projectFolderIds: [], appendedPrompt: "" } },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(requests.length, 1);
  await app.close();
});
