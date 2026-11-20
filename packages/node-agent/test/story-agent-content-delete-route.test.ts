import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerNodeStoryRoutes } from "../src/stories/routes.ts";

const createdAt = "2026-11-20T00:00:00.000Z";

test("Story content delete tool scopes the document to the caller's Story", async () => {
  const calls: unknown[][] = [];
  const enabled: string[] = [];
  const instance = {
    id: "instance_1",
    nodeId: "node_1",
    aiSessions: { sessions: [{ id: "caller_1", storyId: "story_1" }] },
  };
  const app = Fastify();
  try {
    registerNodeStoryRoutes(app, {
      node: { id: "node_1" },
      authenticateInstance: () => instance,
      listInstances: () => [instance],
    } as never, {
      get: async (id: string) => id === "story_1" ? {
        id,
        ownerNodeId: "node_1",
        title: "Story",
        documents: [],
        actions: [],
        createdAt,
        updatedAt: createdAt,
      } : undefined,
      deleteDocument: async (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    } as never, {
      toolPolicy: {
        assertEnabled: async (_storyId: string, tool: string) => {
          enabled.push(tool);
        },
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/ai-sessions/caller_1/story-agent-tools/story_delete_content",
      payload: { input: { storyPath: "notes/release.md", expectedRevision: "a".repeat(64) } },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data, { deleted: true });
    assert.deepEqual(calls, [["story_1", "notes/release.md", "a".repeat(64)]]);
    assert.deepEqual(enabled, ["story_delete_content"]);
  } finally {
    await app.close();
  }
});
