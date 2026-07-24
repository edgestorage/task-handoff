const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const ts = require("typescript");
const test = require("node:test");
const WebSocket = require("ws");
const { registerWorkspaceRequire } = require("./workspace-require.js");

process.env.TASK_HANDOFF_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-test-config-")), "config.json");

registerWorkspaceRequire();

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  renderBoundedTelegramProgressText,
  renderTelegramProgressText,
  telegramMarkdownEscape,
} = require("../packages/core/src/core/chat-render.ts");
const { sendTelegramMessage, splitTelegramMessageText } = require("../packages/control-plane/src/control-plane/chat/adapters/telegram-gateway.ts");
const { TelegramProgressStore } = require("../packages/core/src/core/telegram-progress.ts");
const { listHistoricalSessions } = require("../packages/ai-session-runtime/src/session-history.ts");
const {
  createAiSessionRegistry,
  reconcileActiveAiProcesses,
  scanRecentTranscripts,
} = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const {
  CodexToolActivityTracker,
  CodexSubAgentTracker,
  codexApprovalRequest,
  codexNotification,
  rebuildCodexToolActivity,
  rebuildCodexSubAgents,
} = require("../packages/ai-session-runtime/src/codex-app-server-protocol.ts");
const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionDiscoveryCoordinator } = require("../packages/ai-session-runtime/src/ai-session-discovery.ts");
const { AiSessionHistoryStore } = require("../packages/ai-session-runtime/src/ai-session-history-store.ts");
const { CodexAppServerClient, CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { CodexAppServerApprovalCoordinator } = require("../packages/ai-session-runtime/src/codex-app-server/session/approval-coordinator.ts");
const { CodexAppServerConnectionManager } = require("../packages/ai-session-runtime/src/codex-app-server/client/connection-manager.ts");
const { CodexAppServerSessionDiscovery } = require("../packages/ai-session-runtime/src/codex-app-server/session/discovery.ts");
const { ClaudeControlSockSessionBridge } = require("../packages/ai-session-runtime/src/claude-control-sock.ts");
const { AiSessionEventType, AiSessionSummarySchema } = require("../packages/protocol/src/ai-sessions.ts");
const { APP_SESSION_DELTA_RETENTION_MS } = require("../packages/protocol/src/app-sessions.ts");
const { summarizeTranscriptLine } = require("../packages/core/src/core/transcript.ts");
const { summarizeThreadTurns } = require("../packages/ai-session-runtime/src/codex-app-server-protocol.ts");
const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");
const { CodexAppServerConnectionProxy } = require("../packages/app-runtime/src/codex-app-server-proxy.ts");
const { AiSessionRefreshScheduler, createWebApp } = require("../packages/controlled-instance/src/web/server.ts");
const { applyManagedCodexModelConfig } = require("../packages/controlled-instance/src/web/codex-model-config.ts");

test("codex approval parser preserves the request reason", () => {
  const request = codexApprovalRequest(42, "item/commandExecution/requestApproval", {
    threadId: "thread_approval",
    turnId: "turn_approval",
    itemId: "cmd_1",
    command: "pnpm test",
    reason: "Tests need access to the local package cache.",
  });

  assert.equal(request?.summary, "Tests need access to the local package cache. · Command: pnpm test");
});

test("controlled instance mention routes preserve authoritative context and references", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-mention-routes-"));
  const previousAutoStart = process.env.TASK_HANDOFF_CODEX_APP_SERVER;
  process.env.TASK_HANDOFF_CODEX_APP_SERVER = "0";
  t.after(() => {
    if (previousAutoStart === undefined) delete process.env.TASK_HANDOFF_CODEX_APP_SERVER;
    else process.env.TASK_HANDOFF_CODEX_APP_SERVER = previousAutoStart;
  });
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const codex = registry.start({ agent: "codex", providerSessionId: "thread_routes", cwd: "/workspace/project", status: "idle", phase: "unknown" });
  const sends = [];
  const bridge = {
    id: "codex-app-server-test",
    agent: "codex",
    refresh() {},
    stop() {},
    async mentionCatalog(session) {
      if (session.agent !== "codex") throw Object.assign(new Error("Only Codex sessions support mentions."), { code: "AI_SESSION_MENTIONS_UNSUPPORTED", statusCode: 400 });
      return {
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        cwd: session.cwd,
        candidates: [{ kind: "skill", name: "Docs / Exact", description: "Keep this name", path: "/workspace/project/.agents/skills/docs/SKILL.md" }],
        diagnostics: [],
      };
    },
    async searchMentionFiles(session, query) {
      return { sessionId: session.id, cwd: session.cwd, query, requestId: "search_routes", candidates: [{ kind: "file", name: "Exact Name.ts", path: "src/Exact Name.ts" }], complete: true };
    },
    async executeCommand(_session, input) {
      return { command: input.command, value: input.argument };
    },
    async startMessage(session, input) {
      sends.push({ session, input });
      return { session, provider: "codex", action: "send", turnId: "turn_routes", providerTurnId: "turn_routes" };
    },
    async interrupt(session) {
      return { session, provider: "codex", action: "interrupt" };
    },
  };
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false, aiSessionRegistry: registry, codexAppServer: bridge });
  t.after(() => app.close());

  const catalog = await app.inject({ method: "GET", url: `/api/ai-sessions/${codex.id}/mentions` });
  assert.equal(catalog.statusCode, 200);
  assert.deepEqual(JSON.parse(catalog.payload).data, {
    sessionId: codex.id,
    providerSessionId: "thread_routes",
    cwd: "/workspace/project",
    candidates: [{ kind: "skill", name: "Docs / Exact", description: "Keep this name", path: "/workspace/project/.agents/skills/docs/SKILL.md" }],
    diagnostics: [],
  });
  const files = await app.inject({ method: "POST", url: `/api/ai-sessions/${codex.id}/mentions/files`, payload: { query: "Exact" } });
  assert.equal(files.statusCode, 200);
  assert.equal(JSON.parse(files.payload).data.candidates[0].path, "src/Exact Name.ts");
  const renamed = await app.inject({ method: "POST", url: `/api/ai-sessions/${codex.id}/commands`, payload: { command: "rename", argument: "Exact title" } });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(JSON.parse(renamed.payload).data, { command: "rename", value: "Exact title" });
  const claude = registry.start({ agent: "claude", providerSessionId: "claude_routes", cwd: "/workspace/project", status: "idle", phase: "unknown" });
  const unsupported = await app.inject({ method: "GET", url: `/api/ai-sessions/${claude.id}/mentions` });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(JSON.parse(unsupported.payload).error.code, "AI_SESSION_MENTIONS_UNSUPPORTED");
  const missing = await app.inject({ method: "GET", url: "/api/ai-sessions/other-session/mentions" });
  assert.equal(missing.statusCode, 404);

  const references = [{ kind: "skill", name: "Docs / Exact", path: "/workspace/project/.agents/skills/docs/SKILL.md" }];
  const sent = await app.inject({ method: "POST", url: `/api/ai-sessions/${codex.id}/messages`, payload: { message: "Use @Docs", references } });
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(sends[0].input.references, references);
});

test("codex app-server parser projects supported tool items without output fields", () => {
  const cases = [
    [{ type: "commandExecution", id: "cmd", command: "pnpm test", aggregatedOutput: "secret output" }, "Command", "pnpm test"],
    [{ type: "fileChange", id: "file", changes: [{ path: "src/app.ts", diff: "secret contents" }] }, "File change", "src/app.ts"],
    [{ type: "mcpToolCall", id: "mcp", server: "github", tool: "search", arguments: { q: "issue" }, result: { secret: true } }, "github · search", '{"q":"issue"}'],
    [{ type: "dynamicToolCall", id: "dynamic", namespace: "browser", tool: "click", arguments: { id: 4 }, contentItems: [{ secret: true }] }, "browser · click", '{"id":4}'],
    [{ type: "collabAgentToolCall", id: "collab", tool: "spawnAgent", prompt: "Inspect tests", agentsStates: { child: { message: "secret result" } } }, "Spawn agent", "Inspect tests"],
    [{ type: "webSearch", id: "web", query: "Codex docs" }, "Web search", "Codex docs"],
    [{ type: "imageView", id: "image", path: "/tmp/image.png" }, "View image", "/tmp/image.png"],
    [{ type: "sleep", id: "sleep", durationMs: 250 }, "Sleep", "250 ms"],
    [{ type: "imageGeneration", id: "gen", revisedPrompt: "A map", result: "secret image data" }, "Image generation", "A map"],
  ];
  for (const [item, name, inputPreview] of cases) {
    const event = codexNotification("item/started", {
      threadId: "thread_tools",
      turnId: "turn_tools",
      startedAtMs: 1_750_000_000_000,
      item,
    });
    assert.equal(event.type, "tool-item-started");
    assert.equal(event.tool.id, item.id);
    assert.equal(event.tool.kind, item.type);
    assert.equal(event.tool.name, name);
    assert.equal(event.tool.inputPreview, inputPreview);
    assert.equal(event.tool.startedAt, "2025-06-15T15:06:40.000Z");
    assert.doesNotMatch(JSON.stringify(event.tool), /secret/);
  }

  const long = codexNotification("item/started", {
    threadId: "thread_tools",
    item: { type: "commandExecution", id: "long", command: `run ${"x".repeat(600)}` },
  });
  assert.equal(long.tool.inputPreview.length, 500);
  assert.match(long.tool.inputPreview, /\.\.\.$/);

  const completed = codexNotification("item/completed", {
    threadId: "thread_tools",
    completedAtMs: 1_750_000_000_100,
    item: { type: "commandExecution", id: "cmd", command: "pnpm test", aggregatedOutput: "secret output" },
  });
  assert.equal(completed.type, "tool-item-completed");
  assert.equal(completed.tool.startedAt, undefined);
  assert.doesNotMatch(JSON.stringify(completed.tool), /secret/);
});

test("codex app-server parser excludes non-tools and diagnoses unknown items", () => {
  for (const type of ["agentMessage", "reasoning", "plan", "hookPrompt", "enteredReviewMode", "exitedReviewMode"]) {
    assert.equal(codexNotification("item/started", { threadId: "thread_non_tools", item: { type, id: type } }), undefined);
  }
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(codexNotification("item/started", { threadId: "thread_unknown", item: { type: "futureTool", id: "future" } }), undefined);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["[codex-app-server] ignoring unknown ThreadItem.type: futureTool"]);
});

test("codex app-server parser projects canonical and deprecated context compaction events", () => {
  assert.deepEqual(codexNotification("item/started", {
    threadId: "thread_compact",
    turnId: "turn_compact",
    startedAtMs: 1_750_000_000_000,
    item: { type: "contextCompaction", id: "compact_1" },
  }), {
    type: "context-compaction",
    threadId: "thread_compact",
    turnId: "turn_compact",
    itemId: "context_compaction:turn_compact",
    status: "running",
    observedAt: "2025-06-15T15:06:40.000Z",
  });
  assert.deepEqual(codexNotification("item/completed", {
    threadId: "thread_compact",
    turnId: "turn_compact",
    completedAtMs: 1_750_000_000_100,
    item: { type: "contextCompaction", id: "compact_1" },
  }), {
    type: "context-compaction",
    threadId: "thread_compact",
    turnId: "turn_compact",
    itemId: "context_compaction:turn_compact",
    status: "completed",
    observedAt: "2025-06-15T15:06:40.100Z",
  });
  assert.deepEqual(codexNotification("thread/compacted", {
    threadId: "thread_compact",
    turnId: "turn_legacy",
  }), {
    type: "context-compaction",
    threadId: "thread_compact",
    turnId: "turn_legacy",
    itemId: "context_compaction:turn_legacy",
    status: "completed",
  });
});

test("codex app-server parser preserves assistant item identity on completion", () => {
  const event = codexNotification("item/completed", {
    threadId: "thread_messages",
    turnId: "turn_1",
    item: { type: "agentMessage", id: "item_2", text: "second response" },
  });
  assert.deepEqual(event, {
    type: "agent-message-completed",
    threadId: "thread_messages",
    turnId: "turn_1",
    itemId: "item_2",
    text: "second response",
  });
});

test("ai session reducer preserves assistant item identity on the active turn", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-item-id-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread_1",
    activeTurnId: "turn_1",
    status: "running",
  });
  const updated = registry.applyRealtimeEvent(session.id, {
    kind: "assistant-message",
    activeTurnId: "turn_1",
    itemId: "item_1",
    text: "complete response",
    source: "realtime",
  });

  assert.equal(updated.lastMessageItemId, "item_1");
  assert.equal(updated.turns.find((turn) => turn.id === "turn_1")?.lastMessageItemId, "item_1");
});

test("codex app-server projects sub-agent activity separately from tools", () => {
  const activity = codexNotification("item/completed", {
    threadId: "thread-parent",
    turnId: "turn-parent",
    item: {
      type: "subAgentActivity",
      id: "call-1",
      kind: "interacted",
      agentThreadId: "thread-child",
      agentPath: "agent-a",
    },
  });
  assert.deepEqual(activity, {
    type: "sub-agent-activity",
    threadId: "thread-parent",
    turnId: "turn-parent",
    subAgent: {
      threadId: "thread-child",
      path: "agent-a",
      status: "running",
      activity: "interacted",
      observation: "activity",
    },
  });

  const collab = codexNotification("item/completed", {
    threadId: "thread-parent",
    item: {
      type: "collabAgentToolCall",
      id: "call-1",
      tool: "wait",
      status: "completed",
      agentsStates: {
        "thread-child": { status: "completed", message: "Reviewed the tests" },
      },
    },
  });
  assert.equal(collab.type, "tool-item-completed");
  assert.deepEqual(collab.subAgents, [{
    threadId: "thread-child",
    status: "completed",
    message: "Reviewed the tests",
    observation: "state",
  }]);
});

test("codex sub-agent tracker merges lifecycle and activity without affecting tool counts", () => {
  const tracker = new CodexSubAgentTracker();
  tracker.apply([{ threadId: "thread-child", status: "pending-init", path: "agent-a", activity: "started", observation: "activity" }], "2026-07-13T00:00:01.000Z");
  const completed = tracker.apply([{ threadId: "thread-child", status: "completed", message: "Done", observation: "state" }], "2026-07-13T00:00:02.000Z");
  assert.deepEqual(completed, [{
    threadId: "thread-child",
    path: "agent-a",
    status: "completed",
    activity: "started",
    message: "Done",
    updatedAt: "2026-07-13T00:00:02.000Z",
  }]);
  const clearedMessage = tracker.apply([{ threadId: "thread-child", status: "running", observation: "state" }], "2026-07-13T00:00:03.000Z");
  assert.equal(clearedMessage[0].message, undefined);
});

test("codex sub-agent tracker rejects lagging snapshots and delayed activity", () => {
  const tracker = new CodexSubAgentTracker();
  tracker.apply([{
    threadId: "thread-child",
    status: "completed",
    message: "Done",
    observation: "state",
    observedAt: "2026-07-13T00:00:04.000Z",
  }], "2026-07-13T00:00:04.000Z");
  tracker.apply([{
    threadId: "thread-child",
    status: "interrupted",
    path: "agent-a",
    activity: "interrupted",
    observation: "activity",
    observedAt: "2026-07-13T00:00:03.000Z",
  }], "2026-07-13T00:00:05.000Z");
  tracker.apply([{
    threadId: "thread-child",
    status: "running",
    activity: "interacted",
    observation: "activity",
    observedAt: "2026-07-13T00:00:02.000Z",
  }], "2026-07-13T00:00:06.000Z");

  const afterLaggingSnapshot = tracker.replace([{
    threadId: "thread-child",
    status: "running",
    activity: "started",
    updatedAt: "2026-07-13T00:00:07.000Z",
  }]);
  assert.equal(afterLaggingSnapshot[0].status, "completed");
  assert.equal(afterLaggingSnapshot[0].message, "Done");
  assert.equal(afterLaggingSnapshot[0].activity, "interrupted");
  assert.equal(afterLaggingSnapshot[0].path, "agent-a");

  const running = new CodexSubAgentTracker();
  running.apply([{
    threadId: "thread-child",
    status: "running",
    observation: "state",
  }], "2026-07-13T00:00:04.000Z");
  assert.equal(running.replace([{
    threadId: "thread-child",
    status: "pending-init",
    updatedAt: "2026-07-13T00:00:07.000Z",
  }])[0].status, "running");

  const advancedSnapshot = new CodexSubAgentTracker();
  advancedSnapshot.replace([{ threadId: "thread-child", status: "running", updatedAt: "2026-07-13T00:00:01.000Z" }]);
  assert.equal(advancedSnapshot.replace([{
    threadId: "thread-child",
    status: "completed",
    message: "Snapshot caught up",
    updatedAt: "2026-07-13T00:00:08.000Z",
  }])[0].status, "completed");
});

test("codex sub-agent tracker bounds snapshots while retaining active agents", () => {
  const tracker = new CodexSubAgentTracker();
  for (let index = 0; index < 55; index += 1) {
    tracker.apply([{
      threadId: `terminal-${String(index).padStart(2, "0")}`,
      status: "completed",
      observation: "state",
    }], `2026-07-13T00:00:${String(index).padStart(2, "0")}.000Z`);
  }
  tracker.apply([{
    threadId: "active-old",
    status: "running",
    observation: "state",
  }], "2026-07-12T00:00:00.000Z");
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.length, 50);
  assert.equal(snapshot.some((agent) => agent.threadId === "active-old"), true);
  assert.equal(snapshot.some((agent) => agent.threadId === "terminal-00"), false);
});

test("codex sub-agent snapshot rebuild keeps agents across parent turns", () => {
  const rebuilt = rebuildCodexSubAgents({ turns: [{
    items: [{ type: "collabAgentToolCall", agentsStates: { child_a: { status: "running" } } }],
  }, {
    items: [{ type: "collabAgentToolCall", agentsStates: { child_b: { status: "completed", message: "Done" } } }],
  }] }, "2026-07-13T00:00:04.000Z");
  assert.deepEqual(rebuilt.map((agent) => [agent.threadId, agent.status]), [["child_a", "running"], ["child_b", "completed"]]);
});

test("codex tool tracker deduplicates, backfills completed tools, and falls back across parallel tools", () => {
  const tracker = new CodexToolActivityTracker();
  const first = { id: "tool_a", kind: "commandExecution", name: "Command", inputPreview: "one" };
  const second = { id: "tool_b", kind: "webSearch", name: "Web search", inputPreview: "two" };
  assert.equal(tracker.started(first).toolCallsSinceLastMessage, 1);
  assert.deepEqual(tracker.started(first).currentTool, first);
  assert.deepEqual(tracker.started(second).currentTool, second);
  assert.equal(tracker.snapshot().toolCallsSinceLastMessage, 2);
  assert.deepEqual(tracker.completed(second).currentTool, first);
  assert.equal(tracker.completed({ id: "tool_c", kind: "sleep", name: "Sleep" }).toolCallsSinceLastMessage, 3);
  assert.deepEqual(tracker.snapshot().currentTool, first);
  assert.equal(tracker.completed(second).toolCallsSinceLastMessage, 3);
  assert.equal(tracker.clearActiveTools().currentTool, undefined);
  assert.equal(tracker.snapshot().toolCallsSinceLastMessage, 3);
  assert.deepEqual(tracker.resetForAgentMessage(), {
    seenToolIds: [],
    activeTools: [],
    toolCallsSinceLastMessage: 0,
    currentTool: undefined,
  });
});

test("codex thread tool snapshot rebuild matches realtime tracking and conservatively infers statusless tools", () => {
  const thread = {
    status: { type: "active" },
    turns: [{
      id: "turn_tools",
      status: "inProgress",
      items: [
        { type: "commandExecution", id: "before", command: "old", status: "completed" },
        { type: "agentMessage", id: "boundary", text: "Working" },
        { type: "commandExecution", id: "active", command: "pnpm test", status: "inProgress" },
        { type: "mcpToolCall", id: "done", server: "git", tool: "status", arguments: {}, status: "completed", result: { secret: true } },
        { type: "webSearch", id: "search", query: "latest docs" },
      ],
    }],
  };
  const rebuilt = rebuildCodexToolActivity(thread);
  assert.equal(rebuilt.toolCallsSinceLastMessage, 3);
  assert.deepEqual(rebuilt.seenToolIds, ["active", "done", "search"]);
  assert.equal(rebuilt.currentTool.id, "search");

  const realtime = new CodexToolActivityTracker();
  realtime.started(rebuilt.activeTools[0]);
  realtime.completed({ id: "done", kind: "mcpToolCall", name: "git · status" });
  realtime.started(rebuilt.activeTools[1]);
  assert.deepEqual(realtime.snapshot(), rebuilt);

  thread.turns[0].items.push({ type: "reasoning", id: "after", summary: [], content: [] });
  const conservative = rebuildCodexToolActivity(thread);
  assert.equal(conservative.toolCallsSinceLastMessage, 3);
  assert.equal(conservative.currentTool.id, "active");
});

test("telegram renderer escapes messages and progress payloads", () => {
  assert.equal(telegramMarkdownEscape("a_b"), "a\\_b");
  assert.match(renderTelegramProgressText("Working_now\nrun npm_test"), /^\*Working\\_now\*/);
});

test("telegram progress rendering preserves the heading and latest output within the message limit", () => {
  const rendered = renderBoundedTelegramProgressText(`Working_now\n${"old output\n".repeat(500)}latest_result`, 4000);
  assert.ok(rendered.length <= 4000);
  assert.match(rendered, /^\*Working\\_now\*/);
  assert.match(rendered, /\\\.\\\.\\\./);
  assert.match(rendered, /latest\\_result$/);
});

test("telegram sender chunks escaped text and keeps reply and actions on their intended chunks", async () => {
  const bodies = [];
  const bridge = { id: "telegram_test", channel: "telegram", name: "Telegram", enabled: true, token: "token" };
  const result = await sendTelegramMessage(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: bodies.length } }), { status: 200 });
  }, bridge, "123", `${"escaped_value! ".repeat(600)}done`, {
    replyToMessageId: 42,
    replyMarkup: { inline_keyboard: [[{ text: "Done", callback_data: "done" }]] },
  });

  assert.ok(bodies.length > 1);
  assert.equal(result.message_id, bodies.length);
  assert.equal(bodies[0].reply_to_message_id, 42);
  assert.equal(bodies.at(-1).reply_markup.inline_keyboard[0][0].callback_data, "done");
  assert.equal(bodies.slice(1).some((body) => body.reply_to_message_id), false);
  assert.equal(bodies.slice(0, -1).some((body) => body.reply_markup), false);
  assert.ok(splitTelegramMessageText("a_b ".repeat(1200)).every((chunk) => telegramMarkdownEscape(chunk).length <= 4000));
});

test("telegram progress store shares send edit and finish semantics", async () => {
  const calls = [];
  let nextMessageId = 40;
  const store = new TelegramProgressStore({
    updateIntervalMs: 1,
    send: async (text, route) => {
      nextMessageId += 1;
      calls.push(["send", text, route?.chatId]);
      return { message_id: nextMessageId };
    },
    edit: async (messageId, text, route) => {
      calls.push(["edit", messageId, text, route?.chatId]);
    },
  });

  store.update("k1", "working", { chatId: "c1" });
  await store.flush("k1");
  store.update("k1", "working", { chatId: "c1" });
  await store.flush("k1");
  await store.wait(2);
  await store.applyUpdate("k1", "done", { chatId: "c1" });
  const finished = await store.finish("k1", "final", { chatId: "c1" });

  assert.equal(finished, true);
  assert.deepEqual(calls, [
    ["send", "working", "c1"],
    ["edit", 41, "done", "c1"],
    ["edit", 41, "final", "c1"],
  ]);
});

test("telegram progress store rate limits direct edits", async () => {
  const calls = [];
  const store = new TelegramProgressStore({
    updateIntervalMs: 25,
    send: async (text, route) => {
      calls.push(["send", text, route?.chatId]);
      return { message_id: 41 };
    },
    edit: async (messageId, text, route) => {
      calls.push(["edit", messageId, text, route?.chatId]);
    },
  });

  store.update("k1", "working", { chatId: "c1" });
  await store.flush("k1");
  await store.applyUpdate("k1", "almost done", { chatId: "c1" });
  await store.applyUpdate("k1", "done", { chatId: "c1" });

  assert.deepEqual(calls, [
    ["send", "working", "c1"],
  ]);

  await store.wait(35);
  await store.flush("k1");

  assert.deepEqual(calls, [
    ["send", "working", "c1"],
    ["edit", 41, "done", "c1"],
  ]);
});

test("telegram progress store edits unchanged text when action rows change", async () => {
  const calls = [];
  const initialOptions = {
    actionRows: [[{ text: "Steer queued message", callbackData: "steer:queue_1" }]],
  };
  const updatedOptions = {
    actionRows: [[{ text: "Cancel", callbackData: "cancel" }]],
  };
  const store = new TelegramProgressStore({
    updateIntervalMs: 25,
    send: async () => ({ message_id: 41 }),
    edit: async (messageId, text, _route, options) => {
      calls.push([messageId, text, options]);
    },
  });

  store.remember("k1", 41, "working", undefined, initialOptions);
  await store.applyUpdate("k1", "working", undefined, updatedOptions);
  assert.deepEqual(calls, []);

  await store.wait(35);
  await store.flush("k1");
  await store.applyUpdate("k1", "working", undefined, updatedOptions);

  assert.deepEqual(calls, [[41, "working", updatedOptions]]);
});

test("telegram progress store rekeys pending updates without recreating the old key", async () => {
  const calls = [];
  const store = new TelegramProgressStore({
    updateIntervalMs: 25,
    send: async (text, route) => {
      calls.push(["send", text, route?.chatId]);
      return { message_id: 41 };
    },
    edit: async (messageId, text, route) => {
      calls.push(["edit", messageId, text, route?.chatId]);
    },
  });

  store.remember("old", 41, "working", { chatId: "c1" });
  await store.applyUpdate("old", "done", { chatId: "c1" });
  assert.equal(store.rekey("old", "new"), true);

  await store.wait(35);
  await store.flush("new");

  assert.equal(store.entries.has("old"), false);
  assert.equal(store.entries.has("new"), true);
  assert.deepEqual(calls, [
    ["edit", 41, "done", "c1"],
  ]);
});

test("telegram progress store replacement cancels stale scheduled updates", async () => {
  const calls = [];
  const store = new TelegramProgressStore({
    updateIntervalMs: 25,
    send: async () => ({ message_id: 41 }),
    edit: async (messageId, text) => {
      calls.push([messageId, text]);
    },
  });

  store.remember("key", 41, "working");
  await store.applyUpdate("key", "stale update");
  const replaced = store.remember("key", 42, "queued");

  assert.equal(replaced.messageId, 41);
  await store.wait(35);
  await store.flush("key");

  assert.equal(store.entries.get("key").messageId, 42);
  assert.deepEqual(calls, []);
});

test("telegram progress store replacement ignores an in-flight stale update", async () => {
  const calls = [];
  let releaseSend;
  const store = new TelegramProgressStore({
    updateIntervalMs: 1,
    send: async () => new Promise((resolve) => {
      releaseSend = () => resolve({ message_id: 41 });
    }),
    edit: async (messageId, text) => {
      calls.push([messageId, text]);
    },
  });

  const staleUpdate = store.applyUpdate("key", "stale update");
  store.remember("key", 42, "queued");
  releaseSend();
  assert.equal(await staleUpdate, false);

  assert.equal(store.entries.get("key").messageId, 42);
  assert.deepEqual(calls, []);
});

test("session history lists codex and claude sessions for the current cwd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-session-history-"));
  const cwd = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  const claudeHome = path.join(root, "claude-home");
  fs.mkdirSync(path.join(codexHome, "sessions", "2026", "06", "20"), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "projects", cwd.split(path.sep).join("-")), { recursive: true });

  const codexTranscript = path.join(codexHome, "sessions", "2026", "06", "20", "rollout-2026-06-20T00-00-00-11111111-1111-1111-1111-111111111111.jsonl");
  const claudeTranscript = path.join(claudeHome, "projects", cwd.split(path.sep).join("-"), "22222222-2222-4222-8222-222222222222.jsonl");
  fs.writeFileSync(
    codexTranscript,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "11111111-1111-1111-1111-111111111111", cwd } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex prompt" }] } }),
    ].join("\n"),
  );
  fs.writeFileSync(
    claudeTranscript,
    JSON.stringify({ type: "user", message: { content: "claude prompt" }, cwd, sessionId: "22222222-2222-4222-8222-222222222222" }),
  );
  fs.utimesSync(codexTranscript, new Date("2026-06-20T00:00:00.000Z"), new Date("2026-06-20T00:00:00.000Z"));
  fs.utimesSync(claudeTranscript, new Date("2026-06-19T00:00:00.000Z"), new Date("2026-06-19T00:00:00.000Z"));

  const sessions = listHistoricalSessions({ cwd, codexHome, claudeHome });

  assert.deepEqual(
    sessions.map((session) => [session.agent, session.sessionId, session.title]),
    [
      ["codex", "11111111-1111-1111-1111-111111111111", "codex prompt"],
      ["claude", "22222222-2222-4222-8222-222222222222", "claude prompt"],
    ],
  );
});

test("ai session registry keeps distinct claude app sessions in the same cwd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions"), idleAfterMs: 1, staleAfterMs: 1000 });
  const cwd = path.join(root, "repo");

  const first = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-old",
    providerSessionId: "claude-old",
    title: "Claude",
    cwd,
    status: "idle",
    summary: "Claude app session connected",
  });
  assert.ok(first);

  const second = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-new",
    providerSessionId: "claude-new",
    title: "Claude",
    cwd,
    status: "running",
    summary: "Claude app session connected",
  });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.sessions.length, 2);
  assert.notEqual(second?.id, first.id);
  assert.deepEqual(
    new Set(snapshot.sessions.map((session) => session.providerSessionId)),
    new Set(["claude-old", "claude-new"]),
  );
});

test("ai session registry indexes provider sessions without rescanning on every lookup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-provider-index-"));
  const dir = path.join(root, "ai-sessions");
  const registry = createAiSessionRegistry({ dir });
  const session = registry.start({ agent: "codex", providerSessionId: "thread-indexed" });

  assert.equal(registry.getByProviderSessionId("codex", "thread-indexed")?.id, session.id);
  fs.rmSync(registry.sessionPath(session.id));
  assert.equal(registry.getByProviderSessionId("codex", "thread-indexed"), undefined);

  const persisted = registry.start({ agent: "codex", providerSessionId: "thread-reloaded" });
  const reloaded = createAiSessionRegistry({ dir });
  const found = reloaded.getByProviderSessionId("codex", "thread-reloaded");
  assert.equal(found?.id, persisted.id);
});

test("ai session registry treats unsafe read ids as missing without weakening path validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-unsafe-id-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  assert.equal(registry.get(".."), undefined);
  assert.equal(registry.get("parent/session"), undefined);
  assert.equal(registry.get("parent\\session"), undefined);
  assert.throws(() => registry.sessionPath("parent/session"), /Invalid AI session id/);
});

test("ai session registry migrates unknown sub-agent fields and caps after deduplication", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-sub-agent-migration-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "codex", providerSessionId: "thread-migration" });
  const base = "2026-07-13T00:00:00.000Z";
  const subAgents = Array.from({ length: 70 }, (_, index) => ({
    threadId: `thread-${String(index).padStart(2, "2")}`,
    status: "completed",
    updatedAt: new Date(Date.parse(base) + index * 1000).toISOString(),
    futureField: "ignored",
  }));
  // A duplicate appears after the first 50 entries and must still win.
  subAgents.push({
    threadId: "thread-00",
    status: "running",
    updatedAt: "2026-07-13T00:02:00.000Z",
    futureField: "ignored",
  });
  const persisted = JSON.parse(fs.readFileSync(registry.sessionPath(session.id), "utf8"));
  persisted.subAgents = subAgents;
  fs.writeFileSync(registry.sessionPath(session.id), JSON.stringify(persisted));

  const restored = registry.get(session.id);
  assert.equal(restored?.subAgents.length, 50);
  assert.equal(restored?.subAgents.find((agent) => agent.threadId === "thread-00")?.status, "running");
  assert.equal(restored?.subAgents.some((agent) => "futureField" in agent), false);
});

test("ai session registry initializes empty app sessions as idle without placeholder messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-empty-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app-empty",
    providerSessionId: "thread-empty",
    title: "codex session",
    cwd: "/workspace",
  });

  assert.equal(session.status, "idle");
  assert.equal(session.phase, "unknown");
  assert.equal(session.userPrompt, undefined);
  assert.equal("userPrompts" in session, false);
  assert.deepEqual(session.turns, []);
  assert.equal(session.summary, undefined);
  assert.equal(session.lastMessage, undefined);
  assert.equal(session.toolCallsSinceLastMessage, 0);
});

test("ai session registry atomically replaces and explicitly clears tool activity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-tools-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "codex", providerSessionId: "thread-tools" });
  let changes = 0;
  const stop = registry.onChange(() => { changes += 1; });

  const running = registry.applyRealtimeEvent(session.id, {
    kind: "tool-activity",
    currentTool: {
      id: "item-2",
      kind: "commandExecution",
      name: "Command",
      inputPreview: "pnpm test",
      startedAt: "2026-07-13T00:00:01.000Z",
    },
    toolCallsSinceLastMessage: 2,
  });
  assert.equal(changes, 1);
  assert.equal(running.toolCallsSinceLastMessage, 2);
  assert.equal(running.currentTool.id, "item-2");

  const replaced = registry.applyRealtimeEvent(session.id, {
    kind: "tool-activity",
    currentTool: null,
    toolCallsSinceLastMessage: 1,
  });
  assert.equal(changes, 2);
  assert.equal(replaced.currentTool, undefined);
  assert.equal(replaced.toolCallsSinceLastMessage, 1);
  assert.equal(replaced.counters.toolCalls, 0);
  stop();
});

test("ai session registry keeps sub-agent state independent from tool activity and responses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-sub-agents-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "codex", providerSessionId: "thread-parent" });
  const updated = registry.applyRealtimeEvent(session.id, {
    kind: "sub-agent-activity",
    subAgents: [{
      threadId: "thread-child",
      path: "agent-a",
      status: "running",
      activity: "interacted",
      updatedAt: "2026-07-13T00:00:01.000Z",
    }],
  });
  assert.equal(updated.currentTool, undefined);
  assert.equal(updated.toolCallsSinceLastMessage, 0);
  assert.equal(updated.subAgents[0].threadId, "thread-child");

  const messaged = registry.applyRealtimeEvent(session.id, { kind: "assistant-message", text: "Main response" });
  assert.equal(messaged.subAgents[0].status, "running");
  const completed = registry.applyRealtimeEvent(session.id, { kind: "turn-completed", status: "idle", text: "Done" });
  assert.equal(completed.subAgents[0].status, "running");

  const cleared = registry.applyRealtimeEvent(session.id, { kind: "sub-agent-activity", subAgents: [] });
  assert.deepEqual(cleared.subAgents, []);
});

test("ai session registry clears stale current tools at turn completion without clearing the window count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-tool-terminal-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "codex", providerSessionId: "thread-terminal" });
  registry.applyRealtimeEvent(session.id, {
    kind: "tool-activity",
    currentTool: { id: "item-1", kind: "webSearch", name: "Web search" },
    toolCallsSinceLastMessage: 4,
  });

  const completed = registry.applyRealtimeEvent(session.id, {
    kind: "turn-completed",
    status: "idle",
    text: "Done",
  });
  assert.equal(completed.currentTool, undefined);
  assert.equal(completed.toolCallsSinceLastMessage, 4);
});

test("ai session registry resets tool activity at an assistant message boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-tool-message-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "codex", providerSessionId: "thread-message" });
  registry.applyRealtimeEvent(session.id, {
    kind: "tool-activity",
    currentTool: { id: "item-1", kind: "commandExecution", name: "Command" },
    toolCallsSinceLastMessage: 2,
  });

  const messaged = registry.applyRealtimeEvent(session.id, {
    kind: "assistant-message",
    text: "Result",
  });
  assert.equal(messaged.currentTool, undefined);
  assert.equal(messaged.toolCallsSinceLastMessage, 0);
});

test("ai session registry migrates historical tool activity and ignores unknown persisted fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-tool-migrate-"));
  const dir = path.join(root, "ai-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify({
    id: "legacy",
    agent: "codex",
    status: "running",
    phase: "tool",
    currentTool: {
      name: "Command",
      inputPreview: "pnpm test",
      startedAt: "legacy-date",
      historicalDetail: "ignored",
    },
    startedAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:01.000Z",
    counters: {},
    queue: {},
    futureSessionField: "ignored",
  }));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const registry = createAiSessionRegistry({ dir });
    const session = registry.get("legacy");
    assert.ok(session);
    assert.equal(session.toolCallsSinceLastMessage, 0);
    assert.deepEqual(session.currentTool, { name: "Command", inputPreview: "pnpm test" });
    assert.equal(registry.list().some((item) => item.id === "legacy"), true);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.some((message) => message.includes("futureSessionField")), true);
  assert.equal(warnings.some((message) => message.includes("historicalDetail")), true);
});

test("ai session registry starts explicit turns without carrying over previous responses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-turns-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "claude",
    appSessionId: "app-turns",
    providerSessionId: "claude-turns",
  });

  registry.update(session.id, {
    activeTurnId: "turn_1",
    status: "running",
    phase: "thinking",
    userPrompt: "first prompt",
  });
  registry.update(session.id, {
    activeTurnId: "turn_1",
    status: "idle",
    phase: "responding",
    summary: "first answer",
    lastMessage: "first answer",
  });
  const afterFirst = registry.get(session.id);
  assert.equal(afterFirst.turns.length, 1);
  assert.equal(afterFirst.turns[0].id, "turn_1");
  assert.equal(afterFirst.turns[0].status, "completed");
  assert.equal(afterFirst.turns[0].lastMessage, "first answer");

  registry.update(session.id, {
    activeTurnId: "turn_2",
    status: "running",
    phase: "thinking",
    userPrompt: "second prompt",
  });
  const afterSecondPrompt = registry.get(session.id);
  assert.equal(afterSecondPrompt.turns.length, 2);
  assert.equal(afterSecondPrompt.turns[1].id, "turn_2");
  assert.equal(afterSecondPrompt.turns[1].userPrompt, "second prompt");
  assert.equal(afterSecondPrompt.turns[1].lastMessage, undefined);
  assert.equal(afterSecondPrompt.lastMessage, undefined);

  registry.update(session.id, {
    activeTurnId: "turn_2",
    status: "idle",
    phase: "responding",
    summary: "second answer",
    lastMessage: "second answer",
  });
  const afterSecondAnswer = registry.get(session.id);
  assert.equal(afterSecondAnswer.turns[1].status, "completed");
  assert.equal(afterSecondAnswer.turns[1].lastMessage, "second answer");
  assert.equal(afterSecondAnswer.turns[1].revision > afterSecondPrompt.turns[1].revision, true);
});

test("ai session reducer preserves canonical turn id when transcript provider id drifts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-canonical-turn-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "claude",
    appSessionId: "app-canonical-turn",
    providerSessionId: "claude-canonical-turn",
  });

  registry.applyRealtimeEvent(session.id, {
    kind: "send-ack",
    activeTurnId: "turn_control_1",
    providerTurnId: "provider_ack_1",
    userPrompt: "你好",
    source: "control",
    observedAt: "2026-07-04T12:00:00.000Z",
  });
  registry.applyAdapterSnapshot({
    source: "transcript-scan",
    observedAt: "2026-07-04T12:00:02.000Z",
    agent: "claude",
    appSessionId: "app-canonical-turn",
    providerSessionId: "claude-canonical-turn",
    turns: [{
      id: "provider_transcript_1",
      userPrompt: "你好",
      lastMessage: "你好！有什么我可以帮助你的吗？",
      status: "completed",
      updatedAt: "2026-07-04T12:00:02.000Z",
    }],
    status: "idle",
    replaceActivity: true,
  });

  const updated = registry.get(session.id);
  assert.equal(updated.turns.length, 1);
  assert.equal(updated.turns[0].id, "turn_control_1");
  assert.equal(updated.turns[0].providerTurnId, "provider_transcript_1");
  assert.equal(updated.turns[0].lastMessage, "你好！有什么我可以帮助你的吗？");
});

test("ai session transcript turns ignore synthetic interrupt user messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-interrupt-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "claude",
    providerSessionId: "claude-interrupt",
  });
  const state = { calls: new Map() };
  const lines = [
    {
      type: "user",
      message: { role: "user", content: "一点没有修复啊\n" },
      timestamp: "2026-07-04T09:18:21.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      timestamp: "2026-07-04T09:18:22.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: "你是谁啊" },
      timestamp: "2026-07-04T09:18:36.858Z",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "我是 Claude Code，Anthropic 的 AI 助手。" }],
      },
      timestamp: "2026-07-04T09:18:40.033Z",
    },
  ];

  for (const line of lines) {
    registry.ingestTranscriptLine(session.id, JSON.stringify(line), state);
  }

  const updated = registry.get(session.id);
  assert.deepEqual(updated.turns.map((turn) => turn.userPrompt), ["一点没有修复啊", "你是谁啊"]);
  assert.equal(updated.turns.some((turn) => turn.userPrompt === "[Request interrupted by user]"), false);
  assert.equal(updated.turns.at(-1).userPrompt, "你是谁啊");
  assert.equal(updated.turns.at(-1).lastMessage, "我是 Claude Code，Anthropic 的 AI 助手。");
  assert.equal(updated.turns.at(-1).id, "turn_93eb5abfc9_2026-07-04T09:18:36.858Z_2196543efa");
});

test("codex app-server thread summary keeps assistant response on the real user turn after interrupt", () => {
  const summary = summarizeThreadTurns({
    id: "thread_1",
    turns: [
      {
        id: "turn_1",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "一点没有修复啊" }] },
        ],
      },
      {
        id: "turn_interrupt",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "[Request interrupted by user]" }] },
        ],
      },
      {
        id: "turn_2",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "你是谁啊" }] },
          { type: "agentMessage", text: "我是 Claude Code，Anthropic 的 AI 助手。" },
        ],
      },
    ],
  });

  assert.equal(summary.userPrompt, "你是谁啊");
  assert.equal(summary.lastMessage, "我是 Claude Code，Anthropic 的 AI 助手。");
  assert.deepEqual(summary.turns.map((turn) => turn.id), ["turn_1", "turn_2"]);
  assert.deepEqual(summary.turns.map((turn) => turn.userPrompt), ["一点没有修复啊", "你是谁啊"]);
  assert.equal(summary.turns.at(-1).lastMessage, "我是 Claude Code，Anthropic 的 AI 助手。");
});

test("codex app-server thread summary preserves context-compaction-only turns", () => {
  const summary = summarizeThreadTurns({
    id: "thread_compact",
    turns: [{
      id: "turn_compact",
      status: "completed",
      items: [{ type: "contextCompaction", id: "compact_1" }],
    }],
  });

  assert.deepEqual(summary.turns, [{
    id: "turn_compact",
    status: "completed",
    revision: 0,
    contextCompactions: [{ id: "context_compaction:turn_compact", status: "completed" }],
  }]);
});

test("ai session bind app snapshot does not replace real prompt with interrupt placeholder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-bind-interrupt-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-claude",
    providerSessionId: "claude-interrupt-bind",
    status: "running",
    phase: "thinking",
  });

  registry.update(session.id, {
    activeTurnId: "turn_2",
    status: "running",
    phase: "thinking",
    userPrompt: "你是谁啊",
  });

  const rebound = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-claude",
    providerSessionId: "claude-interrupt-bind",
    userPrompt: "你是谁啊",
    turns: [
      {
        id: "turn_1",
        userPrompt: "一点没有修复啊",
        status: "running",
        phase: "thinking",
        revision: 0,
      },
      {
        id: "turn_2",
        userPrompt: "你是谁啊",
        status: "completed",
        phase: "responding",
        revision: 1,
        lastMessage: "我是 Claude Code，Anthropic 的 AI 助手。",
        summary: "我是 Claude Code，Anthropic 的 AI 助手。",
      },
    ],
    summary: "我是 Claude Code，Anthropic 的 AI 助手。",
    lastMessage: "我是 Claude Code，Anthropic 的 AI 助手。",
    status: "idle",
    phase: "unknown",
    replaceActivity: true,
  });

  assert.equal(rebound.userPrompt, "你是谁啊");
  assert.equal(rebound.turns.at(-1).id, "turn_2");
  assert.equal(rebound.turns.at(-1).userPrompt, "你是谁啊");
  assert.equal(rebound.turns.at(-1).lastMessage, "我是 Claude Code，Anthropic 的 AI 助手。");
  assert.equal(rebound.turns.some((turn) => turn.userPrompt === "[Request interrupted by user]"), false);
});

test("ai session registry rebinds orphaned app sessions without creating duplicates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-rebind-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const input = {
    agent: "claude",
    appId: "claude",
    appSessionId: "app-stable",
    providerSessionId: "claude-stable",
    title: "Claude",
    cwd: "/workspace",
    status: "idle",
  };

  const first = registry.applyAdapterSnapshot(input);
  registry.reconcileAppSessionBindings([]);
  const rebound = registry.applyAdapterSnapshot(input);

  assert.equal(rebound.id, first.id);
  assert.equal(fs.readdirSync(path.join(root, "ai-sessions")).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(registry.snapshot().sessions.length, 1);
});

test("ai session registry snapshots expose one canonical session per app identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-canonical-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  const first = registry.start({
    agent: "claude",
    appSessionId: "app-stable",
    providerSessionId: "claude-stable",
  });
  registry.progress(first.id, "123", "user");
  registry.progress(first.id, "received", "assistant");
  registry.start({
    agent: "claude",
    appSessionId: "app-stable",
    providerSessionId: "claude-stable",
  });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].id, first.id);
  assert.equal(snapshot.sessions[0].userPrompt, "123");
});

test("ai session registry prunes duplicate persisted identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-prune-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  const first = registry.start({
    agent: "claude",
    appSessionId: "app-stable",
    providerSessionId: "claude-stable",
  });
  registry.progress(first.id, "123", "user");
  registry.start({
    agent: "claude",
    appSessionId: "app-stable",
    providerSessionId: "claude-stable",
  });

  assert.equal(fs.readdirSync(path.join(root, "ai-sessions")).filter((name) => name.endsWith(".json")).length, 2);
  registry.prune();
  assert.equal(fs.readdirSync(path.join(root, "ai-sessions")).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(registry.snapshot().sessions[0].id, first.id);
});

test("ai session registry includes user prompt in snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  const session = registry.start({
    agent: "codex",
    appSessionId: "app-1",
    userPrompt: "Design the AI session board",
    summary: "Starting codex",
  });
  registry.progress(session.id, "AI board list updated", "assistant");

  const snapshot = registry.snapshot();
  assert.equal(snapshot.sessions[0].userPrompt, "Design the AI session board");
  assert.equal(snapshot.sessions[0].lastMessage, "AI board list updated");
  assert.equal(snapshot.sessions[0].turns.length, 1);
  assert.match(snapshot.sessions[0].turns[0].id, /^turn_/);
  assert.equal(snapshot.sessions[0].turns[0].revision, 1);
  assert.equal(snapshot.sessions[0].turns[0].userPrompt, "Design the AI session board");
  assert.equal(snapshot.sessions[0].turns[0].summary, "AI board list updated");
  assert.equal(snapshot.sessions[0].turns[0].lastMessage, "AI board list updated");
  assert.equal(typeof snapshot.sessions[0].turns[0].updatedAt, "string");
});

test("ai session registry derives the top-level prompt from canonical turns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-prompt-projection-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    providerSessionId: "thread_prompt_projection",
    userPrompt: "stale prompt",
  });

  const updated = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: session.providerSessionId,
    userPrompt: "stale prompt",
    turns: [{ id: "turn_1", userPrompt: "canonical prompt", status: "running" }],
    activeTurnId: "turn_1",
    status: "running",
    phase: "thinking",
  });

  assert.equal(updated.userPrompt, "canonical prompt");
  assert.equal(updated.turns.at(-1).userPrompt, "canonical prompt");
});

test("ai session registry clears previous response state when a new turn starts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-turn-boundary-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  const session = registry.start({
    agent: "codex",
    appSessionId: "app-1",
    userPrompt: "first prompt",
  });
  registry.progress(session.id, "first answer", "assistant");

  const next = registry.update(session.id, {
    status: "running",
    phase: "thinking",
    userPrompt: "second prompt",
  });

  assert.equal(next.summary, undefined);
  assert.equal(next.lastMessage, undefined);
  assert.equal(next.userPrompt, "second prompt");
  assert.deepEqual(next.turns.map((turn) => ({
    userPrompt: turn.userPrompt,
    summary: turn.summary,
    lastMessage: turn.lastMessage,
  })), [
    {
      userPrompt: "first prompt",
      summary: "first answer",
      lastMessage: "first answer",
    },
    {
      userPrompt: "second prompt",
      summary: undefined,
      lastMessage: undefined,
    },
  ]);
});

test("ai session registry keeps repeated prompt turns separate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-repeated-turn-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });

  const session = registry.start({
    agent: "claude",
    appSessionId: "app-1",
    userPrompt: "same prompt",
  });
  registry.progress(session.id, "first answer", "assistant");

  const next = registry.update(session.id, {
    status: "running",
    phase: "thinking",
    userPrompt: "same prompt",
  });

  assert.equal(next.lastMessage, undefined);
  assert.equal(next.summary, undefined);
  assert.equal(next.turns.length, 2);
  assert.deepEqual(next.turns.map((turn) => ({
    userPrompt: turn.userPrompt,
    lastMessage: turn.lastMessage,
  })), [
    { userPrompt: "same prompt", lastMessage: "first answer" },
    { userPrompt: "same prompt", lastMessage: undefined },
  ]);
});

test("ai session registry emits change events for realtime publishing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const changes = [];
  const unsubscribe = registry.onChange((reason) => changes.push(reason));

  const session = registry.start({
    agent: "codex",
    appSessionId: "app-1",
    userPrompt: "Stream quickly",
  });
  registry.progress(session.id, "working", "assistant");
  registry.complete(session.id, "done");
  unsubscribe();
  registry.progress(session.id, "ignored", "assistant");

  assert.deepEqual(changes, ["write", "write", "write"]);
});

test("ai session controller rejects approvals without structured provider support", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-control-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    appSessionId: "app-1",
    summary: "Waiting for approval",
  });
  const calls = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "codex",
    async sendMessage(current, input) {
      calls.push(["send", current.id, input.message]);
      return { session: current, provider: "codex", action: "send" };
    },
    async interrupt(current) {
      calls.push(["interrupt", current.id]);
      return { session: current, provider: "codex", action: "interrupt" };
    },
  });

  await assert.rejects(
    () => controller.resolveApproval(session.id, "allow"),
    (error) => error?.code === "AI_SESSION_APPROVAL_UNSUPPORTED",
  );
  await assert.rejects(
    () => controller.resolveApproval(session.id, "skip"),
    (error) => error?.code === "AI_SESSION_APPROVAL_UNSUPPORTED",
  );
  assert.deepEqual(calls, []);
});

test("ai session summaries disable interrupt for idle sessions even when provider capability is stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-idle-actions-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-claude",
    providerSessionId: "claude-idle-actions",
    status: "idle",
    phase: "unknown",
    actions: { send: true, interrupt: true, approval: false },
  });

  const [session] = registry.snapshot().sessions;
  assert.equal(session.status, "idle");
  assert.equal(session.actions.interrupt, false);
  assert.equal(session.actions.send, true);
});

test("ai session controller rejects interrupt for idle sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-idle-interrupt-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "claude",
    appSessionId: "app-claude",
    status: "idle",
    phase: "unknown",
  });
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "claude",
    async sendMessage(current) {
      return { session: current, provider: "claude", action: "send" };
    },
    async interrupt(current) {
      return { session: current, provider: "claude", action: "interrupt" };
    },
  });

  await assert.rejects(
    () => controller.interrupt(session.id),
    (error) => error?.code === "AI_SESSION_NOT_ACTIVE",
  );
});

test("ai session controller queues busy messages and exposes queue state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-queue-busy-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    appSessionId: "app-queue",
    activeTurnId: "turn-running",
    status: "running",
    phase: "thinking",
  });
  const calls = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "codex",
    async startMessage(current, input) {
      calls.push(["start", current.id, input.message]);
      return { session: current, provider: "codex", action: "send" };
    },
    async steerMessage(current, input) {
      calls.push(["steer", current.id, input.message]);
      return { session: current, provider: "codex", action: "steer" };
    },
    async interrupt(current) {
      return { session: current, provider: "codex", action: "interrupt" };
    },
  });

  const result = await controller.sendMessage(session.id, { message: "next task" });
  const updated = registry.get(session.id);
  assert.equal(result.action, "queue");
  assert.equal(result.queueId, updated.queue.items[0].id);
  assert.equal(updated.queue.pendingCount, 1);
  assert.equal(updated.queue.items[0].message, "next task");
  assert.deepEqual(calls, []);
});

test("ai session controller starts idle messages without queuing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-queue-idle-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    appSessionId: "app-idle",
    status: "idle",
    phase: "unknown",
  });
  const calls = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "codex",
    async startMessage(current, input) {
      calls.push(["start", current.id, input.message]);
      return { session: current, provider: "codex", action: "send", turnId: "turn-new" };
    },
    async interrupt(current) {
      return { session: current, provider: "codex", action: "interrupt" };
    },
  });

  const result = await controller.sendMessage(session.id, { message: "start now" });
  assert.equal(result.action, "send");
  assert.deepEqual(calls, [["start", session.id, "start now"]]);
  assert.equal(registry.get(session.id).queue.pendingCount, 0);
});

test("ai session controller can steer queued messages into active turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-queue-steer-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    appSessionId: "app-steer",
    activeTurnId: "turn-running",
    status: "running",
    phase: "thinking",
  });
  const queued = registry.enqueueMessage(session.id, "queued follow up");
  const calls = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "codex",
    async steerMessage(current, input) {
      calls.push(["steer", current.id, input.message]);
      return { session: current, provider: "codex", action: "steer", turnId: current.activeTurnId };
    },
    async interrupt(current) {
      return { session: current, provider: "codex", action: "interrupt" };
    },
  });

  const result = await controller.steerQueuedMessage(session.id, queued.item.id);
  assert.equal(result.action, "steer");
  assert.equal(result.queueId, queued.item.id);
  assert.deepEqual(calls, [["steer", session.id, "queued follow up"]]);
  assert.deepEqual(registry.get(session.id).queue.items, []);
});

test("ai session registry does not truncate assistant responses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const fullResponse = `${"A".repeat(5000)}\nfinal line`;

  const session = registry.start({
    agent: "codex",
    appSessionId: "app-1",
    userPrompt: "Return the full answer",
  });
  registry.progress(session.id, fullResponse, "assistant");

  const snapshotSession = registry.snapshot().sessions[0];
  assert.equal(snapshotSession.lastMessage, fullResponse);
  assert.equal(snapshotSession.lastMessage.endsWith("final line"), true);
  assert.equal(snapshotSession.turns[0].lastMessage, fullResponse);
  assert.equal(snapshotSession.summary.endsWith("..."), true);
  assert.equal(AiSessionSummarySchema.parse(snapshotSession).lastMessage, fullResponse);

  registry.complete(session.id, fullResponse);
  assert.equal(registry.snapshot().sessions[0].lastMessage, fullResponse);
});

test("ai session registry merges resumed claude app sessions by provider id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const cwd = path.join(root, "repo");

  const first = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-old",
    providerSessionId: "claude-session",
    title: "Claude",
    cwd,
    status: "idle",
  });
  const resumed = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-new",
    providerSessionId: "claude-session",
    title: "Claude",
    cwd,
    status: "running",
  });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(resumed?.id, first?.id);
  assert.equal(snapshot.sessions[0].appSessionId, "app-new");
  assert.equal(snapshot.sessions[0].providerSessionId, "claude-session");
  assert.equal(snapshot.sessions[0].status, "running");
});

test("claude control sock bridge binds daemon jobs and controls by short id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-control-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const calls = [];
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "ac8eaf94",
            sessionId: "ac8eaf94-408d-43a2-a270-7e15821b5a47",
            pid: 8653,
            cwd: "/workspace",
            state: "running",
            tempo: "active",
            cliVersion: "2.1.168",
            source: "shell",
          },
        ],
      };
    },
    async reply(short, text, options) {
      calls.push(["reply", short, text, options.sockPath]);
      return { ok: true };
    },
    async kill(short, signal, options) {
      calls.push(["kill", short, signal, options.sockPath]);
      return { ok: true };
    },
    subscribe(short, input) {
      calls.push(["subscribe", short, input.options.sockPath]);
      input.onMessage({
        type: "snapshot",
        record: {
          short,
          sessionId: "ac8eaf94-408d-43a2-a270-7e15821b5a47",
          state: "running",
          cwd: "/workspace",
        },
        streamTail: ["\u001b[31mClaude says hi\u001b[0m"],
      });
      return () => calls.push(["unsubscribe", short]);
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "ac8eaf94", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.agent, "claude");
  assert.equal(session.appSessionId, "app_claude");
  assert.equal(session.providerSessionId, "ac8eaf94-408d-43a2-a270-7e15821b5a47");
  assert.equal(session.providerMeta.short, "ac8eaf94");
  assert.equal(session.providerMeta.controlSock, "/tmp/control.sock");
  assert.equal(registry.get(session.id).lastMessage, "Claude says hi");

  const beforeSend = registry.get(session.id);
  await bridge.sendMessage(session, { message: "continue" });
  const afterSend = registry.get(session.id);
  assert.equal(afterSend.userPrompt, "continue");
  assert.equal(afterSend.summary, undefined);
  assert.equal(afterSend.lastMessage, undefined);
  assert.equal(afterSend.turns.length, beforeSend.turns.length + 1);
  assert.equal(afterSend.turns.at(-1).userPrompt, "continue");
  assert.equal(afterSend.turns.at(-1).summary, undefined);
  assert.equal(afterSend.turns.at(-1).lastMessage, undefined);
  await assert.rejects(
    () => bridge.resolveApproval(registry.get(session.id), "allow"),
    /do not expose structured approval control/,
  );
  await bridge.interrupt(registry.get(session.id));
  bridge.stop();
  assert.deepEqual(calls.slice(0, 5), [
    ["subscribe", "ac8eaf94", "/tmp/control.sock"],
    ["reply", "ac8eaf94", "continue\n", "/tmp/control.sock"],
    ["kill", "ac8eaf94", "SIGTERM", "/tmp/control.sock"],
    ["unsubscribe", "ac8eaf94"],
  ]);
});

test("claude control sock bridge ignores startup chrome in stream tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-startup-tail-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "ac8eaf94",
            sessionId: "ac8eaf94-408d-43a2-a270-7e15821b5a47",
            cwd: "/workspace",
            state: "running",
          },
        ],
      };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe(_short, input) {
      input.onMessage({
        type: "snapshot",
        streamTail: [
          "\u001b[1mClaude Code\u001b[0m v2.1.168",
          "mimo-v2.5 · API Usage Billing",
          "~/project/work",
          "● high · /effort",
          "────────────────────────────",
          '› Try "fix typecheck errors"',
        ],
      });
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "ac8eaf94", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "idle");
  assert.equal(session.summary, undefined);
  assert.equal(session.lastMessage, undefined);
});

test("claude control sock bridge strips two-byte escape controls from startup tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-esc78-tail-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "db4dff6d",
            sessionId: "db4dff6d-c544-4e7f-ada6-77ecb2251526",
            cwd: "/workspace",
            state: "running",
            tempo: "active",
            source: "shell",
          },
        ],
      };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe(_short, input) {
      input.onMessage({
        type: "snapshot",
        record: {
          short: "db4dff6d",
          sessionId: "db4dff6d-c544-4e7f-ada6-77ecb2251526",
          state: "running",
          tempo: "active",
          source: "shell",
        },
        streamTail: [
          "\u001b7\u001b[r\u001b8\u001b[?25h",
          "\u001b]0;✳ Claude Code\u0007",
          "\u001b[1mClaude Code\u001b[0m v2.1.168",
          "mimo-v2.5 · API Usage Billing",
          "~/project/work",
          "● high · /effort",
          "────────────────────────────────",
          "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
        ],
      });
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "db4dff6d", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "idle");
  assert.equal(session.summary, undefined);
  assert.equal(session.lastMessage, undefined);
  assert.deepEqual(session.turns, []);
});

test("claude control sock bridge ignores tui chrome and completed state becomes idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-tui-chrome-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "62cee1d4",
            sessionId: "62cee1d4-963f-4a56-8996-bfa5d9b754b2",
            cwd: "/workspace",
            state: "running",
          },
        ],
      };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe(_short, input) {
      input.onMessage({
        type: "snapshot",
        state: "done",
        streamTail: [
          "\u001b]0;✳ Claude Code\u0007",
          'log an error?"',
          "────────────────────────────────",
          "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
        ],
      });
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "62cee1d4", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "idle");
  assert.equal(session.lastMessage, undefined);
  assert.equal(session.turns.length, 0);
});

test("claude control sock bridge records subscribe state patches without driving lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-state-patch-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const messages = [];
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "71bead10",
            sessionId: "71bead10-0fb2-477f-ad44-c81370bcf729",
            cwd: "/workspace",
            state: "running",
            detail: "thinking",
          },
        ],
      };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe(_short, input) {
      messages.push(input.onMessage);
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "71bead10", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "running");

  messages[0]?.({ type: "state", patch: { state: "done" } });

  assert.equal(registry.get(session.id).status, "running");
  assert.equal(registry.get(session.id).providerMeta.state, "done");
  assert.equal(registry.get(session.id).providerMeta.stateSource, "patch.state");
});

test("claude control sock bridge records blocked state patches without approval controls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-state-blocked-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const messages = [];
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "73bead10",
            sessionId: "73bead10-0fb2-477f-ad44-c81370bcf729",
            cwd: "/workspace",
            state: "running",
            detail: "thinking",
          },
        ],
      };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe(_short, input) {
      messages.push(input.onMessage);
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "73bead10", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "running");

  messages[0]?.({ type: "state", patch: { state: "blocked", tempo: "blocked", needs: "user reply required" } });

  assert.equal(registry.get(session.id).status, "running");
  assert.equal(registry.get(session.id).phase, "thinking");
  assert.equal(registry.get(session.id).providerMeta.state, "blocked");
  assert.equal(registry.get(session.id).providerMeta.stateSource, "patch.state");
  assert.equal(registry.get(session.id).actions.approval, false);
});

test("claude control sock bridge applies subscribe settled outcomes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-settled-outcome-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const messages = [];
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return {
        ok: true,
        jobs: [
          {
            short: "72bead10",
            sessionId: "72bead10-0fb2-477f-ad44-c81370bcf729",
            cwd: "/workspace",
            state: "running",
            detail: "thinking",
          },
        ],
      };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe(_short, input) {
      messages.push(input.onMessage);
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "72bead10", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "running");

  messages[0]?.({ type: "settled", outcome: "done" });

  assert.equal(registry.get(session.id).status, "idle");
  assert.equal(registry.get(session.id).providerMeta.state, "done");
});

test("claude control sock bridge treats missing initial state as idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-initial-idle-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    async list() {
      return { ok: true, jobs: [] };
    },
    async reply() {
      return { ok: true };
    },
    async kill() {
      return { ok: true };
    },
    subscribe() {
      return () => undefined;
    },
  });

  await bridge.refresh({
    registry,
    appSessions: [
      {
        id: "app_claude",
        appId: "claude",
        title: "Claude",
        status: "running",
        tty: { cwd: "/workspace" },
        ai: { claude: { short: "ac8eaf94", controlSock: "/tmp/control.sock" } },
      },
    ],
  });

  const session = registry.list()[0];
  assert.equal(session.status, "idle");
  assert.equal(session.summary, undefined);
  assert.equal(session.userPrompt, undefined);
  assert.equal(session.lastMessage, undefined);
});

test("ai session registry merges transcript scans by provider session id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const cwd = path.join(root, "repo");
  const transcriptPath = path.join(root, "claude-transcript.jsonl");
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }));

  const first = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app-1",
    providerSessionId: "claude-session",
    title: "Claude",
    cwd,
    status: "running",
  });
  const scanned = registry.createFromTranscript("claude", transcriptPath, { providerSessionId: "claude-session", cwd });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(scanned.id, first?.id);
  assert.equal(registry.get(scanned.id)?.transcriptPath, transcriptPath);
});

test("ai session registry hides and prunes sessions whose app binding disappeared", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-binding-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions"), orphanedAppSessionRetentionMs: 1000 });
  const session = registry.start({
    agent: "codex",
    appId: "codex",
    appSessionId: "app-live",
    providerSessionId: "thread-live",
    summary: "Working",
  });

  registry.reconcileAppSessionBindings([{ id: "app-live" }], 10_000);
  assert.equal(registry.snapshot().sessions.length, 1);

  registry.reconcileAppSessionBindings([], 10_100);
  assert.equal(registry.snapshot().sessions.length, 0);
  assert.ok(registry.get(session.id));

  registry.reconcileAppSessionBindings([{ id: "app-live" }], 10_200);
  assert.equal(registry.snapshot().sessions.length, 1);

  registry.reconcileAppSessionBindings([], 10_300);
  assert.equal(registry.snapshot().sessions.length, 0);
  registry.reconcileAppSessionBindings([], 11_301);
  assert.equal(registry.get(session.id), undefined);
});

test("ai session registry keeps unbound provider sessions visible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-unbound-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions"), orphanedAppSessionRetentionMs: 1 });
  registry.start({
    agent: "claude",
    providerSessionId: "claude-unbound",
    summary: "No app binding",
  });
  registry.reconcileAppSessionBindings([], 10_000);
  assert.equal(registry.snapshot().sessions.length, 1);
});

test("ai session registry bound snapshots only expose running app-bound sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-bound-snapshot-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  registry.start({
    agent: "codex",
    appId: "codex",
    appSessionId: "app-live",
    providerSessionId: "thread-live",
    summary: "Visible",
  });
  registry.start({
    agent: "codex",
    appId: "codex-app-server",
    providerSessionId: "thread-unbound",
    summary: "Hidden",
  });
  registry.start({
    agent: "codex",
    appId: "codex",
    appSessionId: "app-stopped",
    providerSessionId: "thread-stopped",
    summary: "Stopped",
  });

  const snapshot = registry.boundSnapshot([
    { id: "app-live", status: "running" },
    { id: "app-stopped", status: "stopped" },
  ]);
  assert.deepEqual(snapshot.sessions.map((session) => session.providerSessionId), ["thread-live"]);
  assert.equal(snapshot.runningCount, 0);
});

test("recent transcript discovery ignores codex transcripts by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-scan-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const codexHome = path.join(root, "codex-home");
  const claudeHome = path.join(root, "claude-home");
  const codexSessions = path.join(codexHome, "sessions");
  const claudeProjects = path.join(claudeHome, "projects", "repo");
  fs.mkdirSync(codexSessions, { recursive: true });
  fs.mkdirSync(claudeProjects, { recursive: true });
  fs.writeFileSync(path.join(codexSessions, "codex-session.jsonl"), `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "codex" } })}\n`);
  fs.writeFileSync(path.join(claudeProjects, "claude-session.jsonl"), `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "claude" }] } })}\n`);
  const previousCodexHome = process.env.CODEX_HOME;
  const previousClaudeHome = process.env.CLAUDE_HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_HOME = claudeHome;
  try {
    scanRecentTranscripts(registry);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
  }

  const sessions = registry.snapshot().sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "claude");
});

test("active ai process discovery ignores codex processes by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-process-scan-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const codexTranscript = path.join(root, ".codex", "sessions", "codex-session.jsonl");
  const claudeTranscript = path.join(root, ".claude", "projects", "claude-session.jsonl");
  fs.mkdirSync(path.dirname(codexTranscript), { recursive: true });
  fs.mkdirSync(path.dirname(claudeTranscript), { recursive: true });
  fs.writeFileSync(codexTranscript, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "codex" } })}\n`);
  fs.writeFileSync(claudeTranscript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "claude" }] } })}\n`);
  const codex = registry.createFromTranscript("codex", codexTranscript, { providerSessionId: "codex-session", cwd: root });
  const claude = registry.createFromTranscript("claude", claudeTranscript, { providerSessionId: "claude-session", cwd: root });
  registry.update(codex.id, { status: "idle" });
  registry.update(claude.id, { status: "idle" });
  const commandRunner = (command, args) => {
    if (command === "/bin/ps") {
      return [
        " 111 ttys001 codex",
        " 222 ttys002 claude",
      ].join("\n");
    }
    if (command === "/usr/sbin/lsof" && args[1] === "111") {
      return `node txt ${codexTranscript}\nnode cwd ${root}\n`;
    }
    if (command === "/usr/sbin/lsof" && args[1] === "222") {
      return `node txt ${claudeTranscript}\nnode cwd ${root}\n`;
    }
    return "";
  };
  reconcileActiveAiProcesses(registry, undefined, commandRunner);

  assert.equal(registry.get(codex.id).status, "idle");
  assert.equal(registry.get(claude.id).status, "running");
});

test("ai session registry backfills user prompt from scanned transcripts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const cwd = path.join(root, "repo");
  const transcriptPath = path.join(root, "codex-transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "show the user prompt" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Current progress" }] } }),
    ].join("\n"),
  );

  registry.createFromTranscript("codex", transcriptPath, { providerSessionId: "codex-session", cwd });

  const session = registry.snapshot().sessions[0];
  assert.equal(session.userPrompt, "show the user prompt");
  assert.equal(session.lastMessage, "Current progress");
});

test("ai session registry preserves full assistant text from scanned transcripts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const cwd = path.join(root, "repo");
  const transcriptPath = path.join(root, "codex-transcript.jsonl");
  const fullResponse = `${"B".repeat(5000)}\nnot truncated`;
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: fullResponse }] } })}\n`,
  );

  registry.createFromTranscript("codex", transcriptPath, { providerSessionId: "codex-session", cwd });

  const session = registry.snapshot().sessions[0];
  assert.equal(session.lastMessage, fullResponse);
  assert.equal(session.lastMessage.endsWith("not truncated"), true);
  assert.equal(session.summary.endsWith("..."), true);
});

test("ai session registry treats repeated transcript backfill turns as a snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const cwd = path.join(root, "repo");
  const transcriptPath = path.join(root, "claude-transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { content: "123" }, timestamp: "2026-07-04T09:49:18.040Z" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "收到！有什么我可以帮你的？😊" }] }, timestamp: "2026-07-04T09:49:24.986Z" }),
    ].join("\n"),
  );

  const first = registry.createFromTranscript("claude", transcriptPath, { providerSessionId: "claude-session", cwd });
  const firstTurnId = registry.get(first.id)?.turns?.[0]?.id;
  fs.utimesSync(transcriptPath, new Date("2026-07-04T09:50:00.000Z"), new Date("2026-07-04T09:50:00.000Z"));
  registry.createFromTranscript("claude", transcriptPath, { providerSessionId: "claude-session", cwd });
  fs.utimesSync(transcriptPath, new Date("2026-07-04T09:51:00.000Z"), new Date("2026-07-04T09:51:00.000Z"));
  registry.createFromTranscript("claude", transcriptPath, { providerSessionId: "claude-session", cwd });

  const session = registry.get(first.id);
  assert.equal(session?.turns?.length, 1);
  assert.equal(session?.turns?.[0]?.id, firstTurnId);
  assert.equal(session?.turns?.[0]?.userPrompt, "123");
  assert.equal(session?.turns?.[0]?.lastMessage, "收到！有什么我可以帮你的？😊");
});

test("ai session registry merges transcript answers into adapter acknowledged pending turns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const transcriptPath = path.join(root, "claude-transcript.jsonl");
  const session = registry.start({
    agent: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude-session",
    transcriptPath,
  });

  registry.update(session.id, {
    status: "running",
    phase: "thinking",
    userPrompt: "continue",
  });
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { content: "continue" }, timestamp: "2026-07-04T09:49:18.040Z" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] }, timestamp: "2026-07-04T09:49:24.986Z" }),
    ].join("\n"),
  );
  registry.createFromTranscript("claude", transcriptPath, { providerSessionId: "claude-session" });

  const updated = registry.get(session.id);
  assert.equal(updated.turns.length, 1);
  assert.equal(updated.turns[0].userPrompt, "continue");
  assert.equal(updated.turns[0].lastMessage, "OK");
});

test("ai session registry only treats transcript scans as active when file size grows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-registry-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions"), idleAfterMs: 1000, staleAfterMs: 60000 });
  const cwd = path.join(root, "repo");
  const transcriptPath = path.join(root, "codex-transcript.jsonl");
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hello" } })}\n`);
  const oldTime = new Date(Date.now() - 5000);
  fs.utimesSync(transcriptPath, oldTime, oldTime);

  const first = registry.createFromTranscript("codex", transcriptPath, { providerSessionId: "codex-session", cwd });
  assert.equal(registry.snapshot().sessions[0].status, "idle");
  assert.equal(registry.get(first.id)?.transcriptSize, fs.statSync(transcriptPath).size);
  const firstUpdatedAt = registry.get(first.id)?.updatedAt;

  const touched = new Date();
  fs.utimesSync(transcriptPath, touched, touched);
  registry.createFromTranscript("codex", transcriptPath, { providerSessionId: "codex-session", cwd });
  assert.equal(registry.snapshot().sessions[0].status, "idle");
  assert.equal(registry.get(first.id)?.updatedAt, firstUpdatedAt);

  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "new output" } })}\n`);
  registry.createFromTranscript("codex", transcriptPath, { providerSessionId: "codex-session", cwd });
  assert.equal(registry.snapshot().sessions[0].status, "running");
  assert.notEqual(registry.get(first.id)?.updatedAt, firstUpdatedAt);
});

test("codex app server discovery continues when optional thread-list enrichment fails", async () => {
  const applied = [];
  const discovery = new CodexAppServerSessionDiscovery({
    applyThreadSnapshot: (thread) => applied.push(thread),
    ensureThreadSubscribed: async () => undefined,
  });
  const client = Object.assign(new EventEmitter(), {
    async start() {},
    stop() {},
    async listLoadedThreadIds() { return ["thread_loaded"]; },
    async listThreads() { throw new Error("thread/list is unavailable"); },
    async readThread(threadId) { return { id: threadId, name: "Loaded thread" }; },
  });

  await discovery.sync(client);

  assert.deepEqual(applied, [{ id: "thread_loaded", name: "Loaded thread" }]);
});

test("codex app server connection manager starts once for concurrent callers", async () => {
  let starts = 0;
  let releaseStart;
  const client = Object.assign(new EventEmitter(), {
    start() {
      starts += 1;
      return new Promise((resolve) => { releaseStart = resolve; });
    },
    stop() {},
    async listLoadedThreadIds() { return []; },
  });
  const manager = new CodexAppServerConnectionManager({
    injectedClient: client,
    createClient: () => client,
    onEvent() {},
  });

  const first = manager.ready();
  const second = manager.ready();
  assert.equal(starts, 1);
  releaseStart();
  const [firstConnection, secondConnection] = await Promise.all([first, second]);
  assert.equal(firstConnection, secondConnection);
});

test("codex app server connection manager ignores stale client events and initialization", async () => {
  const clients = [];
  const events = [];
  let releaseFirstStart;
  const manager = new CodexAppServerConnectionManager({
    createClient(options) {
      const client = Object.assign(new EventEmitter(), {
        options,
        start() {
          if (options.socketPath === "/tmp/first.sock") {
            return new Promise((resolve) => { releaseFirstStart = resolve; });
          }
          return Promise.resolve();
        },
        stop() {},
        async listLoadedThreadIds() { return []; },
      });
      clients.push(client);
      return client;
    },
    onEvent(event) { events.push(event); },
  });

  manager.configure("/tmp/first.sock");
  const staleStart = manager.ready();
  manager.configure("/tmp/second.sock");
  await manager.ready();
  const staleStartRejected = assert.rejects(staleStart, /connection changed/);
  releaseFirstStart();
  await staleStartRejected;

  clients[0].emit("event", { type: "thread", thread: { id: "old" } });
  clients[0].emit("disconnect");
  clients[0].emit("event", { type: "thread", thread: { id: "late-old" } });
  clients[1].emit("event", { type: "thread", thread: { id: "new" } });
  assert.deepEqual(events.map((event) => event.thread.id), ["new"]);
  assert.equal(manager.client, clients[1]);
  assert.ok(await manager.ready());
});

test("codex approval coordinator invalidates pending resolvers when the connection changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-approval-epoch-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex-app-server",
    providerSessionId: "thread_approval_epoch",
    status: "waiting",
    phase: "approval",
  });
  let responses = 0;
  const client = Object.assign(new EventEmitter(), {
    async start() {},
    stop() {},
    async listLoadedThreadIds() { return []; },
    async respondToApproval() { responses += 1; },
  });
  const coordinator = new CodexAppServerApprovalCoordinator({
    registry,
    currentClient: () => client,
    readyClient: async () => client,
    findSession: () => session,
    applyThreadSnapshot: () => undefined,
  });
  coordinator.register({
    id: 7,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    threadId: "thread_approval_epoch",
    summary: "Run tests",
    params: {},
  });
  const pending = coordinator.latestForSession(session.id);
  assert.ok(pending);

  coordinator.resetConnection();

  assert.equal(coordinator.latestForSession(session.id), undefined);
  await assert.rejects(() => pending.resolve("allow"), (error) => error.code === "AI_SESSION_APPROVAL_CONNECTION_CHANGED");
  assert.equal(responses, 0);
});

test("codex app server bridge syncs loaded threads and status notifications", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-app-server-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.started = false;
      this.stopped = false;
      this.reads = [];
      this.threads = [
        {
          id: "thread_1",
          cwd: "/workspace",
          name: "Feature work",
          preview: "Implement the thing",
          path: "/Users/me/.codex/sessions/rollout-thread_1.jsonl",
          status: { type: "active", activeFlags: [] },
          turns: [
            {
              id: "turn_1",
              status: "inProgress",
              items: [
                { type: "userMessage", id: "item_user_1", clientId: null, content: [{ type: "text", text: "Implement the app-server sourced receiver", text_elements: [] }] },
                { type: "agentMessage", id: "item_agent_1", text: "Working from app-server turns", phase: null, memoryCitation: null },
              ],
            },
          ],
        },
      ];
    }
    async start() {
      this.started = true;
    }
    async listLoadedThreadIds() {
      return this.threads.map((thread) => thread.id);
    }
    async readThread(threadId, options) {
      this.reads.push({ threadId, options });
      return this.threads.find((thread) => thread.id === threadId);
    }
    async respondToApproval() {}
    stop() {
      this.stopped = true;
    }
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();

  const synced = registry.list()[0];
  assert.equal(fake.started, true);
  assert.equal(synced.agent, "codex");
  assert.equal(synced.providerSessionId, "thread_1");
  assert.equal(synced.appId, "codex-app-server");
  assert.equal(synced.status, "running");
  assert.equal(synced.phase, "thinking");
  assert.deepEqual(fake.reads, [{ threadId: "thread_1", options: { includeTurns: true } }]);
  assert.equal(synced.transcriptPath, undefined);
  assert.equal(synced.userPrompt, "Implement the app-server sourced receiver");
  assert.equal("userPrompts" in synced, false);
  assert.equal(synced.lastMessage, "Working from app-server turns");
  assert.equal(synced.turns.length, 1);
  assert.equal(synced.turns[0].id, "turn_1");
  assert.equal(synced.activeTurnId, "turn_1");
  assert.equal(synced.turns[0].status, "running");
  assert.equal(synced.turns[0].revision, 1);
  assert.equal(synced.turns[0].userPrompt, "Implement the app-server sourced receiver");
  assert.equal(synced.turns[0].summary, "Working from app-server turns");
  assert.equal(synced.turns[0].lastMessage, "Working from app-server turns");

  fake.emit("event", {
    type: "thread-status",
    threadId: "thread_1",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  const unattachedWaiting = registry.list()[0];
  assert.equal(unattachedWaiting.status, "waiting");
  assert.equal(unattachedWaiting.phase, "thinking");

  fake.emit("event", {
    type: "approval-request",
    request: {
      id: 42,
      method: "item/commandExecution/requestApproval",
      kind: "command",
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "cmd_1",
      summary: "Tests need access to the local package cache.",
      params: { threadId: "thread_1", turnId: "turn_1", itemId: "cmd_1", command: "pnpm test" },
    },
  });
  const waiting = registry.list()[0];
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.phase, "approval");
  assert.equal(waiting.actions.approval, true);
  assert.equal(waiting.summary, "Tests need access to the local package cache.");

  fake.emit("event", {
    type: "thread",
    thread: {
      ...fake.threads[0],
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  });
  const waitingAfterSnapshot = registry.list()[0];
  assert.equal(waitingAfterSnapshot.phase, "approval");
  assert.equal(waitingAfterSnapshot.summary, "Tests need access to the local package cache.");
  assert.equal(waitingAfterSnapshot.turns[0].summary, "Tests need access to the local package cache.");

  fake.emit("event", { type: "turn-completed", threadId: "thread_1", status: "completed" });
  assert.equal(registry.list()[0].status, "idle");

  fake.emit("event", { type: "thread-closed", threadId: "thread_1" });
  assert.equal(registry.list()[0].status, "idle");
  bridge.stop();
  assert.equal(fake.stopped, true);
});

test("codex app server bridge preserves context compaction results across realtime and snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-compaction-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.thread = {
        id: "thread_compact",
        status: { type: "idle" },
        turns: [{
          id: "turn_snapshot",
          status: "completed",
          items: [{ type: "contextCompaction", id: "compact_snapshot" }],
        }],
      };
    }
    async start() {}
    async listLoadedThreadIds() { return ["thread_compact"]; }
    async readThread() { return this.thread; }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  let session = registry.list()[0];
  assert.deepEqual(session.turns[0].contextCompactions, [{ id: "context_compaction:turn_snapshot", status: "completed" }]);

  fake.emit("event", codexNotification("item/started", {
    threadId: "thread_compact",
    turnId: "turn_live",
    startedAtMs: 1_750_000_000_000,
    item: { type: "contextCompaction", id: "compact_live" },
  }));
  session = registry.list()[0];
  assert.deepEqual(session.turns.at(-1).contextCompactions, [{
    id: "context_compaction:turn_live",
    status: "running",
    startedAt: "2025-06-15T15:06:40.000Z",
  }]);

  fake.emit("event", codexNotification("item/completed", {
    threadId: "thread_compact",
    turnId: "turn_live",
    completedAtMs: 1_750_000_000_100,
    item: { type: "contextCompaction", id: "compact_live" },
  }));
  session = registry.list()[0];
  assert.deepEqual(session.turns.at(-1).contextCompactions, [{
    id: "context_compaction:turn_live",
    status: "completed",
    startedAt: "2025-06-15T15:06:40.000Z",
    completedAt: "2025-06-15T15:06:40.100Z",
  }]);
  const completedRevision = session.turns.at(-1).revision;
  fake.emit("event", codexNotification("item/completed", {
    threadId: "thread_compact",
    turnId: "turn_live",
    completedAtMs: 1_750_000_000_100,
    item: { type: "contextCompaction", id: "compact_live" },
  }));
  assert.equal(registry.list()[0].turns.at(-1).revision, completedRevision);

  fake.thread = {
    id: "thread_compact",
    status: { type: "active" },
    turns: [{
      id: "turn_live",
      status: "inProgress",
      items: [{ type: "contextCompaction", id: "item-47" }],
    }],
  };
  await bridge.sync();
  session = registry.list()[0];
  assert.deepEqual(session.turns.find((turn) => turn.id === "turn_live").contextCompactions, [{
    id: "context_compaction:turn_live",
    status: "completed",
    startedAt: "2025-06-15T15:06:40.000Z",
    completedAt: "2025-06-15T15:06:40.100Z",
  }]);
  assert.equal(session.currentTool?.kind, "context-compaction");
  assert.equal(session.currentTool?.name, "Context compacted");

  fake.emit("event", codexNotification("item/completed", {
    threadId: "thread_compact",
    turnId: "turn_live",
    item: { type: "agentMessage", id: "message_after_compaction", text: "Continuing after compaction." },
  }));
  session = registry.list()[0];
  assert.equal(session.currentTool, undefined);

  fake.emit("event", codexNotification("thread/compacted", {
    threadId: "thread_compact",
    turnId: "turn_legacy",
  }));
  session = registry.list()[0];
  assert.deepEqual(session.turns.at(-1).contextCompactions, [{
    id: "context_compaction:turn_legacy",
    status: "completed",
  }]);
  const reloaded = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  assert.deepEqual(reloaded.get(session.id).turns.at(-1).contextCompactions, [{
    id: "context_compaction:turn_legacy",
    status: "completed",
  }]);
});

test("codex app server bridge projects realtime tool activity and replaces it from thread snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-tools-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.thread = {
        id: "thread_tools",
        status: { type: "active", activeFlags: [] },
        turns: [{
          id: "turn_tools",
          status: "inProgress",
          items: [
            { type: "agentMessage", id: "message", text: "Starting tools" },
            { type: "commandExecution", id: "snapshot_cmd", command: "pnpm test", status: "inProgress" },
          ],
        }],
      };
    }
    async start() {}
    async listLoadedThreadIds() { return [this.thread.id]; }
    async readThread() { return this.thread; }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  let session = registry.list()[0];
  assert.equal(session.toolCallsSinceLastMessage, 1);
  assert.equal(session.currentTool.id, "snapshot_cmd");

  fake.emit("event", codexNotification("item/started", {
    threadId: "thread_tools",
    turnId: "turn_tools",
    startedAtMs: 1_750_000_000_000,
    item: { type: "webSearch", id: "live_search", query: "Codex app-server" },
  }));
  session = registry.list()[0];
  assert.equal(session.toolCallsSinceLastMessage, 2);
  assert.equal(session.currentTool.id, "live_search");

  fake.emit("event", { type: "turn-completed", threadId: "thread_tools", turnId: "turn_tools", status: "completed" });
  session = registry.list()[0];
  assert.equal(session.currentTool, undefined);
  assert.equal(session.toolCallsSinceLastMessage, 2);

  fake.emit("event", { type: "agent-message-completed", threadId: "thread_tools", turnId: "turn_tools", text: "Done" });
  session = registry.list()[0];
  assert.equal(session.currentTool, undefined);
  assert.equal(session.toolCallsSinceLastMessage, 0);

  fake.emit("event", codexNotification("item/started", {
    threadId: "thread_tools",
    item: { type: "commandExecution", id: "stale_live", command: "stale" },
  }));
  assert.equal(registry.list()[0].toolCallsSinceLastMessage, 1);
  fake.thread = {
    id: "thread_tools",
    status: { type: "idle" },
    turns: [{
      id: "turn_tools",
      status: "completed",
      items: [
        { type: "agentMessage", id: "latest_boundary", text: "Latest" },
        { type: "webSearch", id: "snapshot_done", query: "finished search" },
      ],
    }],
  };
  await bridge.sync();
  session = registry.list()[0];
  assert.equal(session.toolCallsSinceLastMessage, 1);
  assert.equal(session.currentTool, undefined);

  fake.emit("event", { type: "thread-closed", threadId: "thread_tools" });
  fake.emit("event", codexNotification("item/started", {
    threadId: "thread_tools",
    item: { type: "commandExecution", id: "new_connection_tool", command: "fresh" },
  }));
  session = registry.list()[0];
  assert.equal(session.toolCallsSinceLastMessage, 1);
  assert.equal(session.currentTool.id, "new_connection_tool");
});

test("codex app server bridge publishes sub-agent lifecycle independently from tool activity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-sub-agents-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() { return ["thread_parent"]; }
    async readThread() {
      return {
        id: "thread_parent",
        status: { type: "active", activeFlags: [] },
        turns: [{
          id: "turn_parent",
          status: "inProgress",
          items: [{
            type: "collabAgentToolCall",
            id: "spawn-1",
            tool: "spawnAgent",
            status: "completed",
            agentsStates: { thread_child: { status: "running" } },
          }],
        }],
      };
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  let session = registry.list()[0];
  assert.deepEqual(session.subAgents.map((agent) => [agent.threadId, agent.status]), [["thread_child", "running"]]);

  fake.emit("event", codexNotification("item/completed", {
    threadId: "thread_parent",
    turnId: "turn_parent",
    item: { type: "subAgentActivity", id: "spawn-1", kind: "interacted", agentThreadId: "thread_child", agentPath: "agent-a" },
  }));
  session = registry.list()[0];
  assert.equal(session.subAgents[0].path, "agent-a");
  assert.equal(session.subAgents[0].activity, "interacted");
  assert.equal(session.toolCallsSinceLastMessage, 1);

  fake.emit("event", codexNotification("item/completed", {
    threadId: "thread_parent",
    item: {
      type: "collabAgentToolCall",
      id: "wait-1",
      tool: "wait",
      status: "completed",
      agentsStates: { thread_child: { status: "completed", message: "Reviewed tests" } },
    },
  }));
  session = registry.list()[0];
  assert.equal(session.subAgents[0].status, "completed");
  assert.equal(session.subAgents[0].message, "Reviewed tests");
  assert.equal(session.subAgents[0].path, "agent-a");

  fake.emit("event", { type: "agent-message-completed", threadId: "thread_parent", turnId: "turn_parent", text: "Main response" });
  assert.equal(registry.list()[0].subAgents[0].status, "completed");
});

test("codex app server bridge repeated snapshots keep completed turns stable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-stable-turn-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.thread = {
        id: "thread_stable",
        cwd: "/workspace",
        name: "Stable",
        status: { type: "idle" },
        turns: [{
          id: "turn_stable",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "你好", text_elements: [] }] },
            { type: "agentMessage", text: "你好。有什么要我处理的？" },
          ],
        }],
      };
    }
    async start() {}
    async listLoadedThreadIds() {
      return [this.thread.id];
    }
    async readThread() {
      return this.thread;
    }
    stop() {}
  }

  const bridge = new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient());
  await bridge.sync([
    {
      id: "app_codex",
      appId: "codex",
      status: "running",
      ai: { activeThreadId: "thread_stable", threadIds: ["thread_stable"] },
    },
  ]);
  const first = registry.list()[0];
  assert.equal(first.turns[0].revision, 1);
  const firstTurn = { ...first.turns[0] };

  await new Promise((resolve) => setTimeout(resolve, 5));
  await bridge.sync([
    {
      id: "app_codex",
      appId: "codex",
      status: "running",
      ai: { activeThreadId: "thread_stable", threadIds: ["thread_stable"] },
    },
  ]);

  const second = registry.list()[0];
  assert.equal(second.turns[0].revision, firstTurn.revision);
  assert.equal(second.turns[0].observedAt, firstTurn.observedAt);
  assert.equal(second.turns[0].completedAt, firstTurn.completedAt);
  assert.equal(second.turns[0].lastMessage, firstTurn.lastMessage);
});

test("codex app server bridge does not expose approval actions before the request is attached", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-unattached-approval-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_unattached_approval"];
    }
    async readThread() {
      return {
        id: "thread_unattached_approval",
        cwd: "/workspace",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [],
      };
    }
    async respondToApproval() {}
    stop() {}
  }

  const bridge = new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient());
  await bridge.sync();

  const waiting = registry.list()[0];
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.phase, "thinking");
  assert.equal(waiting.actions.approval, false);
  bridge.stop();
});

test("codex app server failed turns expose the turn error message", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-failed-turn-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.threads = [
        {
          id: "thread_failed",
          cwd: "/workspace",
          name: "Failed turn",
          status: { type: "active" },
          turns: [{
            id: "turn_previous",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "previous prompt" }] },
              { type: "agentMessage", text: "previous answer" },
            ],
          }],
        },
      ];
    }
    async start() {}
    async listLoadedThreadIds() {
      return this.threads.map((thread) => thread.id);
    }
    async readThread(threadId) {
      return this.threads.find((thread) => thread.id === threadId);
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();

  const session = registry.list()[0];
  registry.applyRealtimeEvent(session.id, {
    kind: "send-ack",
    activeTurnId: "turn_failed",
    userPrompt: "current prompt",
    source: "control",
  });
  fake.emit("event", {
    type: "turn-completed",
    threadId: "thread_failed",
    turnId: "turn_failed",
    status: "failed",
    error: "The model request failed.",
  });

  const failed = registry.list()[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "The model request failed.");
  assert.equal(failed.lastMessage, "The model request failed.");
  assert.equal(failed.turns.at(-1).id, "turn_failed");
  assert.equal(failed.turns.at(-1).status, "failed");
  assert.equal(failed.turns.at(-1).lastMessage, "The model request failed.");
  assert.equal(failed.turns[0].lastMessage, "previous answer");
});

test("codex app server protocol parses failed turn error details", () => {
  const event = codexNotification("turn/completed", {
    threadId: "thread_failed",
    turn: {
      id: "turn_failed",
      status: "failed",
      error: {
        message: "The model request failed.",
        additionalDetails: "HTTP 500 from provider.",
        codexErrorInfo: null,
      },
    },
  });

  assert.deepEqual(event, {
    type: "turn-completed",
    threadId: "thread_failed",
    turnId: "turn_failed",
    status: "failed",
    error: "The model request failed.\n\nHTTP 500 from provider.",
  });
});

test("codex app server bridge emits raw message deltas without persisting partial snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-message-delta-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_delta"];
    }
    async readThread() {
      return { id: "thread_delta", cwd: "/workspace", status: { type: "active" }, turns: [] };
    }
    stop() {}
  }
  const fake = new FakeCodexAppServerClient();
  const deltas = [];
  const bridge = new CodexAppServerSessionBridge(registry, fake, {
    onMessageDelta: (event) => deltas.push(event),
  });
  await bridge.sync();
  const session = registry.list()[0];
  fake.emit("event", { type: "agent-message-delta", threadId: "thread_delta", turnId: "turn_delta", itemId: "item_delta", delta: "hel" });
  fake.emit("event", { type: "agent-message-delta", threadId: "thread_delta", turnId: "turn_delta", itemId: "item_delta", delta: "lo" });

  assert.deepEqual(deltas.map((event) => event.delta), ["hel", "lo"]);
  assert.equal(registry.get(session.id).lastMessage, undefined);

  fake.emit("event", { type: "agent-message-completed", threadId: "thread_delta", turnId: "turn_delta", itemId: "item_delta", text: "hello" });
  assert.equal(registry.get(session.id).lastMessage, "hello");
});

test("codex app server bridge reports event source closure before reconnect or stop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-message-delta-close-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() { return []; }
    stop() {}
  }
  const fake = new FakeCodexAppServerClient();
  const boundaries = [];
  const bridge = new CodexAppServerSessionBridge(registry, fake, {
    onEventSourceClose: () => boundaries.push("closed"),
  });

  await bridge.sync();
  fake.emit("disconnect");
  bridge.stop();

  assert.deepEqual(boundaries, ["closed", "closed"]);
});

test("codex app server bridge clears activity for empty idle thread snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-empty-thread-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const stale = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_empty",
    cwd: "/workspace",
    summary: "Codex thread is idle.",
    status: "idle",
  });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_empty"];
    }
    async readThread() {
      return {
        id: "thread_empty",
        cwd: "/workspace",
        name: "codex session",
        status: { type: "idle" },
        turns: [],
      };
    }
    stop() {}
  }

  await new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient()).sync([
    {
      id: "app_codex",
      appId: "codex",
      status: "running",
      ai: {
        activeThreadId: "thread_empty",
        appServer: { socketPath: "/tmp/codex.sock" },
      },
    },
  ]);

  const session = registry.get(stale.id);
  assert.equal(session?.status, "idle");
  assert.equal(session?.summary, undefined);
  assert.equal(session?.lastMessage, undefined);
  assert.equal(session?.userPrompt, undefined);
  assert.deepEqual(session?.turns, []);
});

test("codex app server bridge does not let stale thread snapshots overwrite a newer active turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-stale-thread-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_stale",
    cwd: "/workspace",
    userPrompt: "fifth prompt",
    turns: [{
      id: "turn_5",
      userPrompt: "fifth prompt",
      status: "completed",
      revision: 1,
      summary: "fifth answer",
      lastMessage: "fifth answer",
    }],
    summary: "fifth answer",
    lastMessage: "fifth answer",
    status: "idle",
    replaceActivity: true,
  });
  registry.update(session.id, {
    activeTurnId: "turn_6",
    status: "running",
    phase: "thinking",
    userPrompt: "sixth prompt",
  });

  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_stale"];
    }
    async readThread() {
      return {
        id: "thread_stale",
        cwd: "/workspace",
        name: "codex session",
        status: { type: "active" },
        turns: [{
          id: "turn_5",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "fifth prompt" }] },
            { type: "agentMessage", text: "fifth answer" },
          ],
        }],
      };
    }
    stop() {}
  }

  await new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient()).sync([
    {
      id: "app_codex",
      appId: "codex",
      status: "running",
      ai: {
        activeThreadId: "thread_stale",
        appServer: { socketPath: "/tmp/codex.sock" },
      },
    },
  ]);

  const updated = registry.get(session.id);
  assert.equal(updated.userPrompt, "sixth prompt");
  assert.equal(updated.activeTurnId, "turn_6");
  assert.equal(updated.status, "running");
  assert.equal(updated.lastMessage, undefined);
  assert.equal(updated.turns.at(-1).id, "turn_6");
  assert.equal(updated.turns.at(-1).userPrompt, "sixth prompt");
  assert.equal(updated.turns.at(-1).lastMessage, undefined);
});

test("codex app server bridge preserves adapter acknowledged active turn when snapshot lags behind", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-lagging-thread-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_lagging",
    cwd: "/workspace",
    userPrompt: "third prompt",
    turns: [
      { id: "turn_1", userPrompt: "first prompt", status: "completed", revision: 1, summary: "first answer", lastMessage: "first answer" },
      { id: "turn_2", userPrompt: "second prompt", status: "completed", revision: 1, summary: "second answer", lastMessage: "second answer" },
      { id: "turn_3", userPrompt: "third prompt", status: "completed", revision: 1, summary: "third answer", lastMessage: "third answer" },
    ],
    summary: "third answer",
    lastMessage: "third answer",
    status: "idle",
    replaceActivity: true,
  });
  registry.update(session.id, {
    activeTurnId: "turn_4",
    status: "running",
    phase: "thinking",
    userPrompt: "fourth prompt",
  });

  const rebound = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_lagging",
    cwd: "/workspace",
    userPrompt: "third prompt",
    turns: [
      { id: "turn_1", userPrompt: "first prompt", status: "completed", revision: 1, summary: "first answer", lastMessage: "first answer" },
      { id: "turn_2", userPrompt: "second prompt", status: "completed", revision: 1, summary: "second answer", lastMessage: "second answer" },
      { id: "turn_3", userPrompt: "third prompt", status: "completed", revision: 1, summary: "third answer", lastMessage: "third answer" },
    ],
    summary: "third answer",
    lastMessage: "third answer",
    status: "idle",
    phase: "unknown",
    replaceActivity: true,
  });

  assert.equal(rebound.status, "running");
  assert.equal(rebound.phase, "thinking");
  assert.equal(rebound.activeTurnId, "turn_4");
  assert.equal(rebound.userPrompt, "fourth prompt");
  assert.equal(rebound.summary, undefined);
  assert.equal(rebound.lastMessage, undefined);
  assert.equal(rebound.turns.length, 4);
  assert.equal(rebound.turns.at(-1).id, "turn_4");
  assert.equal(rebound.turns.at(-1).userPrompt, "fourth prompt");
  assert.equal(rebound.turns.at(-1).lastMessage, undefined);
});

test("ai session registry clears stale active turn id on idle adapter snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-idle-active-turn-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_idle_active_turn",
    cwd: "/workspace",
    userPrompt: "previous prompt",
    turns: [{
      id: "turn_previous",
      userPrompt: "previous prompt",
      status: "completed",
      revision: 1,
      summary: "previous answer",
      lastMessage: "previous answer",
    }],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "running",
    replaceActivity: true,
  });
  registry.applyRealtimeEvent(session.id, {
    kind: "turn-started",
    activeTurnId: "turn_previous",
    source: "realtime",
  });

  const rebound = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_idle_active_turn",
    cwd: "/workspace",
    userPrompt: "previous prompt",
    turns: [{
      id: "turn_previous",
      userPrompt: "previous prompt",
      status: "completed",
      revision: 1,
      summary: "previous answer",
      lastMessage: "previous answer",
    }],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "idle",
    phase: "unknown",
    replaceActivity: true,
  });

  assert.equal(rebound.status, "idle");
  assert.equal(rebound.activeTurnId, undefined);
  assert.equal(rebound.turns.at(-1).id, "turn_previous");
  assert.equal(rebound.turns.at(-1).status, "completed");
});

test("ai session registry keeps running active turn last when adapter snapshot order lags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-active-order-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_active_order",
    cwd: "/workspace",
    userPrompt: "777",
    activeTurnId: "turn_777",
    turns: [{
      id: "turn_777",
      userPrompt: "777",
      status: "completed",
      revision: 49,
      summary: "previous answer",
      lastMessage: "previous answer",
    }],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "idle",
    phase: "unknown",
    replaceActivity: true,
  });

  const running = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_active_order",
    cwd: "/workspace",
    userPrompt: "888",
    activeTurnId: "turn_888",
    turns: [
      {
        id: "turn_888",
        userPrompt: "888",
        status: "running",
        phase: "thinking",
        revision: 1,
      },
      {
        id: "turn_777",
        userPrompt: "777",
        status: "completed",
        revision: 51,
        summary: "previous answer",
        lastMessage: "previous answer",
      },
    ],
    status: "running",
    phase: "thinking",
    replaceActivity: true,
  });

  assert.equal(running.activeTurnId, "turn_888");
  assert.equal(running.userPrompt, "888");
  assert.equal(running.turns.at(-1).id, "turn_888");
  assert.equal(running.turns.at(-1).userPrompt, "888");
});

test("ai session registry preserves existing turn order when later snapshots update old turns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-turn-order-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude_turn_order",
    cwd: "/workspace",
    userPrompt: "333",
    turns: [
      {
        id: "turn_222",
        userPrompt: "222",
        status: "completed",
        revision: 1,
        summary: "answer 222",
        lastMessage: "answer 222",
      },
      {
        id: "turn_333",
        userPrompt: "333",
        status: "running",
        revision: 1,
      },
    ],
    activeTurnId: "turn_333",
    status: "running",
    phase: "thinking",
    replaceActivity: true,
  });

  const updated = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude_turn_order",
    cwd: "/workspace",
    userPrompt: "333",
    turns: [
      {
        id: "turn_333",
        userPrompt: "333",
        status: "completed",
        revision: 2,
        summary: "answer 333",
        lastMessage: "answer 333",
      },
      {
        id: "turn_222",
        userPrompt: "222",
        status: "completed",
        revision: 2,
        summary: "answer 222 updated",
        lastMessage: "answer 222 updated",
      },
    ],
    summary: "answer 333",
    lastMessage: "answer 333",
    status: "idle",
    phase: "unknown",
    replaceActivity: true,
  });

  assert.deepEqual(updated.turns.map((turn) => turn.userPrompt), ["222", "333"]);
  assert.equal(updated.turns[0].lastMessage, "answer 222 updated");
  assert.equal(updated.turns[1].lastMessage, "answer 333");
});

test("ai session registry clears stale top-level response when active turn completes without text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-interrupt-response-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_interrupt_response",
    cwd: "/workspace",
    userPrompt: "previous prompt",
    turns: [{
      id: "turn_previous",
      userPrompt: "previous prompt",
      status: "completed",
      revision: 1,
      summary: "previous answer",
      lastMessage: "previous answer",
    }],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "idle",
    replaceActivity: true,
  });

  registry.applyRealtimeEvent(session.id, {
    kind: "send-ack",
    activeTurnId: "turn_current",
    userPrompt: "current prompt",
    source: "control",
  });
  const interrupted = registry.applyRealtimeEvent(session.id, {
    kind: "turn-completed",
    activeTurnId: "turn_current",
    status: "idle",
    phase: "unknown",
    source: "control",
  });

  assert.equal(interrupted.userPrompt, "current prompt");
  assert.equal(interrupted.summary, undefined);
  assert.equal(interrupted.lastMessage, undefined);
  assert.equal(interrupted.turns.at(-1).id, "turn_current");
  assert.equal(interrupted.turns.at(-1).userPrompt, "current prompt");
  assert.equal(interrupted.turns.at(-1).lastMessage, undefined);
});

test("ai session registry reuses transcript turn ids across repeated backfills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-transcript-ids-"));
  const transcriptPath = path.join(root, "claude-session.jsonl");
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "这个项目是做什么的" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "项目说明" }] } }),
  ].join("\n") + "\n");
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.createFromTranscript("claude", transcriptPath, {
    providerSessionId: "claude-repeat-backfill",
    cwd: "/workspace",
  });
  const firstTurns = registry.get(session.id).turns.map((turn) => turn.id);

  registry.createFromTranscript("claude", transcriptPath, {
    providerSessionId: "claude-repeat-backfill",
    cwd: "/workspace",
  });
  const second = registry.get(session.id);

  assert.deepEqual(second.turns.map((turn) => turn.id), firstTurns);
  assert.deepEqual(second.turns.map((turn) => turn.userPrompt), ["这个项目是做什么的"]);
  assert.equal(second.turns.length, 1);
  assert.equal(second.turns[0].lastMessage, "项目说明");
});

test("ai session registry does not synthesize duplicate turns from top-level snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-snapshot-no-turns-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const first = registry.applyAdapterSnapshot({
    source: "transcript-scan",
    agent: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude-no-turns",
    cwd: "/workspace",
    userPrompt: "你好啊",
    summary: "你好！有什么可以帮你的吗？ 😊",
    lastMessage: "你好！有什么可以帮你的吗？ 😊",
    status: "idle",
    phase: "unknown",
    observedAt: "2026-07-04T13:07:44.556Z",
    replaceActivity: false,
  });

  for (let index = 0; index < 5; index += 1) {
    registry.applyAdapterSnapshot({
      source: "transcript-scan",
      agent: "claude",
      appSessionId: "app_claude",
      providerSessionId: "claude-no-turns",
      cwd: "/workspace",
      userPrompt: "你好啊",
      summary: "你好！有什么可以帮你的吗？ 😊",
      lastMessage: "你好！有什么可以帮你的吗？ 😊",
      status: "idle",
      phase: "unknown",
      observedAt: `2026-07-04T13:08:0${index}.000Z`,
      replaceActivity: false,
    });
  }

  const session = registry.get(first.id);
  assert.equal(session.userPrompt, "你好啊");
  assert.equal(session.lastMessage, "你好！有什么可以帮你的吗？ 😊");
  assert.equal(session.turns.length, 0);
});

test("ai session registry keeps pending send ack running across idle app refreshes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-idle-refresh-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude_idle_refresh",
    cwd: "/workspace",
    userPrompt: "previous prompt",
    turns: [{
      id: "turn_previous",
      userPrompt: "previous prompt",
      status: "completed",
      revision: 1,
      summary: "previous answer",
      lastMessage: "previous answer",
    }],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "idle",
    replaceActivity: true,
  });

  registry.applyRealtimeEvent(session.id, {
    kind: "send-ack",
    userPrompt: "latest prompt",
  });

  const rebound = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude_idle_refresh",
    cwd: "/workspace",
    status: "idle",
    phase: "unknown",
  });

  assert.equal(rebound.status, "running");
  assert.equal(rebound.phase, "thinking");
  assert.equal(rebound.userPrompt, "latest prompt");
  assert.equal(rebound.summary, undefined);
  assert.equal(rebound.lastMessage, undefined);
  assert.equal(rebound.turns.length, 2);
  assert.equal(rebound.turns.at(-1).userPrompt, "latest prompt");
  assert.equal(rebound.turns.at(-1).lastMessage, undefined);
});

test("ai session registry keeps transcript-tail response on acknowledged turn id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-turn-canonical-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "claude",
    appId: "claude",
    appSessionId: "app_claude",
    providerSessionId: "claude_turn_canonical",
    cwd: "/workspace",
    status: "idle",
    phase: "unknown",
  });

  registry.applyRealtimeEvent(session.id, {
    kind: "send-ack",
    activeTurnId: "turn_ack",
    providerTurnId: "turn_ack",
    userPrompt: "你好啊",
    observedAt: "2026-07-04T16:34:35.089Z",
    source: "control",
  });
  registry.applyRealtimeEvent(session.id, {
    kind: "user-message",
    activeTurnId: "turn_transcript",
    providerTurnId: "turn_transcript",
    userPrompt: "你好啊",
    observedAt: "2026-07-04T16:34:35.111Z",
    source: "transcript-tail",
  });
  registry.applyRealtimeEvent(session.id, {
    kind: "assistant-message",
    activeTurnId: "turn_transcript",
    providerTurnId: "turn_transcript",
    text: "你好！有什么我可以帮你的吗？",
    observedAt: "2026-07-04T16:34:37.799Z",
    source: "transcript-tail",
  });

  const updated = registry.get(session.id);
  assert.equal(updated.status, "idle");
  assert.equal(updated.phase, "unknown");
  assert.equal(updated.activeTurnId, "turn_ack");
  assert.equal(updated.turns.length, 1);
  assert.equal(updated.turns[0].id, "turn_ack");
  assert.equal(updated.turns[0].providerTurnId, "turn_transcript");
  assert.equal(updated.turns[0].userPrompt, "你好啊");
  assert.equal(updated.turns[0].lastMessage, "你好！有什么我可以帮你的吗？");
  assert.equal(updated.turns[0].status, "completed");
});

test("ai session reducer records turn source metadata and priority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-source-meta-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    sourcePriority: 60,
    snapshotVersion: 7,
    observedAt: "2026-07-04T00:00:00.000Z",
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_meta",
    cwd: "/workspace",
    userPrompt: "snapshot prompt",
    turns: [{
      id: "turn_snapshot",
      providerTurnId: "provider_turn_snapshot",
      userPrompt: "snapshot prompt",
      status: "completed",
      revision: 1,
      summary: "snapshot answer",
      lastMessage: "snapshot answer",
    }],
    summary: "snapshot answer",
    lastMessage: "snapshot answer",
    status: "idle",
    replaceActivity: true,
  });

  const initialTurn = registry.get(session.id).turns[0];
  assert.equal(initialTurn.source, "adapter-snapshot");
  assert.equal(initialTurn.providerTurnId, "provider_turn_snapshot");
  assert.equal(initialTurn.sourcePriority, 60);
  assert.equal(initialTurn.snapshotVersion, 7);
  assert.equal(initialTurn.observedAt, "2026-07-04T00:00:00.000Z");

  registry.applyRealtimeEvent(session.id, {
    kind: "send-ack",
    activeTurnId: "turn_realtime",
    providerTurnId: "provider_turn_realtime",
    userPrompt: "realtime prompt",
    observedAt: "2026-07-04T00:00:01.000Z",
    source: "realtime",
  });

  const afterRealtime = registry.get(session.id);
  assert.equal(afterRealtime.activeTurnId, "turn_realtime");
  assert.equal(afterRealtime.userPrompt, "realtime prompt");
  assert.equal(afterRealtime.turns.at(-1).source, "realtime");
  assert.equal(afterRealtime.turns.at(-1).providerTurnId, "provider_turn_realtime");
  assert.equal(afterRealtime.turns.at(-1).sourcePriority, 80);
  assert.equal(afterRealtime.turns.at(-1).observedAt, "2026-07-04T00:00:01.000Z");

  const lagging = registry.applyAdapterSnapshot({
    source: "transcript-scan",
    sourcePriority: 20,
    snapshotVersion: 8,
    observedAt: "2026-07-04T00:00:02.000Z",
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_meta",
    cwd: "/workspace",
    userPrompt: "snapshot prompt",
    turns: [{
      id: "turn_snapshot",
      providerTurnId: "provider_turn_snapshot",
      userPrompt: "snapshot prompt",
      status: "completed",
      revision: 2,
      summary: "late transcript answer",
      lastMessage: "late transcript answer",
    }],
    summary: "late transcript answer",
    lastMessage: "late transcript answer",
    status: "idle",
    replaceActivity: true,
  });

  assert.equal(lagging.activeTurnId, "turn_realtime");
  assert.equal(lagging.status, "running");
  assert.equal(lagging.userPrompt, "realtime prompt");
  assert.equal(lagging.lastMessage, undefined);
  assert.equal(lagging.turns.at(-1).id, "turn_realtime");
  assert.equal(lagging.turns.at(-1).lastMessage, undefined);
});

test("codex app server bridge does not attach previous response to a new active turn snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-active-snapshot-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_active_snapshot",
    cwd: "/workspace",
    userPrompt: "previous prompt",
    turns: [{
      id: "turn_previous",
      userPrompt: "previous prompt",
      status: "completed",
      revision: 1,
      summary: "previous answer",
      lastMessage: "previous answer",
    }],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "idle",
    replaceActivity: true,
  });
  registry.update(session.id, {
    activeTurnId: "turn_new",
    status: "running",
    phase: "thinking",
    userPrompt: "new prompt",
  });

  const rebound = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_codex",
    providerSessionId: "thread_active_snapshot",
    cwd: "/workspace",
    userPrompt: "new prompt",
    turns: [
      {
        id: "turn_previous",
        userPrompt: "previous prompt",
        status: "completed",
        revision: 1,
        summary: "previous answer",
        lastMessage: "previous answer",
      },
      {
        id: "turn_new",
        userPrompt: "new prompt",
        status: "completed",
        revision: 0,
      },
    ],
    summary: "previous answer",
    lastMessage: "previous answer",
    status: "idle",
    phase: "unknown",
    replaceActivity: true,
  });

  assert.equal(rebound.userPrompt, "new prompt");
  assert.equal(rebound.summary, undefined);
  assert.equal(rebound.lastMessage, undefined);
  assert.equal(rebound.turns.at(-1).id, "turn_new");
  assert.equal(rebound.turns.at(-1).userPrompt, "new prompt");
  assert.equal(rebound.turns.at(-1).summary, undefined);
  assert.equal(rebound.turns.at(-1).lastMessage, undefined);
});

test("codex app server bridge does not use thread preview as ai response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-preview-response-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_preview"];
    }
    async readThread() {
      return {
        id: "thread_preview",
        cwd: "/workspace",
        name: "codex session",
        preview: "哈哈哈",
        status: { type: "active", activeFlags: [] },
        turns: [{
          id: "turn_1",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "哈哈哈" }] },
          ],
        }],
      };
    }
    stop() {}
  }

  await new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient()).sync([
    {
      id: "app_codex",
      appId: "codex",
      status: "running",
      ai: {
        activeThreadId: "thread_preview",
        appServer: { socketPath: "/tmp/codex.sock" },
      },
    },
  ]);

  const session = registry.list()[0];
  assert.equal(session.userPrompt, "哈哈哈");
  assert.equal(session.summary, undefined);
  assert.equal(session.lastMessage, undefined);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].userPrompt, "哈哈哈");
  assert.equal(session.turns[0].summary, undefined);
  assert.equal(session.turns[0].lastMessage, undefined);
});

test("codex app server bridge does not bind loaded threads by cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-no-cwd-bind-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_loaded"];
    }
    async readThread() {
      return (
        {
          id: "thread_loaded",
          cwd: "/workspace",
          name: "Loaded",
          preview: "Loaded thread",
          status: { type: "idle" },
        }
      );
    }
    stop() {}
  }

  const bridge = new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient());
  await bridge.sync([
    {
      id: "app_running",
      appId: "codex",
      status: "running",
      tty: { cwd: "/workspace" },
      ai: { appServer: { socketPath: "/private/tmp/codex.sock" } },
    },
  ]);

  const session = registry.list()[0];
  assert.equal(session.providerSessionId, "thread_loaded");
  assert.equal(session.appSessionId, undefined);
  assert.equal(session.appId, "codex-app-server");
});

test("codex app server bridge binds threads only from explicit app metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-event-bind-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return [];
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync([
    {
      id: "app_running",
      appId: "codex",
      status: "running",
      tty: { cwd: "/workspace-a" },
      ai: { activeThreadId: "thread_started", threadIds: ["thread_started"], appServer: { socketPath: "/private/tmp/codex.sock" } },
    },
    {
      id: "app_stopped",
      appId: "codex",
      status: "stopped",
      tty: { cwd: "/workspace-b" },
      ai: { appServer: { socketPath: "/private/tmp/codex.sock" } },
    },
  ]);
  fake.emit("event", {
    type: "thread",
    thread: {
      id: "thread_started",
      cwd: "/some-other-workspace",
      name: "Started",
      preview: "Started thread",
      status: { type: "active", activeFlags: [] },
    },
  });

  const session = registry.list()[0];
  assert.equal(session.providerSessionId, "thread_started");
  assert.equal(session.appSessionId, "app_running");
  assert.equal(session.appId, "codex");
  assert.equal(session.cwd, "/some-other-workspace");
});

test("codex app server bridge does not guess a binding from single app or duplicate prompts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-no-guess-bind-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_duplicate_prompt"];
    }
    async readThread() {
      return {
        id: "thread_duplicate_prompt",
        cwd: "/workspace",
        name: "Duplicate",
        preview: "same prompt",
        status: { type: "idle" },
      };
    }
    stop() {}
  }

  const bridge = new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient());
  await bridge.sync([
    {
      id: "app_one",
      appId: "codex",
      title: "Codex",
      status: "running",
      launch: { args: ["same prompt"] },
      tty: { cwd: "/workspace" },
      ai: { appServer: { socketPath: "/private/tmp/codex.sock" } },
    },
    {
      id: "app_two",
      appId: "codex",
      title: "Codex",
      status: "running",
      launch: { args: ["same prompt"] },
      tty: { cwd: "/workspace" },
      ai: { appServer: { socketPath: "/private/tmp/codex.sock" } },
    },
  ]);

  const session = registry.list()[0];
  assert.equal(session.providerSessionId, "thread_duplicate_prompt");
  assert.equal(session.appSessionId, undefined);
  assert.equal(session.appId, "codex-app-server");
});

test("codex app server client paginates loaded thread ids", async () => {
  const client = new CodexAppServerClient({ command: "codex" });
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (!params.cursor) {
      return { data: ["thread_1"], nextCursor: "page_2" };
    }
    return { data: ["thread_2", 42, "thread_3"], nextCursor: null };
  };

  assert.deepEqual(await client.listLoadedThreadIds(), ["thread_1", "thread_2", "thread_3"]);
  assert.deepEqual(requests, [
    { method: "thread/loaded/list", params: { cursor: undefined, limit: 100 } },
    { method: "thread/loaded/list", params: { cursor: "page_2", limit: 100 } },
  ]);
});

test("codex app server bridge rebuilds the client when shared socket changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-socket-change-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.started = false;
      this.stopped = false;
    }
    async start() {
      this.started = true;
    }
    async listLoadedThreadIds() {
      return [];
    }
    stop() {
      this.stopped = true;
    }
  }
  const clients = [];
  const bridge = new CodexAppServerSessionBridge(registry, {
    createClient: (options) => {
      const client = new FakeCodexAppServerClient(options);
      clients.push(client);
      return client;
    },
  });

  await bridge.sync([{ id: "app_a", appId: "codex", status: "running", ai: { appServer: { socketPath: "/tmp/codex-a.sock" } } }]);
  await bridge.sync([{ id: "app_b", appId: "codex", status: "running", ai: { appServer: { socketPath: "/tmp/codex-b.sock" } } }]);

  assert.equal(clients.length, 2);
  assert.equal(clients[0].options.socketPath, "/tmp/codex-a.sock");
  assert.equal(clients[1].options.socketPath, "/tmp/codex-b.sock");
  assert.equal(clients[0].stopped, true);
  assert.equal(clients[1].started, true);
});

test("ai session registry treats stopped app session bindings as missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-stopped-binding-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions"), orphanedAppSessionRetentionMs: 1000 });
  registry.start({
    agent: "codex",
    appId: "codex",
    appSessionId: "app_stopped",
    providerSessionId: "thread-stopped",
    summary: "Old app",
  });

  registry.reconcileAppSessionBindings([{ id: "app_stopped", status: "stopped" }], 10_000);
  assert.equal(registry.snapshot().sessions.length, 0);
});

test("ai session registry clears stale app binding from authoritative adapter snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-cleared-binding-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions"), orphanedAppSessionRetentionMs: 1000 });
  const session = registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex",
    appSessionId: "app_stopped",
    providerSessionId: "thread-stopped",
    appBindingKeys: ["app:app_stopped"],
    status: "idle",
  });

  registry.reconcileAppSessionBindings([{ id: "app_stopped", status: "stopped" }], 10_000);
  assert.equal(registry.snapshot().sessions.length, 0);

  registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex-app-server",
    providerSessionId: "thread-stopped",
    status: "idle",
  });

  const updated = registry.get(session.id);
  assert.equal(updated?.appSessionId, undefined);
  assert.equal(updated?.appBindingKeys, undefined);
  assert.equal(registry.snapshot().sessions.length, 1);
  assert.equal(registry.snapshot().sessions[0].appSessionId, undefined);
});

test("claude control sock bridge ignores stopped app sessions and prunes undiscovered adapter sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-adapter-prune-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const stopped = registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "claude",
    appId: "claude",
    appSessionId: "app_stopped",
    providerSessionId: "stopped-provider",
    providerMeta: { short: "deadbeef" },
    status: "idle",
  });
  const stale = registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "claude",
    providerSessionId: "stale-provider",
    providerMeta: { short: "feedface" },
    status: "running",
  });
  const bridge = new ClaudeControlSockSessionBridge(registry, {
    list: async () => ({
      ok: true,
      jobs: [{
        short: "cafebabe",
        sessionId: "live-provider",
        pid: 123,
        cwd: "/workspace",
        state: "running",
      }],
    }),
    reply: async () => ({ ok: true }),
    kill: async () => ({ ok: true }),
    subscribe: () => () => {},
  });

  await bridge.refresh({
    registry,
    appSessions: [
      { id: "app_stopped", appId: "claude", status: "stopped", ai: { claude: { short: "deadbeef", cwd: "/workspace" } } },
    ],
  });

  assert.equal(registry.get(stopped.id), undefined);
  assert.equal(registry.get(stale.id), undefined);
  const sessions = registry.snapshot(10).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].providerSessionId, "live-provider");
  assert.equal(sessions[0].providerMeta.short, "cafebabe");
});

test("codex app server bridge controls turns through the ai session provider interface", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-app-control-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.started = false;
      this.startedTurns = [];
      this.steeredTurns = [];
      this.interruptedTurns = [];
      this.threads = [
        {
          id: "thread_control",
          cwd: "/workspace",
          name: "Control work",
          preview: "Ready",
          status: { type: "idle" },
        },
      ];
    }
    async start() {
      this.started = true;
    }
    async listLoadedThreadIds() {
      return this.threads.map((thread) => thread.id);
    }
    async readThread(threadId) {
      return this.threads.find((thread) => thread.id === threadId);
    }
    async startTurn(threadId, message) {
      this.startedTurns.push({ threadId, message });
      return { turnId: `turn_started_${this.startedTurns.length}` };
    }
    async steerTurn(threadId, turnId, message) {
      this.steeredTurns.push({ threadId, turnId, message });
      if (message === "stale follow up") {
        throw new Error("no active turn to steer");
      }
      if (turnId === "mismatched_turn") {
        throw new Error("expected active turn id `mismatched_turn` but found `actual_turn`");
      }
      return { turnId };
    }
    async interruptTurn(threadId, turnId) {
      this.interruptedTurns.push({ threadId, turnId });
      if (turnId === "stale_turn") {
        throw new Error("no active turn to interrupt");
      }
      if (turnId === "mismatched_turn") {
        throw new Error("expected active turn id `mismatched_turn` but found `actual_turn`");
      }
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  const session = registry.list()[0];

  const sent = await bridge.sendMessage(session, { message: "first" });
  assert.equal(sent.providerTurnId, "turn_started_1");
  assert.deepEqual(fake.startedTurns, [{ threadId: "thread_control", message: "first" }]);
  const afterSend = registry.get(session.id);
  assert.equal(afterSend.activeTurnId, "turn_started_1");
  assert.equal(afterSend.userPrompt, "first");
  assert.equal(afterSend.summary, undefined);
  assert.equal(afterSend.lastMessage, undefined);
  assert.equal(afterSend.turns.at(-1).id, "turn_started_1");
  assert.equal(afterSend.turns.at(-1).userPrompt, "first");
  assert.equal(afterSend.turns.at(-1).summary, undefined);
  assert.equal(afterSend.turns.at(-1).lastMessage, undefined);

  const running = registry.get(session.id);
  await bridge.sendMessage(running, { message: "follow up" });
  assert.deepEqual(fake.steeredTurns, [{ threadId: "thread_control", turnId: "turn_started_1", message: "follow up" }]);

  await assert.rejects(
    () => bridge.resolveApproval(registry.get(session.id), "allow"),
    (error) => error?.code === "AI_SESSION_APPROVAL_NOT_ATTACHED",
  );
  assert.equal(fake.steeredTurns.length, 1);

  await bridge.interrupt(registry.get(session.id));
  assert.deepEqual(fake.interruptedTurns, [{ threadId: "thread_control", turnId: "turn_started_1" }]);

  registry.update(session.id, { activeTurnId: "stale_turn", status: "running", phase: "thinking" });
  const fallbackSent = await bridge.sendMessage(registry.get(session.id), { message: "stale follow up" });
  assert.deepEqual(fake.steeredTurns.at(-1), { threadId: "thread_control", turnId: "stale_turn", message: "stale follow up" });
  assert.deepEqual(fake.startedTurns.at(-1), { threadId: "thread_control", message: "stale follow up" });
  assert.equal(fallbackSent.providerTurnId, "turn_started_2");
  assert.equal(registry.get(session.id).activeTurnId, "turn_started_2");
  assert.equal(registry.get(session.id).turns.at(-1).userPrompt, "stale follow up");

  const startedCountAfterStale = fake.startedTurns.length;
  registry.update(session.id, { activeTurnId: "mismatched_turn", status: "running", phase: "thinking" });
  const recoveredSent = await bridge.sendMessage(registry.get(session.id), { message: "recover active turn mismatch" });
  assert.deepEqual(fake.steeredTurns.slice(-2), [
    { threadId: "thread_control", turnId: "mismatched_turn", message: "recover active turn mismatch" },
    { threadId: "thread_control", turnId: "actual_turn", message: "recover active turn mismatch" },
  ]);
  assert.equal(fake.startedTurns.length, startedCountAfterStale);
  assert.equal(recoveredSent.providerTurnId, "actual_turn");
  assert.equal(registry.get(session.id).activeTurnId, "actual_turn");
  assert.equal(registry.get(session.id).turns.at(-1).userPrompt, "recover active turn mismatch");

  registry.update(session.id, { activeTurnId: "stale_turn", status: "running", phase: "thinking" });
  await bridge.interrupt(registry.get(session.id));
  assert.equal(registry.get(session.id).status, "idle");
  assert.equal(registry.get(session.id).activeTurnId, undefined);

  registry.update(session.id, { activeTurnId: "mismatched_turn", status: "running", phase: "thinking" });
  await bridge.interrupt(registry.get(session.id));
  assert.deepEqual(fake.interruptedTurns.slice(-2), [
    { threadId: "thread_control", turnId: "mismatched_turn" },
    { threadId: "thread_control", turnId: "actual_turn" },
  ]);
  assert.equal(registry.get(session.id).activeTurnId, "actual_turn");
});

test("codex mention facade filters catalogs, invalidates cache, searches cwd, and submits structured inputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-mentions-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexMentionsClient extends EventEmitter {
    catalogCalls = 0;
    turns = [];
    async start() {}
    stop() {}
    async listLoadedThreadIds() { return []; }
    async listSkills(cwd) {
      this.catalogCalls += 1;
      return { data: [{ cwd, skills: [
        { name: "docs", description: "Documentation", path: `${cwd}/.agents/skills/docs/SKILL.md`, enabled: true },
        { name: "disabled", description: "Disabled", path: `${cwd}/disabled/SKILL.md`, enabled: false },
      ] }] };
    }
    async listPlugins() {
      return { marketplaces: [{ name: "curated", plugins: [
        { id: "review@curated", name: "Review", installed: true, enabled: true, availability: "AVAILABLE" },
        { id: "blocked@curated", name: "Blocked", installed: true, enabled: true, availability: "DISABLED_BY_ADMIN" },
      ] }] };
    }
    async listApps() {
      return { data: [
        { id: "github", name: "GitHub", description: "Issues and pull requests", isAccessible: true, isEnabled: true },
        { id: "hidden", name: "Hidden", isAccessible: false, isEnabled: true },
      ] };
    }
    async startFuzzyFileSearch() {}
    async updateFuzzyFileSearch(sessionId, query) {
      queueMicrotask(() => {
        this.emit("notification", { method: "fuzzyFileSearch/sessionUpdated", params: { sessionId, query, files: [
          { path: "/workspace/src/index.ts", file_name: "index.ts", match_type: "file" },
          { path: "/outside/secret", file_name: "secret", match_type: "file" },
        ] } });
        this.emit("notification", { method: "fuzzyFileSearch/sessionCompleted", params: { sessionId } });
      });
    }
    async stopFuzzyFileSearch() {}
    async startTurn(threadId, message, inputs) {
      this.turns.push({ threadId, message, inputs });
      return { turnId: "turn_mentions" };
    }
  }
  const fake = new FakeCodexMentionsClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  const session = registry.start({ agent: "codex", providerSessionId: "thread_mentions", cwd: "/workspace", status: "idle", phase: "unknown" });

  const catalog = await bridge.mentionCatalog(session);
  assert.deepEqual(catalog.candidates.map((candidate) => [candidate.kind, candidate.name, candidate.path]), [
    ["skill", "docs", "/workspace/.agents/skills/docs/SKILL.md"],
    ["plugin", "Review", "plugin://review@curated"],
    ["app", "GitHub", "app://github"],
  ]);
  await bridge.mentionCatalog(session);
  assert.equal(fake.catalogCalls, 1);
  fake.emit("notification", { method: "skills/changed", params: {} });
  await bridge.mentionCatalog(session);
  assert.equal(fake.catalogCalls, 2);

  const files = await bridge.searchMentionFiles(session, "index");
  assert.equal(files.complete, true);
  assert.deepEqual(files.candidates.map((candidate) => candidate.path), ["src/index.ts"]);

  await bridge.startMessage(session, { message: "Use these", references: [
    { kind: "skill", name: "docs", path: "/workspace/.agents/skills/docs/SKILL.md" },
    { kind: "app", name: "GitHub", path: "app://github" },
    { kind: "app", name: "GitHub duplicate", path: "app://github" },
  ] });
  assert.deepEqual(fake.turns[0].inputs, [
    { type: "text", text: "Use these", text_elements: [] },
    { type: "skill", name: "docs", path: "/workspace/.agents/skills/docs/SKILL.md" },
    { type: "mention", name: "GitHub", path: "app://github" },
  ]);
  await assert.rejects(
    () => bridge.startMessage(registry.get(session.id), { message: "Bad", references: [{ kind: "app", name: "Missing", path: "app://missing" }] }),
    (error) => error?.code === "AI_SESSION_REFERENCE_UNAVAILABLE",
  );
});

test("codex command facade invokes structured app-server methods", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-commands-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const calls = [];
  class FakeCodexCommandsClient extends EventEmitter {
    async start() {}
    stop() {}
    async listLoadedThreadIds() { return []; }
    async startReview(threadId) { calls.push(["review", threadId]); return { turnId: "turn_review" }; }
    async setThreadName(threadId, name) { calls.push(["rename", threadId, name]); }
    async setThreadGoal(threadId, objective) { calls.push(["goal-set", threadId, objective]); return { goal: { objective } }; }
    async getThreadGoal(threadId) { calls.push(["goal-get", threadId]); return { goal: { objective: "Ship it" } }; }
    async compactThread(threadId) { calls.push(["compact", threadId]); }
  }
  const bridge = new CodexAppServerSessionBridge(registry, new FakeCodexCommandsClient());
  const session = registry.start({ agent: "codex", providerSessionId: "thread_commands", cwd: "/workspace", status: "idle", phase: "unknown" });

  assert.deepEqual(await bridge.executeCommand(session, { command: "review" }), { command: "review", turnId: "turn_review" });
  assert.deepEqual(await bridge.executeCommand(session, { command: "rename", argument: "New name" }), { command: "rename", value: "New name" });
  bridge["applyProviderEvent"]({ type: "thread-name", threadId: "thread_commands", name: "New name" });
  assert.equal(registry.get(session.id).title, "New name");
  assert.deepEqual(await bridge.executeCommand(session, { command: "goal", argument: "Ship it" }), { command: "goal", value: "Ship it" });
  assert.deepEqual(await bridge.executeCommand(session, { command: "goal" }), { command: "goal", value: "Ship it" });
  assert.deepEqual(await bridge.executeCommand(session, { command: "compact" }), { command: "compact" });
  assert.deepEqual(calls, [
    ["review", "thread_commands"],
    ["rename", "thread_commands", "New name"],
    ["goal-set", "thread_commands", "Ship it"],
    ["goal-get", "thread_commands"],
    ["compact", "thread_commands"],
  ]);
  await assert.rejects(
    () => bridge.executeCommand({ ...session, status: "running" }, { command: "review" }),
    (error) => error?.code === "AI_SESSION_BUSY",
  );
});

test("AI session queue preserves references through steer and retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-reference-queue-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "codex", activeTurnId: "turn-running", status: "running", phase: "thinking" });
  const reference = { kind: "plugin", name: "Review", path: "plugin://review@curated" };
  const calls = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "codex",
    async steerMessage(current, input) {
      calls.push(input);
      return { session: current, provider: "codex", action: "steer", turnId: current.activeTurnId };
    },
    async interrupt(current) { return { session: current, provider: "codex", action: "interrupt" }; },
  });
  const queued = await controller.sendMessage(session.id, { message: "Review this", references: [reference] });
  assert.deepEqual(registry.get(session.id).queue.items[0].references, [reference]);
  registry.markQueuedMessageFailed(session.id, queued.queueId, new Error("temporary"));
  controller.retryQueuedMessage(session.id, queued.queueId);
  assert.deepEqual(registry.get(session.id).queue.items[0].references, [reference]);
  await controller.steerQueuedMessage(session.id, queued.queueId);
  assert.deepEqual(calls[0].references, [reference]);
  assert.deepEqual(registry.get(session.id).queue.items, []);
});

test("AI session controller carries references through immediate and automatic dequeue and rejects non-Codex providers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-reference-control-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const reference = { kind: "skill", name: "Docs", path: "/workspace/docs/SKILL.md" };
  const calls = [];
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "codex",
    async startMessage(current, input) {
      calls.push(input);
      return { session: current, provider: "codex", action: "send", turnId: "turn" };
    },
    async interrupt(current) { return { session: current, provider: "codex", action: "interrupt" }; },
  });
  const idle = registry.start({ agent: "codex", status: "idle", phase: "unknown" });
  await controller.sendMessage(idle.id, { message: "Immediate", mode: "immediate", references: [reference] });
  assert.deepEqual(calls[0].references, [reference]);

  const busy = registry.start({ agent: "codex", activeTurnId: "running", status: "running", phase: "thinking" });
  await controller.sendMessage(busy.id, { message: "Later", mode: "auto", references: [reference] });
  registry.complete(busy.id, "Done");
  await controller.sendNextQueuedMessage(busy.id);
  assert.deepEqual(calls[1].references, [reference]);

  const claude = registry.start({ agent: "claude", status: "idle", phase: "unknown" });
  await assert.rejects(
    () => controller.sendMessage(claude.id, { message: "No", references: [reference] }),
    (error) => error?.code === "AI_SESSION_REFERENCES_UNSUPPORTED",
  );
});

test("codex app server bridge records sent prompt even when provider omits turn id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-send-no-turn-id-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.startedTurns = [];
      this.threads = [{
        id: "thread_no_turn_id",
        cwd: "/workspace",
        status: { type: "idle" },
        turns: [{
          id: "turn_previous",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "不用了" }] },
            { type: "agentMessage", text: "好的。" },
          ],
        }],
      }];
    }
    async start() {}
    async listLoadedThreadIds() {
      return this.threads.map((thread) => thread.id);
    }
    async readThread(threadId) {
      return this.threads.find((thread) => thread.id === threadId);
    }
    async startTurn(threadId, message) {
      this.startedTurns.push({ threadId, message });
      return {};
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  const session = registry.list()[0];
  const sent = await bridge.sendMessage(session, { message: "最新消息" });

  assert.equal(sent.providerTurnId, undefined);
  assert.deepEqual(fake.startedTurns, [{ threadId: "thread_no_turn_id", message: "最新消息" }]);
  const updated = registry.get(session.id);
  assert.equal(updated.status, "running");
  assert.equal(updated.userPrompt, "最新消息");
  assert.equal(updated.turns.length, 2);
  assert.equal(updated.turns.at(-1).userPrompt, "最新消息");
  assert.equal(updated.turns.at(-1).lastMessage, undefined);
  assert.notEqual(updated.turns.at(-1).id, "turn_previous");
  bridge.stop();
});

test("codex app server bridge updates user prompts from app-server item notifications", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-app-item-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_item"];
    }
    async readThread() {
      return { id: "thread_item", cwd: "/workspace", status: { type: "active", activeFlags: [] }, turns: [] };
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  fake.emit("event", {
    type: "user-message",
    threadId: "thread_item",
    turnId: "turn_1",
    text: "Use app-server item payload",
  });

  const session = registry.list()[0];
  assert.equal(session.userPrompt, "Use app-server item payload");
  assert.equal("userPrompts" in session, false);
  assert.equal(session.turns[0].userPrompt, "Use app-server item payload");
  assert.equal(session.transcriptPath, undefined);
});

test("codex app server bridge resolves app-server approval requests structurally", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-app-approval-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.approvals = [];
      this.startedTurns = [];
    }
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_approval"];
    }
    async readThread() {
      return {
        id: "thread_approval",
        cwd: "/workspace",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn_previous", items: [{ type: "agentMessage", text: "Existing assistant response" }] }],
      };
    }
    async startTurn(threadId, message) {
      this.startedTurns.push({ threadId, message });
      return { turnId: "turn_fallback" };
    }
    async interruptTurn() {}
    async respondToApproval(request, decision) {
      this.approvals.push({ request, decision });
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  fake.emit("event", {
    type: "approval-request",
    request: {
      id: 42,
      method: "item/commandExecution/requestApproval",
      kind: "command",
      threadId: "thread_approval",
      turnId: "turn_approval",
      itemId: "cmd_1",
      summary: "Approve command: pnpm test",
      params: { threadId: "thread_approval", turnId: "turn_approval", itemId: "cmd_1", command: "pnpm test" },
    },
  });

  const waiting = registry.list()[0];
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.phase, "approval");
  assert.equal(waiting.activeTurnId, "turn_approval");
  assert.equal(waiting.summary, "Approve command: pnpm test");
  assert.equal(waiting.actions.approval, true);

  const approved = await bridge.resolveApproval(waiting, "allow");
  assert.equal(approved.action, "approval");
  assert.equal(approved.decision, "allow");
  assert.deepEqual(fake.approvals.map((entry) => [entry.request.id, entry.decision]), [[42, "allow"]]);
  assert.deepEqual(fake.startedTurns, []);
  assert.equal(registry.get(waiting.id).status, "running");
  assert.equal(registry.get(waiting.id).phase, "thinking");
  assert.equal(registry.get(waiting.id).lastMessage, "Existing assistant response");
  assert.notEqual(registry.get(waiting.id).summary, "Codex approval allowed.");
});

test("codex app server bridge resumes thread to attach pending approval requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-app-approval-resume-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.approvals = [];
      this.resumedThreads = [];
    }
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_resume_approval"];
    }
    async readThread() {
      return {
        id: "thread_resume_approval",
        cwd: "/workspace",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [{ id: "turn_previous", items: [{ type: "agentMessage", text: "Existing assistant response" }] }],
      };
    }
    async resumeThread(threadId) {
      this.resumedThreads.push(threadId);
      queueMicrotask(() => {
        this.emit("event", {
          type: "approval-request",
          request: {
            id: 88,
            method: "item/fileChange/requestApproval",
            kind: "file-change",
            threadId,
            turnId: "turn_replayed",
            itemId: "patch_1",
            summary: "Approve file changes under /workspace",
            params: { threadId, turnId: "turn_replayed", itemId: "patch_1", grantRoot: "/workspace" },
          },
        });
      });
      return {
        id: threadId,
        cwd: "/workspace",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [{ id: "turn_previous", items: [{ type: "agentMessage", text: "Existing assistant response" }] }],
      };
    }
    async respondToApproval(request, decision) {
      this.approvals.push({ request, decision });
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();

  const waiting = registry.list()[0];
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.phase, "approval");

  const approved = await bridge.resolveApproval(waiting, "allow");
  assert.equal(approved.action, "approval");
  assert.deepEqual(fake.resumedThreads, ["thread_resume_approval"]);
  assert.deepEqual(fake.approvals.map((entry) => [entry.request.id, entry.decision]), [[88, "allow"]]);
  assert.equal(registry.get(waiting.id).activeTurnId, "turn_replayed");
  assert.equal(registry.get(waiting.id).status, "running");
  assert.equal(registry.get(waiting.id).phase, "thinking");
  assert.equal(registry.get(waiting.id).lastMessage, "Existing assistant response");
  assert.notEqual(registry.get(waiting.id).summary, "Codex approval allowed.");
});

test("codex app server bridge subscribes each loaded thread once per connection epoch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-thread-subscriptions-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.resumedThreads = [];
    }
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_one", "thread_two"];
    }
    async readThread(threadId) {
      return { id: threadId, cwd: "/workspace", status: { type: "active" }, turns: [] };
    }
    async resumeThread(threadId) {
      this.resumedThreads.push(threadId);
      return { id: threadId, cwd: "/workspace", status: { type: "active" }, turns: [] };
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  await bridge.sync();
  assert.deepEqual(fake.resumedThreads, ["thread_one", "thread_two"]);

  bridge.stop();
  await bridge.sync();
  assert.deepEqual(fake.resumedThreads, ["thread_one", "thread_two", "thread_one", "thread_two"]);
});

test("codex app server bridge isolates thread subscription failures and retries only failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-thread-subscription-failure-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.resumedThreads = [];
    }
    async start() {}
    async listLoadedThreadIds() {
      return ["thread_failing", "thread_healthy"];
    }
    async readThread(threadId) {
      return { id: threadId, cwd: "/workspace", status: { type: "active" }, turns: [] };
    }
    async resumeThread(threadId) {
      this.resumedThreads.push(threadId);
      if (threadId === "thread_failing") throw new Error("resume failed");
      return { id: threadId, cwd: "/workspace", status: { type: "active" }, turns: [] };
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  assert.deepEqual(registry.list().map((session) => session.providerSessionId).sort(), ["thread_failing", "thread_healthy"]);
  await bridge.sync();
  assert.deepEqual(fake.resumedThreads, ["thread_failing", "thread_healthy", "thread_failing"]);
});

test("codex app server client responds to permission approvals with granted permission profile", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new CodexAppServerClient({ command: "codex", requestTimeoutMs: 100 });
  client.child = {
    stdin: input,
    killed: false,
  };
  const writes = [];
  input.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  output.on("data", (chunk) => client.onData(chunk));

  await client.respondToApproval(
    {
      id: 99,
      method: "item/permissions/requestApproval",
      kind: "permissions",
      threadId: "thread_permissions",
      turnId: "turn_permissions",
      itemId: "call_permissions",
      summary: "Approve write",
      params: {
        threadId: "thread_permissions",
        turnId: "turn_permissions",
        itemId: "call_permissions",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/read-only"],
            write: ["/Users/example/project/file.txt"],
          },
        },
      },
    },
    "allow",
  );

  const response = JSON.parse(writes.join("").trim());
  assert.deepEqual(response, {
    id: 99,
    result: {
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/read-only"],
          write: ["/Users/example/project/file.txt"],
        },
      },
      scope: "turn",
    },
  });
});

test("codex app server bridge does not bind transcript sessions by prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-app-fallback-bind-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    providerSessionId: "thread_from_transcript",
    userPrompt: "quick prompt",
    summary: "quick response",
  });
  class FakeCodexAppServerClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() {
      return [];
    }
    stop() {}
  }

  const bridge = new CodexAppServerSessionBridge(registry, new FakeCodexAppServerClient());
  await bridge.sync([
    {
      id: "app_quick",
      appId: "codex",
      title: "Codex",
      status: "running",
      launch: { args: ["quick prompt"] },
      tty: { cwd: "/workspace" },
      ai: { appServer: { socketPath: "/tmp/codex-app-server.sock" } },
    },
  ]);

  assert.equal(registry.get(session.id).appSessionId, undefined);
  assert.equal(registry.get(session.id).appId, undefined);
});

test("codex app server bridge ignores idle thread status while a sent turn has no response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-idle-status-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  class FakeCodexAppServerClient extends EventEmitter {
    constructor() {
      super();
      this.threads = [{
        id: "thread_idle_race",
        cwd: "/workspace",
        status: { type: "idle" },
        turns: [{
          id: "turn_previous",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "previous prompt" }] },
            { type: "agentMessage", text: "previous answer" },
          ],
        }],
      }];
    }
    async start() {}
    async listLoadedThreadIds() {
      return this.threads.map((thread) => thread.id);
    }
    async readThread(threadId) {
      return this.threads.find((thread) => thread.id === threadId);
    }
    async startTurn() {
      return { turnId: "turn_new" };
    }
    stop() {}
  }

  const fake = new FakeCodexAppServerClient();
  const bridge = new CodexAppServerSessionBridge(registry, fake);
  await bridge.sync();
  const session = registry.list()[0];
  await bridge.sendMessage(session, { message: "nihao" });

  fake.emit("event", {
    type: "thread-status",
    threadId: "thread_idle_race",
    status: { type: "idle" },
  });

  const updated = registry.get(session.id);
  assert.equal(updated.status, "running");
  assert.equal(updated.activeTurnId, "turn_new");
  assert.equal(updated.userPrompt, "nihao");
  assert.equal(updated.lastMessage, undefined);
  assert.equal(updated.turns.at(-1).id, "turn_new");
  assert.equal(updated.turns.at(-1).userPrompt, "nihao");
  assert.equal(updated.turns.at(-1).lastMessage, undefined);
  bridge.stop();
});

test("ai session discovery coordinator runs providers with shared context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-discovery-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const coordinator = new AiSessionDiscoveryCoordinator();
  const calls = [];
  const appSessions = [{ id: "app_1", appId: "codex" }];
  coordinator.register({
    id: "first",
    refresh(context) {
      calls.push(["first", context.registry === registry, context.appSessions === appSessions]);
    },
  });
  coordinator.register({
    id: "second",
    async refresh(context) {
      calls.push(["second", context.registry === registry, context.appSessions === appSessions]);
    },
  });

  await coordinator.refresh({ registry, appSessions });

  assert.deepEqual(calls, [
    ["first", true, true],
    ["second", true, true],
  ]);
});

test("transcript progress hides codex turn context events", () => {
  const state = { calls: new Map() };
  assert.equal(
    summarizeTranscriptLine(JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-a" } }), state),
    undefined,
  );
});

test("transcript progress extracts user prompts", () => {
  const state = { calls: new Map() };
  assert.deepEqual(
    summarizeTranscriptLine(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix the AI board" }] } }), state),
    { text: "fix the AI board", kind: "user" },
  );
  assert.deepEqual(
    summarizeTranscriptLine(
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "show current prompt" }] } }),
      state,
    ),
    { text: "show current prompt", kind: "user" },
  );
});

test("web app serves core API routes with isolated storage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-api-"));
  const paths = appRuntimeTestPaths(root);
  const historicalChannelsDir = path.join(root, "channels");
  const historicalConversationsDir = path.join(root, "conversations");
  const historicalFiles = [
    [path.join(historicalChannelsDir, "telegram.default.json"), '{"legacy":"channel"}\n'],
    [path.join(historicalConversationsDir, "index.json"), '{"legacy":"conversation"}\n'],
    [paths.configPath, '{"legacy":"receiver-settings"}\n'],
  ];
  for (const [filePath, content] of historicalFiles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
    TASK_HANDOFF_CODEX_COMMAND: process.execPath,
    TASK_HANDOFF_CODEX_MODEL: "gpt-codex-test",
    TASK_HANDOFF_CLAUDE_COMMAND: process.execPath,
    TASK_HANDOFF_CLAUDE_MODEL: "claude-sonnet-test",
    TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS: "1",
    TASK_HANDOFF_CHROMIUM_COMMAND: process.execPath,
    TASK_HANDOFF_VSCODE_WEB_COMMAND: process.execPath,
    TASK_HANDOFF_XTERM_COMMAND: process.execPath,
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.payload).data.ok, true);

    const status = await app.inject({ method: "GET", url: "/api/status" });
    assert.equal(status.statusCode, 200);
    const statusData = JSON.parse(status.payload).data;
    assert.equal(statusData.runningAppCount, 0);
    assert.equal(statusData.aiSessions, undefined);

    const instanceStatus = await app.inject({ method: "GET", url: "/api/instance/status" });
    assert.equal(instanceStatus.statusCode, 200);
    const instanceStatusData = JSON.parse(instanceStatus.payload).data;
    assert.equal(instanceStatusData.status, "running");
    assert.equal(instanceStatusData.controlMode, "standalone");
    assert.equal(instanceStatusData.receiver, undefined);
    assert.equal(instanceStatusData.apps.runningCount, 0);
    assert.equal(instanceStatusData.aiSessions.waitingCount, 0);

    const aiSessions = await app.inject({ method: "GET", url: "/api/ai-sessions" });
    assert.equal(aiSessions.statusCode, 200);
    assert.deepEqual(JSON.parse(aiSessions.payload).data.snapshot.sessions, []);

    const instanceCapabilities = await app.inject({ method: "GET", url: "/api/instance/capabilities" });
    assert.equal(instanceCapabilities.statusCode, 200);
    const capabilitiesData = JSON.parse(instanceCapabilities.payload).data;
    assert.equal(capabilitiesData.features.appRuntime, true);
    assert.equal(capabilitiesData.features.receiver, undefined);
    assert.equal(capabilitiesData.apps, undefined);
    assert.equal(instanceStatusData.appInventory.items.some((entry) => entry.id === "terminal-tty"), true);

    const workspaceStatus = await app.inject({ method: "GET", url: "/api/workspace/status" });
    assert.equal(workspaceStatus.statusCode, 200);
    assert.equal(JSON.parse(workspaceStatus.payload).data.path, process.env.TASK_HANDOFF_WORKSPACE || process.env.WORKSPACE || "/workspace");

    const diagnostics = await app.inject({ method: "GET", url: "/api/diagnostics" });
    assert.equal(diagnostics.statusCode, 200);
    const diagnosticsData = JSON.parse(diagnostics.payload).data;
    assert.equal(diagnosticsData.runtime.platform, process.platform);
    assert.equal(diagnosticsData.runtime.linuxRuntime, process.platform === "linux");
    assert.equal(diagnosticsData.noVnc.available, false);
    assert.equal(diagnosticsData.storage.every((entry) => entry.writable), true);
    assert.equal(diagnosticsData.storage.some((entry) => entry.key === "appCatalogDir"), true);
    assert.equal(diagnosticsData.storage.some((entry) => entry.key === "runtimeDir"), true);
    assert.equal(diagnosticsData.storage.some((entry) => entry.key === "eventsDir"), true);
    assert.equal(diagnosticsData.storage.some((entry) => entry.key === "logDir"), true);
    assert.equal(diagnosticsData.storage.some((entry) => entry.key === "channelsDir"), false);
    assert.equal(diagnosticsData.storage.some((entry) => entry.key === "conversationsDir"), false);
    assert.equal(diagnosticsData.commands.some((entry) => entry.name === "chromium"), true);
    assert.match(diagnosticsData.sessionStreams.ai.streamId, /^ais_/);
    assert.match(diagnosticsData.sessionStreams.app.streamId, /^aps_/);
    assert.equal(Number.isInteger(diagnosticsData.sessionStreams.ai.revision), true);
    assert.equal(Number.isInteger(diagnosticsData.sessionStreams.app.revision), true);
    assert.equal(Number.isInteger(diagnosticsData.sessionStreams.ai.discoveryUnchanged), true);
    assert.equal(Number.isInteger(diagnosticsData.sessionStreams.ai.discoveryCorrections), true);
    assert.deepEqual(diagnosticsData.sessionStreams.ai.messageDeltaCoalescing, {
      windowMs: 32,
      pendingMessageCount: 0,
      rawDeltaCount: 0,
      emittedEventCount: 0,
      totalBatchSize: 0,
      maxBatchSize: 0,
      flushReasons: {},
      totalFirstBatchWaitMs: 0,
      maxFirstBatchWaitMs: 0,
    });

    const catalog = await app.inject({ method: "GET", url: "/api/apps/catalog" });
    assert.equal(catalog.statusCode, 200);
    const catalogItems = JSON.parse(catalog.payload).data;
    assert.equal(catalogItems.some((entry) => entry.id === "terminal-tty"), true);
    const codexApp = catalogItems.find((entry) => entry.id === "codex");
    assert.equal(codexApp.command, process.env.TASK_HANDOFF_CODEX_COMMAND || "codex");
    assert.deepEqual(codexApp.args, ["-c", "check_for_update_on_startup=false", "--model", "gpt-codex-test"]);
    const claudeApp = catalogItems.find((entry) => entry.id === "claude");
    assert.equal(claudeApp.command, process.env.TASK_HANDOFF_CLAUDE_COMMAND || "claude");
    assert.deepEqual(claudeApp.args, ["--dangerously-skip-permissions", "--model", "claude-sonnet-test"]);
    assert.equal(catalogItems.some((entry) => entry.id === "cc-switch"), false);
    assert.equal(catalogItems.some((entry) => entry.id === "web-cap"), false);
    const guiTerminal = catalogItems.find((entry) => entry.id === "terminal-gui");
    assert.equal(guiTerminal.kind, "gui");
    assert.equal(guiTerminal.command, process.env.TASK_HANDOFF_XTERM_COMMAND || "xterm");

    const customCatalog = await app.inject({
      method: "PATCH",
      url: "/api/apps/catalog/custom",
      payload: {
        items: [{ id: "custom-tty", name: "Custom TTY", kind: "tty", command: "/bin/bash" }],
      },
    });
    assert.equal(customCatalog.statusCode, 200);
    assert.equal(JSON.parse(customCatalog.payload).data.items[0].id, "custom-tty");

    for (const payload of [
      { items: [{ id: "custom-service", name: "Service", kind: "service", command: "/bin/true" }] },
      { items: [{ id: "terminal-tty", name: "Override", kind: "tty", command: "/bin/bash" }] },
      { items: [{ id: "shell-command", name: "Shell", kind: "tty", command: "bash -lc echo unsafe" }] },
    ]) {
      const invalidCatalog = await app.inject({
        method: "PATCH",
        url: "/api/apps/catalog/custom",
        payload,
      });
      assert.equal(invalidCatalog.statusCode, 400);
      assert.equal(JSON.parse(invalidCatalog.payload).error.code, "APP_CATALOG_INVALID");
    }

    fs.writeFileSync(
      path.join(paths.appCatalogDir, "custom.json"),
      `${JSON.stringify({ schemaVersion: 1, items: [{ id: "bad-service", name: "Bad", kind: "service", command: "/bin/true" }] })}\n`,
    );
    const degradedCatalog = await app.inject({ method: "GET", url: "/api/apps/catalog" });
    assert.equal(degradedCatalog.statusCode, 200);
    assert.equal(JSON.parse(degradedCatalog.payload).data.some((entry) => entry.id === "terminal-tty"), true);
    assert.equal(JSON.parse(degradedCatalog.payload).data.some((entry) => entry.id === "bad-service"), false);
    const invalidCustomCatalog = await app.inject({ method: "GET", url: "/api/apps/catalog/custom" });
    assert.equal(invalidCustomCatalog.statusCode, 400);
    assert.equal(JSON.parse(invalidCustomCatalog.payload).error.code, "APP_CATALOG_INVALID");

    for (const payload of [
      { appId: 123 },
      { appId: "terminal-tty", args: "not-array" },
      { appId: "terminal-tty", env: { "bad-key": "value" } },
      { appId: "terminal-gui", display: { width: 100, height: 900, depth: 24 } },
      { appId: "terminal-gui", display: { width: 1440, height: 900, depth: 8 } },
      { appId: "terminal-gui", displayTarget: { mode: "shared", id: "bad id" } },
      { appId: "terminal-tty", extra: true },
    ]) {
      const invalidLaunch = await app.inject({
        method: "POST",
        url: "/api/apps/sessions",
        payload,
      });
      assert.equal(invalidLaunch.statusCode, 400);
      assert.equal(JSON.parse(invalidLaunch.payload).error.code, "APP_LAUNCH_INVALID");
    }

    for (const [method, url, payload] of [
      ["GET", "/api/receiver/status"],
      ["POST", "/api/receiver/start"],
      ["POST", "/api/receiver/messages", {}],
      ["GET", "/api/receiver/pending"],
      ["POST", "/api/receiver/pending/1/reply", { markdown: "reply" }],
      ["GET", "/api/tasks/pending"],
      ["POST", "/api/tasks/1/approve"],
      ["GET", "/api/channels"],
      ["PATCH", "/api/channels/telegram/default", {}],
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations/1/use"],
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings", {}],
    ]) {
      const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
      assert.deepEqual(JSON.parse(response.payload), { error: { code: "NOT_FOUND", message: "Not found." } });
    }
    for (const [filePath, content] of historicalFiles) {
      assert.equal(fs.readFileSync(filePath, "utf8"), content);
    }
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app ai session read routes do not refresh discovery state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-ai-read-"));
  const paths = appRuntimeTestPaths(root);
  const aiSessionDir = path.join(paths.dataDir, "ai-sessions");
  fs.mkdirSync(aiSessionDir, { recursive: true });
	  fs.writeFileSync(
	    path.join(aiSessionDir, "ais_existing.json"),
	    `${JSON.stringify({
	      id: "ais_existing",
	      agent: "codex",
	      appSessionId: "app_existing",
	      appId: "codex",
	      providerSessionId: "thread_existing",
	      userPrompt: "existing prompt",
	      turns: [{ id: "turn_existing", userPrompt: "existing prompt", status: "running", revision: 0 }],
	      status: "running",
	      phase: "thinking",
      startedAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
      counters: { toolCalls: 0, edits: 0, approvals: 0 },
      queue: { pendingCount: 0, items: [] },
    })}\n`,
  );

  const codexHome = path.join(root, "codex-home");
  const transcriptDir = path.join(codexHome, "sessions", "2026", "07", "04");
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir, "rollout-new-thread.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "new-thread", cwd: "/workspace" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "discovered only if refresh runs" }] } }),
    ].join("\n"),
  );

  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
	    TASK_HANDOFF_AI_SESSION_SCAN: "0",
	    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
	    TASK_HANDOFF_CODEX_APP_SERVER: "0",
	    CODEX_HOME: codexHome,
	    TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS: "600000",
	  });
	  const appRuntime = {
	    replaceManagedEnvironment: () => undefined,
	    listSessions: () => [{ id: "app_existing", appId: "codex", status: "running", ai: { threadIds: ["thread_existing"] } }],
	    runningSessionCount: () => 1,
	    sharedResourceSessionAi: () => undefined,
	    on: () => undefined,
	    stopAll: () => undefined,
	  };
	  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false, appRuntime });
  try {
    await app.ready();
    process.env.TASK_HANDOFF_AI_SESSION_SCAN = "1";
    const listed = await app.inject({ method: "GET", url: "/api/ai-sessions" });
    assert.equal(listed.statusCode, 200);
    const sessions = JSON.parse(listed.payload).data.snapshot.sessions;
    assert.deepEqual(sessions.map((session) => session.id), ["ais_existing"]);
    assert.equal(sessions[0].userPrompt, "existing prompt");

    const detail = await app.inject({ method: "GET", url: "/api/ai-sessions/ais_existing" });
    assert.equal(detail.statusCode, 200);
    assert.equal(JSON.parse(detail.payload).data.providerSessionId, "thread_existing");

    const unsafeDetail = await app.inject({ method: "GET", url: "/api/ai-sessions/parent%5Csession" });
    assert.equal(unsafeDetail.statusCode, 404);

    const turns = await app.inject({ method: "GET", url: "/api/ai-sessions/ais_existing/turns" });
    assert.equal(turns.statusCode, 200);
    assert.deepEqual(JSON.parse(turns.payload).data.turns.map((turn) => turn.id), ["turn_existing"]);
    assert.equal(fs.readdirSync(aiSessionDir).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app events websocket sends session handshake and authoritative app-management snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-events-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  t.after(async () => {
    await app.close();
    restoreEnv();
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`);
  t.after(() => socket.terminate());
  const firstMessages = withTimeout(webSocketMessageFrames(socket, 2), "initial events");

  await withTimeout(waitForWebSocketOpen(socket), "controlled instance events websocket open");
  const [helloFrame, appManagementFrame] = await firstMessages;
  const hello = JSON.parse(helloFrame.message);
  assert.equal(hello.type, "streams.hello");
  assert.deepEqual(hello.payload.streams.map((stream) => stream.topic).sort(), ["ai.sessions", "app.sessions"]);
  const appManagement = JSON.parse(appManagementFrame.message);
  assert.equal(appManagement.type, "app.management");
  assert.equal(appManagement.payload.streamId, appManagement.payload.snapshot.streamId);
  assert.equal(appManagement.payload.sequence, appManagement.payload.snapshot.sequence);
});

test("controlled instance session streams use restart epochs and ordered retained app deltas", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-session-stream-epochs-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
  });
  let first;
  let second;
  const originalDateNow = Date.now;
  try {
    first = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
    await first.ready();
    const firstAi = JSON.parse((await first.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
    const firstApp = JSON.parse((await first.inject({ method: "GET", url: "/api/apps/sessions/state" })).payload).data;

    const launchedResponse = await first.inject({ method: "POST", url: "/api/apps/sessions", payload: { appId: "terminal-tty" } });
    assert.equal(launchedResponse.statusCode, 200);
    const launched = JSON.parse(launchedResponse.payload).data;
    const renamedResponse = await first.inject({ method: "PATCH", url: `/api/apps/sessions/${launched.id}`, payload: { title: "Ordered delta" } });
    assert.equal(renamedResponse.statusCode, 200);

    const head = JSON.parse((await first.inject({ method: "GET", url: "/api/apps/sessions/state" })).payload).data;
    const delta = JSON.parse((await first.inject({ method: "GET", url: `/api/apps/sessions?streamId=${encodeURIComponent(firstApp.streamId)}&sinceRevision=0` })).payload).data;
    assert.equal(delta.syncRequired, false);
    assert.deepEqual(delta.events.map((event) => event.payload.meta.revision), Array.from({ length: head.revision }, (_, index) => index + 1));
    assert.equal(delta.events.every((event, index) => index === 0 || event.payload.meta.previousRevision === event.payload.meta.revision - 1), true);

    Date.now = () => originalDateNow() + APP_SESSION_DELTA_RETENTION_MS + 1;
    const expired = JSON.parse((await first.inject({ method: "GET", url: `/api/apps/sessions?streamId=${encodeURIComponent(firstApp.streamId)}&sinceRevision=0` })).payload).data;
    assert.equal(expired.syncRequired, true);
    assert.deepEqual(expired.events, []);
    Date.now = originalDateNow;

    await first.close();
    first = undefined;
    second = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
    await second.ready();
    const secondAi = JSON.parse((await second.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
    const secondApp = JSON.parse((await second.inject({ method: "GET", url: "/api/apps/sessions/state" })).payload).data;
    assert.notEqual(secondAi.streamId, firstAi.streamId);
    assert.notEqual(secondApp.streamId, firstApp.streamId);
  } finally {
    Date.now = originalDateNow;
    if (first) await first.close();
    if (second) await second.close();
    restoreEnv();
  }
});

test("controlled instance publishes provider changes immediately and discovery corrects missed changes without unchanged revisions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-session-discovery-"));
  const paths = appRuntimeTestPaths(root);
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const appRuntime = {
    replaceManagedEnvironment: () => undefined,
    listSessions: () => [{ id: "app_discovery", appId: "codex", status: "running" }],
    runningSessionCount: () => 1,
    sharedResourceSessionAi: () => undefined,
    on: () => undefined,
    stopAll: () => undefined,
  };
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS: "1000",
    TASK_HANDOFF_AI_SESSION_PUBLISH_DEBOUNCE_MS: "5",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
  });
  const app = await createWebApp({
    staticDir: path.join(root, "missing-static"),
    logger: false,
    aiSessionRegistry: registry,
    appRuntime,
  });
  try {
    await app.ready();
    const appSessionId = "app_discovery";
    const initial = JSON.parse((await app.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
    const providerStartedAt = Date.now();
    const providerSession = registry.start({ agent: "codex", appSessionId, providerSessionId: "provider_immediate", status: "idle" });
    const providerState = await waitForCondition(async () => {
      const state = JSON.parse((await app.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
      return state.revision > initial.revision ? state : undefined;
    }, "provider event projection", 500);
    assert.ok(Date.now() - providerStartedAt < 500);
    assert.equal(providerState.snapshot.sessions.some((session) => session.providerSessionId === "provider_immediate"), true);

    registry.applyRealtimeEvent(providerSession.id, {
      kind: "tool-activity",
      currentTool: { id: "tool_immediate", kind: "commandExecution", name: "Command", inputPreview: "pnpm test" },
      toolCallsSinceLastMessage: 2,
      source: "realtime",
    });
    const toolState = await waitForCondition(async () => {
      const state = JSON.parse((await app.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
      return state.revision > providerState.revision ? state : undefined;
    }, "tool activity projection", 500);
    const toolSession = toolState.snapshot.sessions.find((session) => session.id === providerSession.id);
    assert.deepEqual(toolSession.currentTool, {
      id: "tool_immediate",
      kind: "commandExecution",
      name: "Command",
      inputPreview: "pnpm test",
    });
    assert.equal(toolSession.toolCallsSinceLastMessage, 2);
    const toolDelta = JSON.parse((await app.inject({
      method: "GET",
      url: `/api/ai-sessions?streamId=${encodeURIComponent(toolState.streamId)}&sinceRevision=${providerState.revision}`,
    })).payload).data;
    const retainedToolSession = toolDelta.events
      .flatMap((event) => event.payload.upserted || event.payload.snapshot?.sessions || [])
      .find((session) => session.id === providerSession.id && session.toolCallsSinceLastMessage === 2);
    assert.equal(retainedToolSession.toolCallsSinceLastMessage, 2);
    assert.equal(retainedToolSession.currentTool.id, "tool_immediate");

    const externalRegistry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
    externalRegistry.start({ agent: "claude", appSessionId, providerSessionId: "provider_missed", status: "idle" });
    const correctedState = await waitForCondition(async () => {
      const state = JSON.parse((await app.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
      return state.snapshot.sessions.some((session) => session.providerSessionId === "provider_missed") ? state : undefined;
    }, "discovery correction", 2500);
    const correctedRevision = correctedState.revision;
    const correctedDiagnostics = JSON.parse((await app.inject({ method: "GET", url: "/api/diagnostics" })).payload).data.sessionStreams.ai;
    assert.ok(correctedDiagnostics.discoveryCorrections >= 1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const unchangedState = JSON.parse((await app.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
    const unchangedDiagnostics = JSON.parse((await app.inject({ method: "GET", url: "/api/diagnostics" })).payload).data.sessionStreams.ai;
    assert.equal(unchangedState.revision, correctedRevision);
    assert.ok(unchangedDiagnostics.discoveryUnchanged >= 1);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("AI session refresh schedules a trailing scan when an app session update arrives in flight", async () => {
  let releaseFirstRefresh;
  let markFirstRefreshStarted;
  const firstRefreshStarted = new Promise((resolve) => {
    markFirstRefreshStarted = resolve;
  });
  const firstRefreshGate = new Promise((resolve) => {
    releaseFirstRefresh = resolve;
  });
  let sourceRevision = 0;
  let appliedRevision = -1;
  let refreshCount = 0;
  const published = [];
  const scheduler = new AiSessionRefreshScheduler(
    async () => {
      refreshCount += 1;
      const observedRevision = sourceRevision;
      if (refreshCount === 1) {
        markFirstRefreshStarted();
        await firstRefreshGate;
      }
      appliedRevision = observedRevision;
    },
    (reason) => published.push({ reason, appliedRevision }),
  );

  const createdRefresh = scheduler.request("app-session-created");
  await firstRefreshStarted;
  sourceRevision = 1;
  const updatedRefresh = scheduler.request("app-session-updated");
  releaseFirstRefresh();
  await Promise.all([createdRefresh, updatedRefresh]);

  assert.equal(refreshCount, 2);
  assert.deepEqual(published, [
    { reason: "app-session-created", appliedRevision: 0 },
    { reason: "app-session-updated", appliedRevision: 1 },
  ]);
});

test("web app AI session snapshot endpoint only exposes app-bound sessions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-events-bound-ai-"));
  const paths = appRuntimeTestPaths(root);
  const aiSessionDir = path.join(paths.dataDir, "ai-sessions");
  fs.mkdirSync(aiSessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(aiSessionDir, "ais_unbound.json"),
    `${JSON.stringify({
      id: "ais_unbound",
      agent: "codex",
      appId: "codex-app-server",
      providerSessionId: "thread_unbound",
      status: "idle",
      phase: "unknown",
      startedAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
      counters: { toolCalls: 0, edits: 0, approvals: 0 },
      queue: { pendingCount: 0, items: [] },
    })}\n`,
  );
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS: "600000",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    assert.ok(port > 0);
    const response = await app.inject({ method: "GET", url: "/api/ai-sessions/state" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload).data.snapshot.sessions, []);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app imports and exports built-in config sync presets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-config-sync-"));
  const paths = appRuntimeTestPaths(root);
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(workspace, ".task-handoff", "configs", "claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".task-handoff", "configs", "claude", ".claude.json"), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(workspace, ".task-handoff", "configs", "claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
  fs.writeFileSync(path.join(workspace, ".task-handoff", "configs", "claude", "commands", "hello.md"), "hello");
  fs.mkdirSync(path.join(workspace, ".task-handoff", "configs", "codex"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".task-handoff", "configs", "codex", "config.toml"),
    'model = "workspace-model"\nmodel_provider = "workspace-provider"\n[features]\nhooks = true\n',
  );
  fs.mkdirSync(path.join(home, ".config", "chromium", "Default"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "chromium", "Default", "Bookmarks"), "{}");

  const restoreEnv = withWebStorageEnv(paths, {
    HOME: home,
    TASK_HANDOFF_WORKSPACE: workspace,
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_CODEX_MODEL: "instance-model",
    TASK_HANDOFF_CODEX_BASE_URL: "https://instance.example/v1",
    OPENAI_API_KEY: "instance-api-key",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const presets = await app.inject({ method: "GET", url: "/api/config-sync/presets" });
    assert.equal(presets.statusCode, 200);
    assert.equal(JSON.parse(presets.payload).data.some((preset) => preset.id === "browser"), true);

    const imported = await app.inject({ method: "POST", url: "/api/config-sync/import/claude" });
    assert.equal(imported.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf8"), JSON.stringify({ projects: {} }));
    assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), true);
    assert.equal(fs.readFileSync(path.join(home, ".claude", "commands", "hello.md"), "utf8"), "hello");

    const importedCodex = await app.inject({ method: "POST", url: "/api/config-sync/import/codex" });
    assert.equal(importedCodex.statusCode, 200);
    const managedCodexConfig = require("@iarna/toml").parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"));
    assert.equal(managedCodexConfig.model, "instance-model");
    assert.equal(managedCodexConfig.model_provider, "openai");
    assert.equal(managedCodexConfig.openai_base_url, "https://instance.example/v1");
    assert.equal(managedCodexConfig.features.hooks, true);

    const exported = await app.inject({ method: "POST", url: "/api/config-sync/export/browser" });
    assert.equal(exported.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(workspace, ".task-handoff", "configs", "browser", "chromium", "Default", "Bookmarks"), "utf8"), "{}");

    fs.mkdirSync(path.join(workspace, ".task-handoff", "configs", "custom"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".task-handoff", "configs", "custom", "token.txt"), "custom-token");
    const customImported = await app.inject({
      method: "POST",
      url: "/api/config-sync/import/custom",
      payload: {
        preset: {
          id: "custom",
          label: "Custom",
          projectRoot: ".task-handoff/configs/custom",
          items: [{ id: "token", type: "file", projectPath: "token.txt", containerPath: "${HOME}/.custom-token" }],
        },
      },
    });
    assert.equal(customImported.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(home, ".custom-token"), "utf8"), "custom-token");
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("controlled instance materializes its selected Codex model and API-key auth", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-model-config-"));
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(configPath, 'model = "old-model"\n[features]\nhooks = true\n');

  const result = applyManagedCodexModelConfig({
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    CODEX_HOME: codexHome,
    TASK_HANDOFF_CODEX_MODEL: "selected-model",
    TASK_HANDOFF_CODEX_BASE_URL: "https://proxy.example/v1",
    OPENAI_API_KEY: "managed-api-key",
  });

  assert.equal(result.applied, true);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.match(fs.readFileSync(result.backupPath, "utf8"), /old-model/);
  const contents = fs.readFileSync(configPath, "utf8");
  const config = require("@iarna/toml").parse(contents);
  assert.equal(config.model, "selected-model");
  assert.equal(config.model_provider, "openai");
  assert.equal(config.openai_base_url, "https://proxy.example/v1");
  assert.equal(config.features.hooks, true);
  assert.equal(contents.includes("managed-api-key"), false);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  const authPath = path.join(codexHome, "auth.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "managed-api-key",
  });
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test("controlled instance leaves user Codex files unchanged when no managed model is assigned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-no-model-"));
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const configContents = 'model = "user-model"\nmodel_provider = "user-provider"\n';
  const authContents = `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "user-key" }, null, 2)}\n`;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(configPath, configContents);
  fs.writeFileSync(authPath, authContents);

  const result = applyManagedCodexModelConfig({
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    CODEX_HOME: codexHome,
  });

  assert.deepEqual(result, { applied: false });
  assert.equal(fs.readFileSync(configPath, "utf8"), configContents);
  assert.equal(fs.readFileSync(authPath, "utf8"), authContents);
  assert.deepEqual(fs.readdirSync(codexHome).sort(), ["auth.json", "config.toml"]);
});

test("controlled instance refreshes managed model auth through its registration-token endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-managed-model-env-"));
  const paths = appRuntimeTestPaths(root);
  const codexHome = path.join(root, ".codex");
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_REGISTRATION_TOKEN: "instance-registration-token",
    CODEX_HOME: codexHome,
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const forbidden = await app.inject({ method: "PUT", url: "/api/internal/model-environment", payload: { OPENAI_API_KEY: "should-not-apply" } });
    assert.equal(forbidden.statusCode, 403);
    const applied = await app.inject({
      method: "PUT",
      url: "/api/internal/model-environment",
      headers: { authorization: "Bearer instance-registration-token" },
      payload: {
        OPENAI_API_KEY: "rotated-managed-key",
        OPENAI_BASE_URL: "https://proxy.example/v1",
        TASK_HANDOFF_CODEX_BASE_URL: "https://proxy.example/v1",
        TASK_HANDOFF_CODEX_MODEL: "gpt-managed",
      },
    });
    assert.equal(applied.statusCode, 200);
    assert.deepEqual(applied.json().data, { applied: true, codexAuthConfigured: true, configUpdated: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")), {
      auth_mode: "apikey",
      OPENAI_API_KEY: "rotated-managed-key",
    });
    assert.equal(applied.payload.includes("rotated-managed-key"), false);
    const configBeforeNoModel = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const authBeforeNoModel = fs.readFileSync(path.join(codexHome, "auth.json"), "utf8");
    const noModel = await app.inject({
      method: "PUT",
      url: "/api/internal/model-environment",
      headers: { authorization: "Bearer instance-registration-token" },
      payload: {},
    });
    assert.equal(noModel.statusCode, 200);
    assert.deepEqual(noModel.json().data, { applied: true, codexAuthConfigured: false, configUpdated: false });
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), configBeforeNoModel);
    assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), authBeforeNoModel);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app exposes cc-switch only when enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-cc-switch-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_ENABLE_CC_SWITCH: "1",
    TASK_HANDOFF_CC_SWITCH_COMMAND: process.execPath,
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const catalog = await app.inject({ method: "GET", url: "/api/apps/catalog" });
    assert.equal(catalog.statusCode, 200);
    const ccSwitch = JSON.parse(catalog.payload).data.find((entry) => entry.id === "cc-switch");
    assert.equal(ccSwitch.name, "CC Switch");
    assert.equal(ccSwitch.kind, "gui");
    assert.equal(ccSwitch.command, process.execPath);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app does not expose internal web-cap when enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-cap-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_ENABLE_WEB_CAP: "1",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const catalog = await app.inject({ method: "GET", url: "/api/apps/catalog" });
    assert.equal(catalog.statusCode, 200);
    assert.equal(JSON.parse(catalog.payload).data.some((entry) => entry.id === "web-cap"), false);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app never starts or stops a receiver in standalone or controlled mode", async () => {
  for (const mode of ["standalone", "controlled"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-web-${mode}-no-receiver-`));
    const paths = appRuntimeTestPaths(root);
    const restoreEnv = withWebStorageEnv(paths, {
      TASK_HANDOFF_CONTROL_MODE: mode,
      TASK_HANDOFF_RECEIVER_AUTO_START: "1",
      TASK_HANDOFF_WEB_AUTH: "off",
      TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
      CODEX_HOME: path.join(root, ".codex"),
    });
    const app = await createWebApp({
      staticDir: path.join(root, "missing-static"),
      logger: false,
    });
    try {
      await app.ready();
      const status = await app.inject({ method: "GET", url: "/api/instance/status" });
      assert.equal(status.statusCode, 200);
      assert.equal(JSON.parse(status.payload).data.controlMode, mode);
      assert.equal(JSON.parse(status.payload).data.receiver, undefined);
      assert.equal(fs.existsSync(path.join(paths.logDir, "receiver.log")), false);
    } finally {
      await app.close();
      restoreEnv();
    }
  }
});

test("web app enforces token auth for API routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-auth-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "required",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const unauthorized = await app.inject({ method: "GET", url: "/api/status" });
    assert.equal(unauthorized.statusCode, 401);
    const token = fs.readFileSync(paths.webTokenPath, "utf8").trim();
    assert.ok(token);

    const authorized = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.statusCode, 200);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("app runtime ignores persisted sessions by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-runtime-default-"));
  const paths = appRuntimeTestPaths(root);
  writeAppSessionMetadata(paths, "app_existing", "running", "2026-06-20T01:01:00.000Z");

  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_APP_SESSION_PERSIST: undefined,
    TASK_HANDOFF_APP_SESSION_RETENTION_DAYS: undefined,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    assert.deepEqual(runtime.listSessions(), []);
    assert.equal(runtime.getSession("app_existing"), undefined);
  } finally {
    restoreEnv();
  }
});

test("controlled instance history routes use trusted Task Handoff entries for resume", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-history-routes-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths);
  const history = new AiSessionHistoryStore(paths);
  history.upsert({
    id: "ais_history_route",
    agent: "codex",
    providerSessionId: "thread_history_route",
    title: "Trusted history title",
    cwd: "/workspace/trusted",
    lastActiveAt: "2026-07-20T10:00:00.000Z",
    archivedAt: "2026-07-20T10:01:00.000Z",
  }, [{ id: "turn_history_route", userPrompt: "Trusted prompt", lastMessage: "Trusted answer", status: "completed" }]);
  const runtime = new AppRuntimeManager(paths);
  const starts = [];
  const resumedApps = [];
  runtime.start = (appId, options) => {
    starts.push({ appId, options });
    const session = { id: "app_history_route", appId, kind: "tty", status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    resumedApps.push(session);
    return session;
  };
  runtime.listSessions = () => resumedApps;
  const app = await createWebApp({
    staticDir: path.join(root, "missing-static"),
    logger: false,
    appRuntime: runtime,
  });
  try {
    const listed = await app.inject({ method: "GET", url: "/api/ai-sessions/history" });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().data.items.map((item) => [item.id, item.providerSessionId]), [["ais_history_route", "thread_history_route"]]);
    const detail = await app.inject({ method: "GET", url: "/api/ai-sessions/history/ais_history_route" });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().data.turns.map((turn) => [turn.id, turn.userPrompt, turn.lastMessage]), [["turn_history_route", "Trusted prompt", "Trusted answer"]]);
    const missingDetail = await app.inject({ method: "GET", url: "/api/ai-sessions/history/ais_missing" });
    assert.equal(missingDetail.statusCode, 404);
    assert.equal(missingDetail.json().error.code, "AI_SESSION_HISTORY_NOT_FOUND");

    const rejected = await app.inject({
      method: "POST",
      url: "/api/ai-sessions/ais_history_route/resume",
      payload: { providerSessionId: "thread_attacker", cwd: "/tmp/attacker", args: ["--new-session"] },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(starts.length, 0);

    const resumed = await app.inject({ method: "POST", url: "/api/ai-sessions/ais_history_route/resume", payload: {} });
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(resumed.json().data, {
      disposition: "resumed",
      aiSessionId: "ais_history_route",
      providerSessionId: "thread_history_route",
      appSessionId: "app_history_route",
    });
    assert.deepEqual(starts, [{
      appId: "codex",
      options: {
        cwd: "/workspace/trusted",
        aiSessionResume: { aiSessionId: "ais_history_route", providerSessionId: "thread_history_route" },
      },
    }]);

    const missing = await app.inject({ method: "POST", url: "/api/ai-sessions/ais_missing/resume", payload: {} });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "AI_SESSION_HISTORY_NOT_FOUND");
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("app runtime catalog reflects executable availability on every read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-availability-"));
  const paths = appRuntimeTestPaths(root);
  const installedCommand = path.join(root, "installed-tool");
  const relativeCommandDir = path.join(root, "relative");
  const relativeCommand = path.join(relativeCommandDir, "relative-tool");
  const missingCommand = path.join(root, "missing-tool");
  fs.mkdirSync(relativeCommandDir);
  fs.writeFileSync(installedCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(relativeCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const runtime = new AppRuntimeManager(paths);
  runtime.saveCustomCatalog([
    { id: "installed-tool", name: "Installed Tool", kind: "tty", command: installedCommand },
    { id: "relative-tool", name: "Relative Tool", kind: "tty", command: "./relative-tool", cwd: relativeCommandDir },
    { id: "missing-tool", name: "Missing Tool", kind: "tty", command: missingCommand },
  ]);

  assert.equal(runtime.catalog().some((app) => app.id === "installed-tool"), true);
  assert.equal(runtime.catalog().some((app) => app.id === "relative-tool"), true);
  assert.equal(runtime.catalog().some((app) => app.id === "missing-tool"), false);
  assert.throws(() => runtime.start("missing-tool"), (error) => error?.code === "APP_DEPENDENCY_MISSING");

  fs.chmodSync(installedCommand, 0o644);
  assert.equal(runtime.catalog().some((app) => app.id === "installed-tool"), false);
});

test("app session title updates through the API, persists, and emits an authoritative update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-rename-"));
  const paths = appRuntimeTestPaths(root);
  writeAppSessionMetadata(paths, "app_existing", "stopped", "2026-06-20T01:01:00.000Z");
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_APP_SESSION_PERSIST: "1",
  });
  const runtime = new AppRuntimeManager(paths);
  const updates = [];
  runtime.on("updated", (session) => updates.push(session));
  const app = await createWebApp({
    staticDir: path.join(root, "missing-static"),
    logger: false,
    appRuntime: runtime,
  });
  try {
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/apps/sessions/app_existing",
      payload: { title: "  Project Codex  " },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().data.title, "Project Codex");
    assert.equal(runtime.getSession("app_existing").title, "Project Codex");
    assert.equal(updates.at(-1).title, "Project Codex");

    const metadata = JSON.parse(fs.readFileSync(path.join(paths.appSessionsDir, "app_existing", "metadata.json"), "utf8"));
    assert.equal(metadata.title, "Project Codex");
    assert.equal(metadata.launch.title, "Project Codex");

    const invalid = await app.inject({ method: "PATCH", url: "/api/apps/sessions/app_existing", payload: { title: "   " } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "APP_SESSION_UPDATE_INVALID");

    const missing = await app.inject({ method: "PATCH", url: "/api/apps/sessions/missing", payload: { title: "Missing" } });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "APP_SESSION_NOT_FOUND");
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("app runtime prepares vscode web sessions with a dark default theme", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-vscode-theme-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  const sessionDir = path.join(paths.appSessionsDir, "vscode_session");

  runtime.prepareWebAppSession({ id: "vscode-web" }, sessionDir);

  const settingsPath = path.join(sessionDir, "user-data", "User", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings["workbench.colorTheme"], "Default Dark Modern");
  assert.equal(settings["workbench.preferredDarkColorTheme"], "Default Dark Modern");

  fs.writeFileSync(settingsPath, `${JSON.stringify({ "workbench.colorTheme": "Default Light Modern" })}\n`);
  runtime.prepareWebAppSession({ id: "vscode-web" }, sessionDir);
  const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(preservedSettings["workbench.colorTheme"], "Default Light Modern");
  assert.equal(preservedSettings["workbench.preferredDarkColorTheme"], "Default Dark Modern");
});

test("app runtime resumes claude through the background worker and attaches by short id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-bg-"));
  const paths = appRuntimeTestPaths(root);
  const fakeClaude = path.join(root, "claude");
  const callsPath = path.join(root, "claude-calls.log");
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}\nif [ "$1" = "--bg" ]; then echo "worker ac8eaf94"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CLAUDE_COMMAND: fakeClaude,
    TASK_HANDOFF_CLAUDE_MODEL: "sonnet-test",
    TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS: "1",
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const spawned = [];
    runtime.hasCommand = () => true;
    runtime.spawnTerminalPty = (shell, args, cwd, env) => {
      const pty = new EventEmitter();
      pty.pid = 2468;
      pty.onData = (listener) => pty.on("data", listener);
      pty.onExit = (listener) => pty.on("exit", listener);
      pty.write = () => {};
      pty.resize = () => {};
      pty.kill = () => {};
      spawned.push({ shell, args, cwd, env });
      return pty;
    };

    const session = runtime.start("claude", {
      cwd: root,
      aiSessionResume: { aiSessionId: "ais_claude_resume", providerSessionId: "claude_provider_resume" },
    });

    assert.equal(session.appId, "claude");
    assert.equal(session.tty.mode, "claude-attach");
    assert.equal(session.ai.agent, "claude");
    assert.equal(session.ai.claude.short, "ac8eaf94");
    assert.equal(spawned[0].shell, fakeClaude);
    assert.deepEqual(spawned[0].args, ["attach", "ac8eaf94"]);
    const bgCall = fs.readFileSync(callsPath, "utf8").trim();
    assert.equal(bgCall, "--bg --dangerously-skip-permissions --model sonnet-test --resume claude_provider_resume");
  } finally {
    restoreEnv();
  }
});

test("app runtime rejects structured AI session resume for unsupported apps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-resume-unsupported-"));
  const runtime = new AppRuntimeManager(appRuntimeTestPaths(root));
  runtime.hasCommand = () => true;
  assert.throws(
    () => runtime.start("terminal-tty", {
      aiSessionResume: { aiSessionId: "ais_unsupported", providerSessionId: "provider_unsupported" },
    }),
    (error) => error?.code === "APP_RESUME_UNSUPPORTED",
  );
});

test("app runtime launches codex resume with the trusted provider session id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-resume-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, { TASK_HANDOFF_CODEX_APP_SERVER_DISABLED: "1" });
  try {
    const runtime = new AppRuntimeManager(paths);
    let spawned;
    runtime.hasCommand = () => true;
    runtime.spawnTerminalPty = (shell, args, cwd) => {
      spawned = { shell, args, cwd };
      const pty = new EventEmitter();
      pty.pid = 2469;
      pty.onData = (listener) => pty.on("data", listener);
      pty.onExit = (listener) => pty.on("exit", listener);
      pty.write = () => {};
      pty.resize = () => {};
      pty.kill = () => {};
      return pty;
    };
    const session = runtime.start("codex", {
      cwd: "/workspace/codex-resume",
      aiSessionResume: { aiSessionId: "ais_codex_resume", providerSessionId: "thread_codex_resume" },
    });
    assert.equal(session.appId, "codex");
    assert.deepEqual(session.launch.aiSessionResume, { aiSessionId: "ais_codex_resume", providerSessionId: "thread_codex_resume" });
    assert.deepEqual(spawned.args.slice(-2), ["resume", "thread_codex_resume"]);
    assert.equal(spawned.args.includes("fork"), false);
    assert.equal(spawned.cwd, "/workspace/codex-resume");
  } finally {
    restoreEnv();
  }
});

test("app runtime injects managed model credentials without persisting them in session metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-managed-app-env-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  runtime.replaceManagedEnvironment({ OPENAI_API_KEY: "runtime-managed-key" });
  runtime.hasCommand = () => true;
  let spawnedEnv;
  runtime.spawnTerminalPty = (_shell, _args, _cwd, env) => {
    spawnedEnv = env;
    const pty = new EventEmitter();
    pty.pid = 2468;
    pty.onData = (listener) => pty.on("data", listener);
    pty.onExit = (listener) => pty.on("exit", listener);
    pty.write = () => {};
    pty.resize = () => {};
    pty.kill = () => {};
    return pty;
  };
  const session = runtime.start("terminal-tty", { cwd: root });
  assert.equal(spawnedEnv.OPENAI_API_KEY, "runtime-managed-key");
  assert.equal(JSON.stringify(session).includes("runtime-managed-key"), false);
});

test("app runtime stops claude background worker when attach fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-attach-fail-"));
  const paths = appRuntimeTestPaths(root);
  const fakeClaude = path.join(root, "claude");
  const callsPath = path.join(root, "claude-calls.log");
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}\nif [ "$1" = "--bg" ]; then echo "worker ac8eaf94"; exit 0; fi\nif [ "$1" = "stop" ]; then exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CLAUDE_COMMAND: fakeClaude,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    runtime.hasCommand = () => true;
    runtime.spawnTerminalPty = () => {
      throw new Error("attach failed");
    };

    assert.throws(() => runtime.start("claude", { cwd: root }), /attach failed/);
    assert.deepEqual(fs.readFileSync(callsPath, "utf8").trim().split("\n"), [
      "--bg",
      "stop ac8eaf94",
    ]);
  } finally {
    restoreEnv();
  }
});

test("app runtime stop terminates claude background worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-claude-stop-"));
  const paths = appRuntimeTestPaths(root);
  const fakeClaude = path.join(root, "claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nif [ \"$1\" = \"--bg\" ]; then echo ac8eaf94; exit 0; fi\nexit 0\n", { mode: 0o755 });
  const socketPath = path.join(root, "control.sock");
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      socket.end(`${JSON.stringify({ ok: true, op: request.op })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CLAUDE_COMMAND: fakeClaude,
    CLAUDE_CONTROL_SOCK: socketPath,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    runtime.hasCommand = () => true;
    runtime.spawnTerminalPty = () => {
      const pty = new EventEmitter();
      pty.pid = 2468;
      pty.onData = (listener) => pty.on("data", listener);
      pty.onExit = (listener) => pty.on("exit", listener);
      pty.write = () => {};
      pty.resize = () => {};
      pty.kill = () => {};
      return pty;
    };
    const session = runtime.start("claude", { cwd: root });
    runtime.stop(session.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests[0].op, "kill");
    assert.equal(requests[0].short, "ac8eaf94");
  } finally {
    restoreEnv();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("app runtime loads configured chromium extension dirs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-chromium-extensions-"));
  const paths = appRuntimeTestPaths(root);
  const extensionOne = path.join(root, "extension-one");
  const extensionTwo = path.join(root, "extension-two");
  const ignored = path.join(root, "ignored");
  fs.mkdirSync(extensionOne, { recursive: true });
  fs.mkdirSync(extensionTwo, { recursive: true });
  fs.mkdirSync(ignored, { recursive: true });
  fs.writeFileSync(path.join(extensionOne, "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(extensionTwo, "manifest.json"), "{}\n");
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CHROMIUM_EXTENSION_DIRS: `${extensionOne};${ignored};${extensionTwo}`,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const args = runtime.guiArgs(
      {
        id: "chromium",
        command: "chromium",
        args: ["about:blank"],
        automation: { type: "cdp" },
      },
      path.join(paths.appSessionsDir, "browser"),
      9222,
      [],
    );
    assert.equal(args.includes(`--load-extension=${extensionOne},${extensionTwo}`), true);
  } finally {
    restoreEnv();
  }
});

test("app runtime isolates chromium profile by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-chromium-profile-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CHROMIUM_PROFILE_MODE: undefined,
    TASK_HANDOFF_CHROMIUM_USER_DATA_DIR: undefined,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const sessionDir = path.join(paths.appSessionsDir, "browser");
    const args = runtime.guiArgs(
      {
        id: "chromium",
        command: "chromium",
        args: ["about:blank"],
        automation: { type: "cdp" },
      },
      sessionDir,
      9222,
      [],
    );
    assert.equal(args.includes(`--user-data-dir=${path.join(sessionDir, "profile")}`), true);
  } finally {
    restoreEnv();
  }
});

test("app runtime keeps chromium profile isolated when explicitly requested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-chromium-isolated-profile-"));
  const paths = appRuntimeTestPaths(root);
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CHROMIUM_PROFILE_MODE: "isolated",
    TASK_HANDOFF_CHROMIUM_USER_DATA_DIR: undefined,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const sessionDir = path.join(paths.appSessionsDir, "browser");
    const args = runtime.guiArgs(
      {
        id: "chromium",
        command: "chromium",
        args: ["about:blank"],
        automation: { type: "cdp" },
      },
      sessionDir,
      9222,
      [],
    );
    assert.equal(args.includes(`--user-data-dir=${path.join(sessionDir, "profile")}`), true);
  } finally {
    restoreEnv();
  }
});

test("app runtime can use an explicitly configured shared chromium profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-chromium-shared-profile-"));
  const paths = appRuntimeTestPaths(root);
  const userDataDir = path.join(root, "chromium-profile");
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_CHROMIUM_USER_DATA_DIR: userDataDir,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const args = runtime.guiArgs(
      {
        id: "chromium",
        command: "chromium",
        args: ["about:blank"],
        automation: { type: "cdp" },
      },
      path.join(paths.appSessionsDir, "browser"),
      9222,
      [],
    );
    assert.equal(args.includes(`--user-data-dir=${userDataDir}`), true);
  } finally {
    restoreEnv();
  }
});

test("app runtime keeps kasmvnc auth isolated without overriding gui app home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-gui-home-"));
  const paths = appRuntimeTestPaths(root);
  const appHome = path.join(root, "agent-home");
  const displayHome = path.join(paths.appSessionsDir, "display_main", "home");
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_GUI_APP_HOME: appHome,
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const env = runtime.appEnvForDisplay(
      { id: "terminal-gui", command: "xterm", kind: "gui" },
      {},
      {
        id: "main",
        display: ":101",
        width: 1024,
        height: 768,
        depth: 24,
        backend: "kasmvnc",
        vncPort: 8101,
        xauthority: path.join(displayHome, ".Xauthority"),
        sessionDir: path.join(paths.appSessionsDir, "display_main"),
        logDir: path.join(paths.logDir, "app-sessions", "display_main"),
        processes: [],
        appSessionIds: new Set(),
      },
    );
    assert.equal(env.HOME, appHome);
    assert.equal(env.XAUTHORITY, path.join(displayHome, ".Xauthority"));
  } finally {
    restoreEnv();
  }
});

test("app runtime loads persisted sessions as restartable history when enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-runtime-"));
  const paths = appRuntimeTestPaths(root);
  const sessionDir = path.join(paths.appSessionsDir, "app_existing");
  const logDir = path.join(paths.logDir, "app-sessions", "app_existing");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "tty.log"), "hello from history\n");
  fs.writeFileSync(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(
      {
        id: "app_existing",
        appId: "terminal-tty",
        title: "Recovered Terminal",
        kind: "tty",
        status: "running",
        createdAt: "2026-06-20T01:00:00.000Z",
        updatedAt: "2026-06-20T01:01:00.000Z",
        launch: {
          title: "Recovered Terminal",
          cwd: "/workspace",
          args: ["-lc", "echo recovered"],
        },
        tty: {
          webPath: "/api/apps/sessions/app_existing/tty",
          shell: "/bin/bash",
          cwd: "/workspace",
          mode: "pty",
        },
        process: {
          pid: 999999,
          command: "/bin/bash",
        },
        paths: {
          sessionDir,
          logDir,
        },
      },
      null,
      2,
    )}\n`,
  );

  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_APP_SESSION_PERSIST: "1",
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const [session] = runtime.listSessions();
    assert.equal(session.id, "app_existing");
    assert.equal(session.status, "exited");
    assert.equal(session.error.code, "APP_SESSION_RESTORED_WITHOUT_PROCESS");
    assert.equal(runtime.getSession("app_existing").launch.cwd, "/workspace");
    assert.equal(runtime.readLogs("app_existing").files[0].content, "hello from history\n");
    assert.equal(runtime.stop("app_existing").status, "exited");
    assert.equal((await runtime.delete("app_existing")).id, "app_existing");
    assert.equal(fs.existsSync(sessionDir), false);
    assert.equal(fs.existsSync(logDir), false);
  } finally {
    restoreEnv();
  }
});

test("app runtime cleans expired historical sessions when persistence and retention are enabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-retention-"));
  const paths = appRuntimeTestPaths(root);
  writeAppSessionMetadata(paths, "app_old", "exited", "2000-01-01T00:00:00.000Z");
  writeAppSessionMetadata(paths, "app_recent", "stopped", new Date().toISOString());
  writeAppSessionMetadata(paths, "app_running", "running", "2000-01-01T00:00:00.000Z");

  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_APP_SESSION_PERSIST: "1",
    TASK_HANDOFF_APP_SESSION_RETENTION_DAYS: "7",
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const ids = runtime.listSessions().map((session) => session.id).sort();
    assert.deepEqual(ids, ["app_recent", "app_running"]);
    assert.equal(fs.existsSync(path.join(paths.appSessionsDir, "app_old")), false);
    assert.equal(fs.existsSync(path.join(paths.logDir, "app-sessions", "app_old")), false);
    assert.equal(runtime.getSession("app_recent").status, "stopped");
    assert.equal(runtime.getSession("app_running").status, "exited");
    assert.equal(runtime.getSession("app_running").error.code, "APP_SESSION_RESTORED_WITHOUT_PROCESS");
  } finally {
    restoreEnv();
  }
});

test("app runtime stop releases live session resources but keeps history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-stop-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  const sessionDir = path.join(paths.appSessionsDir, "live_gui");
  const logDir = path.join(paths.logDir, "app-sessions", "live_gui");
  runtime.sessions.set("live_gui", {
    metadata: {
      id: "live_gui",
      appId: "chromium",
      title: "Live GUI",
      kind: "gui",
      status: "running",
      createdAt: "2026-06-20T01:00:00.000Z",
      updatedAt: "2026-06-20T01:00:00.000Z",
      display: {
        display: ":101",
        width: 1440,
        height: 900,
        depth: 24,
      },
      vnc: {
        host: "127.0.0.1",
        port: 6101,
        websockifyPort: 7101,
        webPath: "/api/apps/sessions/live_gui/vnc",
        noVncPath: "/api/apps/sessions/live_gui/novnc/vnc.html",
      },
      paths: {
        sessionDir,
        logDir,
      },
    },
    processes: [],
    outputBacklog: "",
    clients: new Set(),
  });

  const stopped = runtime.stop("live_gui");
  assert.equal(stopped.status, "stopped");
  assert.equal(runtime.getSession("live_gui").status, "stopped");
  assert.equal(runtime.vncTarget("live_gui"), undefined);
  assert.equal(runtime.allocateDisplay(), 101);
});

test("app runtime delete waits for live gui processes before removing session files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-delete-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  const sessionDir = path.join(paths.appSessionsDir, "live_gui_delete");
  const logDir = path.join(paths.logDir, "app-sessions", "live_gui_delete");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "chromium.log"), "running\n");

  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    setTimeout(() => {
      child.signalCode = signal;
      child.emit("close", null, signal);
    }, 20);
    return true;
  };
  runtime.sessions.set("live_gui_delete", {
    metadata: {
      id: "live_gui_delete",
      appId: "chromium",
      title: "Live GUI Delete",
      kind: "gui",
      status: "running",
      createdAt: "2026-06-20T01:00:00.000Z",
      updatedAt: "2026-06-20T01:00:00.000Z",
      paths: { sessionDir, logDir },
    },
    processes: [child],
    outputBacklog: "",
    clients: new Set(),
  });

  const startedAt = Date.now();
  const deleted = await runtime.delete("live_gui_delete");
  assert.equal(deleted.id, "live_gui_delete");
  assert.equal(child.killed, true);
  assert.ok(Date.now() - startedAt >= 15);
  assert.equal(runtime.getSession("live_gui_delete"), undefined);
  assert.equal(fs.existsSync(sessionDir), false);
  assert.equal(fs.existsSync(logDir), false);
});

test("app runtime can launch gui apps into a shared display", () => {
  const previousBackend = process.env.TASK_HANDOFF_VNC_BACKEND;
  process.env.TASK_HANDOFF_VNC_BACKEND = "novnc";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-shared-display-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  const children = [];
  const killed = [];
  const displayStarts = [];

  function fakeChild(name) {
    const child = new EventEmitter();
    child.stdout = { pipe() {} };
    child.stderr = { pipe() {} };
    child.pid = 10_000 + children.length;
    child.spawnfile = name;
    child.killed = false;
    child.kill = (signal = "SIGTERM") => {
      child.killed = true;
      killed.push({ name, signal });
      return true;
    };
    children.push({ name, child });
    return child;
  }

  runtime.hasCommand = () => true;
  runtime.waitForXDisplay = () => {};
  runtime.startNoVncDisplay = (display, width, height, depth, vncPort, websockifyPort) => {
    displayStarts.push({ display, width, height, depth, vncPort, websockifyPort });
    return [fakeChild("Xvfb"), fakeChild("x11vnc"), fakeChild("websockify")];
  };
  runtime.startCompositor = () => fakeChild("picom");
  runtime.spawnLogged = (command) => fakeChild(command);

  try {
    const first = runtime.start("terminal-gui", { displayTarget: { mode: "shared", id: "main", autoCreate: true } });
    const second = runtime.start("terminal-gui", { displayTarget: { mode: "shared", id: "main", autoCreate: true } });

    assert.equal(displayStarts.length, 1);
    assert.equal(first.display.mode, "shared");
    assert.equal(first.display.displaySessionId, "main");
    assert.equal(second.display.display, first.display.display);
    assert.equal(second.vnc.port, first.vnc.port);
    assert.equal(children.filter((entry) => entry.name === "openbox").length, 1);
    assert.equal(children.filter((entry) => entry.name === "picom").length, 1);
    assert.equal(children.filter((entry) => entry.name === "xterm").length, 2);

    children.find((entry) => entry.name === "picom").child.emit("exit", 1, null);
    assert.equal(runtime.getSession(first.id).status, "running");
    assert.equal(runtime.getSession(second.id).status, "running");

    runtime.stop(first.id);
    assert.equal(killed.some((entry) => entry.name === "Xvfb"), false);
    assert.deepEqual(runtime.vncTarget(second.id), { host: "127.0.0.1", port: second.vnc.port });

    runtime.stop(second.id);
    assert.equal(killed.some((entry) => entry.name === "Xvfb"), true);
    assert.equal(killed.some((entry) => entry.name === "openbox"), true);
    assert.equal(killed.some((entry) => entry.name === "picom"), true);
  } finally {
    if (previousBackend === undefined) {
      delete process.env.TASK_HANDOFF_VNC_BACKEND;
    } else {
      process.env.TASK_HANDOFF_VNC_BACKEND = previousBackend;
    }
  }
});

test("app runtime reports CDP automation readiness", async () => {
  const cdpServer = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        Browser: "Chrome/Test",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/test",
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve, reject) => {
    cdpServer.once("error", reject);
    cdpServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-automation-"));
    const paths = appRuntimeTestPaths(root);
    const runtime = new AppRuntimeManager(paths);
    const port = cdpServer.address().port;
    runtime.sessions.set("live_browser", {
      metadata: {
        id: "live_browser",
        appId: "chromium",
        title: "Live Browser",
        kind: "gui",
        status: "running",
        createdAt: "2026-06-20T01:00:00.000Z",
        updatedAt: "2026-06-20T01:00:00.000Z",
        automation: {
          type: "cdp",
          endpoint: `http://127.0.0.1:${port}`,
          port,
        },
        paths: {
          sessionDir: path.join(paths.appSessionsDir, "live_browser"),
          logDir: path.join(paths.logDir, "app-sessions", "live_browser"),
        },
      },
      processes: [],
      outputBacklog: "",
      clients: new Set(),
    });

    const status = await runtime.automationStatus("live_browser");
    assert.equal(status.ready, true);
    assert.equal(status.browser, "Chrome/Test");
    assert.equal(status.protocolVersion, "1.3");
    assert.equal(status.webSocketDebuggerUrl, "ws://127.0.0.1/devtools/browser/test");
  } finally {
    await new Promise((resolve) => cdpServer.close(resolve));
  }
});

test("web app reports automation route errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-automation-"));
  const paths = appRuntimeTestPaths(root);
  writeAppSessionMetadata(paths, "tty_history", "stopped", "2026-06-20T01:00:00.000Z");
  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
    TASK_HANDOFF_APP_SESSION_PERSIST: "1",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const missing = await app.inject({ method: "GET", url: "/api/apps/sessions/missing/automation" });
    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.payload).error.code, "APP_SESSION_NOT_FOUND");

    const unavailable = await app.inject({ method: "GET", url: "/api/apps/sessions/tty_history/automation" });
    assert.equal(unavailable.statusCode, 409);
    assert.equal(JSON.parse(unavailable.payload).error.code, "APP_AUTOMATION_UNAVAILABLE");
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app proxies session HTTP with httpxy while preserving KasmVNC theming", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-web-proxy-"));
  const paths = appRuntimeTestPaths(root);
  const requests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: body.toString("utf8"),
      });
      if (request.url.startsWith("/index.html")) {
        response.writeHead(200, {
          "content-type": "text/html",
          etag: "upstream-etag",
          "x-upstream": "html",
        });
        response.end("<!doctype html><html><head></head><body>Ready</body></html>");
        return;
      }
      if (request.url === "/style.css") {
        response.writeHead(200, { "content-type": "text/css" });
        response.end("#noVNC_transition { background: #fff url(spinner.svg); }");
        return;
      }
      if (request.url === "/asset.bin") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from([0, 1, 2, 253, 254, 255]));
        return;
      }
      if (request.url === "/echo") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(requests.at(-1)));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.equal(typeof address, "object");

  const runtime = new AppRuntimeManager(paths);
  const sessionDir = path.join(paths.appSessionsDir, "app_proxy");
  const logDir = path.join(paths.logDir, "app-sessions", "app_proxy");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  runtime.sessions.set("app_proxy", {
    metadata: {
      id: "app_proxy",
      appId: "vscode-web",
      title: "Proxy",
      kind: "web",
      status: "running",
      createdAt: "2026-06-20T01:00:00.000Z",
      updatedAt: "2026-06-20T01:00:00.000Z",
      web: {
        host: "127.0.0.1",
        port: address.port,
        webPath: "/api/apps/sessions/app_proxy/web/",
      },
      vnc: {
        backend: "kasmvnc",
        host: "127.0.0.1",
        port: address.port,
        webPath: "/api/apps/sessions/app_proxy/web/",
        noVncPath: "/api/apps/sessions/app_proxy/web/",
      },
      process: {
        command: "test-upstream",
      },
      paths: {
        sessionDir,
        logDir,
      },
    },
    processes: [],
    outputBacklog: "",
    clients: new Set(),
  });

  const restoreEnv = withWebStorageEnv(paths, {
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
    TASK_HANDOFF_KASMVNC_USERNAME: "agent",
    TASK_HANDOFF_KASMVNC_PASSWORD: "secret",
  });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false, appRuntime: runtime });
  try {
    const html = await app.inject({ method: "GET", url: "/api/apps/sessions/app_proxy/web/index.html?theme=dark" });
    assert.equal(html.statusCode, 200);
    assert.equal(html.headers.etag, undefined);
    assert.match(html.payload, /task-handoff-kasm-loading-theme/);
    assert.match(html.payload, /<body>Ready<\/body>/);
    assert.equal(requests.at(-1).url, "/index.html?theme=dark");
    assert.equal(requests.at(-1).authorization, `Basic ${Buffer.from("agent:secret").toString("base64")}`);

    const css = await app.inject({ method: "GET", url: "/api/apps/sessions/app_proxy/web/style.css" });
    assert.equal(css.statusCode, 200);
    assert.match(css.payload, /#05090b url\(spinner\.svg\)/);

    const echoed = await app.inject({
      method: "POST",
      url: "/api/apps/sessions/app_proxy/web/echo",
      headers: { "content-type": "application/json" },
      payload: { ok: true },
    });
    assert.equal(echoed.statusCode, 200);
    const echoedBody = JSON.parse(echoed.payload);
    assert.equal(echoedBody.method, "POST");
    assert.equal(echoedBody.contentType, "application/json");
    assert.equal(echoedBody.body, JSON.stringify({ ok: true }));

    const binary = await app.inject({ method: "GET", url: "/api/apps/sessions/app_proxy/web/asset.bin" });
    assert.equal(binary.statusCode, 200);
    assert.deepEqual(Buffer.from(binary.rawPayload), Buffer.from([0, 1, 2, 253, 254, 255]));
  } finally {
    await app.close();
    restoreEnv();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("codex app server uses a short unix socket path outside deep runtime directories", async () => {
  const longSegment = "deep-runtime-path-".repeat(8);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-socket-"));
  const paths = appRuntimeTestPaths(path.join(root, longSegment));
  const runtime = new AppRuntimeManager(paths);
  const spawned = [];
  const servers = [];

  runtime.spawnLogged = (command, args) => {
    const child = new EventEmitter();
    child.stdout = { pipe() {} };
    child.stderr = { pipe() {} };
    child.pid = 12345;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      return true;
    };
    spawned.push({ command, args, child });
    const endpoint = args.at(-1);
    const socketPath = endpoint.replace(/^unix:\/\//, "");
    const server = net.createServer((socket) => socket.end());
    server.listen(socketPath);
    servers.push(server);
    return child;
  };

  const session = runtime.acquireSharedResource("codex", "codex", root, process.env, "app_test");
  try {
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, "codex");
    assert.equal(spawned[0].args[0], "app-server");
    assert.equal(spawned[0].args[1], "--listen");
    assert.equal(spawned[0].args[2], `unix://${session.details.socketPath}`);
    assert.equal(session.details.socketPath.startsWith(path.join(paths.runtimeDir, "codex-app-server")), false);
    const socketRoot = process.platform === "darwin" ? "/private/tmp" : fs.realpathSync(os.tmpdir());
    assert.equal(session.details.socketPath.startsWith(`${socketRoot}/task-handoff-codex-`), true);
    assert.ok(session.details.socketPath.length < 100);
  } finally {
    runtime.releaseSharedResource("codex", "app_test");
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

test("app runtime reuses an already running shared codex app server", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-shared-reuse-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  const spawned = [];
  const servers = [];

  runtime.hasCommand = () => true;
  runtime.spawnLogged = (command, args) => {
    const child = new EventEmitter();
    child.stdout = { pipe() {} };
    child.stderr = { pipe() {} };
    child.pid = 20_000 + spawned.length;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      return true;
    };
    spawned.push({ command, args, child });
    const socketPath = args.at(-1).replace(/^unix:\/\//, "");
    const server = net.createServer((socket) => socket.end());
    server.listen(socketPath);
    servers.push(server);
    return child;
  };

  const first = runtime.ensureSharedResource("codex");
  const second = runtime.ensureSharedResource("codex");
  try {
    assert.equal(spawned.length, 1);
    assert.equal(second.details.socketPath, first.details.socketPath);
    assert.equal(runtime.sharedResourceInfo("codex").details.socketPath, first.details.socketPath);
  } finally {
    runtime.stopAll();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

test("app runtime codex app-server proxy records thread bindings from the app connection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-proxy-bind-"));
  const paths = appRuntimeTestPaths(root);
  const runtime = new AppRuntimeManager(paths);
  const upstreamSocketPath = path.join(root, "upstream.sock");
  const boundThreads = [];
  const unixServer = http.createServer();
  const upstreamServer = new WebSocket.WebSocketServer({ server: unixServer });

  upstreamServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "thread/start") {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread_from_proxy", status: { type: "idle" } } } }));
      }
      if (message.method === "thread/resume") {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: "idle" } } } }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    unixServer.once("error", reject);
    unixServer.listen(upstreamSocketPath, resolve);
  });

  const proxy = new CodexAppServerConnectionProxy(upstreamSocketPath, (threadId) => boundThreads.push(threadId));
  const port = runtime.allocatePort("web");
  proxy.start(port);
  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
    await new Promise((resolve, reject) => {
      client.once("message", (data) => {
        try {
          assert.equal(JSON.parse(data.toString()).result.thread.id, "thread_from_proxy");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      client.once("error", reject);
    });
    client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread_resumed_proxy" } }));
    await new Promise((resolve, reject) => {
      client.once("message", (data) => {
        try {
          assert.equal(JSON.parse(data.toString()).result.thread.id, "thread_resumed_proxy");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      client.once("error", reject);
    });
    assert.deepEqual(boundThreads, ["thread_from_proxy", "thread_resumed_proxy", "thread_resumed_proxy"]);
    client.close();
  } finally {
    proxy.stop();
    await new Promise((resolve) => unixServer.close(resolve));
  }
});

test("app runtime allocators skip occupied ports and live displays", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-alloc-"));
  const paths = appRuntimeTestPaths(root);
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(6101, "127.0.0.1", resolve);
  });
  try {
    const runtime = new AppRuntimeManager(paths);
    const vncPort = runtime.allocatePort("vnc");
    assert.notEqual(vncPort, 6101);
    assert.equal(vncPort, 6102);

    runtime.sessions.set("live_display", {
      metadata: {
        id: "live_display",
        appId: "chromium",
        title: "Live Display",
        kind: "gui",
        status: "running",
        createdAt: "2026-06-20T01:00:00.000Z",
        updatedAt: "2026-06-20T01:00:00.000Z",
        display: {
          display: ":101",
          width: 1440,
          height: 900,
          depth: 24,
        },
        paths: {
          sessionDir: path.join(paths.appSessionsDir, "live_display"),
          logDir: path.join(paths.logDir, "app-sessions", "live_display"),
        },
      },
      processes: [],
      outputBacklog: "",
      clients: new Set(),
    });
    assert.equal(runtime.allocateDisplay(), 102);
  } finally {
    occupied.close();
  }
});

function appRuntimeTestPaths(root) {
  return {
    configPath: path.join(root, "config.json"),
    dataDir: root,
    appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"),
    runtimeDir: path.join(root, "runtime"),
    eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"),
    logDir: path.join(root, "logs"),
    webTokenPath: path.join(root, "web-token"),
  };
}

function writeAppSessionMetadata(paths, id, status, updatedAt) {
  const sessionDir = path.join(paths.appSessionsDir, id);
  const logDir = path.join(paths.logDir, "app-sessions", id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "tty.log"), `${id}\n`);
  fs.writeFileSync(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(
      {
        id,
        appId: "terminal-tty",
        title: id,
        kind: "tty",
        status,
        createdAt: updatedAt,
        updatedAt,
        tty: {
          webPath: `/api/apps/sessions/${id}/tty`,
          shell: "/bin/bash",
          cwd: "/workspace",
          mode: "pty",
        },
        process: {
          command: "/bin/bash",
        },
        paths: {
          sessionDir,
          logDir,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function waitForWebSocketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitForCondition(check, label, timeoutMs = 2000) {
  const startedAt = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function onceWebSocketMessageFrame(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ message: data.toString(), isBinary }));
    socket.once("error", reject);
  });
}

function webSocketMessageFrames(socket, count) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const onMessage = (data, isBinary) => {
      frames.push({ message: data.toString(), isBinary });
      if (frames.length >= count) {
        socket.off("message", onMessage);
        socket.off("error", onError);
        resolve(frames);
      }
    };
    const onError = (error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

function withTimeout(promise, label, timeoutMs = 2000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function withWebStorageEnv(paths, extra = {}) {
  const patch = {
    TASK_HANDOFF_CONFIG: paths.configPath,
    TASK_HANDOFF_DATA_DIR: paths.dataDir,
    TASK_HANDOFF_APP_CATALOG_DIR: paths.appCatalogDir,
    TASK_HANDOFF_APP_SESSION_DIR: paths.appSessionsDir,
    TASK_HANDOFF_RUNTIME_DIR: paths.runtimeDir,
    TASK_HANDOFF_EVENTS_DIR: paths.eventsDir,
    TASK_HANDOFF_ARTIFACT_DIR: paths.artifactDir,
    TASK_HANDOFF_LOG_DIR: paths.logDir,
    TASK_HANDOFF_WEB_TOKEN_FILE: paths.webTokenPath,
    CODEX_HOME: undefined,
    CLAUDE_HOME: undefined,
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_CONTROL_MODE: undefined,
    TASK_HANDOFF_DIAGNOSTIC_LOGS: undefined,
    TASK_HANDOFF_INSTANCE_ID: undefined,
    TASK_HANDOFF_INSTANCE_NAME: undefined,
    TASK_HANDOFF_NODE_AGENT_URL: undefined,
    TASK_HANDOFF_NODE_ID: undefined,
    TASK_HANDOFF_PROJECT_ID: undefined,
    TASK_HANDOFF_REGISTRATION_TOKEN: undefined,
    TASK_HANDOFF_RUNTIME_ID: undefined,
    TASK_HANDOFF_WORKSPACE_MODE: undefined,
    TASK_HANDOFF_ENABLE_CC_SWITCH: "0",
    TASK_HANDOFF_ENABLE_WEB_CAP: "0",
    ...extra,
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
