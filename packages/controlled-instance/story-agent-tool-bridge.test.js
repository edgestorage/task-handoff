import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StoryAgentToolBridge } from "./src/web/story-agent-tool-bridge.ts";
import { STORY_AGENT_TOOL_NAMES } from "@task-handoff/protocol/story-agent-tools";
import { AGENT_INVOCATION_TOOL_NAMES } from "@task-handoff/protocol/agent-invocation-tools";

function testBridge(invocations) {
  return new StoryAgentToolBridge({
    token: "bridge-token",
    endpoint: "http://127.0.0.1/unused",
    service: {
      invoke: async (session, tool, args) => {
        invocations.push({ session, tool, args });
        if (tool === "story_run_action") return { session: { instanceId: "instance-1", sessionId: "created-session" } };
        return { source: session.id, tool, args };
      },
      invokeAgentRun: async (session, args, clientRequestId) => {
        invocations.push({ session, tool: "agent_run", args, clientRequestId });
        return { runId: "run-1", status: "completed", result: { text: "done", truncated: false } };
      },
    },
    resolveSession: (provider, providerSessionId) => providerSessionId === `${provider}-provider-session`
      ? { id: `${provider}-ai-session`, agent: provider, storyId: "story-1" }
      : undefined,
  });
}

test("OpenCode bridge authenticates and resolves provider session identity", async () => {
  const invocations = [];
  const app = Fastify();
  testBridge(invocations).register(app);

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/internal/agent-tools/invoke",
    payload: { provider: "opencode", providerSessionId: "opencode-provider-session", tool: "story_list_content", arguments: {} },
  });
  assert.equal(forbidden.statusCode, 403);

  const response = await app.inject({
    method: "POST",
    url: "/api/internal/agent-tools/invoke",
    headers: { authorization: "Bearer bridge-token" },
    payload: { provider: "opencode", providerSessionId: "opencode-provider-session", tool: "story_list_content", arguments: {} },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.source, "opencode-ai-session");
  assert.equal(invocations[0].session.storyId, "story-1");
  await app.close();
});

test("provider runtime environments only expose the OpenCode plugin path to OpenCode", () => {
  const bridge = new StoryAgentToolBridge({
    token: "bridge-token",
    endpoint: "http://127.0.0.1/api/internal/agent-tools",
    pluginPath: "/runtime/opencode-story-plugin.mjs",
    service: { invoke: async () => ({}) },
    resolveSession: () => undefined,
  });

  assert.deepEqual(bridge.runtimeEnvironment(), {
    TASK_HANDOFF_AGENT_TOOLS_ENDPOINT: "http://127.0.0.1/api/internal/agent-tools",
    TASK_HANDOFF_AGENT_TOOLS_TOKEN: "bridge-token",
  });
  assert.deepEqual(bridge.openCodeRuntimeEnvironment(), {
    ...bridge.runtimeEnvironment(),
    TASK_HANDOFF_OPENCODE_STORY_PLUGIN: "/runtime/opencode-story-plugin.mjs",
  });
});

test("Codex MCP bridge uses trusted request metadata to resolve an existing AI Session", async () => {
  const invocations = [];
  const app = Fastify();
  testBridge(invocations).register(app);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://controlled-instance.test/api/internal/agent-tools/mcp"),
    {
      requestInit: { headers: { authorization: "Bearer bridge-token" } },
      fetch: async (input, init) => {
        const url = input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
        const response = await app.inject({
          method: init?.method || "GET",
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          payload: init?.body ? String(init.body) : undefined,
        });
        return new Response(response.rawPayload, { status: response.statusCode, headers: response.headers });
      },
    },
  );
  const client = new Client({ name: "story-bridge-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...STORY_AGENT_TOOL_NAMES, ...AGENT_INVOCATION_TOOL_NAMES].sort());
    const readOnlyTools = listed.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(readOnlyTools, [
      "story_get_ai_session",
      "story_get_ai_session_turn",
      "story_list_actions",
      "story_list_ai_sessions",
      "story_list_automation_runs",
      "story_list_automations",
      "story_list_content",
    ]);
    assert.equal(listed.tools.find((tool) => tool.name === "story_get_content")?.annotations?.readOnlyHint, undefined);
    assert.equal(listed.tools.find((tool) => tool.name === "story_set_content")?.annotations?.readOnlyHint, undefined);
    assert.equal(listed.tools.find((tool) => tool.name === "story_run_action")?.annotations?.readOnlyHint, undefined);
    for (const tool of listed.tools) {
      assert.ok(tool.outputSchema);
      assert.equal("storyId" in (tool.inputSchema.properties || {}), false);
      assert.equal("nodeId" in (tool.inputSchema.properties || {}), false);
      assert.equal("providerSessionId" in (tool.inputSchema.properties || {}), false);
    }
    const unidentified = await client.callTool({ name: "story_list_content", arguments: {} });
    assert.equal(unidentified.isError, true);
    assert.equal(invocations.length, 0);
    const result = await client.callTool({
      name: "story_run_action",
      arguments: { actionId: "action_1", clientRequestId: "request_1" },
      _meta: { threadId: "codex-provider-session", sessionId: "codex-provider-session" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { session: { instanceId: "instance-1", sessionId: "created-session" } });
    assert.deepEqual(result.structuredContent, { session: { instanceId: "instance-1", sessionId: "created-session" } });
    assert.equal(invocations[0].session.storyId, "story-1");
    assert.equal(invocations[0].tool, "story_run_action");
    assert.deepEqual(invocations[0].args, { actionId: "action_1", clientRequestId: "request_1" });
    const agentResult = await client.callTool({
      name: "agent_run",
      arguments: { agentId: "agent-1", prompt: "Review this change" },
      _meta: { threadId: "codex-provider-session", toolCallId: "call-1" },
    });
    assert.deepEqual(agentResult.structuredContent, {
      runId: "run-1",
      status: "completed",
      result: { text: "done", truncated: false },
    });
    assert.match(invocations[1].clientRequestId, /^agent_tool_[a-f0-9]{64}$/);
    const agentTool = listed.tools.find((tool) => tool.name === "agent_run");
    assert.equal("providerSessionId" in agentTool.inputSchema.properties, false);
    assert.equal("clientRequestId" in agentTool.inputSchema.properties, false);
    assert.equal("provenance" in agentTool.inputSchema.properties, false);
  } finally {
    await client.close();
    await app.close();
  }
});
