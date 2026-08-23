const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const { codexItemTimeline } = require("../packages/ai-session-runtime/src/codex-app-server-protocol.ts");
const { CodexAppServerClient, CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerRpcError, codexPaginatedTimelineSupported } = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");
const { codexNotification } = require("../packages/ai-session-runtime/src/codex-app-server/protocol/events.ts");
const { CodexTimelineStore } = require("../packages/ai-session-runtime/src/codex-app-server/session/timeline-store.ts");
const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionEventType, AiSessionTimelineSchema, AiSessionTurnTimelineSchema, mergeAiSessionTimelineItems } = require("../packages/protocol/src/ai-sessions.ts");
const { AiSessionActionService } = require("../packages/control-plane/src/control-plane/sessions/ai-session-actions.ts");
const { ControlPlaneAiSessionAggregator } = require("../packages/control-plane/src/control-plane/sessions/ai-session-aggregator.ts");
const { NodeTunnelEventRouter } = require("../packages/control-plane/src/control-plane/nodes/tunnel-event-router.ts");

test("AI session controller routes Timeline reads through provider capabilities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-timeline-control-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({ agent: "claude", appSessionId: "app-1", userPrompt: "Inspect" });
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "claude",
    async timeline(current) {
      return { sessionId: current.id, providerSessionId: "provider-1", items: [], generatedAt: "2026-08-16T00:00:00.000Z" };
    },
    async turnTimeline(current, turnId) {
      return { sessionId: current.id, turnId, items: [], generatedAt: "2026-08-16T00:00:00.000Z" };
    },
    async interrupt(current) {
      return { session: current, provider: "claude", action: "interrupt" };
    },
  });
  assert.deepEqual(controller.timelineCapabilities(), {
    sessionReadAgents: ["claude"],
    turnReadAgents: ["claude"],
    liveItemAgents: [],
  });
  assert.equal((await controller.timeline(session.id)).sessionId, session.id);
  assert.equal((await controller.turnTimeline(session.id, "turn-1")).turnId, "turn-1");
});

test("AI session controller relays provider-neutral realtime Timeline items", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-timeline-events-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const controller = new AiSessionController(registry);
  let providerListener;
  controller.register({
    agent: "future-agent",
    subscribeTimelineItems(listener) {
      providerListener = listener;
      return () => { providerListener = undefined; };
    },
    async interrupt(session) {
      return { session, provider: "future-agent", action: "interrupt" };
    },
  });
  const received = [];
  const unsubscribe = controller.subscribeTimelineItems((event) => received.push(event));
  const event = {
    sessionId: "session-1",
    providerSessionId: "provider-1",
    item: { id: "command-1", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
  };
  providerListener(event);
  assert.deepEqual(received, [event]);
  unsubscribe();
  providerListener(event);
  assert.equal(received.length, 1);
});

test("AI session controller advertises Timeline read and live-item capabilities independently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-timeline-independent-capabilities-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const controller = new AiSessionController(registry);
  controller.register({
    agent: "turn-reader",
    async turnTimeline(session, turnId) {
      return { sessionId: session.id, turnId, items: [], generatedAt: "2026-08-16T00:00:00.000Z" };
    },
    async interrupt(session) {
      return { session, provider: "turn-reader", action: "interrupt" };
    },
  });
  controller.register({
    agent: "live-only",
    subscribeTimelineItems() {
      return () => undefined;
    },
    async interrupt(session) {
      return { session, provider: "live-only", action: "interrupt" };
    },
  });
  assert.deepEqual(controller.timelineCapabilities(), {
    sessionReadAgents: [],
    turnReadAgents: ["turn-reader"],
    liveItemAgents: ["live-only"],
  });
});

test("Codex timeline preserves visible message and activity order without exposing reasoning", () => {
  const timeline = codexItemTimeline("ais_1", "thread_1", [
        { id: "user_1", type: "userMessage", content: [{ type: "text", text: "Fix it" }] },
        { id: "reason_1", type: "reasoning", summary: ["Inspect the state"] },
        { id: "agent_1", type: "agentMessage", text: "I found the source." },
        { id: "cmd_1", type: "commandExecution", command: "rg appSessionId", cwd: "/workspace", status: "completed", aggregatedOutput: "one match", exitCode: 0, durationMs: 12 },
        { id: "agent_2", type: "agentMessage", text: "Fixed." },
        { id: "file_1", type: "fileChange", status: "completed", changes: [{ path: "/workspace/a.ts", kind: "update" }] },
  ].map((item) => ({ turnId: "turn_1", item })), "2026-08-15T00:00:00.000Z");

  assert.deepEqual(timeline.items.map((item) => item.type), [
    "user-message",
    "ai-message",
    "activity",
    "ai-message",
    "activity",
  ]);
  assert.deepEqual(timeline.items.map((item) => item.id), ["user_1", "agent_1", "cmd_1", "agent_2", "file_1"]);
  assert.deepEqual(timeline.items[2], {
    id: "cmd_1",
    turnId: "turn_1",
    type: "activity",
    activityKind: "commandExecution",
    title: "Command",
    status: "completed",
    durationMs: 12,
    input: "rg appSessionId",
    output: "one match",
    exitCode: 0,
    summary: undefined,
    paths: undefined,
  });
  assert.equal(AiSessionTimelineSchema.safeParse(timeline).success, true);
});

test("unknown Codex items remain visible as generic activity", () => {
  const timeline = codexItemTimeline("ais_1", "thread_1", [{
    turnId: "turn_1",
    item: { id: "future_1", type: "futureActivity", secretInternalShape: true },
  }]);
  assert.deepEqual(timeline.items, [{
    id: "future_1",
    turnId: "turn_1",
    type: "activity",
    activityKind: "futureActivity",
    title: "futureActivity",
    status: undefined,
    durationMs: undefined,
    summary: undefined,
    input: undefined,
    output: undefined,
    paths: undefined,
  }]);
});

test("Codex timeline merges current-connection realtime items into authoritative history", () => {
  const entries = [
        { id: "user_live", type: "userMessage", content: [{ type: "text", text: "Run it" }] },
        { id: "agent_live", type: "agentMessage", text: "I will inspect it." },
  ].map((item) => ({ turnId: "turn_live", item }));
  const realtime = [{
    turnId: "turn_live",
    item: { id: "cmd_live", type: "commandExecution", command: "pnpm test", status: "completed", aggregatedOutput: "passed", exitCode: 0 },
  }];
  const timeline = codexItemTimeline("ais_live", "thread_live", entries, "2026-08-15T00:00:00.000Z", realtime);
  assert.deepEqual(timeline.items.map((item) => item.id), ["user_live", "agent_live", "cmd_live"]);
  assert.equal(timeline.items.at(-1).output, "passed");

  entries.push(realtime[0]);
  const converged = codexItemTimeline("ais_live", "thread_live", entries, "2026-08-15T00:00:01.000Z", realtime);
  assert.equal(converged.items.filter((item) => item.id === "cmd_live").length, 1);
});

test("live Timeline items use shared message ids as ordering anchors", () => {
  const progress = { id: "message_progress", turnId: "turn_live", type: "ai-message", text: "Checking" };
  const file = { id: "file_live", turnId: "turn_live", type: "activity", activityKind: "fileChange", title: "File change", status: "completed" };
  const final = { id: "message_final", turnId: "turn_live", type: "ai-message", text: "Done" };
  const command = { id: "command_live", turnId: "turn_live", type: "activity", activityKind: "commandExecution", title: "Command", status: "completed" };
  const merged = mergeAiSessionTimelineItems(
    [progress, file, final],
    [progress, command, file, final],
  );
  assert.deepEqual(merged.map((item) => item.id), ["message_progress", "command_live", "file_live", "message_final"]);
});

test("Codex current-connection realtime ordering does not append Commands after a later AI message", () => {
  const entries = [
    { id: "message_progress", type: "agentMessage", text: "Checking" },
    { id: "file_live", type: "fileChange", status: "completed", changes: [{ path: "/workspace/a.ts" }] },
    { id: "message_final", type: "agentMessage", text: "Done" },
  ].map((item) => ({ turnId: "turn_live", item }));
  const realtime = [
    { turnId: "turn_live", item: { id: "message_progress", type: "agentMessage", text: "Checking", status: "completed" } },
    { turnId: "turn_live", item: { id: "command_live", type: "commandExecution", command: "pnpm test", status: "completed" } },
    { turnId: "turn_live", item: { id: "file_live", type: "fileChange", status: "completed", changes: [{ path: "/workspace/a.ts" }] } },
    { turnId: "turn_live", item: { id: "message_final", type: "agentMessage", text: "Done", status: "completed" } },
  ];
  const timeline = codexItemTimeline("session_live", "thread_live", entries, "2026-08-15T00:00:00.000Z", realtime);
  assert.deepEqual(timeline.items.map((item) => item.id), ["message_progress", "command_live", "file_live", "message_final"]);
});

test("persistent Codex item history survives an empty realtime cache without losing tools", () => {
  const entries = [
    { turnId: "turn_1", item: { id: "user_1", type: "userMessage", content: [{ type: "text", text: "Run it" }] } },
    { turnId: "turn_1", item: { id: "message_1", type: "agentMessage", text: "Checking" } },
    { turnId: "turn_1", item: { id: "command_1", type: "commandExecution", command: "pnpm test", status: "completed", aggregatedOutput: "ok", exitCode: 0 } },
    { turnId: "turn_1", item: { id: "message_2", type: "agentMessage", text: "Done" } },
  ];
  const beforeRestart = codexItemTimeline("session_1", "thread_1", entries, "2026-08-15T00:00:00.000Z", entries);
  const afterRestart = codexItemTimeline("session_1", "thread_1", entries, "2026-08-15T00:00:01.000Z", []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(afterRestart.items)),
    JSON.parse(JSON.stringify(beforeRestart.items)),
  );
  assert.deepEqual(afterRestart.items.map((item) => item.id), ["user_1", "message_1", "command_1", "message_2"]);
});

test("Codex Timeline store restores item order and lifecycle updates after process reconstruction", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-timeline-"));
  const firstProcess = new CodexTimelineStore(directory);
  firstProcess.upsert("thread_1", { id: "message_1", turnId: "turn_1", type: "ai-message", text: "Checking" });
  firstProcess.upsert("thread_1", { id: "command_1", turnId: "turn_1", type: "activity", activityKind: "commandExecution", title: "Command", status: "running" });
  firstProcess.upsert("thread_1", { id: "command_1", turnId: "turn_1", type: "activity", activityKind: "commandExecution", title: "Command", status: "completed", output: "ok", exitCode: 0 });
  firstProcess.upsert("thread_1", { id: "message_2", turnId: "turn_1", type: "ai-message", text: "Done" });

  const storedFile = path.join(directory, fs.readdirSync(directory)[0]);
  const legacyRecord = JSON.parse(fs.readFileSync(storedFile, "utf8"));
  legacyRecord.items.push({ id: "reasoning_legacy", turnId: "turn_1", type: "activity", activityKind: "reasoning", title: "Reasoning" });
  fs.writeFileSync(storedFile, JSON.stringify(legacyRecord));

  const restartedProcess = new CodexTimelineStore(directory);
  const restored = restartedProcess.items("thread_1");
  assert.deepEqual(restored.map((item) => item.id), ["message_1", "command_1", "message_2"]);
  assert.equal(restored[1].status, "completed");
  assert.equal(restored[1].output, "ok");
});

test("Codex Timeline store retains only provider sessions owned by AI session persistence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-timeline-retain-"));
  const store = new CodexTimelineStore(directory);
  store.upsert("thread_active", { id: "message_active", turnId: "turn_1", type: "ai-message", text: "Active" });
  store.upsert("thread_history", { id: "message_history", turnId: "turn_1", type: "ai-message", text: "History" });
  store.upsert("thread_expired", { id: "message_expired", turnId: "turn_1", type: "ai-message", text: "Expired" });

  assert.equal(store.retain(["thread_active", "thread_history"]), 1);
  assert.deepEqual(store.items("thread_active").map((item) => item.id), ["message_active"]);
  assert.deepEqual(store.items("thread_history").map((item) => item.id), ["message_history"]);
  assert.deepEqual(store.items("thread_expired"), []);
  assert.equal(fs.readdirSync(directory).length, 2);
});

test("legacy Codex restores adapter-owned item events after a full process restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-timeline-restart-"));
  const registryPath = path.join(root, "ai-sessions");
  const timelineStorePath = path.join(root, "timeline");
  const snapshot = {
    id: "thread_restart",
    cwd: "/workspace",
    status: { type: "active", activeFlags: [] },
    turns: [{
      id: "turn_restart",
      status: "inProgress",
      items: [{ id: "message_before", type: "agentMessage", text: "Checking" }],
    }],
  };

  class RestartableCodexClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() { return [snapshot.id]; }
    async readThread() { return snapshot; }
    stop() {}
  }

  const firstRegistry = createAiSessionRegistry({ dir: registryPath });
  const firstClient = new RestartableCodexClient();
  const firstBridge = new CodexAppServerSessionBridge(firstRegistry, firstClient, { timelineStorePath });
  await firstBridge.sync();
  const session = firstRegistry.getByProviderSessionId("codex", snapshot.id);
  assert.ok(session);

  const command = { type: "commandExecution", id: "command_live", command: "pnpm test" };
  firstClient.emit("event", codexNotification("item/started", {
    threadId: snapshot.id,
    turnId: "turn_restart",
    item: command,
  }));
  firstClient.emit("event", codexNotification("item/completed", {
    threadId: snapshot.id,
    turnId: "turn_restart",
    item: { ...command, aggregatedOutput: "ok", exitCode: 0 },
  }));
  const beforeRestart = await firstBridge.timeline(session);
  assert.deepEqual(beforeRestart.items.map((item) => item.id), ["message_before", "command_live"]);
  firstBridge.stop();

  const secondRegistry = createAiSessionRegistry({ dir: registryPath });
  const secondBridge = new CodexAppServerSessionBridge(secondRegistry, new RestartableCodexClient(), { timelineStorePath });
  await secondBridge.sync();
  const restoredSession = secondRegistry.getByProviderSessionId("codex", snapshot.id);
  assert.ok(restoredSession);
  const afterRestart = await secondBridge.timeline(restoredSession);
  assert.deepEqual(JSON.parse(JSON.stringify(afterRestart.items)), JSON.parse(JSON.stringify(beforeRestart.items)));
  secondBridge.stop();
});

test("legacy Codex uses thread/read plus adapter-owned item history without calling native item history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-timeline-unsupported-"));
  const snapshot = {
    id: "thread_unsupported",
    cwd: "/workspace",
    status: { type: "idle" },
    turns: [{
      id: "turn_old",
      status: "completed",
      items: [{ id: "command_old", type: "commandExecution", command: "pnpm test" }],
    }],
  };
  let reads = 0;
  let itemReads = 0;
  class UnsupportedTimelineCodexClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() { return [snapshot.id]; }
    async readThread() { reads += 1; return snapshot; }
    async listThreadItems() { itemReads += 1; return undefined; }
    stop() {}
  }

  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const client = new UnsupportedTimelineCodexClient();
  const timelineStorePath = path.join(root, "timeline");
  const bridge = new CodexAppServerSessionBridge(registry, client, { timelineStorePath });
  await bridge.sync();
  const session = registry.getByProviderSessionId("codex", snapshot.id);
  assert.ok(session);
  const discoveryReads = reads;
  assert.deepEqual(bridge.timelineCapabilities(), {
    sessionRead: true,
    turnRead: true,
    liveItems: true,
  });
  const command = { type: "commandExecution", id: "command_new", command: "pnpm test" };
  client.emit("event", codexNotification("item/started", {
    threadId: snapshot.id,
    turnId: "turn_new",
    item: command,
  }));
  client.emit("event", codexNotification("item/completed", {
    threadId: snapshot.id,
    turnId: "turn_new",
    item: { ...command, aggregatedOutput: "passed", exitCode: 0 },
  }));
  const timeline = await bridge.timeline(session);
  assert.deepEqual(timeline.items.map((item) => item.id), ["command_old", "command_new"]);
  assert.equal(timeline.items[1].output, "passed");
  assert.equal(JSON.stringify(fs.readdirSync(timelineStorePath).map((name) => fs.readFileSync(path.join(timelineStorePath, name), "utf8"))).includes("command_new"), true);
  assert.equal(reads, discoveryReads + 1);
  assert.equal(itemReads, 0);
  bridge.stop();
});

test("Codex bridge returns one authoritative turn Timeline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-turn-timeline-"));
  const snapshot = {
    id: "thread_turn_timeline",
    historyMode: "paginated",
    cwd: "/workspace",
    status: { type: "idle" },
    turns: [
      { id: "turn_1", status: "completed", items: [{ id: "message_1", type: "agentMessage", text: "First" }] },
      { id: "turn_2", status: "completed", items: [{ id: "message_2", type: "agentMessage", text: "Second" }] },
    ],
  };
  const requestedTurns = [];
  class TurnTimelineCodexClient extends EventEmitter {
    async start() {}
    async listLoadedThreadIds() { return [snapshot.id]; }
    async readThread() { return snapshot; }
    async listThreadItems(_threadId, turnId) {
      requestedTurns.push(turnId);
      const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
      return turn?.items.map((item) => ({ turnId, item })) || [];
    }
    stop() {}
  }

  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const client = new TurnTimelineCodexClient();
  const timelineStorePath = path.join(root, "timeline");
  const bridge = new CodexAppServerSessionBridge(registry, client, { timelineStorePath });
  await bridge.sync();
  assert.deepEqual(bridge.timelineCapabilities(), {
    sessionRead: true,
    turnRead: true,
    liveItems: true,
  });
  const session = registry.getByProviderSessionId("codex", snapshot.id);
  assert.ok(session);
  const publicTurn = session.turns.find((turn) => turn.providerTurnId === "turn_2" || turn.id === "turn_2");
  assert.ok(publicTurn);
  const timeline = await bridge.turnTimeline(session, publicTurn.id);
  assert.deepEqual(requestedTurns, ["turn_2"]);
  assert.deepEqual(timeline.items.map((item) => item.id), ["message_2"]);
  assert.equal(timeline.turnId, publicTurn.id);
  client.emit("event", codexNotification("item/started", {
    threadId: snapshot.id,
    turnId: "turn_3",
    item: { type: "commandExecution", id: "native_command", command: "pnpm test" },
  }));
  assert.equal(fs.existsSync(timelineStorePath), false);
  bridge.stop();
});

test("Codex client pages through the persistent single-item history", async () => {
  const client = new CodexAppServerClient();
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (!params.cursor) return { data: [{ turnId: "turn_1", item: { id: "command_1", type: "commandExecution" } }], nextCursor: "next" };
    return { data: [{ turnId: "turn_1", item: { id: "message_1", type: "agentMessage", text: "Done" } }], nextCursor: null };
  };
  const items = await client.listThreadItems("thread_1");
  assert.deepEqual(items.map((entry) => entry.item.id), ["command_1", "message_1"]);
  assert.deepEqual(requests.map(({ method }) => method), ["thread/items/list", "thread/items/list"]);
  assert.equal(requests[0].params.sortDirection, "asc");
  assert.equal(requests[0].params.turnId, null);
});

test("Codex paginated Timeline support follows the source-backed release boundary", () => {
  assert.equal(codexPaginatedTimelineSupported(undefined), false);
  assert.equal(codexPaginatedTimelineSupported("codex-cli/0.144.1 (Darwin)"), false);
  assert.equal(codexPaginatedTimelineSupported("codex-cli/0.145.0-alpha.17"), false);
  assert.equal(codexPaginatedTimelineSupported("codex-cli/0.145.0-alpha.18"), true);
  assert.equal(codexPaginatedTimelineSupported("codex-cli 0.145.0"), true);
  assert.equal(codexPaginatedTimelineSupported("codex-cli/1.0.0"), true);
});

test("Codex client requests paginated history only from supporting versions", async () => {
  const start = async (userAgent) => {
    const client = new CodexAppServerClient();
    client.serverUserAgent = userAgent;
    let params;
    client.request = async (method, value) => {
      assert.equal(method, "thread/start");
      params = value;
      return { thread: { id: `thread-${userAgent}`, cwd: "/workspace", ephemeral: false, historyMode: value.historyMode || "legacy" } };
    };
    await client.startThread({
      cwd: "/workspace",
      ...(client.supportsPaginatedTimeline() ? { historyMode: "paginated" } : {}),
    });
    return params;
  };

  assert.equal((await start("codex-cli/0.144.1")).historyMode, undefined);
  assert.equal((await start("codex-cli/0.145.0-alpha.18")).historyMode, "paginated");
});

test("Codex client asks persistent history for only one turn", async () => {
  const client = new CodexAppServerClient();
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    return { data: [{ turnId: "turn_2", item: { id: "message_2", type: "agentMessage", text: "Done" } }], nextCursor: null };
  };
  const items = await client.listThreadItems("thread_1", "turn_2");
  assert.deepEqual(items.map((entry) => entry.item.id), ["message_2"]);
  assert.equal(requests[0].params.turnId, "turn_2");
});

test("Codex client disables Timeline reads when thread/items/list is unsupported", async () => {
  const client = new CodexAppServerClient();
  let requests = 0;
  client.request = async () => {
    requests += 1;
    throw new CodexAppServerRpcError("unsupported", -32601);
  };
  assert.equal(await client.listThreadItems("thread_native"), undefined);
  assert.equal(await client.listThreadItems("thread_legacy"), undefined);
  assert.equal(requests, 1);
});

test("real Codex app-server exposes restart-safe persistent Timeline items", {
  skip: !process.env.TASK_HANDOFF_REAL_CODEX_TIMELINE_THREAD_ID,
}, async () => {
  const client = new CodexAppServerClient({ requestTimeoutMs: 30_000 });
  try {
    await client.start();
    const items = await client.listThreadItems(process.env.TASK_HANDOFF_REAL_CODEX_TIMELINE_THREAD_ID);
    assert.ok(items, "the installed Codex app-server must support thread/items/list");
    assert.ok(items.some((entry) => entry.item.type === "agentMessage"));
    assert.ok(items.some((entry) => entry.item.type === "commandExecution"));
    assert.ok(items.every((entry) => typeof entry.turnId === "string" && typeof entry.item.id === "string"));
  } finally {
    client.stop();
  }
});

test("complete-session Timeline forwarding is capability-gated by the canonical document", async () => {
  let requestedPath = "";
  const service = new AiSessionActionService({
    requireInstance: async () => ({ capabilities: { features: { aiSessionTimeline: {
      sessionReadAgents: ["codex"],
      turnReadAgents: [],
      liveItemAgents: [],
    } } } }),
    request: async (_instance, route) => {
      requestedPath = route;
      return { sessionId: "ais_1", providerSessionId: "thread_1", items: [], generatedAt: "2026-08-15T00:00:00.000Z" };
    },
    requireRuntime: async () => ({}),
  });
  const timeline = await service.timeline("instance_1", "ais_1");
  assert.equal(requestedPath, "/ai-sessions/ais_1/timeline");
  assert.equal(timeline.sessionId, "ais_1");

  const unsupported = new AiSessionActionService({
    requireInstance: async () => ({ capabilities: { features: {} } }),
    request: async () => { throw new Error("must not forward"); },
    requireRuntime: async () => ({}),
  });
  await assert.rejects(() => unsupported.timeline("instance_unsupported", "ais_1"), (error) => error.code === "AI_SESSION_TIMELINE_UNSUPPORTED");
});

test("per-turn Timeline forwarding is independently capability-gated", async () => {
  let requestedPath = "";
  const service = new AiSessionActionService({
    requireInstance: async () => ({ capabilities: { features: { aiSessionTimeline: {
      sessionReadAgents: [],
      turnReadAgents: ["codex"],
      liveItemAgents: [],
    } } } }),
    request: async (_instance, route) => {
      requestedPath = route;
      return { sessionId: "ais_1", turnId: "turn_2", items: [], generatedAt: "2026-08-15T00:00:00.000Z" };
    },
    requireRuntime: async () => ({}),
  });
  const timeline = await service.turnTimeline("instance_1", "ais_1", "turn_2");
  assert.equal(requestedPath, "/ai-sessions/ais_1/turns/turn_2/timeline");
  assert.equal(AiSessionTurnTimelineSchema.safeParse(timeline).success, true);

  const unsupported = new AiSessionActionService({
    requireInstance: async () => ({ capabilities: { features: { aiSessionTimeline: {
      sessionReadAgents: ["codex"],
      turnReadAgents: [],
      liveItemAgents: [],
    } } } }),
    request: async () => { throw new Error("must not forward"); },
    requireRuntime: async () => ({}),
  });
  await assert.rejects(
    () => unsupported.turnTimeline("instance_unsupported", "ais_1", "turn_2"),
    (error) => error.code === "AI_SESSION_TURN_TIMELINE_UNSUPPORTED",
  );
});

test("Timeline forwarding accepts provider-scoped capabilities", async () => {
  const requested = [];
  const service = new AiSessionActionService({
    requireInstance: async () => ({
      capabilities: {
        features: {
          aiSessionTimeline: {
            sessionReadAgents: ["future-agent"],
            turnReadAgents: ["future-agent"],
            liveItemAgents: [],
          },
        },
      },
    }),
    request: async (_instance, route) => {
      requested.push(route);
      if (route.endsWith("/timeline") && route.includes("/turns/")) {
        return { sessionId: "ais_1", turnId: "turn_1", items: [], generatedAt: "2026-08-16T00:00:00.000Z" };
      }
      return { sessionId: "ais_1", providerSessionId: "provider_1", items: [], generatedAt: "2026-08-16T00:00:00.000Z" };
    },
    requireRuntime: async () => ({}),
  });
  await service.timeline("instance_1", "ais_1");
  await service.turnTimeline("instance_1", "ais_1", "turn_1");
  assert.deepEqual(requested, [
    "/ai-sessions/ais_1/timeline",
    "/ai-sessions/ais_1/turns/turn_1/timeline",
  ]);
});

test("control-plane tunnel forwards a validated single Timeline item event", async () => {
  const published = [];
  const aggregator = new ControlPlaneAiSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  const router = new NodeTunnelEventRouter({
    events: { publish: (type, payload, options) => published.push({ type, payload, options }) },
    onSessionEvent: (event) => aggregator.handleEvent(event),
    validateInstanceScope: async (nodeId, instanceId) => nodeId === "node_1" && instanceId === "instance_1",
  });
  const itemEvent = {
    instanceId: "instance_1",
    nodeId: "node_1",
    sessionId: "session_1",
    providerSessionId: "thread_1",
    item: { id: "cmd_1", turnId: "turn_1", type: "activity", activityKind: "commandExecution", title: "Command", status: "completed" },
    generatedAt: "2026-08-15T00:00:00.000Z",
  };
  router.handle("node_1", {
    type: "node-agent.event.forwarded",
    instanceId: "instance_1",
    event: { type: AiSessionEventType.TimelineItem, topic: "ai.sessions", payload: itemEvent, scope: { instanceId: "instance_1" } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(published.length, 1);
  assert.equal(published[0].type, AiSessionEventType.TimelineItem);
  assert.deepEqual(published[0].payload, itemEvent);
  assert.deepEqual(published[0].options.scope, { nodeId: "node_1", instanceId: "instance_1" });
});
