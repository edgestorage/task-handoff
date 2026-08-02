const assert = require("node:assert/strict");
const test = require("node:test");

const { registerChatGatewayRoutes } = require("../packages/control-plane/src/control-plane/http/chat-gateway-routes.ts");
const { ControlPlaneChatGatewayRuntime } = require("../packages/control-plane/src/control-plane/chat/gateway/runtime.ts");
const { TelegramAiSessionCallbacks } = require("../packages/control-plane/src/control-plane/chat/gateway/telegram-ai-session-callbacks.ts");
const { TelegramMessageAggregator } = require("../packages/control-plane/src/control-plane/chat/gateway/telegram-message-aggregator.ts");

const bridge = { id: "bridge_a", channel: "telegram", enabled: true };

test("stopping a bridge discards its pending Telegram aggregate", async () => {
  const dispatched = [];
  const aggregator = new TelegramMessageAggregator({
    requireBridge: () => bridge,
    send: async () => ({}),
    answerCallback: async () => ({}),
    dispatch: async (...args) => { dispatched.push(args); },
    delayMs: 5,
  });

  await aggregator.handleIncoming(bridge, "chat_a", "user_a", "hello");
  aggregator.stopBridge(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 0);
});

test("Telegram aggregate timer reports flush failures instead of rejecting unhandled", async () => {
  const errors = [];
  const aggregator = new TelegramMessageAggregator({
    requireBridge: () => { throw new Error("bridge deleted"); },
    send: async () => ({}),
    answerCallback: async () => ({}),
    dispatch: async () => ({}),
    onError: (bridgeId, error) => errors.push([bridgeId, error.message]),
    delayMs: 5,
  });

  await aggregator.handleIncoming(bridge, "chat_a", "user_a", "hello");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(errors, [[bridge.id, "bridge deleted"]]);
});

test("Telegram AI callback tokens expire and can be cleared on shutdown", async () => {
  let now = 100;
  let interrupts = 0;
  const answers = [];
  const callbacks = new TelegramAiSessionCallbacks({
    interrupt: async () => { interrupts += 1; },
    queue: async () => ({ items: [] }),
    steer: async () => ({}),
    remove: async () => ({}),
    actionAllowed: () => true,
    answer: async (_bridge, _callbackQueryId, text) => { answers.push(text); },
    send: async () => ({}),
    deleteMessage: async () => ({}),
    setBridgeError: () => {},
    info: () => {},
    warn: () => {},
    tokenTtlMs: 10,
    now: () => now,
  });
  const context = { bridge, chatId: "chat_a", callbackQueryId: "callback_a", userId: "user_a" };

  const expired = callbacks.cancelCallbackData("inst_a", "session_a");
  now = 110;
  await callbacks.tryHandle(expired, context);
  assert.equal(interrupts, 0);
  assert.equal(answers.at(-1), "This AI session action expired");

  const cleared = callbacks.cancelCallbackData("inst_b", "session_b");
  callbacks.clear();
  await callbacks.tryHandle(cleared, context);
  assert.equal(interrupts, 0);
  assert.equal(answers.at(-1), "This AI session action expired");
});

test("deleting a chat bridge stops its runtime before deleting storage", async () => {
  const handlers = new Map();
  const app = {
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
    patch: (route, handler) => handlers.set(`PATCH ${route}`, handler),
    delete: (route, handler) => handlers.set(`DELETE ${route}`, handler),
    log: { info() {} },
  };
  const calls = [];
  const service = {
    deleteChatBridge: (id) => { calls.push(`delete:${id}`); return true; },
  };
  const chatGateway = {
    stopBridge: (id) => { calls.push(`stop:${id}`); return {}; },
  };
  registerChatGatewayRoutes({ app, service, chatGateway });

  const handler = handlers.get("DELETE /api/chat-gateway/bridges/:id");
  assert.deepEqual(await handler({ params: { id: bridge.id } }), { data: { deleted: true } });
  assert.deepEqual(calls, [`stop:${bridge.id}`, `delete:${bridge.id}`]);
});

for (const channel of ["telegram", "wechat"]) {
  test(`stopping a ${channel} bridge isolates its in-flight poll response`, async () => {
    let releasePoll;
    const pollResponse = new Promise((resolve) => { releasePoll = resolve; });
    const fetchCalls = [];
    const updates = [];
    const routed = [];
    const currentBridge = {
      id: `bridge_${channel}`,
      channel,
      name: `${channel} bridge`,
      enabled: true,
      token: "secret-token",
      tokenSet: true,
      pollIntervalMs: 60_000,
      allowedUserIds: [],
      settings: {},
    };
    const service = {
      listChatBridges: () => [currentBridge],
      requireChatBridge: () => currentBridge,
      updateChatBridge: (_id, input) => { updates.push(input); return currentBridge; },
      listChatSessions: () => [],
      listPendingRoutes: async () => [],
      handleChatGatewayMessage: async (input) => { routed.push(input); return {}; },
      handleChatGatewayAction: async () => ({}),
      resolveChatActionToken: () => { throw new Error("unused"); },
      pendingDecisionCallbackData: () => "unused",
      listAiSessions: async () => ({ instances: [] }),
      boardAsync: async () => [],
      aiSessionQueue: async () => ({ items: [] }),
      steerAiSessionQueuedMessage: async () => ({}),
      removeAiSessionQueuedMessage: async () => ({}),
      interruptAiSession: async () => ({}),
    };
    const runtime = new ControlPlaneChatGatewayRuntime(service, async (url) => {
      fetchCalls.push(String(url));
      return pollResponse;
    });

    runtime.startBridge(currentBridge.id);
    assert.equal(fetchCalls.length, 1);
    runtime.stopBridge(currentBridge.id);
    releasePoll(new Response(JSON.stringify(channel === "telegram"
      ? {
          ok: true,
          result: [{
            update_id: 10,
            message: {
              message_id: 20,
              chat: { id: 30 },
              from: { id: 40 },
              photo: [{ file_id: "photo_a", file_size: 100, width: 10, height: 10 }],
            },
          }],
        }
      : {
          errcode: 0,
          get_updates_buf: "cursor-next",
          msgs: [{
            message_type: 1,
            from_user_id: "chat_a",
            context_token: "context-next",
            item_list: [{ type: 1, text_item: { text: "hello" } }],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    assert.equal(fetchCalls.length, 1, "stale Telegram polls must not begin attachment downloads");
    assert.deepEqual(updates, []);
    assert.deepEqual(routed, []);
    runtime.stopAll();
  });
}

test("stopping the runtime isolates an explicitly requested in-flight poll", async () => {
  let releasePoll;
  const pollResponse = new Promise((resolve) => { releasePoll = resolve; });
  const updates = [];
  const routed = [];
  const currentBridge = {
    id: "bridge_manual_poll",
    channel: "telegram",
    name: "manual poll bridge",
    enabled: false,
    token: "secret-token",
    tokenSet: true,
    pollIntervalMs: 60_000,
    allowedUserIds: [],
    settings: {},
  };
  const service = {
    listChatBridges: () => [currentBridge],
    requireChatBridge: () => currentBridge,
    updateChatBridge: (_id, input) => { updates.push(input); return currentBridge; },
    listChatSessions: () => [],
    listPendingRoutes: async () => [],
    handleChatGatewayMessage: async (input) => { routed.push(input); return {}; },
    handleChatGatewayAction: async () => ({}),
    resolveChatActionToken: () => { throw new Error("unused"); },
    pendingDecisionCallbackData: () => "unused",
    listAiSessions: async () => ({ instances: [] }),
    boardAsync: async () => [],
    aiSessionQueue: async () => ({ items: [] }),
    steerAiSessionQueuedMessage: async () => ({}),
    removeAiSessionQueuedMessage: async () => ({}),
    interruptAiSession: async () => ({}),
  };
  const runtime = new ControlPlaneChatGatewayRuntime(service, async () => pollResponse);

  const polling = runtime.pollBridgeNow(currentBridge.id);
  runtime.stopAll();
  releasePoll(new Response(JSON.stringify({
    ok: true,
    result: [{ update_id: 10, message: { message_id: 20, chat: { id: 30 }, from: { id: 40 }, text: "hello" } }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await polling;

  assert.deepEqual(updates, []);
  assert.deepEqual(routed, []);
});

test("WeChat interval, immediate, and manual polls share one cursor flight", async (t) => {
  const releases = [];
  const fetchCursors = [];
  const routed = [];
  const currentBridge = {
    id: "bridge_wechat_single_flight",
    channel: "wechat",
    name: "wechat bridge",
    enabled: true,
    token: "secret-token",
    tokenSet: true,
    defaultChatId: "chat_a",
    pollIntervalMs: 5,
    allowedUserIds: [],
    settings: { updatesBuf: "cursor-before" },
  };
  const service = {
    listChatBridges: () => [currentBridge],
    requireChatBridge: () => currentBridge,
    updateChatBridge: () => currentBridge,
    listChatSessions: () => [],
    listPendingRoutes: async () => [],
    handleChatGatewayMessage: async (input) => { routed.push(input); return {}; },
    handleChatGatewayAction: async () => ({}),
    resolveChatActionToken: () => { throw new Error("unused"); },
    pendingDecisionCallbackData: () => "unused",
    listAiSessions: async () => ({ instances: [] }),
    boardAsync: async () => [],
    aiSessionQueue: async () => ({ items: [] }),
    steerAiSessionQueuedMessage: async () => ({}),
    removeAiSessionQueuedMessage: async () => ({}),
    interruptAiSession: async () => ({}),
  };
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (_url, init) => {
    fetchCursors.push(JSON.parse(String(init.body)).get_updates_buf);
    return new Promise((resolve) => { releases.push(resolve); });
  });
  t.after(() => runtime.stopAll());

  runtime.startBridge(currentBridge.id);
  const manual = runtime.pollBridgeNow(currentBridge.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fetchCursors, ["cursor-before"]);
  assert.equal(releases.length, 1);

  releases[0](new Response(JSON.stringify({
    errcode: 0,
    get_updates_buf: "cursor-after",
    msgs: [{
      message_type: 1,
      from_user_id: "chat_a",
      context_token: "context-next",
      item_list: [{ type: 1, text_item: { text: "hello once" } }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await manual;
  runtime.stopBridge(currentBridge.id);

  assert.equal(routed.length, 1);
  assert.equal(routed[0].message.text, "hello once");
});

test("a restarted WeChat bridge is not blocked by a hung obsolete poll", async (t) => {
  const releases = [];
  const fetchCursors = [];
  const updates = [];
  const routed = [];
  const currentBridge = {
    id: "bridge_wechat_restart",
    channel: "wechat",
    name: "wechat restart bridge",
    enabled: true,
    token: "secret-token",
    tokenSet: true,
    defaultChatId: "chat_a",
    pollIntervalMs: 60_000,
    allowedUserIds: [],
    settings: { updatesBuf: "cursor-before" },
  };
  const service = {
    listChatBridges: () => [currentBridge],
    requireChatBridge: () => currentBridge,
    updateChatBridge: (_id, input) => { updates.push(input); return currentBridge; },
    listChatSessions: () => [],
    listPendingRoutes: async () => [],
    handleChatGatewayMessage: async (input) => { routed.push(input); return {}; },
    handleChatGatewayAction: async () => ({}),
    resolveChatActionToken: () => { throw new Error("unused"); },
    pendingDecisionCallbackData: () => "unused",
    listAiSessions: async () => ({ instances: [] }),
    boardAsync: async () => [],
    aiSessionQueue: async () => ({ items: [] }),
    steerAiSessionQueuedMessage: async () => ({}),
    removeAiSessionQueuedMessage: async () => ({}),
    interruptAiSession: async () => ({}),
  };
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (_url, init) => {
    fetchCursors.push(JSON.parse(String(init.body)).get_updates_buf);
    return new Promise((resolve) => { releases.push(resolve); });
  });
  t.after(() => runtime.stopAll());

  runtime.startBridge(currentBridge.id);
  runtime.stopBridge(currentBridge.id);
  runtime.startBridge(currentBridge.id);
  assert.deepEqual(fetchCursors, ["cursor-before", "cursor-before"]);

  releases[1](new Response(JSON.stringify({
    errcode: 0,
    get_updates_buf: "cursor-current",
    msgs: [{
      message_type: 1,
      from_user_id: "chat_a",
      context_token: "context-current",
      item_list: [{ type: 1, text_item: { text: "current message" } }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  releases[0](new Response(JSON.stringify({
    errcode: 0,
    get_updates_buf: "cursor-obsolete",
    msgs: [{
      message_type: 1,
      from_user_id: "chat_a",
      context_token: "context-obsolete",
      item_list: [{ type: 1, text_item: { text: "obsolete message" } }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.deepEqual(updates, [{ settings: { updatesBuf: "cursor-current" } }]);
  assert.deepEqual(routed.map((entry) => entry.message.text), ["current message"]);
});
