import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeStoryPlugin } from "./src/opencode-story-plugin.ts";

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
  assert.deepEqual(Object.keys(hooks.tool.story_get_content.args), ["storyPaths", "destinationPath"]);
  assert.equal("sessionID" in hooks.tool.story_get_content.args, false);
  assert.equal("storyId" in hooks.tool.story_get_content.args, false);
});
