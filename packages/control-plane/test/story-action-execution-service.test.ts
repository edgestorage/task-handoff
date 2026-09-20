import assert from "node:assert/strict";
import test from "node:test";
import { StoryActionExecutionService } from "../src/node-agent/stories/action-execution-service.ts";

function fixture(overrides: {
  archivedAt?: string;
  targetInstanceId?: string;
  instanceNodeId?: string;
  fetchImpl?: typeof fetch;
} = {}) {
  const instance = {
    id: "instance_1",
    nodeId: overrides.instanceNodeId || "node_1",
    registrationToken: "registration-token",
    runtimeId: "runtime_1",
    runtime: { workspacePath: "/runtime/workspace" },
    workspace: { path: "/legacy/workspace" },
    source: { type: "local-folder", path: "/host/workspace" },
  };
  const story = {
    id: "story_1",
    archivedAt: overrides.archivedAt,
    actions: [{
      id: "action_1",
      title: "Deploy",
      promptTemplate: "Deploy the current release",
      ...(overrides.targetInstanceId === undefined ? { targetInstanceId: "instance_1" } : overrides.targetInstanceId ? { targetInstanceId: overrides.targetInstanceId } : {}),
      sessionPreset: {
        agent: "codex",
        permissionMode: "auto-review",
        cwdFolderId: "folder_1",
        modelSelection: { modelEntityId: "model_1", modelName: "gpt-5" },
      },
    }],
  };
  const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const fetchImpl = overrides.fetchImpl || (async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({ data: { disposition: "created", aiSessionId: "session_1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const state = {
    node: { id: "node_1" },
    requireInstance: (id: string) => {
      if (id !== instance.id) throw Object.assign(new Error("Instance not found."), { code: "NODE_INSTANCE_NOT_FOUND", statusCode: 404 });
      return instance;
    },
    localFolders: { get: (id: string) => id === "folder_1" ? { id, path: "/host/workspace/packages/app" } : undefined },
    requireRuntime: () => ({ type: "docker" }),
  };
  const stories = { automationContext: async (id: string) => id === story.id ? story : undefined };
  return {
    requests,
    service: new StoryActionExecutionService(state as never, stories as never, fetchImpl, async () => "http://instance.local"),
  };
}

test("Story Action execution resolves the persisted target and preset into one private create request", async () => {
  const { service, requests } = fixture();
  assert.deepEqual(await service.run("story_1", "action_1", "request_1"), {
    targetInstanceId: "instance_1",
    aiSessionId: "session_1",
  });
  assert.equal(requests[0]?.url, "http://instance.local/api/internal/node-agent/story-automation/ai-sessions");
  assert.equal(requests[0]?.authorization, "Bearer registration-token");
  assert.deepEqual(requests[0]?.body, {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/runtime/workspace/packages/app" },
    cwdFolderId: "folder_1",
    message: "Deploy the current release",
    permissionMode: "auto-review",
    clientRequestId: "request_1",
    modelSelection: { modelEntityId: "model_1", modelName: "gpt-5" },
    storyId: "story_1",
  });
});

test("Story Action execution preserves the client request id across retries", async () => {
  const { service, requests } = fixture();
  await service.run("story_1", "action_1", "stable_request");
  await service.run("story_1", "action_1", "stable_request");
  assert.deepEqual(requests.map((request) => (request.body as { clientRequestId: string }).clientRequestId), ["stable_request", "stable_request"]);
});

test("historical targetless, archived, and cross-node Actions fail before dispatch", async () => {
  const cases = [
    { fixture: fixture({ targetInstanceId: "" }), code: "STORY_ACTION_TARGET_REQUIRED" },
    { fixture: fixture({ archivedAt: "2026-09-19T00:00:00.000Z" }), code: "STORY_ARCHIVED" },
    { fixture: fixture({ instanceNodeId: "node_2" }), code: "STORY_NODE_MISMATCH" },
  ];
  for (const entry of cases) {
    await assert.rejects(
      () => entry.fixture.service.run("story_1", "action_1", "request_1"),
      (error: any) => error.code === entry.code,
    );
    assert.equal(entry.fixture.requests.length, 0);
  }
});
