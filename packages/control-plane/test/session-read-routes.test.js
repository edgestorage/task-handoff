import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSessionRoutes } from "../src/control-plane/http/session-routes.ts";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function createApp(overrides = {}) {
  const calls = [];
  const session = { id: "ais_fake0000001", storyId: "story_fake000001" };
  const aggregatorSessions = overrides.sessions ?? [session];
  const service = {
    aiSessionTranscript: async (instanceId, sessionId, tail) => {
      calls.push({ name: "transcript", instanceId, sessionId, tail });
      return { path: "/home/agent/.codex/rollout.jsonl", lineCount: 7, tail: "tail line" };
    },
    appSessionLogs: async (instanceId, sessionId, maxBytes) => {
      calls.push({ name: "logs", instanceId, sessionId, maxBytes });
      return { sessionId, logDir: "/data/logs", maxBytes: maxBytes ?? 65536, files: [] };
    },
    appSessionScreenshot: async (instanceId, sessionId) => {
      calls.push({ name: "screenshot", instanceId, sessionId });
      return { status: 200, headers: { "content-type": "image/png" }, body: new Blob([PNG_BYTES]).stream() };
    },
    requireControlledInstance: async (instanceId) => ({ id: instanceId, nodeId: "node_fake0001" }),
    requireNode: (nodeId) => ({ id: nodeId }),
    resolveNodeAgentTransport: () => ({
      request: async (node, route) => {
        calls.push({ name: "node-json", nodeId: node.id, route });
        return new Response(JSON.stringify({ data: { documents: [{ title: "Intro", storyPath: "intro.md", revision: "a".repeat(64) }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      requestStream: async (node, route) => {
        calls.push({ name: "node-stream", nodeId: node.id, route });
        return new Response("# Story\n", { status: 200, headers: { "content-type": "application/octet-stream", "content-length": "8", "x-story-revision": "b".repeat(64) } });
      },
    }),
    ...overrides.service,
  };
  const app = Fastify();
  registerSessionRoutes({
    app,
    service,
    events: { publish: () => {} },
    appSessionAggregator: { list: async () => ({ instances: [] }) },
    aiSessionAggregator: {
      list: async () => ({ updatedAt: new Date().toISOString(), instances: [{ instanceId: "instance_fake001", streamId: "stream_1", aiSessions: { updatedAt: new Date().toISOString(), runningCount: 0, waitingCount: 0, staleCount: 0, sessions: aggregatorSessions } }] }),
    },
    aiSessionAttachments: {},
    aiSessionAttachmentCache: {},
  });
  return { app, calls, service };
}

test("AI session transcript and app session logs are relayed through the instance gateway", async () => {
  const { app, calls } = createApp();
  try {
    const transcript = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/ai-sessions/ais_fake0000001/transcript?tail=25" });
    assert.equal(transcript.statusCode, 200);
    assert.deepEqual(transcript.json().data.tail, "tail line");
    assert.deepEqual(calls[0], { name: "transcript", instanceId: "instance_fake001", sessionId: "ais_fake0000001", tail: 25 });

    const logs = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fake001/logs?maxBytes=2048" });
    assert.equal(logs.statusCode, 200);
    assert.deepEqual(calls[1], { name: "logs", instanceId: "instance_fake001", sessionId: "appsess_fake001", maxBytes: 2048 });
  } finally {
    await app.close();
  }
});

test("app session screenshots stream binary PNG bytes", async () => {
  const { app, calls } = createApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fakegui1/screenshot" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.deepEqual(response.rawPayload, PNG_BYTES);
    assert.deepEqual(calls[0], { name: "screenshot", instanceId: "instance_fake001", sessionId: "appsess_fakegui1" });
  } finally {
    await app.close();
  }
});

test("session story content resolves the Story from the AI session snapshot", async () => {
  const { app, calls } = createApp();
  try {
    const listed = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/ai-sessions/ais_fake0000001/story-content" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.storyId, "story_fake000001");
    assert.equal(listed.json().data.documents[0].storyPath, "intro.md");
    assert.deepEqual(calls[0], { name: "node-json", nodeId: "node_fake0001", route: "/stories/story_fake000001/content" });

    const preview = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/ai-sessions/ais_fake0000001/story-content/preview?storyPath=intro.md" });
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(preview.json().data, { storyPath: "intro.md", revision: "b".repeat(64), content: "# Story\n", size: 8 });
  } finally {
    await app.close();
  }
});

test("story content reads require an AI session that is assigned to a Story", async () => {
  const { app } = createApp({ sessions: [{ id: "ais_fake0000002" }] });
  try {
    const response = await app.inject({ method: "GET", url: "/api/controlled-instances/instance_fake001/ai-sessions/ais_fake0000002/story-content" });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "STORY_CONTEXT_REQUIRED");
  } finally {
    await app.close();
  }
});
