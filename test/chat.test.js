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
  createChatApprovalPayload,
  createChatBridgeRegistry,
  createChatProgressController,
  createChatResultPayload,
  createChatTaskPayload,
  createChatTextRouter,
  chatRoutesForConversation,
  deliverChatPayload,
  normalizeChatCapabilities,
  normalizeChatCommandLine,
  routeWithTargetContext,
  renderPlainChatPayload,
} = require("../packages/core/src/core/chat.ts");

const {
  renderTelegramApprovalPayload,
  renderTelegramProgressText,
  renderTelegramTitledPayload,
  telegramMarkdownEscape,
} = require("../packages/core/src/core/chat-render.ts");
const { TelegramProgressStore } = require("../packages/core/src/core/telegram-progress.ts");
const { TelegramBridge, splitTelegramText, telegramMarkdownV2ToLegacy } = require("../packages/receiver-worker/src/integrations/telegram.ts");
const { DingdingBridge } = require("../packages/receiver-worker/src/integrations/dingding.ts");

const {
  formatCommandHelp,
  getArgumentEntryCommand,
  getCommandSuggestions,
  getSuggestionWindow,
  hasCommandArguments,
  shouldCompleteCommand,
} = require("../packages/receiver-worker/src/domain/commands.ts");

const {
  createConversation,
  createPassiveConversation,
  normalizeConversations,
  parseConversationAgent,
  parseConversationId,
  parseConversationMode,
} = require("../packages/core/src/core/conversations.ts");
const {
  activeAgentCommand,
  claudeSessionId,
  codexSessionId,
  lastCodexMessage,
  normalizeConversationMode,
  parseClaudeFinalMessage,
  parseCodexFinalMessage,
  summarizeClaudeFailure,
  summarizeClaudeJsonLine,
  summarizeCodexFailure,
  summarizeCodexJsonLine,
} = require("../packages/receiver-worker/src/domain/active-agents.ts");
const {
  conversationAiSessionId,
  conversationAgent,
  conversationAgentSessionId,
  conversationWithAiSession,
  conversationWithCwd,
  conversationWithMode,
  conversationWithNewAgentSession,
} = require("../packages/receiver-worker/src/domain/conversation-actions.ts");
const { CWD_PICKER_PAGE_SIZE, createCwdPicker, handleCwdPickerAction } = require("../packages/receiver-worker/src/domain/cwd-picker.ts");
const { listHistoricalSessions } = require("../packages/ai-session-runtime/src/session-history.ts");
const {
  createAiSessionRegistry,
  reconcileActiveAiProcesses,
  scanRecentTranscripts,
} = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const {
  codexNotification,
} = require("../packages/ai-session-runtime/src/codex-app-server-protocol.ts");
const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionDiscoveryCoordinator } = require("../packages/ai-session-runtime/src/ai-session-discovery.ts");
const { CodexAppServerClient, CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { ClaudeControlSockSessionBridge } = require("../packages/ai-session-runtime/src/claude-control-sock.ts");
const { createReceiverCommandHandlers } = require("../packages/receiver-worker/src/controllers/command-handlers.ts");
const { createReceiverChatRouter } = require("../packages/receiver-worker/src/controllers/chat-command-router.ts");
const { createReceiverTerminalCommandRouter } = require("../packages/receiver-worker/src/controllers/terminal-command-router.ts");
const {
  createIncomingPendingItem,
  createIncomingResultEnvelope,
  incomingDeliveryConversationIds,
  incomingResultBindingPatch,
  incomingTimeoutReply,
} = require("../packages/receiver-worker/src/controllers/incoming-result-workflow.ts");
const {
  bindChatToConversation,
  generateChatToolInstanceId,
  listChatBindings,
  listChatToolInstances,
  normalizeChatToolState,
} = require("../packages/receiver-worker/src/state/chat-tools.ts");
const {
  CONVERSATION_ACTIVE_MS,
  isConversationActive,
  isConversationActivityExpired,
  markConversationActive,
  normalizeConversationActivity,
  ownerKeysFromMessage,
  shouldAssignNewConversation,
} = require("../packages/receiver-worker/src/state/activity.ts");
const {
  buildConversationBindingPatch,
  buildSessionConversationBindingPatch,
  conversationIdForIdentities,
} = require("../packages/receiver-worker/src/state/conversation-bindings.ts");
const { identitiesFromMessage } = require("../packages/receiver-worker/src/state/binding-identities.ts");
const { deleteConversationState } = require("../packages/receiver-worker/src/state/conversation-store.ts");
const { toPendingView } = require("../packages/receiver-worker/src/state/pending.ts");
const {
  addResultHistoryEntry,
  createResultHistoryStore,
  resultHistoryPayload,
} = require("../packages/receiver-worker/src/state/result-history.ts");

const { waitForSenderReply, waitingForTaskMessage } = require("../packages/protocol/src/sender.ts");
const { AiSessionEventType, AiSessionSummarySchema } = require("../packages/protocol/src/ai-sessions.ts");
const { APP_SESSION_DELTA_RETENTION_MS } = require("../packages/protocol/src/app-sessions.ts");
const { MCP_SENDER_TIMEOUT_MS } = require("../apps/cli/src/mcp/index.ts");
const { summarizeTranscriptLine } = require("../packages/core/src/core/transcript.ts");
const { summarizeThreadTurns } = require("../packages/ai-session-runtime/src/codex-app-server-protocol.ts");
const { encodeMessage } = require("../packages/core/src/core/protocol.ts");
const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");
const { AiSessionRefreshScheduler, createWebApp } = require("../packages/controlled-instance/src/web/server.ts");
const { applyManagedCodexModelConfig } = require("../packages/controlled-instance/src/web/codex-model-config.ts");
const {
  APPROVAL_TIMEOUT_MS,
  APPROVAL_TIMEOUT_REPLY,
  resolveApprovalConversation,
  sessionIdsForApprovalHook,
} = require("../apps/cli/src/hooks/codex-approval.ts");
const {
  hasClaudeMcpServer,
  hasCodexMcpServer,
  installClaudeMcpServer,
  installCodexMcpServer,
  removeClaudeMcpServer,
  removeCodexMcpServer,
} = require("../apps/cli/src/hooks/mcp-install.ts");
const { parseComponent, parseTarget, resolveInstallTargets } = require("../apps/cli/src/hooks/unified-install.ts");

test("normalizes Telegram bot command suffixes", () => {
  assert.equal(normalizeChatCommandLine("/status@TaskHandoffBot"), "/status");
  assert.equal(normalizeChatCommandLine("/reply@TaskHandoffBot #1 ok"), "/reply #1 ok");
  assert.equal(normalizeChatCommandLine("/status"), "/status");
});

test("chat text router dispatches commands and replies", () => {
  const commands = [];
  const replies = [];
  const logs = [];
  const commandResponses = [];
  const router = createChatTextRouter({
    addLog: (message) => logs.push(message),
    handleCommand: (line) => commands.push(line),
    runCommand: (line) => {
      commands.push(line);
      return line === "/help" ? formatCommandHelp() : "";
    },
    replyDefault: (...args) => {
      replies.push(args);
      return "queued";
    },
    sendCommandResponse: (options) => commandResponses.push(options),
  });

  assert.equal(router({ channel: "telegram", conversationId: 1, text: "/status@Bot" }), "command");
  assert.deepEqual(commands, ["/status"]);
  assert.equal(router({ channel: "telegram", conversationId: 1, text: "/help@Bot" }), "command");
  assert.deepEqual(commands, ["/status", "/help"]);
  assert.equal(commandResponses[0].channel, "telegram");
  assert.equal(commandResponses[0].conversationId, 1);
  assert.match(commandResponses[0].text, /\/help\s+显示命令帮助/);
  assert.match(commandResponses[0].text, /\n\/status\s+显示 receiver 状态/);
  assert.equal(
    router({ channel: "wechat", conversationId: 2, text: "hello", label: "sent from Wechat" }),
    "queued",
  );
  assert.equal(replies[0][0], "hello");
  assert.equal(replies[0][1], "sent from Wechat");
  assert.equal(replies[0][2], 2);
  assert.match(logs[0], /telegram c1 command/);
});

test("plain payload rendering covers task and approval messages", () => {
  assert.equal(
    renderPlainChatPayload(
      createChatTaskPayload({
        conversationId: 7,
        id: 3,
        timeoutLabel: "5m",
        body: "body",
      }),
    ),
    "task-handoff c7 #3\ntimeout: 5m\n\nbody\n\nReply here to send text back to the waiting CLI.",
  );

  assert.match(
    renderPlainChatPayload(
      createChatApprovalPayload({
        conversationId: 7,
        id: 4,
        timeoutLabel: "5m",
        body: "approve?",
      }),
    ),
    /\/approve #4, \/skip #4, or \/deny #4/,
  );
});

test("registry stores capabilities and stops bridges", () => {
  const registry = createChatBridgeRegistry();
  let stopped = false;
  registry.set("example", { stop: () => (stopped = true), capabilities: { buttons: true, plainTextOnly: false } });

  assert.equal(registry.get("example"), registry.getEntry("example").bridge);
  assert.deepEqual(registry.getCapabilities("example"), {
    ...normalizeChatCapabilities(),
    buttons: true,
    plainTextOnly: false,
  });

  registry.stopAll();
  assert.equal(stopped, true);
  assert.equal(registry.get("example"), undefined);
});

test("deliverChatPayload chooses approval and task bridge methods", async () => {
  const calls = [];
  const route = {
    capabilities: normalizeChatCapabilities(),
    bridge: {
      sendApprovalPayload: async (payload) => calls.push(["approval", payload.kind]),
      sendTask: async (payload) => calls.push(["task", payload.kind]),
    },
  };

  await deliverChatPayload(route, createChatApprovalPayload({ conversationId: 1, id: 2, body: "approve?" }));
  await deliverChatPayload(route, createChatTaskPayload({ conversationId: 1, id: 3, body: "task" }));

  assert.deepEqual(calls, [
    ["approval", "approval"],
    ["task", "task"],
  ]);
});

test("deliverChatPayload passes active route target to bridge methods", async () => {
  const calls = [];
  const route = chatRoutesForConversation(
    createChatBridgeRegistry(),
    [
      {
        channel: "telegram",
        instanceId: "telegram-1",
        routeKey: "telegram:telegram-1:111",
        conversationId: 1,
        target: { chatId: "111" },
        capabilities: normalizeChatCapabilities({ buttons: true }),
        bridge: {
          enabled: true,
          sendTask: async (payload, activeRoute) => calls.push([payload.kind, activeRoute.routeKey, activeRoute.target.chatId]),
        },
      },
    ],
    1,
  )[0];

  await deliverChatPayload(route, createChatTaskPayload({ conversationId: 1, body: "task" }));
  assert.deepEqual(calls, [["task", "telegram:telegram-1:111", "111"]]);
});

test("chat routes inject registered bridge capabilities", () => {
  const registry = createChatBridgeRegistry();
  const bridge = { send: () => undefined, capabilities: { progress: true } };
  registry.set("telegram", bridge);

  const routes = chatRoutesForConversation(
    registry,
    [
      { channel: "telegram", conversationId: 1 },
      { channel: "wechat", conversationId: 1 },
      { channel: "telegram", conversationId: 2 },
    ],
    1,
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].bridge, bridge);
  assert.equal(routes[0].capabilities.progress, true);
  assert.equal(routes[0].capabilities.plainTextOnly, true);
});

test("deliverChatPayload falls back to plain send", async () => {
  const calls = [];
  await deliverChatPayload(
    {
      capabilities: normalizeChatCapabilities(),
      bridge: {
        send: async (text) => calls.push(text),
      },
    },
    createChatTaskPayload({ conversationId: 2, body: "plain" }),
  );

  assert.match(calls[0], /task-handoff c2/);
  assert.match(calls[0], /plain/);
});

test("result payload attachments render action buttons", () => {
  const bridge = new TelegramBridge({
    onText: () => undefined,
    onLog: () => undefined,
  });
  const payload = createChatResultPayload({
    conversationId: 2,
    id: 7,
    body: "done",
    attachments: [
      {
        id: "1",
        kind: "image",
        path: "/tmp/screenshot.png",
        name: "screenshot.png",
      },
    ],
  });

  const markup = bridge.attachmentReplyMarkup(payload);

  assert.equal(markup.inline_keyboard[0][0].text, "发送图片 screenshot.png");
  assert.equal(markup.inline_keyboard[0][0].callback_data, "task_handoff:attachment:2:7:1");
});

test("progress controller starts and finishes a route independently", async () => {
  const updates = [];
  let stopped = false;
  const route = {
    channel: "telegram",
    conversationId: 1,
    capabilities: { progress: true },
    bridge: {
      enabled: true,
      updateProgress: (key, text) => updates.push([key, text]),
      finishProgressPayload: async (key, payload) => {
        updates.push([key, payload.kind]);
        return true;
      },
    },
  };
  const progressMap = new Map();
  const controller = createChatProgressController({
    routes: () => [route],
    progressMap,
    watch: ({ onUpdate }) => {
      onUpdate("working");
      return { stop: () => (stopped = true), transcriptPath: "/tmp/transcript.jsonl" };
    },
  });

  controller.start({ kind: "task", conversationId: 1 });
  assert.deepEqual(updates[0], ["telegram:1", "working"]);
  assert.equal(progressMap.has("telegram:1"), true);

  assert.equal(await controller.finishRoute(route, 1, { kind: "result" }), true);
  assert.equal(stopped, true);
  assert.equal(progressMap.has("telegram:1"), false);
  assert.deepEqual(updates[1], ["telegram:1", "result"]);
});

test("progress controller keeps reused chat routes separate by conversation", () => {
  const updates = [];
  const route = {
    channel: "telegram",
    routeKey: "telegram:default:111",
    conversationId: 1,
    capabilities: { progress: true },
    bridge: {
      enabled: true,
      updateProgress: (key, text) => updates.push([key, text]),
    },
  };
  const progressMap = new Map();
  const controller = createChatProgressController({
    routes: () => [route],
    progressMap,
    watch: ({ item, onUpdate }) => {
      onUpdate(`c${item.conversationId}`);
      return { stop: () => undefined };
    },
  });

  controller.start({ kind: "task", conversationId: 1 });
  route.conversationId = 2;
  controller.start({ kind: "task", conversationId: 2 });

  assert.deepEqual(updates, [
    ["telegram:default:111:1", "c1"],
    ["telegram:default:111:2", "c2"],
  ]);
  assert.equal(progressMap.has("telegram:default:111:1"), true);
  assert.equal(progressMap.has("telegram:default:111:2"), true);
});

test("progress controller carries route target context to progress messages", () => {
  const updates = [];
  const route = {
    channel: "telegram",
    routeKey: "telegram:default:111",
    conversationId: 1,
    target: { chatId: "111" },
    capabilities: { progress: true },
    bridge: {
      enabled: true,
      updateProgress: (key, text, activeRoute) => updates.push([key, text, activeRoute.target.replyToMessageId]),
    },
  };
  const controller = createChatProgressController({
    routes: () => [route],
    progressMap: new Map(),
    watch: ({ onUpdate }) => {
      onUpdate("working");
      return { stop: () => undefined };
    },
  });

  controller.start({ kind: "task", conversationId: 1, routeTarget: { replyToMessageId: 42 } });

  assert.deepEqual(updates, [["telegram:default:111:1", "working", 42]]);
});

test("progress controller passes progress actions to bridges", () => {
  const updates = [];
  const route = {
    channel: "telegram",
    routeKey: "telegram:default:111",
    conversationId: 1,
    capabilities: { progress: true },
    bridge: {
      enabled: true,
      updateProgress: (key, text, activeRoute, options) => updates.push([key, text, options.actions[0]]),
    },
  };
  const controller = createChatProgressController({
    routes: () => [route],
    progressMap: new Map(),
    watch: ({ onUpdate }) => {
      onUpdate("working");
      return { stop: () => undefined };
    },
  });

  controller.start({
    kind: "task",
    conversationId: 1,
    progressActions: [{ text: "取消", callbackData: "task_handoff:active_cancel:1" }],
  });

  assert.deepEqual(updates, [
    ["telegram:default:111:1", "working", { text: "取消", callbackData: "task_handoff:active_cancel:1" }],
  ]);
});

test("route target context preserves existing route chat ids", () => {
  const privateRoute = { target: { chatId: "test-private-chat-id" } };
  const groupRoute = { target: { chatId: "test-group-chat-id" } };
  const groupReplyTarget = { chatId: "test-group-chat-id", replyToMessageId: 42 };

  assert.deepEqual(routeWithTargetContext(privateRoute, groupReplyTarget).target, { chatId: "test-private-chat-id" });
  assert.deepEqual(routeWithTargetContext(groupRoute, groupReplyTarget).target, {
    chatId: "test-group-chat-id",
    replyToMessageId: 42,
  });
});

test("progress controller deletes progress when an intervening message arrives", async () => {
  const deleted = [];
  const sent = [];
  const route = {
    channel: "telegram",
    conversationId: 1,
    capabilities: { progress: true },
    target: { chatId: "111" },
    bridge: {
      enabled: true,
      updateProgress: () => undefined,
      deleteProgress: async (key) => {
        deleted.push(key);
        return true;
      },
      sendTask: async (_payload, activeRoute) => sent.push(activeRoute.target.replyToMessageId),
      finishProgressPayload: async () => {
        throw new Error("finish should not run after intervening message");
      },
    },
  };
  const progressMap = new Map();
  const controller = createChatProgressController({
    routes: () => [route],
    progressMap,
    watch: () => ({ stop: () => undefined }),
  });

  controller.start({ kind: "task", conversationId: 1, routeTarget: { replyToMessageId: 42 } });
  controller.markIntervening(1);

  assert.equal(await controller.finishRoute(route, 1, { kind: "result" }), true);
  assert.deepEqual(deleted, ["telegram:1"]);
  assert.deepEqual(sent, [42]);
  assert.equal(progressMap.has("telegram:1"), false);
});

test("telegram renderer escapes titled, progress, and approval payloads", () => {
  assert.equal(telegramMarkdownEscape("a_b"), "a\\_b");
  assert.match(renderTelegramTitledPayload({ title: "Task_Handoff", body: "body_with_underscore" }), /^\*Task\\_Handoff\*/);
  assert.match(renderTelegramProgressText("Working_now\nrun npm_test"), /^\*Working\\_now\*/);
  assert.match(
    renderTelegramApprovalPayload({
      body: "权限请求审批：please_check\n命令：npm test",
    }),
    /\*权限请求审批：\*please\\_check/,
  );
});

test("telegram long messages split under safe limit", () => {
  const longText = `${"a".repeat(2000)}\n${"b".repeat(2000)}\n${"c".repeat(2000)}`;
  const chunks = splitTelegramText(longText, 3900);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.every((chunk) => chunk.length <= 3900), true);
  assert.equal(chunks.join(""), longText);
});

test("telegram raw markdown falls back to legacy markdown before plain text", async () => {
  const calls = [];
  const telegram = new TelegramBridge({
    token: "token",
    chatId: "1",
    onText: () => {},
    onLog: () => {},
  });
  telegram.bot = {
    telegram: {
      sendMessage: async (_chatId, text, extra) => {
        calls.push([text, extra?.parse_mode]);
        if (extra?.parse_mode === "MarkdownV2") {
          throw new Error("bad markdown v2");
        }
        return { message_id: 1 };
      },
    },
  };

  await telegram.sendMessage("*Title*\n\n1\\. \\- item", { rawMarkdownV2: true });

  assert.deepEqual(calls, [
    ["*Title*\n\n1\\. \\- item", "MarkdownV2"],
    ["*Title*\n\n1. - item", "Markdown"],
  ]);
  assert.equal(telegramMarkdownV2ToLegacy("\\| 23\\\\.35 \\|"), "| 23\\.35 |");
});

test("telegram edit markdown falls back to legacy markdown before plain text", async () => {
  const calls = [];
  const telegram = new TelegramBridge({
    token: "token",
    chatId: "1",
    onText: () => {},
    onLog: () => {},
  });
  telegram.bot = {
    telegram: {
      editMessageText: async (_chatId, _messageId, _inlineMessageId, text, extra) => {
        calls.push([text, extra?.parse_mode]);
        if (extra?.parse_mode === "MarkdownV2") {
          throw new Error("bad markdown v2");
        }
        return { message_id: 1 };
      },
    },
  };

  await telegram.editMessage(1, "*Title*\n\n1\\. \\- item", { rawMarkdownV2: true });

  assert.deepEqual(calls, [
    ["*Title*\n\n1\\. \\- item", "MarkdownV2"],
    ["*Title*\n\n1. - item", "Markdown"],
  ]);
});

test("telegram progress messages can reply to the source task message", async () => {
  const calls = [];
  const telegram = new TelegramBridge({
    token: "token",
    chatId: "1",
    onText: () => {},
    onLog: () => {},
  });
  telegram.bot = {
    telegram: {
      sendMessage: async (_chatId, _text, extra) => {
        calls.push(extra?.reply_to_message_id);
        return { message_id: 10 };
      },
    },
  };

  await telegram.applyProgressUpdate("telegram:default:1:2", "working", {
    target: { chatId: "1", replyToMessageId: 42 },
  });

  assert.deepEqual(calls, [42]);
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

test("telegram ignores messages and actions from unauthorized users", async () => {
  const texts = [];
  const actions = [];
  const answers = [];
  const logs = [];
  const telegram = new TelegramBridge({
    token: "token",
    allowedUserIds: ["42"],
    multiChat: true,
    onText: (text) => texts.push(text),
    onAction: (action) => actions.push(action),
    onLog: (message) => logs.push(message),
  });

  await telegram.handleMessage({
    message: { chat: { id: "1" }, from: { id: 7 }, message_id: 1, text: "/status" },
  });
  await telegram.handleAction({
    callbackQuery: {
      from: { id: 7 },
      message: { chat: { id: "1" }, message_id: 2 },
      data: "task_handoff:conversation:1",
    },
    answerCbQuery: async (message) => answers.push(message),
  });

  assert.deepEqual(texts, []);
  assert.deepEqual(actions, []);
  assert.deepEqual(answers, ["not authorized"]);
  assert.equal(logs.filter((message) => /unauthorized/.test(message)).length, 2);

  await telegram.handleMessage({
    message: { chat: { id: "1" }, from: { id: 42 }, message_id: 3, text: "/status" },
  });
  assert.deepEqual(texts, ["/status"]);
});

test("telegram ignores expired callback query answers", async () => {
  const actions = [];
  const logs = [];
  const telegram = new TelegramBridge({
    token: "token",
    allowedUserIds: ["42"],
    multiChat: true,
    onText: () => {},
    onAction: (action) => {
      actions.push(action);
      return true;
    },
    onLog: (message) => logs.push(message),
  });

  await telegram.handleAction({
    callbackQuery: {
      from: { id: 42 },
      message: { chat: { id: "1" }, message_id: 2 },
      data: "task_handoff:approval:1:2:allow",
    },
    answerCbQuery: async () => {
      throw new Error("400: Bad Request: query is too old and response timeout expired or query ID is invalid");
    },
    editMessageReplyMarkup: async () => {},
  });

  assert.equal(actions.length, 1);
  assert.match(logs.join("\n"), /callback answer skipped/);
});

test("telegram routes active cancel callback actions", async () => {
  const actions = [];
  const answers = [];
  const telegram = new TelegramBridge({
    token: "token",
    allowedUserIds: ["42"],
    multiChat: true,
    onText: () => {},
    onAction: (action) => {
      actions.push(action);
      return { cancelled: true, message: "已请求取消 c3" };
    },
    onLog: () => {},
  });

  await telegram.handleAction({
    callbackQuery: {
      from: { id: 42 },
      message: { chat: { id: "1" }, message_id: 2 },
      data: "task_handoff:active_cancel:3",
    },
    answerCbQuery: async (message) => answers.push(message),
  });

  assert.deepEqual(actions, [{ type: "active_cancel", conversationId: 3, chatId: "1" }]);
  assert.deepEqual(answers, ["已请求取消 c3"]);
});

test("telegram routes session callback actions", async () => {
  const actions = [];
  const answers = [];
  const telegram = new TelegramBridge({
    token: "token",
    allowedUserIds: ["42"],
    multiChat: true,
    onText: () => {},
    onAction: (action) => {
      actions.push(action);
      return { found: true, message: "selected" };
    },
    onLog: () => {},
  });

  await telegram.handleAction({
    callbackQuery: {
      from: { id: 42 },
      message: { chat: { id: "1" }, message_id: 2 },
      data: "task_handoff:session:3:codex:11111111-1111-1111-1111-111111111111",
    },
    answerCbQuery: async (message) => answers.push(message),
  });

  assert.deepEqual(actions, [
    {
      type: "session",
      conversationId: 3,
      agent: "codex",
      sessionId: "11111111-1111-1111-1111-111111111111",
      chatId: "1",
    },
  ]);
  assert.deepEqual(answers, ["selected"]);
});

test("telegram binds the first user when no allowlist is configured", async () => {
  const texts = [];
  const changes = [];
  const telegram = new TelegramBridge({
    token: "token",
    multiChat: true,
    onText: (text) => texts.push(text),
    onLog: () => {},
    onChange: (state) => changes.push(state),
  });

  await telegram.handleMessage({
    message: { chat: { id: "1" }, message_id: 0, text: "anonymous" },
  });
  await telegram.handleMessage({
    message: { chat: { id: "1" }, from: { id: 42 }, message_id: 1, text: "first" },
  });
  await telegram.handleMessage({
    message: { chat: { id: "1" }, from: { id: 7 }, message_id: 2, text: "second" },
  });

  assert.deepEqual(texts, ["first"]);
  assert.deepEqual(telegram.allowedUserIds, ["42"]);
  assert.deepEqual(changes.at(-1).allowedUserIds, ["42"]);
});

test("telegram image paths are appended to text prompts", () => {
  const telegram = new TelegramBridge({
    onText: () => {},
    onLog: () => {},
  });
  assert.deepEqual(
    telegram.imageAttachments({
      photo: [
        { file_id: "small", file_size: 10, width: 10 },
        { file_id: "large", file_size: 20, width: 20 },
      ],
      document: { file_id: "doc", file_name: "scan.png", mime_type: "image/png", file_size: 30 },
    }).map((entry) => [entry.fileId, entry.fileName, entry.fileSize]),
    [
      ["large", "telegram-photo.jpg", 20],
      ["doc", "scan.png", 30],
    ],
  );
  assert.equal(
    telegram.textWithImagePaths("看一下", ["/tmp/task-handoff-images/a.jpg"]),
    "看一下\n\n图片路径：/tmp/task-handoff-images/a.jpg",
  );
  assert.equal(
    telegram.textWithImagePaths("", ["/tmp/task-handoff-images/a.jpg", "/tmp/task-handoff-images/b.png"]),
    "图片1路径：/tmp/task-handoff-images/a.jpg\n图片2路径：/tmp/task-handoff-images/b.png",
  );
});

test("dingding card actions route approvals and preserve callback context", async () => {
  const actions = [];
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
    onAction: (action) => {
      actions.push(action);
      return true;
    },
  });

  const result = await dingding.handleLogicalCardAction(
    "approval_allow_12",
    { outTrackId: "track-1", userId: "user-1", spaceId: "dtv1.card//IM_GROUP.chat-1" },
    { biz_conversation_id: "chat-1", biz_sender_id: "user-1", biz_session_webhook: "https://example.test/webhook" },
  );

  assert.deepEqual(actions, [{ type: "approval", id: 12, decision: "allow" }]);
  assert.equal(result.handled, true);
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_conversation_id, "chat-1");
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_sender_id, "user-1");
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_session_webhook, "https://example.test/webhook");
});

test("dingding conversation card action forwards chat extra", async () => {
  const actions = [];
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
    onAction: (action) => {
      actions.push(action);
      return { text: "已绑定", replyMarkup: undefined };
    },
  });

  const callbackData = Buffer.from("task_handoff:conversation:2", "utf8").toString("base64url");
  const result = await dingding.handleLogicalCardAction(
    `th_cb_${callbackData}`,
    { outTrackId: "track-2", userId: "user-2", spaceId: "dtv1.card//IM_GROUP.chat-2" },
    { biz_conversation_id: "chat-2", biz_sender_id: "user-2", biz_session_webhook: "https://example.test/webhook-2" },
  );

  assert.deepEqual(actions, [
    {
      type: "conversation",
      conversationId: 2,
      chatId: "chat-2",
      senderId: "user-2",
      sessionWebhook: "https://example.test/webhook-2",
    },
  ]);
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_conversation_id, "chat-2");
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_session_webhook, "https://example.test/webhook-2");
});

test("dingding routes active cancel card action with callback context", async () => {
  const actions = [];
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
    onAction: (action) => {
      actions.push(action);
      return { cancelled: true, message: "已请求取消 c4" };
    },
  });

  const callbackData = Buffer.from("task_handoff:active_cancel:4", "utf8").toString("base64url");
  const result = await dingding.handleLogicalCardAction(
    `th_cb_${callbackData}`,
    { outTrackId: "track-3", userId: "user-3", spaceId: "dtv1.card//IM_GROUP.chat-3" },
    { biz_conversation_id: "chat-3", biz_sender_id: "user-3", biz_session_webhook: "https://example.test/webhook-3" },
  );

  assert.deepEqual(actions, [
    {
      type: "active_cancel",
      conversationId: 4,
      chatId: "chat-3",
      senderId: "user-3",
      sessionWebhook: "https://example.test/webhook-3",
    },
  ]);
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_step, "active_cancel");
});

test("dingding routes session card action with callback context", async () => {
  const actions = [];
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
    onAction: (action) => {
      actions.push(action);
      return { found: true, message: "selected" };
    },
  });

  const callbackData = Buffer.from("task_handoff:session:4:claude:22222222-2222-4222-8222-222222222222", "utf8").toString("base64url");
  const result = await dingding.handleLogicalCardAction(
    `th_cb_${callbackData}`,
    { outTrackId: "track-4", userId: "user-4", spaceId: "dtv1.card//IM_GROUP.chat-4" },
    { biz_conversation_id: "chat-4", biz_sender_id: "user-4", biz_session_webhook: "https://example.test/webhook-4" },
  );

  assert.deepEqual(actions, [
    {
      type: "session",
      conversationId: 4,
      agent: "claude",
      sessionId: "22222222-2222-4222-8222-222222222222",
      chatId: "chat-4",
      senderId: "user-4",
      sessionWebhook: "https://example.test/webhook-4",
    },
  ]);
  assert.equal(result.cardResponse.cardData.cardParamMap.biz_step, "session_updated");
});

test("dingding ignores messages and actions from unauthorized users", async () => {
  const texts = [];
  const actions = [];
  const logs = [];
  const dingding = new DingdingBridge({
    allowedUserIds: ["allowed-user"],
    multiChat: true,
    onText: (text) => texts.push(text),
    onAction: (action) => {
      actions.push(action);
      return true;
    },
    onLog: (message) => logs.push(message),
  });

  await dingding.handleRobotMessage({
    headers: { messageId: "m1" },
    data: JSON.stringify({
      conversationId: "chat-1",
      senderStaffId: "blocked-user",
      text: { content: "blocked" },
    }),
  });
  await dingding.handleRobotMessage({
    headers: { messageId: "m2" },
    data: JSON.stringify({
      conversationId: "chat-1",
      senderStaffId: "allowed-user",
      text: { content: "allowed" },
    }),
  });
  await dingding.handleCardCallback({
    headers: { messageId: "m3" },
    data: JSON.stringify({
      userId: "blocked-user",
      outTrackId: "track-1",
      cardActionData: { cardPrivateData: { actionIdList: ["approval_allow_1"], params: {} } },
    }),
  });

  assert.deepEqual(texts, ["allowed"]);
  assert.deepEqual(actions, []);
  assert.equal(logs.some((message) => /unauthorized user ignored/.test(message)), true);
  assert.equal(logs.some((message) => /unauthorized action ignored/.test(message)), true);
});

test("dingding binds the first user when no allowlist is configured", async () => {
  const changes = [];
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
    onChange: (state) => changes.push(state.allowedUserIds),
  });

  await dingding.handleRobotMessage({
    headers: { messageId: "m1" },
    data: JSON.stringify({
      conversationId: "chat-1",
      senderStaffId: "first-user",
      text: { content: "hello" },
    }),
  });
  await dingding.handleRobotMessage({
    headers: { messageId: "m2" },
    data: JSON.stringify({
      conversationId: "chat-1",
      senderStaffId: "second-user",
      text: { content: "blocked" },
    }),
  });

  assert.deepEqual(dingding.allowedUserIds, ["first-user"]);
  assert.equal(changes.some((ids) => ids?.[0] === "first-user"), true);
});

test("dingding bind clears cached access token", () => {
  const dingding = new DingdingBridge({
    clientId: "old-id",
    clientSecret: "old-secret",
    onText: () => {},
    onLog: () => {},
  });
  dingding.accessToken = { value: "old-token", expiresAt: Date.now() + 60_000 };
  dingding.start = () => {};

  dingding.bind("new-id", "new-secret", "corp", "robot", "chat");

  assert.equal(dingding.accessToken, undefined);
});

test("dingding progress reuses pending card creation", async () => {
  let createCount = 0;
  const updates = [];
  let resolveCreate;
  const created = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
  });
  dingding.enabled = true;
  dingding.sendActionsCard = async () => {
    createCount += 1;
    await created;
    return "track-1";
  };
  dingding.updateActionsCard = async (_track, text) => {
    updates.push(text);
  };

  dingding.updateProgress("k1", "first", {});
  dingding.updateProgress("k1", "second", {});
  assert.equal(createCount, 1);
  resolveCreate();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createCount, 1);
  assert.deepEqual(updates, ["second"]);
});

test("dingding progress retries after initial card creation failure", async () => {
  let createCount = 0;
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
  });
  dingding.enabled = true;
  dingding.sendActionsCard = async () => {
    createCount += 1;
    if (createCount === 1) {
      throw new Error("temporary failure");
    }
    return "track-2";
  };

  dingding.updateProgress("k2", "first", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  dingding.updateProgress("k2", "second", {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createCount, 2);
  assert.equal(dingding.progressCards.get("k2").outTrackId, "track-2");
});

test("dingding action cards fall back to markdown when card target is incomplete", async () => {
  const sent = [];
  const dingding = new DingdingBridge({
    onText: () => {},
    onLog: () => {},
  });
  dingding.sendMarkdownByWebhook = async (_webhook, text) => {
    sent.push(text);
  };

  await dingding.sendMessage(
    "选择会话",
    { reply_markup: { inline_keyboard: [[{ text: "c1", callback_data: "task_handoff:conversation:1" }]] } },
    { target: { sessionWebhook: "https://example.test/webhook" } },
  );

  assert.deepEqual(sent, ["选择会话"]);
});

test("receiver command helpers suggest and complete commands", () => {
  const suggestions = getCommandSuggestions("/telegram s");
  assert.deepEqual(suggestions.map((command) => command.value), ["/telegram status"]);

  const argumentCommand = getArgumentEntryCommand("/telegram bind token");
  assert.equal(argumentCommand.value, "/telegram bind <token> [chat]");
  assert.equal(hasCommandArguments("/telegram bind token", argumentCommand), true);
  assert.equal(shouldCompleteCommand("/telegram sta", suggestions[0]), true);
  assert.equal(getCommandSuggestions("/conversation delete 2")[0].value, "/conversation delete [id]");
  assert.equal(getArgumentEntryCommand("/conversation cwd 2 /tmp").value, "/conversation cwd [id] <path>");
  assert.equal(getCommandSuggestions("/rest")[0].value, "/restart");

  const window = getSuggestionWindow(getCommandSuggestions("/"), 3);
  assert.equal(window.start, 0);
  assert.equal(window.items.length, 6);
});

test("receiver conversation helpers normalize stored state", () => {
  assert.equal(parseConversationId("3"), 3);
  assert.equal(parseConversationId("0"), undefined);
  assert.equal(parseConversationMode("codex"), "codex");
  assert.equal(parseConversationMode("claude"), "claude");
  assert.equal(parseConversationAgent("codex"), "codex");
  assert.equal(parseConversationAgent("claude"), "claude");

  const conversation = createPassiveConversation(9, "closed");
  assert.equal(conversation.id, 9);
  assert.equal(conversation.status, "closed");
  const codexConversation = createConversation(10, "codex");
  assert.equal(codexConversation.mode, "codex");
  assert.equal(codexConversation.agent, "codex");
  const claudeConversation = createConversation(11, "claude");
  assert.equal(claudeConversation.mode, "claude");
  assert.equal(claudeConversation.agent, "claude");

  const normalized = normalizeConversations({
    defaultConversationId: 4,
    nextConversationId: 2,
    conversations: [
      { id: "bad" },
      { id: 4, mode: "passive", status: "closed", createdAt: "a", updatedAt: "b" },
      { id: 5, mode: "codex", status: "open", createdAt: "a", updatedAt: "b", cwd: "/repo", timeoutMs: 12345, aiSessionId: "ais-a", codexSessionId: "codex-a" },
      { id: 6, mode: "claude", status: "open", createdAt: "a", updatedAt: "b" },
    ],
  });
  assert.equal(normalized.defaultConversationId, 4);
  assert.equal(normalized.conversations.some((entry) => entry.id === 4 && entry.status === "closed"), true);
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).mode, "codex");
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).agent, "codex");
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).aiSessionId, "ais-a");
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).agentSessionId, "codex-a");
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).cwd, "/repo");
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).timeoutMs, 12345);
  assert.equal(normalized.conversations.find((entry) => entry.id === 5).codexSessionId, "codex-a");
  assert.equal(normalized.conversations.find((entry) => entry.id === 6).mode, "claude");
  assert.equal(normalized.conversations.find((entry) => entry.id === 6).agent, "claude");
  assert.equal(normalized.nextConversationId >= 5, true);
});

test("receiver conversation actions reset stale active sessions", () => {
  const codexConversation = {
    id: 1,
    mode: "codex",
    agent: "codex",
    cwd: "/repo-a",
    aiSessionId: "ais-a",
    agentSessionId: "codex-a",
    codexSessionId: "codex-a",
  };
  assert.equal(conversationAgent(codexConversation), "codex");
  assert.equal(conversationAiSessionId(codexConversation), "ais-a");
  assert.equal(conversationAgentSessionId(codexConversation), "codex-a");
  const moved = conversationWithCwd(codexConversation, "/repo-b", "now", "/");
  assert.equal(moved.cwd, "/repo-b");
  assert.equal(moved.aiSessionId, undefined);
  assert.equal(moved.agentSessionId, undefined);
  assert.equal(moved.codexSessionId, undefined);

  const claudeMode = conversationWithMode(codexConversation, "claude", "later");
  assert.equal(claudeMode.agent, "claude");
  assert.equal(claudeMode.aiSessionId, undefined);
  assert.equal(claudeMode.agentSessionId, undefined);
  assert.equal(claudeMode.codexSessionId, undefined);
});

test("receiver conversation actions can start a fresh active session", () => {
  const reset = conversationWithNewAgentSession(
    {
      id: 2,
      mode: "codex",
      agent: "codex",
      aiSessionId: "ais-active",
      agentSessionId: "agent-session",
      codexSessionId: "codex-session",
    },
    "2026-06-20T00:00:00.000Z",
  );

  assert.equal(reset.agent, "codex");
  assert.equal(reset.aiSessionId, undefined);
  assert.equal(reset.agentSessionId, undefined);
  assert.equal(reset.codexSessionId, undefined);
  assert.equal(reset.updatedAt, "2026-06-20T00:00:00.000Z");
});

test("receiver conversation actions can bind ai sessions as the primary session identity", () => {
  const bound = conversationWithAiSession(
    {
      id: 3,
      mode: "passive",
      cwd: "/old",
    },
    {
      id: "ais-bound",
      agent: "claude",
      providerSessionId: "claude-provider",
      cwd: "/repo",
    },
    "2026-06-20T00:00:00.000Z",
  );

  assert.equal(bound.mode, "claude");
  assert.equal(bound.agent, "claude");
  assert.equal(bound.aiSessionId, "ais-bound");
  assert.equal(bound.agentSessionId, "claude-provider");
  assert.equal(bound.codexSessionId, undefined);
  assert.equal(bound.cwd, "/repo");
  assert.equal(bound.updatedAt, "2026-06-20T00:00:00.000Z");
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
  assert.equal(synced.turns[0].status, "completed");
  assert.equal(synced.turns[0].revision, 1);
  assert.equal(synced.turns[0].userPrompt, "Implement the app-server sourced receiver");
  assert.equal(synced.turns[0].summary, "Working from app-server turns");
  assert.equal(synced.turns[0].lastMessage, "Working from app-server turns");

  fake.emit("event", {
    type: "thread-status",
    threadId: "thread_1",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  const waiting = registry.list()[0];
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.phase, "approval");

  fake.emit("event", { type: "turn-completed", threadId: "thread_1", status: "completed" });
  assert.equal(registry.list()[0].status, "idle");

  fake.emit("event", { type: "thread-closed", threadId: "thread_1" });
  assert.equal(registry.list()[0].status, "idle");
  bridge.stop();
  assert.equal(fake.stopped, true);
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
      return { id: "thread_approval", cwd: "/workspace", status: { type: "active", activeFlags: [] }, turns: [] };
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

  const approved = await bridge.resolveApproval(waiting, "allow");
  assert.equal(approved.action, "approval");
  assert.equal(approved.decision, "allow");
  assert.deepEqual(fake.approvals.map((entry) => [entry.request.id, entry.decision]), [[42, "allow"]]);
  assert.deepEqual(fake.startedTurns, []);
  assert.equal(registry.get(waiting.id).summary, "Codex approval allowed.");
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
        turns: [],
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
        turns: [],
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
  assert.equal(registry.get(waiting.id).summary, "Codex approval allowed.");
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

test("cwd picker navigates and confirms directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-cwd-picker-"));
  fs.mkdirSync(path.join(root, "child"));
  const store = new Map();
  const picker = createCwdPicker(store, 7, root);
  assert.match(picker.text, /设置 c7 工作目录/);
  assert.equal(picker.replyMarkup.inline_keyboard[0][0].text, "[dir] child");

  const opened = handleCwdPickerAction(store, { token: picker.token, action: "open", index: 0 }, () => {
    throw new Error("should not save while opening");
  });
  assert.match(opened.text, /child/);

  let saved;
  const confirmed = handleCwdPickerAction(store, { token: picker.token, action: "confirm" }, (conversationId, cwd) => {
    saved = { conversationId, cwd };
    return { ok: true, message: cwd };
  });
  assert.equal(confirmed.message, "saved");
  assert.deepEqual(saved, { conversationId: 7, cwd: path.join(root, "child") });
  assert.equal(store.has(picker.token), false);
});

test("cwd picker paginates large directory lists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-cwd-picker-pages-"));
  for (let index = 0; index < CWD_PICKER_PAGE_SIZE + 3; index += 1) {
    fs.mkdirSync(path.join(root, `d${String(index).padStart(2, "0")}`));
  }
  const store = new Map();
  const picker = createCwdPicker(store, 8, root);
  assert.equal(picker.replyMarkup.inline_keyboard.some((row) => row.some((button) => button.callback_data.includes(":next"))), true);
  assert.match(picker.text, /第 1\/2 页/);
  assert.equal(store.get(picker.token).entries[0], "d00");
  assert.equal(store.get(picker.token).entries.at(-1), "d11");

  const nextPage = handleCwdPickerAction(store, { token: picker.token, action: "next" }, () => {
    throw new Error("should not save while paging");
  });
  assert.match(nextPage.text, /第 2\/2 页/);
  assert.equal(store.get(picker.token).entries[0], "d12");
  assert.equal(store.get(picker.token).entries.at(-1), "d14");

  const opened = handleCwdPickerAction(store, { token: picker.token, action: "open", index: 0 }, () => {
    throw new Error("should not save while opening");
  });
  assert.match(opened.text, /d12/);
  assert.equal(store.get(picker.token).cwd, path.join(root, "d12"));
  assert.equal(store.get(picker.token).page, 0);
});

test("conversation cwd and delete default to the active terminal conversation", () => {
  const logs = [];
  const cwdCalls = [];
  const deleted = [];
  const conversationsRef = { current: [createPassiveConversation(1), createPassiveConversation(3)] };
  const activeConversationIdRef = { current: 3 };
  const handlers = createReceiverCommandHandlers({
    addLog: (message) => logs.push(message),
    activeConversationIdRef,
    defaultConversationIdRef: { current: 1 },
    telegramConversationIdRef: { current: 1 },
    wechatConversationIdRef: { current: 1 },
    conversationsRef,
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: { current: normalizeChatToolState({}) },
    findConversation: (id) => conversationsRef.current.find((conversation) => conversation.id === id),
    createNextConversation: () => createPassiveConversation(4),
    setActiveConversationId: (id) => {
      activeConversationIdRef.current = id;
    },
    setDefaultConversationId: () => {},
    ensureConversation: (id) => createPassiveConversation(id),
    syncConversations: (conversations) => {
      conversationsRef.current = conversations;
    },
    persistConversations: () => {},
    setConversationCwd: (id, cwdValue) => {
      cwdCalls.push({ id, cwdValue });
      return { ok: true, message: `cwd ${id} ${cwdValue}` };
    },
    deleteConversation: (id) => {
      deleted.push(id);
      return true;
    },
    syncTelegram: () => {},
    syncWechat: () => {},
  });

  handlers.handleConversationCommand("cwd /tmp/project");
  handlers.handleConversationCommand("delete");

  assert.deepEqual(cwdCalls, [{ id: 3, cwdValue: "/tmp/project" }]);
  assert.deepEqual(deleted, [3]);
  assert.match(logs[0], /cwd 3/);
});

test("timeout command persists timeout on the active conversation", () => {
  const logs = [];
  const timeouts = new Map();
  const activeConversationIdRef = { current: 3 };
  const router = createReceiverTerminalCommandRouter({
    activeConversationIdRef,
    addLog: (message) => logs.push(message),
    chatBridgesRef: { current: { get: () => undefined } },
    defaultConversationIdRef: { current: 1 },
    defaultTimeoutMsRef: { current: 60 * 60 * 1000 },
    findPendingById: () => undefined,
    focusedIdRef: { current: undefined },
    handleChatCommand: () => {},
    handleConversationCommand: () => {},
    handleTelegramCommand: () => {},
    handleWechatCommand: () => {},
    handleDingdingCommand: () => {},
    cancelActiveConversation: () => false,
    resetConversationSession: () => ({ ok: false, message: "not used" }),
    formatSessionHistory: () => "not used",
    getConversationTimeoutMs: (conversationId) => timeouts.get(conversationId) || 60 * 60 * 1000,
    pendingRef: { current: [] },
    queuedRepliesRef: { current: [] },
    resultHistoryRef: { current: createResultHistoryStore() },
    replyApproval: () => {},
    replyDefault: () => {},
    replyToItem: () => {},
    restartSelf: () => {},
    setDefaultTimeoutMs: () => {},
    setFocusedId: () => {},
    setConversationTimeoutMs: (conversationId, timeoutMs) => {
      if (timeoutMs) {
        timeouts.set(conversationId, timeoutMs);
      } else {
        timeouts.delete(conversationId);
      }
    },
    setTimeoutTarget: () => {},
    stopAll: () => {},
    telegramConversationIdRef: { current: 1 },
    timeoutTargetRef: { current: undefined },
    wechatConversationIdRef: { current: 1 },
    dingdingConversationIdRef: { current: 1 },
  });

  router("/timeout 10s");
  assert.equal(timeouts.get(3), 10000);
  assert.match(logs.at(-1), /conversation 3 timeout set/);

  router("/timeout reset");
  assert.equal(timeouts.has(3), false);
  assert.match(logs.at(-1), /conversation 3 timeout reset/);

  router("/timeout 20s", { conversationId: 7 });
  assert.equal(timeouts.get(7), 20000);
  assert.equal(timeouts.has(3), false);
  assert.match(logs.at(-1), /conversation 7 timeout set/);
});

test("cancel command targets the active or contextual conversation", () => {
  const cancelled = [];
  const logs = [];
  const router = createReceiverTerminalCommandRouter({
    activeConversationIdRef: { current: 3 },
    addLog: (message) => logs.push(message),
    chatBridgesRef: { current: { get: () => undefined } },
    defaultConversationIdRef: { current: 1 },
    defaultTimeoutMsRef: { current: 60 * 60 * 1000 },
    findPendingById: () => undefined,
    focusedIdRef: { current: undefined },
    handleChatCommand: () => {},
    handleConversationCommand: () => {},
    handleTelegramCommand: () => {},
    handleWechatCommand: () => {},
    handleDingdingCommand: () => {},
    cancelActiveConversation: (conversationId) => {
      cancelled.push(conversationId);
      return true;
    },
    resetConversationSession: () => ({ ok: false, message: "not used" }),
    formatSessionHistory: () => "not used",
    getConversationTimeoutMs: () => 60 * 60 * 1000,
    pendingRef: { current: [] },
    queuedRepliesRef: { current: [] },
    resultHistoryRef: { current: createResultHistoryStore() },
    replyApproval: () => {},
    replyDefault: () => {},
    replyToItem: () => {},
    restartSelf: () => {},
    setDefaultTimeoutMs: () => {},
    setFocusedId: () => {},
    setConversationTimeoutMs: () => {},
    setTimeoutTarget: () => {},
    stopAll: () => {},
    telegramConversationIdRef: { current: 1 },
    timeoutTargetRef: { current: undefined },
    wechatConversationIdRef: { current: 1 },
    dingdingConversationIdRef: { current: 1 },
  });

  router("/cancel");
  router("/cancel", { conversationId: 7 });
  router("/cancel 9");

  assert.deepEqual(cancelled, [3, 7, 9]);
  assert.match(logs.at(-1), /active conversation 9/);
});

test("session new command targets active, contextual, or explicit conversations", () => {
  const reset = [];
  const logs = [];
  const router = createReceiverTerminalCommandRouter({
    activeConversationIdRef: { current: 3 },
    addLog: (message) => logs.push(message),
    chatBridgesRef: { current: { get: () => undefined } },
    defaultConversationIdRef: { current: 1 },
    defaultTimeoutMsRef: { current: 60 * 60 * 1000 },
    findPendingById: () => undefined,
    focusedIdRef: { current: undefined },
    handleChatCommand: () => {},
    handleConversationCommand: () => {},
    handleTelegramCommand: () => {},
    handleWechatCommand: () => {},
    handleDingdingCommand: () => {},
    cancelActiveConversation: () => false,
    resetConversationSession: (conversationId) => {
      reset.push(conversationId);
      return { ok: true, message: `reset c${conversationId}` };
    },
    formatSessionHistory: (conversationId, agent) => `sessions c${conversationId} ${agent || "all"}`,
    getConversationTimeoutMs: () => 60 * 60 * 1000,
    pendingRef: { current: [] },
    queuedRepliesRef: { current: [] },
    resultHistoryRef: { current: createResultHistoryStore() },
    replyApproval: () => {},
    replyDefault: () => {},
    replyToItem: () => {},
    restartSelf: () => {},
    setDefaultTimeoutMs: () => {},
    setFocusedId: () => {},
    setConversationTimeoutMs: () => {},
    setTimeoutTarget: () => {},
    stopAll: () => {},
    telegramConversationIdRef: { current: 1 },
    timeoutTargetRef: { current: undefined },
    wechatConversationIdRef: { current: 1 },
    dingdingConversationIdRef: { current: 1 },
  });

  router("/session new");
  router("/session new", { conversationId: 7 });
  router("/session new 9");
  router("/session");
  router("/session codex", { conversationId: 8 });

  assert.deepEqual(reset, [3, 7, 9]);
  assert.match(logs.at(-3), /reset c9/);
  assert.match(logs.at(-2), /sessions c3 all/);
  assert.match(logs.at(-1), /sessions c8 codex/);
});

test("mcp sender has a long local fallback timeout", () => {
  assert.equal(MCP_SENDER_TIMEOUT_MS, 6 * 60 * 60 * 1000);
});

test("active codex conversation command uses codex exec", () => {
  assert.equal(normalizeConversationMode("codex"), "codex");
  assert.equal(normalizeConversationMode("claude"), "claude");
  const command = activeAgentCommand({
    mode: "codex",
    cwd: "/repo",
    outputPath: "/tmp/last-message.txt",
    env: { TASK_HANDOFF_CODEX_COMMAND: "/bin/codex" },
  });
  assert.equal(command.command, "/bin/codex");
  assert.deepEqual(command.args, ["exec", "--json", "--cd", "/repo", "-o", "/tmp/last-message.txt", "-"]);
  assert.equal(command.args.includes("--full-auto"), false);
  assert.equal(command.args.includes("--dangerously-skip-permissions"), false);
  const resumeCommand = activeAgentCommand({
    mode: "codex",
    cwd: "/repo",
    outputPath: "/tmp/last-message.txt",
    sessionId: "codex-a",
    env: { TASK_HANDOFF_CODEX_COMMAND: "/bin/codex" },
  });
  assert.deepEqual(resumeCommand.args, ["exec", "resume", "--json", "-o", "/tmp/last-message.txt", "codex-a", "-"]);
  assert.equal(codexSessionId(JSON.stringify({ type: "session_meta", payload: { id: "codex-a" } })), "codex-a");
  assert.equal(codexSessionId(JSON.stringify({ type: "thread.started", thread_id: "thread-a" })), "thread-a");
  assert.equal(parseCodexFinalMessage(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } })), "done");
  assert.equal(parseCodexFinalMessage(JSON.stringify({ type: "result", result: "done result" })), "done result");
  assert.equal(summarizeCodexJsonLine(JSON.stringify({ type: "thread.started", thread_id: "thread-a" })), "Codex session thread-a started");
  assert.equal(summarizeCodexFailure(JSON.stringify({ type: "turn.failed", error: { message: "bad" } }), ""), "bad");
  assert.equal(
    lastCodexMessage(
      [
        JSON.stringify({ msg: { type: "agent_message", message: "first" } }),
        JSON.stringify({ msg: { type: "agent_message", message: "second" } }),
      ].join("\n"),
    ),
    "second",
  );
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

test("active claude conversation command uses print stream json", () => {
  const command = activeAgentCommand({
    mode: "claude",
    cwd: "/repo",
    outputPath: "/tmp/unused.txt",
    prompt: "hello claude",
    env: { TASK_HANDOFF_CLAUDE_COMMAND: "/bin/claude", TASK_HANDOFF_CLAUDE_MODEL: "sonnet-test" },
  });
  assert.equal(command.command, "/bin/claude");
  assert.equal(command.stdin, false);
  assert.equal(command.args[0], "--print");
  assert.deepEqual(command.args.slice(1, 5), ["--verbose", "--output-format", "stream-json", "--include-partial-messages"]);
  assert.equal(command.args.includes("--dangerously-skip-permissions"), false);
  assert.deepEqual(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2), ["--model", "sonnet-test"]);
  assert.equal(typeof command.sessionId, "string");
  assert.equal(command.args.at(-2), command.sessionId);
  assert.equal(command.args.at(-1), "hello claude");

  const permissiveCommand = activeAgentCommand({
    mode: "claude",
    cwd: "/repo",
    outputPath: "/tmp/unused.txt",
    prompt: "hello claude",
    env: { TASK_HANDOFF_CLAUDE_COMMAND: "/bin/claude", TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS: "1" },
  });
  assert.equal(permissiveCommand.args.includes("--dangerously-skip-permissions"), true);

  const resumeCommand = activeAgentCommand({
    mode: "claude",
    cwd: "/repo",
    outputPath: "/tmp/unused.txt",
    prompt: "resume claude",
    sessionId: "claude-a",
    env: { TASK_HANDOFF_CLAUDE_COMMAND: "/bin/claude" },
  });
  assert.deepEqual(resumeCommand.args.slice(-3), ["--resume", "claude-a", "resume claude"]);
  assert.equal(claudeSessionId(JSON.stringify({ type: "system", session_id: "claude-a" })), "claude-a");
  assert.equal(parseClaudeFinalMessage(JSON.stringify({ type: "result", result: "done result" })), "done result");
  assert.equal(summarizeClaudeJsonLine(JSON.stringify({ type: "system", session_id: "claude-a" })), "Claude session claude-a started");
  assert.equal(summarizeClaudeFailure(JSON.stringify({ type: "error", message: "bad" }), ""), "bad");
  assert.equal(summarizeClaudeFailure(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "last hint" }] } }), ""), "last hint");
});

test("chat tool state ignores top-level telegram and migrates wechat single chat bindings", () => {
  const state = normalizeChatToolState({
    telegram: { token: "tg-token", chatId: "111", conversationId: 2 },
    wechat: { token: "wx-token", baseUrl: "https://wx", chatId: "wx-user", contextToken: "ctx", conversationId: 3 },
  });

  assert.deepEqual(state.chatTools.telegram, {});
  assert.equal(state.chatTools.wechat.default.baseUrl, "https://wx");
  assert.equal(state.chatBindings.wechat.default["wx-user"].conversationId, 3);
  assert.equal(state.chatBindings.wechat.default["wx-user"].contextToken, "ctx");
});

test("chat tool state legacy migration is idempotent with existing tools", () => {
  const state = normalizeChatToolState({
    telegram: { token: "tg-token", chatId: "111", conversationId: 2 },
    wechat: { token: "wx-token", chatId: "wx-user", contextToken: "ctx", conversationId: 3 },
    chatTools: {
      telegram: { default: { token: "tg-token", enabled: true, defaultChatId: "111" } },
      wechat: { default: { token: "wx-token", enabled: true, defaultChatId: "wx-user" } },
    },
  });

  assert.deepEqual(Object.keys(state.chatTools.telegram), ["default"]);
  assert.deepEqual(Object.keys(state.chatTools.wechat), ["default"]);
  assert.equal(state.chatBindings.telegram.default, undefined);
  assert.equal(state.chatBindings.wechat.default["wx-user"].contextToken, "ctx");
});

test("chat tool state preserves configured telegram tools without top-level migration", () => {
  const state = normalizeChatToolState({
    telegram: { token: "legacy-token", chatId: "111", conversationId: 2 },
    chatTools: {
      telegram: { default: { token: "new-token", enabled: true, defaultChatId: "111" } },
    },
  });

  assert.deepEqual(Object.keys(state.chatTools.telegram), ["default"]);
  assert.equal(state.chatTools.telegram.default.token, "new-token");
  assert.equal(state.chatBindings.telegram.default, undefined);
});

test("chat tool state supports generated keys and one cid per chat", () => {
  const state = normalizeChatToolState({
    chatTools: { telegram: { "telegram-1": { token: "one" } } },
  });

  assert.equal(generateChatToolInstanceId(state, "telegram"), "telegram-2");
  bindChatToConversation(state, "telegram", "telegram-1", "111", 1);
  bindChatToConversation(state, "telegram", "telegram-1", "111", 4);

  assert.deepEqual(listChatBindings(state), [
    { channel: "telegram", instanceId: "telegram-1", chatId: "111", conversationId: 4 },
  ]);
});

test("chat tool state lists configured chat software instances", () => {
  const state = normalizeChatToolState({
    chatTools: {
      telegram: { default: { enabled: true, defaultChatId: "111" }, "telegram-2": { enabled: false } },
      wechat: { default: { enabled: true, defaultChatId: "wx-user" } },
    },
  });

  assert.deepEqual(listChatToolInstances(state), [
    { channel: "telegram", instanceId: "default", enabled: true, defaultChatId: "111" },
    { channel: "telegram", instanceId: "telegram-2", enabled: false, defaultChatId: undefined },
    { channel: "wechat", instanceId: "default", enabled: true, defaultChatId: "wx-user" },
  ]);
});

test("chat status command shows configured chat software instance counts", () => {
  const logs = [];
  const handlers = createReceiverCommandHandlers({
    addLog: (message) => logs.push(message),
    activeConversationIdRef: { current: 1 },
    defaultConversationIdRef: { current: 1 },
    telegramConversationIdRef: { current: 1 },
    wechatConversationIdRef: { current: 1 },
    dingdingConversationIdRef: { current: 1 },
    conversationsRef: { current: [createPassiveConversation(1)] },
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: {
      current: normalizeChatToolState({
        chatTools: {
          telegram: { default: { enabled: true, defaultChatId: "111" }, "telegram-2": {} },
          wechat: { default: { enabled: true, defaultChatId: "wx-user" } },
        },
      }),
    },
    findConversation: () => undefined,
    createNextConversation: () => createPassiveConversation(2),
    setActiveConversationId: () => {},
    setDefaultConversationId: () => {},
    ensureConversation: () => createPassiveConversation(1),
    syncConversations: () => {},
    persistConversations: () => {},
    setConversationCwd: () => ({ ok: true, message: "ok" }),
    deleteConversation: () => true,
    syncTelegram: () => {},
    syncWechat: () => {},
    syncDingding: () => {},
  });

  handlers.handleChatCommand("status");

  assert.match(logs[0], /telegram=2 on=1/);
  assert.match(logs[0], /wechat=1 on=1/);
  assert.match(logs[0], /dingding=0/);
  assert.match(logs[0], /telegram:default on defaultChat=111/);
});

test("chat conversation new binds the current chat to the created conversation", () => {
  const state = normalizeChatToolState({
    chatTools: { telegram: { default: { token: "token" } } },
  });
  const conversations = [createPassiveConversation(1)];
  let nextConversationId = 2;
  const sent = [];
  const logs = [];

  const router = createReceiverChatRouter({
    addLog: (message) => logs.push(message),
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: { current: state },
    commandCaptureRef: { current: undefined },
    createNextConversation: (mode = "passive") => {
      const conversation = createConversation(nextConversationId, parseConversationMode(mode) || "passive");
      nextConversationId += 1;
      conversations.push(conversation);
      return conversation;
    },
    createCwdPicker: () => ({ text: "", replyMarkup: {} }),
    deleteConversation: () => true,
    ensureConversation: (conversationId) => {
      const existing = conversations.find((conversation) => conversation.id === conversationId);
      if (existing) {
        return existing;
      }
      const conversation = createPassiveConversation(conversationId);
      conversations.push(conversation);
      return conversation;
    },
    findConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId),
    listConversations: () => conversations,
    handleCommand: () => {},
    replyDefault: () => undefined,
    resultHistoryRef: { current: createResultHistoryStore() },
    setConversationCwd: () => ({ ok: true, message: "" }),
  });

  const handled = router.handleChatConversationCommand({
    channel: "telegram",
    instanceId: "default",
    chatId: "111",
    text: "/conversation new codex",
    send: (message) => sent.push(message),
    fallbackConversationId: 1,
  });

  assert.equal(handled, true);
  assert.equal(conversations[1].id, 2);
  assert.equal(conversations[1].mode, "codex");
  assert.equal(state.chatBindings.telegram.default["111"].conversationId, 2);
  assert.match(sent[0], /已创建会话 c2/);
  assert.equal(logs.some((message) => message.includes("telegram:default:111 bound to c2")), true);
});

test("chat conversation command shows picker and action binds selected conversation", async () => {
  const state = normalizeChatToolState({
    chatTools: { telegram: { default: { token: "token" } } },
  });
  bindChatToConversation(state, "telegram", "default", "111", 1);
  const conversations = [createPassiveConversation(1), createConversation(2, "codex")];
  const sent = [];
  const logs = [];
  const resultHistory = createResultHistoryStore();
  addResultHistoryEntry(resultHistory, {
    conversationId: 2,
    source: "codex",
    kind: "active",
    result: "latest c2 result",
    createdAt: "2026-05-26T00:00:00.000Z",
  });

  const router = createReceiverChatRouter({
    addLog: (message) => logs.push(message),
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: { current: state },
    commandCaptureRef: { current: undefined },
    createNextConversation: () => createPassiveConversation(3),
    createCwdPicker: () => ({ text: "", replyMarkup: {} }),
    deleteConversation: () => true,
    ensureConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId) || createPassiveConversation(conversationId),
    findConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId),
    listConversations: () => conversations,
    handleCommand: () => {},
    replyDefault: () => undefined,
    resultHistoryRef: { current: resultHistory },
    setConversationCwd: () => ({ ok: true, message: "" }),
  });

  const handled = router.handleChatConversationCommand({
    channel: "telegram",
    instanceId: "default",
    chatId: "111",
    text: "conversation",
    send: (message, extra) => sent.push({ message, extra }),
    fallbackConversationId: 1,
  });

  assert.equal(handled, true);
  assert.match(sent[0].message, /选择会话/);
  assert.match(sent[0].message, /当前 c1，共 2 个/);
  assert.match(sent[0].message, /\* c1 · 被动 · 当前/);
  assert.match(sent[0].message, /c2 · Codex/);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].text, "✓ c1 · 被动");
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[1][0].text, "c2 · Codex");
  assert.deepEqual(sent[0].extra.reply_markup.inline_keyboard.map((row) => row[0].callback_data), [
    "task_handoff:conversation:1",
    "task_handoff:conversation:2",
  ]);

  const result = router.handleChatConversationAction({
    channel: "telegram",
    instanceId: "default",
    chatId: "111",
    conversationId: 2,
    fallbackConversationId: 1,
  });

  assert.equal(result.found, true);
  assert.equal(state.chatBindings.telegram.default["111"].conversationId, 2);
  assert.match(result.text, /已将当前聊天绑定到会话 c2/);
  assert.match(result.text, /最近完成任务/);
  assert.match(result.text, /latest c2 result/);
  assert.match(result.text, /选择会话/);
  assert.equal(logs.some((message) => message.includes("telegram:default:111 bound to c2")), true);
});

test("chat session command shows cwd history picker and selects a session", () => {
  const state = normalizeChatToolState({
    chatTools: { telegram: { default: { token: "token" } } },
  });
  bindChatToConversation(state, "telegram", "default", "111", 1);
  const conversations = [{ ...createPassiveConversation(1), cwd: "/repo" }];
  const sent = [];
  const selected = [];
  const sessions = [
    {
      agent: "codex",
      sessionId: "11111111-1111-1111-1111-111111111111",
      cwd: "/repo",
      updatedAt: "2026-06-20T00:00:00.000Z",
      transcriptPath: "/tmp/codex.jsonl",
      title: "codex task",
    },
  ];

  const router = createReceiverChatRouter({
    addLog: () => {},
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: { current: state },
    commandCaptureRef: { current: undefined },
    createNextConversation: () => createPassiveConversation(2),
    createCwdPicker: () => ({ text: "", replyMarkup: {} }),
    deleteConversation: () => true,
    ensureConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId) || createPassiveConversation(conversationId),
    findConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId),
    listConversations: () => conversations,
    listHistoricalSessionsForCwd: (options) => {
      assert.equal(options.cwd, "/repo");
      return sessions.filter((session) => !options.agent || session.agent === options.agent);
    },
    handleCommand: () => {},
    replyDefault: () => undefined,
    resultHistoryRef: { current: createResultHistoryStore() },
    selectHistoricalSession: (conversationId, session) => {
      selected.push([conversationId, session.agent, session.sessionId]);
      return { ok: true, message: `selected ${session.sessionId}` };
    },
    setConversationCwd: () => ({ ok: true, message: "" }),
  });

  const handled = router.handleChatConversationCommand({
    channel: "telegram",
    instanceId: "default",
    chatId: "111",
    text: "/session",
    send: (message, extra) => sent.push({ message, extra }),
    fallbackConversationId: 1,
  });

  assert.equal(handled, true);
  assert.match(sent[0].message, /选择 Codex\/Claude 历史 session/);
  assert.equal(
    sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data,
    "task_handoff:session:1:codex:i0",
  );
  assert.ok(Buffer.byteLength(sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data, "utf8") <= 64);

  const result = router.handleChatSessionAction({
    conversationId: 1,
    agent: "codex",
    sessionId: "i0",
  });

  assert.equal(result.found, true);
  assert.deepEqual(selected, [[1, "codex", "11111111-1111-1111-1111-111111111111"]]);

  const legacyResult = router.handleChatSessionAction({
    conversationId: 1,
    agent: "codex",
    sessionId: "11111111-1111-1111-1111-111111111111",
  });

  assert.equal(legacyResult.found, true);
  assert.deepEqual(selected.at(-1), [1, "codex", "11111111-1111-1111-1111-111111111111"]);
});

test("chat conversation use response includes latest completed task", () => {
  const state = normalizeChatToolState({
    chatTools: { telegram: { default: { token: "token" } } },
  });
  const conversations = [createPassiveConversation(1), createConversation(2, "codex")];
  const resultHistory = createResultHistoryStore();
  const sent = [];

  addResultHistoryEntry(resultHistory, {
    conversationId: 2,
    source: "cli",
    kind: "task",
    result: "done from c2",
    createdAt: "2026-05-26T00:00:00.000Z",
  });

  const router = createReceiverChatRouter({
    addLog: () => {},
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: { current: state },
    commandCaptureRef: { current: undefined },
    createNextConversation: () => createPassiveConversation(3),
    createCwdPicker: () => ({ text: "", replyMarkup: {} }),
    deleteConversation: () => true,
    ensureConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId) || createPassiveConversation(conversationId),
    findConversation: (conversationId) => conversations.find((conversation) => conversation.id === conversationId),
    listConversations: () => conversations,
    handleCommand: () => {},
    replyDefault: () => undefined,
    resultHistoryRef: { current: resultHistory },
    setConversationCwd: () => ({ ok: true, message: "" }),
  });

  const handled = router.handleChatConversationCommand({
    channel: "telegram",
    instanceId: "default",
    chatId: "111",
    text: "/conversation use 2",
    send: (message) => sent.push(message),
    fallbackConversationId: 1,
  });

  assert.equal(handled, true);
  assert.match(sent[0], /已将当前聊天绑定到会话 c2/);
  assert.match(sent[0], /最近完成任务/);
  assert.match(sent[0], /done from c2/);
});

test("result history stores latest in memory and builds navigation buttons", () => {
  const store = createResultHistoryStore();
  addResultHistoryEntry(store, {
    conversationId: 2,
    source: "cli",
    kind: "task",
    result: "first result",
    createdAt: "2026-05-26T00:00:00.000Z",
  });
  addResultHistoryEntry(store, {
    conversationId: 2,
    source: "codex",
    kind: "active",
    result: "second result",
    createdAt: "2026-05-26T00:01:00.000Z",
  });

  const latest = resultHistoryPayload(store, 2);
  assert.equal(latest.found, true);
  assert.match(latest.text, /历史结果 c2 2\/2/);
  assert.match(latest.text, /second result/);
  assert.deepEqual(latest.replyMarkup.inline_keyboard[0].map((button) => button.callback_data), [
    "task_handoff:history:2:0",
    "task_handoff:history:2:1",
    "task_handoff:history:2:1",
  ]);
});

test("chat history command uses the bound conversation history", () => {
  const state = normalizeChatToolState({
    chatTools: { telegram: { default: { token: "token" } } },
  });
  bindChatToConversation(state, "telegram", "default", "111", 4);
  const resultHistory = createResultHistoryStore();
  addResultHistoryEntry(resultHistory, {
    conversationId: 4,
    source: "claude",
    kind: "active",
    result: "bound history",
    createdAt: "2026-05-26T00:00:00.000Z",
  });
  const sent = [];

  const router = createReceiverChatRouter({
    addLog: () => {},
    chatBridgesRef: { current: { get: () => undefined } },
    chatToolStateRef: { current: state },
    commandCaptureRef: { current: undefined },
    createNextConversation: () => createPassiveConversation(2),
    createCwdPicker: () => ({ text: "", replyMarkup: {} }),
    deleteConversation: () => true,
    ensureConversation: (conversationId) => createPassiveConversation(conversationId),
    findConversation: (conversationId) => createPassiveConversation(conversationId),
    listConversations: () => [createPassiveConversation(1), createConversation(4, "claude")],
    handleCommand: () => {},
    replyDefault: () => undefined,
    resultHistoryRef: { current: resultHistory },
    setConversationCwd: () => ({ ok: true, message: "" }),
  });

  const handled = router.handleChatConversationCommand({
    channel: "telegram",
    instanceId: "default",
    chatId: "111",
    text: "/history",
    send: (message, extra) => sent.push({ message, extra }),
    fallbackConversationId: 1,
  });

  assert.equal(handled, true);
  assert.match(sent[0].message, /历史结果 c4 1\/1/);
  assert.match(sent[0].message, /bound history/);
  assert.equal(sent[0].extra, undefined);
});

test("conversation activity marks mcp and sender sessions active for 12 hours", () => {
  const now = Date.parse("2026-05-25T10:00:00.000Z");
  const activity = normalizeConversationActivity({
    conversationActivity: {
      1: { source: "mcp", ownerKeys: ["session:codexId:abc"], activatedAt: new Date(now - 1000).toISOString() },
      2: { source: "cli", activatedAt: new Date(now - CONVERSATION_ACTIVE_MS - 1000).toISOString() },
      4: { source: "mcp", ownerKeys: ["mcp:session:codexId:legacy"], activatedAt: new Date(now - 1000).toISOString() },
      bad: { source: "cli", activatedAt: "not a date" },
    },
  });

  assert.equal(isConversationActive(activity, 1, now), true);
  assert.equal(isConversationActive(activity, 2, now), false);
  assert.equal(isConversationActivityExpired(activity, 1, now), false);
  assert.equal(isConversationActivityExpired(activity, 2, now), true);
  assert.equal(isConversationActive(activity, 3, now), false);
  assert.equal(shouldAssignNewConversation(activity, 1, "session:codexId:abc", now), false);
  assert.equal(shouldAssignNewConversation(activity, 1, "session:codexId:def", now), true);
  assert.equal(shouldAssignNewConversation(activity, 4, "session:codexId:legacy", now), true);
  assert.equal(shouldAssignNewConversation(activity, 4, "mcp:session:codexId:legacy", now), false);

  markConversationActive(activity, 3, "mcp", ["session:codexId:def"], now);
  assert.equal(activity["3"].activatedAt, "2026-05-25T10:00:00.000Z");
  assert.deepEqual(activity["3"].ownerKeys, ["session:codexId:def"]);
  assert.equal(isConversationActive(activity, 3, now), true);

  markConversationActive(activity, 3, "mcp", ["session:claudeSessionId:claude-a"], now + 1);
  assert.deepEqual(activity["3"].ownerKeys, ["session:codexId:def", "session:claudeSessionId:claude-a"]);
});

test("conversation activity owner keys only use session binding identities", () => {
  assert.deepEqual(
    ownerKeysFromMessage({
      source: "mcp",
      sessionIds: { codexId: "codex-a", mcpThreadId: "codex-a", claudeSessionId: "claude-a" },
      cwd: "/repo",
    }),
    [
      "session:codexId:codex-a",
      "session:mcpThreadId:codex-a",
      "session:claudeSessionId:claude-a",
      "session:codex:codex-a",
    ],
  );
  assert.deepEqual(ownerKeysFromMessage({ source: "cli", sessionIds: { claudeSessionId: "claude-a" } }), [
    "session:claudeSessionId:claude-a",
  ]);
  assert.deepEqual(ownerKeysFromMessage({ source: "cli", cwd: "/repo" }), ["unknown:cli"]);
});

test("conversation bindings build and look up session identities only", () => {
  const message = {
    sessionIds: { codexId: "codex-a", claudeSessionId: "claude-a" },
    cwd: "/repo",
  };
  const patch = buildConversationBindingPatch(message, 9);
  const identities = identitiesFromMessage({ sessionIds: { codexSessionId: "codex-a" } });

  assert.equal(patch.conversationBindings.sessions["codex:codex-a"], "9");
  assert.equal(patch.conversationBindings.cwd, undefined);
  assert.equal(conversationIdForIdentities(patch, identities), 9);

  const sessionPatch = buildSessionConversationBindingPatch(message, 10);
  assert.equal(sessionPatch.conversationBindings.sessions["codex:codex-a"], "10");
  assert.equal(sessionPatch.conversationBindings.cwd, undefined);
  assert.equal(sessionPatch.conversationBindings.parentPids, undefined);
});

test("incoming result workflow normalizes task messages and pending items", () => {
  const socket = { write: () => undefined, end: () => undefined };
  const attachment = { id: "a1", kind: "file", path: "/tmp/report.txt", name: "report.txt" };
  const message = {
    type: "result",
    result: "  **ready**  ",
    conversationId: 4,
    source: "mcp",
    cwd: "/repo",
    sessionIds: { codexId: "codex-a" },
    attachments: [attachment],
  };
  const envelope = createIncomingResultEnvelope({
    message,
    conversationId: 4,
    visibleConversationIdsForApproval: () => {
      throw new Error("task messages should not fan out");
    },
    bindingConversationIdForApproval: () => {
      throw new Error("task messages should bind directly");
    },
  });

  assert.equal(envelope.source, "mcp");
  assert.equal(envelope.normalizedResult, "  **ready**  ");
  assert.equal(envelope.kind, "task");
  assert.deepEqual(envelope.visibleConversationIds, [4]);
  assert.equal(envelope.bindingConversationId, 4);
  assert.equal(envelope.isReadyResult, false);

  const item = createIncomingPendingItem({
    ...envelope,
    id: 11,
    conversationId: 4,
    socket,
    message,
    timeoutMs: 1234,
  });

  assert.equal(item.id, 11);
  assert.equal(item.conversationId, 4);
  assert.equal(item.socket, socket);
  assert.equal(item.result, "  **ready**  ");
  assert.equal(item.timeoutMs, 1234);
  assert.equal(item.codexId, "codex-a");
  assert.equal(item.cwd, "/repo");
  assert.deepEqual(item.attachments, [attachment]);
  assert.deepEqual(incomingDeliveryConversationIds(item), [4]);
});

test("incoming result workflow fans out approvals and persists session bindings", () => {
  const message = {
    type: "result",
    result: " READY ",
    kind: "approval",
    sessionIds: { codexId: "codex-a" },
    cwd: "/repo",
  };
  const envelope = createIncomingResultEnvelope({
    message,
    conversationId: 2,
    visibleConversationIdsForApproval: () => [2, 9],
    bindingConversationIdForApproval: (_message, fallbackConversationId, visibleConversationIds) => {
      assert.equal(fallbackConversationId, 2);
      assert.deepEqual(visibleConversationIds, [2, 9]);
      return 9;
    },
  });

  assert.equal(envelope.kind, "approval");
  assert.deepEqual(envelope.visibleConversationIds, [2, 9]);
  assert.equal(envelope.bindingConversationId, 9);
  assert.equal(envelope.isReadyResult, true);

  const item = createIncomingPendingItem({
    ...envelope,
    id: 12,
    conversationId: 2,
    socket: { write: () => undefined, end: () => undefined },
    message,
    timeoutMs: 5000,
  });
  assert.deepEqual(incomingDeliveryConversationIds(item), [2, 9]);

  const patch = incomingResultBindingPatch(message, envelope.kind, envelope.bindingConversationId, { 2: { source: "cli" } });
  assert.equal(patch.conversationBindings.sessions["codex:codex-a"], "9");
  assert.equal(patch.conversationBindings.cwd, undefined);
  assert.deepEqual(patch.conversationActivity, { 2: { source: "cli" } });
});

test("incoming result workflow formats timeout replies", () => {
  assert.equal(incomingTimeoutReply("cli"), waitingForTaskMessage("cli"));
  assert.equal(incomingTimeoutReply("mcp"), waitingForTaskMessage("mcp"));
  assert.match(incomingTimeoutReply("mcp", "继续实现测试"), /继续实现测试/);
  assert.match(incomingTimeoutReply("mcp", "继续实现测试"), /MCP 端继续调用 get_task/);
});

test("pending views preserve approval fanout conversations", () => {
  assert.deepEqual(
    toPendingView({
      id: 1,
      conversationId: 2,
      visibleConversationIds: [2, 7],
      result: "approval?",
      timeoutMs: 1000,
      source: "cli",
      kind: "approval",
    }),
    {
      id: 1,
      conversationId: 2,
      visibleConversationIds: [2, 7],
      result: "approval?",
      timeoutMs: 1000,
      source: "cli",
      kind: "approval",
    },
  );
});

test("conversation store delete removes bindings, chat bindings, and activity", () => {
  const deleted = deleteConversationState({
    settings: {
      conversationBindings: {
        sessions: { "codex:one": "2", "codex:two": "3" },
        cwd: { "/repo": "2" },
        parentPids: { 123: "2" },
      },
    },
    conversations: [{ id: 1 }, { id: 2 }, { id: 3 }],
    chatBindings: {
      telegram: { default: { 111: { conversationId: 2 }, 222: { conversationId: 3 } } },
      wechat: {},
    },
    conversationActivity: { 2: { activatedAt: "2026-05-25T10:00:00.000Z" } },
    conversationId: 2,
  });

  assert.deepEqual(deleted.conversations.map((conversation) => conversation.id), [1, 3]);
  assert.equal(deleted.chatBindings.telegram.default["111"], undefined);
  assert.equal(deleted.chatBindings.telegram.default["222"].conversationId, 3);
  assert.equal(deleted.patch.conversationBindings.sessions["codex:one"], undefined);
  assert.equal(deleted.patch.conversationActivity[2], undefined);
});

test("sender timeout messages distinguish cli and mcp sources", () => {
  assert.equal(waitingForTaskMessage("cli"), "任务即将下发，请继续执行命令行发送ready以等待新任务");
  assert.equal(
    waitingForTaskMessage("mcp"),
    "任务即将下发，请在 MCP 端继续调用 get_task 工具发送ready以等待新任务或者目标",
  );
});

async function captureSenderMessage(options) {
  const socketPath = path.join(os.tmpdir(), `th-${process.pid}-${Date.now().toString(36)}.sock`);
  let server;
  const messagePromise = new Promise((resolve, reject) => {
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        try {
          const message = JSON.parse(buffer.slice(0, newlineIndex));
          socket.write(encodeMessage({ type: "reply", value: "ok" }));
          socket.end();
          resolve(message);
        } catch (error) {
          reject(error);
        }
      });
    });
    server.once("error", reject);
    server.listen(socketPath, async () => {
      try {
        assert.equal(await waitForSenderReply({ result: "done", socketPath, ...options }), "ok");
      } catch (error) {
        reject(error);
      }
    });
  });

  try {
    return await messagePromise;
  } finally {
    await new Promise((resolve) => server?.close(resolve));
    fs.rmSync(socketPath, { force: true });
  }
}

test("sender only sends timeoutMs when timeout is explicitly overridden", async () => {
  const defaultMessage = await captureSenderMessage({ timeoutMs: 1, timeoutOverridden: false, source: "mcp" });
  assert.equal(defaultMessage.timeoutMs, undefined);

  const overriddenMessage = await captureSenderMessage({ timeoutMs: 123, timeoutOverridden: true, source: "mcp" });
  assert.equal(overriddenMessage.timeoutMs, 123);
});

test("sender does not send parentPid context", async () => {
  const mcpMessage = await captureSenderMessage({ source: "mcp", sessionIds: { codexId: "codex-a" } });
  assert.equal(mcpMessage.cwd, undefined);
  assert.equal(mcpMessage.parentPid, undefined);
  assert.deepEqual(mcpMessage.sessionIds.codexId, "codex-a");

  const cliMessage = await captureSenderMessage({ cwd: "/repo" });
  assert.equal(cliMessage.cwd, "/repo");
  assert.equal(cliMessage.parentPid, undefined);
});

test("approval hook defaults to a 12 hour deny timeout", async () => {
  assert.equal(APPROVAL_TIMEOUT_MS, 12 * 60 * 60 * 1000);
  assert.equal(APPROVAL_TIMEOUT_REPLY, "deny");
  assert.equal(
    await waitForSenderReply({
      result: "approval?",
      socketPath: "/tmp/task-handoff-missing-test.sock",
      timeoutMs: 1,
      timeoutOverridden: true,
      kind: "approval",
      timeoutReply: APPROVAL_TIMEOUT_REPLY,
    }),
    "deny",
  );
});

test("approval hook forwards binding session ids to receiver", () => {
  assert.deepEqual(
    sessionIdsForApprovalHook({
      codexId: "codex-a",
      claudeSessionId: "claude-a",
      terminalSessionId: "term-a",
    }),
    {
      codexId: "codex-a",
      codexSessionId: "codex-a",
      codexThreadId: "codex-a",
      claudeSessionId: "claude-a",
      terminalSessionId: "term-a",
    },
  );
});

test("approval hook skips unmatched conversation requests", () => {
  assert.equal(
    resolveApprovalConversation([
      ["option", undefined],
      ["bindings", undefined],
      ["hook_payload", undefined],
    ]),
    undefined,
  );
  assert.deepEqual(
    resolveApprovalConversation([
      ["option", undefined],
      ["bindings", 7],
      ["hook_payload", 9],
    ]),
    ["bindings", 7],
  );
});

test("codex mcp installer manages only the task-handoff server entry", () => {
  const original = {
    mcp_servers: {
      other: {
        command: "other-server",
      },
    },
  };
  const installed = installCodexMcpServer(original, {
    name: "task_handoff",
    command: "node",
    args: ["/tmp/task-handoff.js", "mcp"],
  });

  assert.equal(original.mcp_servers.task_handoff, undefined);
  assert.equal(installed.mcp_servers.other.command, "other-server");
  assert.equal(installed.mcp_servers.task_handoff.command, "node");
  assert.deepEqual(installed.mcp_servers.task_handoff.args, ["/tmp/task-handoff.js", "mcp"]);
  assert.equal(installed.mcp_servers.task_handoff.tool_timeout_sec, 86400);
  assert.equal(hasCodexMcpServer(installed, { name: "task_handoff" }).managed, true);

  const removed = removeCodexMcpServer(installed, { name: "task_handoff" });
  assert.equal(removed.mcp_servers.task_handoff, undefined);
  assert.equal(removed.mcp_servers.other.command, "other-server");
});

test("claude mcp installer writes mcpServers without touching other servers", () => {
  const original = {
    mcpServers: {
      other: {
        command: "other-server",
      },
    },
  };
  const installed = installClaudeMcpServer(original, {
    name: "task_handoff",
    command: "node",
    args: ["/tmp/task-handoff.js", "mcp"],
  });

  assert.equal(original.mcpServers.task_handoff, undefined);
  assert.equal(installed.mcpServers.other.command, "other-server");
  assert.equal(installed.mcpServers.task_handoff.type, "stdio");
  assert.deepEqual(installed.mcpServers.task_handoff.args, ["/tmp/task-handoff.js", "mcp"]);
  assert.equal(hasClaudeMcpServer(installed, { name: "task_handoff" }).managed, true);

  const removed = removeClaudeMcpServer(installed, { name: "task_handoff" });
  assert.equal(removed.mcpServers.task_handoff, undefined);
  assert.equal(removed.mcpServers.other.command, "other-server");
});

test("unified install target parsing supports explicit and detected targets", () => {
  assert.equal(parseComponent("mcp"), "mcp");
  assert.equal(parseComponent("hook"), "hook");
  assert.equal(parseTarget(undefined), "all");
  assert.equal(parseTarget("codex"), "codex");
  assert.deepEqual(resolveInstallTargets("codex"), ["codex"]);
  assert.deepEqual(resolveInstallTargets("claude"), ["claude"]);
  assert.equal(resolveInstallTargets("all", { codexHome: "/tmp/codex-home" }).includes("codex"), true);
  assert.equal(resolveInstallTargets("all", { claudeHome: "/tmp/claude-home" }).includes("claude"), true);
  assert.deepEqual(resolveInstallTargets("all", { codexHome: "/tmp/codex-home", claudeHome: "/tmp/claude-home" }), [
    "codex",
    "claude",
  ]);
  assert.throws(() => parseComponent("approval"), /mcp or hook/);
  assert.throws(() => parseTarget("vscode"), /codex, claude, or all/);
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

    const catalog = await app.inject({ method: "GET", url: "/api/apps/catalog" });
    assert.equal(catalog.statusCode, 200);
    const catalogItems = JSON.parse(catalog.payload).data;
    assert.equal(catalogItems.some((entry) => entry.id === "terminal-tty"), true);
    const codexApp = catalogItems.find((entry) => entry.id === "codex");
    assert.equal(codexApp.command, process.env.TASK_HANDOFF_CODEX_COMMAND || "codex");
    assert.deepEqual(codexApp.args, ["--model", "gpt-codex-test"]);
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
	    sharedCodexAppServerInfo: () => undefined,
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

    const turns = await app.inject({ method: "GET", url: "/api/ai-sessions/ais_existing/turns" });
    assert.equal(turns.statusCode, 200);
    assert.deepEqual(JSON.parse(turns.payload).data.turns.map((turn) => turn.id), ["turn_existing"]);
    assert.equal(fs.readdirSync(aiSessionDir).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("web app events websocket sends stream handshake without an unconditional snapshot", async (t) => {
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
  const firstMessages = withTimeout(webSocketMessageFrames(socket, 1), "initial events");

  await withTimeout(waitForWebSocketOpen(socket), "controlled instance events websocket open");
  const [helloFrame] = await firstMessages;
  const hello = JSON.parse(helloFrame.message);
  assert.equal(hello.type, "streams.hello");
  assert.deepEqual(hello.payload.streams.map((stream) => stream.topic).sort(), ["ai.sessions", "app.sessions"]);
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
    sharedCodexAppServerInfo: () => undefined,
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
    registry.start({ agent: "codex", appSessionId, providerSessionId: "provider_immediate", status: "idle" });
    const providerState = await waitForCondition(async () => {
      const state = JSON.parse((await app.inject({ method: "GET", url: "/api/ai-sessions/state" })).payload).data;
      return state.revision > initial.revision ? state : undefined;
    }, "provider event projection", 500);
    assert.ok(Date.now() - providerStartedAt < 500);
    assert.equal(providerState.snapshot.sessions.some((session) => session.providerSessionId === "provider_immediate"), true);

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

test("app runtime launches claude through background worker and attaches by short id", () => {
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

    const session = runtime.start("claude", { cwd: root });

    assert.equal(session.appId, "claude");
    assert.equal(session.tty.mode, "claude-attach");
    assert.equal(session.ai.agent, "claude");
    assert.equal(session.ai.claude.short, "ac8eaf94");
    assert.equal(spawned[0].shell, fakeClaude);
    assert.deepEqual(spawned[0].args, ["attach", "ac8eaf94"]);
    const bgCall = fs.readFileSync(callsPath, "utf8").trim();
    assert.equal(bgCall, "--bg --dangerously-skip-permissions --model sonnet-test");
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

  const session = runtime.acquireSharedCodexAppServer("codex", root, process.env, "app_test");
  try {
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, "codex");
    assert.equal(spawned[0].args[0], "app-server");
    assert.equal(spawned[0].args[1], "--listen");
    assert.equal(spawned[0].args[2], `unix://${session.socketPath}`);
    assert.equal(session.socketPath.startsWith(path.join(paths.runtimeDir, "codex-app-server")), false);
    const socketRoot = process.platform === "darwin" ? "/private/tmp" : fs.realpathSync(os.tmpdir());
    assert.equal(session.socketPath.startsWith(`${socketRoot}/task-handoff-codex-`), true);
    assert.ok(session.socketPath.length < 100);
  } finally {
    runtime.releaseSharedCodexAppServer("app_test");
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

  const first = runtime.ensureSharedCodexAppServer();
  const second = runtime.ensureSharedCodexAppServer();
  try {
    assert.equal(spawned.length, 1);
    assert.equal(second.socketPath, first.socketPath);
    assert.equal(runtime.sharedCodexAppServerInfo().socketPath, first.socketPath);
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
    });
  });

  await new Promise((resolve, reject) => {
    unixServer.once("error", reject);
    unixServer.listen(upstreamSocketPath, resolve);
  });

  const proxy = runtime._createCodexAppServerConnectionProxyForTest(upstreamSocketPath, (threadId) => boundThreads.push(threadId));
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
    assert.deepEqual(boundThreads, ["thread_from_proxy"]);
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
