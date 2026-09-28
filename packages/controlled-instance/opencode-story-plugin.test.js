import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeStoryPlugin } from "./src/opencode-story-plugin.ts";
import { STORY_AGENT_TOOL_NAMES } from "@task-handoff/protocol/story-agent-tools";
import { AGENT_INVOCATION_TOOL_NAMES } from "@task-handoff/protocol/agent-invocation-tools";

test("OpenCode Story plugin forwards the host-provided session identity", async () => {
  let request;
  const plugin = createOpenCodeStoryPlugin({
    endpoint: "http://127.0.0.1:8080/api/internal/agent-tools",
    token: "private-token",
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: { pagination: { hasMore: false } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const hooks = await plugin();
  const result = await hooks.tool.story_list_content.execute({}, {
    sessionID: "ses_opencode_1",
    abort: new AbortController().signal,
  });

  assert.equal(request.url, "http://127.0.0.1:8080/api/internal/agent-tools/invoke");
  assert.equal(request.init.headers.authorization, "Bearer private-token");
  assert.deepEqual(JSON.parse(request.init.body), {
    provider: "opencode",
    providerSessionId: "ses_opencode_1",
    tool: "story_list_content",
    arguments: {},
  });
  assert.deepEqual(JSON.parse(result), { pagination: { hasMore: false } });
});

test("OpenCode Story plugin does not expose session identity as a model argument", async () => {
  const hooks = await createOpenCodeStoryPlugin()();
  assert.deepEqual(Object.keys(hooks.tool), [...STORY_AGENT_TOOL_NAMES, ...AGENT_INVOCATION_TOOL_NAMES]);
  assert.deepEqual(Object.keys(hooks.tool.story_get_content.args), ["storyPaths", "destinationPath"]);
  assert.equal("sessionID" in hooks.tool.story_get_content.args, false);
  assert.equal("storyId" in hooks.tool.story_get_content.args, false);
  assert.deepEqual(Object.keys(hooks.tool.agent_run.args), ["agentId", "orchestrationId", "prompt", "budget"]);
  assert.equal("clientRequestId" in hooks.tool.agent_run.args, false);
  assert.equal("providerSessionId" in hooks.tool.agent_run.args, false);
});

test("OpenCode Agent tool forwards provider-owned call identity outside model arguments", async () => {
  let request;
  const hooks = await createOpenCodeStoryPlugin({
    endpoint: "http://127.0.0.1:8080/api/internal/agent-tools",
    token: "private-token",
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: { runId: "run-1", status: "completed", result: { text: "done", truncated: false } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  })();
  const result = await hooks.tool.agent_run.execute({ agentId: "agent-1", prompt: "Review" }, {
    sessionID: "ses-opencode-1",
    callID: "call-1",
    abort: new AbortController().signal,
  });
  assert.deepEqual(JSON.parse(request.init.body), {
    provider: "opencode",
    providerSessionId: "ses-opencode-1",
    tool: "agent_run",
    arguments: { agentId: "agent-1", prompt: "Review" },
    callId: "call-1",
  });
  assert.equal(JSON.parse(result).runId, "run-1");
});
