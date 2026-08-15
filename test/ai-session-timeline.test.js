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
const { codexItemTimeline, codexThreadTimeline, mergeCodexTimelineItems } = require("../packages/ai-session-runtime/src/codex-app-server-protocol.ts");
const { CodexAppServerClient, CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerRpcError } = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");
const { CodexTimelineStore } = require("../packages/ai-session-runtime/src/codex-app-server/session/timeline-store.ts");
const { AiSessionEventType, AiSessionTimelineSchema, mergeAiSessionTimelineItems } = require("../packages/protocol/src/ai-sessions.ts");
const { AiSessionActionService } = require("../packages/control-plane/src/control-plane/sessions/ai-session-actions.ts");
const { ControlPlaneAiSessionAggregator } = require("../packages/control-plane/src/control-plane/sessions/ai-session-aggregator.ts");
const { NodeTunnelEventRouter } = require("../packages/control-plane/src/control-plane/nodes/tunnel-event-router.ts");

test("Codex timeline preserves visible message and activity order without exposing reasoning", () => {
  const timeline = codexThreadTimeline("ais_1", "thread_1", {
    turns: [{
      id: "turn_1",
      status: "completed",
      items: [
        { id: "user_1", type: "userMessage", content: [{ type: "text", text: "Fix it" }] },
        { id: "reason_1", type: "reasoning", summary: ["Inspect the state"] },
        { id: "agent_1", type: "agentMessage", text: "I found the source." },
        { id: "cmd_1", type: "commandExecution", command: "rg appSessionId", cwd: "/workspace", status: "completed", aggregatedOutput: "one match", exitCode: 0, durationMs: 12 },
        { id: "agent_2", type: "agentMessage", text: "Fixed." },
        { id: "file_1", type: "fileChange", status: "completed", changes: [{ path: "/workspace/a.ts", kind: "update" }] },
      ],
    }],
  }, "2026-08-15T00:00:00.000Z");

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
  const timeline = codexThreadTimeline("ais_1", "thread_1", {
    turns: [{ id: "turn_1", items: [{ id: "future_1", type: "futureActivity", secretInternalShape: true }] }],
  });
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

test("Codex timeline fills lagging thread reads from realtime tool items without duplicates", () => {
  const thread = {
    turns: [{
      id: "turn_live",
      items: [
        { id: "user_live", type: "userMessage", content: [{ type: "text", text: "Run it" }] },
        { id: "agent_live", type: "agentMessage", text: "I will inspect it." },
      ],
    }],
  };
  const realtime = [{
    turnId: "turn_live",
    item: { id: "cmd_live", type: "commandExecution", command: "pnpm test", status: "completed", aggregatedOutput: "passed", exitCode: 0 },
  }];
  const timeline = codexThreadTimeline("ais_live", "thread_live", thread, "2026-08-15T00:00:00.000Z", realtime);
  assert.deepEqual(timeline.items.map((item) => item.id), ["user_live", "agent_live", "cmd_live"]);
  assert.equal(timeline.items.at(-1).output, "passed");

  thread.turns[0].items.push(realtime[0].item);
  const converged = codexThreadTimeline("ais_live", "thread_live", thread, "2026-08-15T00:00:01.000Z", realtime);
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

test("Codex v0.0.21 recovery aligns synthetic thread/read ids with authoritative item event ids", () => {
  const snapshot = [
    { id: "item-141", turnId: "turn-1", type: "user-message", text: "Question" },
    { id: "item-142", turnId: "turn-1", type: "ai-message", text: "Checking" },
    { id: "item-143", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command", input: "pnpm test" },
    { id: "item-144", turnId: "turn-1", type: "ai-message", text: "Done" },
  ];
  const itemEvents = [
    { id: "user-real", turnId: "turn-1", type: "user-message", text: "Question" },
    { id: "msg-progress", turnId: "turn-1", type: "ai-message", text: "Checking" },
    { id: "exec-real", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command", status: "completed", input: "pnpm test" },
    { id: "msg-final", turnId: "turn-1", type: "ai-message", text: "Done" },
  ];

  const merged = mergeCodexTimelineItems(snapshot, itemEvents);
  assert.deepEqual(merged.map((item) => item.id), ["user-real", "msg-progress", "exec-real", "msg-final"]);
  assert.equal(merged[2].status, "completed");
});

test("Codex identity alignment preserves repeated equal messages as separate occurrences", () => {
  const snapshot = [
    { id: "item-1", turnId: "turn-1", type: "ai-message", text: "Still working" },
    { id: "item-2", turnId: "turn-1", type: "ai-message", text: "Still working" },
  ];
  const itemEvents = [
    { id: "msg-1", turnId: "turn-1", type: "ai-message", text: "Still working" },
    { id: "msg-2", turnId: "turn-1", type: "ai-message", text: "Still working" },
  ];
  assert.deepEqual(mergeCodexTimelineItems(snapshot, itemEvents).map((item) => item.id), ["msg-1", "msg-2"]);
});

test("Codex realtime compensation does not append Commands after a later AI message", () => {
  const thread = { turns: [{ id: "turn_live", items: [
    { id: "message_progress", type: "agentMessage", text: "Checking" },
    { id: "file_live", type: "fileChange", status: "completed", changes: [{ path: "/workspace/a.ts" }] },
    { id: "message_final", type: "agentMessage", text: "Done" },
  ] }] };
  const realtime = [
    { turnId: "turn_live", item: { id: "message_progress", type: "agentMessage", text: "Checking", status: "completed" } },
    { turnId: "turn_live", item: { id: "command_live", type: "commandExecution", command: "pnpm test", status: "completed" } },
    { turnId: "turn_live", item: { id: "file_live", type: "fileChange", status: "completed", changes: [{ path: "/workspace/a.ts" }] } },
    { turnId: "turn_live", item: { id: "message_final", type: "agentMessage", text: "Done", status: "completed" } },
  ];
  const timeline = codexThreadTimeline("session_live", "thread_live", thread, "2026-08-15T00:00:00.000Z", realtime);
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

test("Codex bridge restores live item events after a full process restart without persisting reasoning", async () => {
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

  firstClient.emit("event", {
    type: "tool-item-started",
    threadId: snapshot.id,
    turnId: "turn_restart",
    item: { id: "command_live", type: "commandExecution", command: "pnpm test" },
    timelineItem: { id: "command_live", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    tool: { id: "command_live", kind: "commandExecution", name: "Command" },
  });
  firstClient.emit("event", {
    type: "timeline-item",
    threadId: snapshot.id,
    turnId: "turn_restart",
    timelineItem: { id: "reasoning_live", type: "reasoning", summary: ["private chain of thought"], status: "completed" },
  });
  firstClient.emit("event", {
    type: "tool-item-completed",
    threadId: snapshot.id,
    turnId: "turn_restart",
    item: { id: "command_live", type: "commandExecution", command: "pnpm test", aggregatedOutput: "ok", exitCode: 0 },
    timelineItem: { id: "command_live", type: "commandExecution", command: "pnpm test", status: "completed", aggregatedOutput: "ok", exitCode: 0 },
    tool: { id: "command_live", kind: "commandExecution", name: "Command" },
  });
  const beforeRestart = await firstBridge.timeline(session);
  assert.deepEqual(beforeRestart.items.map((item) => item.id), ["message_before", "command_live"]);
  assert.equal(beforeRestart.items[1].status, "completed");
  firstBridge.stop();

  const secondRegistry = createAiSessionRegistry({ dir: registryPath });
  const secondBridge = new CodexAppServerSessionBridge(secondRegistry, new RestartableCodexClient(), { timelineStorePath });
  await secondBridge.sync();
  const restoredSession = secondRegistry.getByProviderSessionId("codex", snapshot.id);
  assert.ok(restoredSession);
  const afterRestart = await secondBridge.timeline(restoredSession);

  assert.deepEqual(
    JSON.parse(JSON.stringify(afterRestart.items)),
    JSON.parse(JSON.stringify(beforeRestart.items)),
  );
  assert.equal(JSON.stringify(fs.readdirSync(timelineStorePath).map((name) => fs.readFileSync(path.join(timelineStorePath, name), "utf8"))).includes("reasoning_live"), false);
  secondBridge.stop();
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
});

test("Codex client falls back when v0.0.21 lacks persistent single-item history", async () => {
  const client = new CodexAppServerClient();
  let requests = 0;
  client.request = async () => {
    requests += 1;
    throw new CodexAppServerRpcError("unsupported", -32601);
  };
  assert.equal(await client.listThreadItems("thread_legacy"), undefined);
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

test("Timeline forwarding is capability-gated for v0.0.21 compatibility", async () => {
  let requestedPath = "";
  const service = new AiSessionActionService({
    requireInstance: async () => ({ capabilities: { features: { aiSessionTimeline: true } } }),
    request: async (_instance, route) => {
      requestedPath = route;
      return { sessionId: "ais_1", providerSessionId: "thread_1", items: [], generatedAt: "2026-08-15T00:00:00.000Z" };
    },
    requireRuntime: async () => ({}),
    refreshSnapshots: async () => undefined,
  });
  const timeline = await service.timeline("instance_1", "ais_1");
  assert.equal(requestedPath, "/ai-sessions/ais_1/timeline");
  assert.equal(timeline.sessionId, "ais_1");

  const legacy = new AiSessionActionService({
    requireInstance: async () => ({ capabilities: { features: {} } }),
    request: async () => { throw new Error("must not forward"); },
    requireRuntime: async () => ({}),
    refreshSnapshots: async () => undefined,
  });
  await assert.rejects(() => legacy.timeline("instance_legacy", "ais_1"), (error) => error.code === "AI_SESSION_TIMELINE_UNSUPPORTED");
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
