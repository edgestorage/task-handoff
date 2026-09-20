const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionCreateCoordinator } = require("../packages/ai-session-runtime/src/ai-session-create.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { codexThreadConfig } = require("../packages/ai-session-runtime/src/codex-app-server/story-tool-config.ts");
const { openCodeSessionPermissionRules } = require("../packages/ai-session-runtime/src/opencode/story-tool-permissions.ts");
const { NodeAgentRegistrationClient } = require("../packages/controlled-instance/src/web/node-agent-client.ts");

const revision = (value) => value.repeat(64);

test("policy updates configure provider sessions, reject stale calls, and refresh OpenCode before the next Turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-tool-convergence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  let enabledTools = [
    "story_list_content", "story_get_content", "story_set_content", "story_list_actions", "story_run_action",
  ];
  let policyRevision = revision("a");
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    events.push({ kind: "node-agent", method: init.method || "GET", path: parsed.pathname });
    if (init.method === "POST" && parsed.pathname.endsWith("/story_list_content")) {
      if (!enabledTools.includes("story_list_content")) {
        return Response.json({ error: { code: "STORY_AGENT_TOOL_DISABLED", message: "Story Agent Tool is disabled." } }, { status: 403 });
      }
      return Response.json({ data: { documents: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasMore: false } } });
    }
    return Response.json({ data: {
      storyId: "story_1",
      policy: {
        content: enabledTools.includes("story_list_content"),
        actions: enabledTools.includes("story_list_actions"),
        automations: false,
        aiSessions: false,
      },
      revision: policyRevision,
      enabledTools,
    } });
  };
  const registration = new NodeAgentRegistrationClient({
    controlMode: "controlled",
    nodeAgentUrl: "http://node-agent.test",
    registrationToken: "token_1",
    instanceId: "instance_1",
    heartbeatIntervalMs: 10_000,
  }, async () => ({}), fetchImpl);
  const registry = createAiSessionRegistry({ dir: root });
  const resolveTools = async () => (await registration.resolveStoryAgentToolsForStory("story_1")).enabledTools;
  const controller = new AiSessionController(registry, resolveTools);
  for (const agent of ["codex", "opencode"]) {
    controller.register({
      agent,
      async createSession(input) {
        events.push({
          kind: "provider",
          phase: "create",
          agent,
          projection: agent === "codex"
            ? codexThreadConfig(undefined, input.storyAgentTools)
            : openCodeSessionPermissionRules("ask", input.storyAgentTools || []),
        });
        return { providerSessionId: `${agent}_provider`, cwd: input.cwd, creationSource: "ai-session" };
      },
      async startMessage(session, input) {
        events.push({
          kind: "provider",
          phase: "turn",
          agent,
          projection: agent === "codex"
            ? "session-config-unchanged"
            : openCodeSessionPermissionRules("ask", input.storyAgentTools || []),
        });
        return { session, provider: agent, action: "send", turnId: `${agent}_turn` };
      },
    });
  }
  const create = new AiSessionCreateCoordinator({ registry, controller, resolveStoryAgentTools: resolveTools });

  const codex = await create.create({ agent: "codex", cwd: "/workspace", message: "Start", storyId: "story_1", clientRequestId: "codex_create" });
  const openCode = await create.create({ agent: "opencode", cwd: "/workspace", message: "Start", storyId: "story_1", clientRequestId: "opencode_create" });
  const firstFetch = events.findIndex((event) => event.kind === "node-agent");
  const firstProviderSetup = events.findIndex((event) => event.kind === "provider" && event.phase === "create");
  assert.ok(firstFetch >= 0 && firstFetch < firstProviderSetup);
  const codexCreate = events.find((event) => event.agent === "codex" && event.phase === "create");
  assert.deepEqual(codexCreate.projection, {
    "mcp_servers.task_handoff_story.enabled": true,
    "mcp_servers.task_handoff_story.enabled_tools": enabledTools,
  });
  const openCodeCreate = events.find((event) => event.agent === "opencode" && event.phase === "create");
  assert.equal(openCodeCreate.projection.findLast((rule) => rule.permission === "story_run_action").action, "allow");

  enabledTools = [];
  policyRevision = revision("b");
  registration.invalidateStoryAgentTools({ storyId: "story_1", revision: policyRevision });
  await assert.rejects(
    () => registration.invokeStoryAgentTool("caller_1", "story_list_content", {}),
    (error) => error.code === "STORY_AGENT_TOOL_DISABLED" && error.statusCode === 403,
  );

  await controller.startMessage(codex.aiSessionId, { message: "Next Codex turn" });
  await controller.startMessage(openCode.aiSessionId, { message: "Next OpenCode turn" });
  const codexTurn = events.findLast((event) => event.agent === "codex" && event.phase === "turn");
  assert.equal(codexTurn.projection, "session-config-unchanged");
  const openCodeTurn = events.findLast((event) => event.agent === "opencode" && event.phase === "turn");
  assert.equal(openCodeTurn.projection.findLast((rule) => rule.permission === "story_list_content").action, "deny");
});
