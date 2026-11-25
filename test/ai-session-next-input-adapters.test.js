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
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AiSessionNextInputSuggestionCoordinator } = require("../packages/ai-session-runtime/src/ai-session-next-input.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { OpenCodeSessionBridge } = require("../packages/ai-session-runtime/src/opencode.ts");

const now = "2026-11-25T00:00:00.000Z";

function registryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-next-input-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createAiSessionRegistry({ dir: path.join(root, "registry") });
}

function runningTurn(id = "turn_1", userPrompt = "继续修复") {
  return {
    id,
    providerTurnId: id,
    source: "realtime",
    status: "running",
    phase: "thinking",
    userPrompt,
    userMessages: [{ id: `msg_${id}`, text: userPrompt }],
    startedAt: now,
    updatedAt: now,
    revision: 0,
  };
}

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CodexClient extends EventEmitter {
  async start() {}
  stop() {}
  async listLoadedThreadIds() { return []; }
}

function codexFixture(t, observeSuccessfulTurn, onEventSourceClose) {
  const registry = registryFixture(t);
  const client = new CodexClient();
  const successfulTurns = [];
  const bridge = new CodexAppServerSessionBridge(registry, client, {
    onSuccessfulTurn: (sessionId, providerTurnId) => {
      successfulTurns.push([sessionId, providerTurnId]);
      observeSuccessfulTurn?.(sessionId, providerTurnId);
    },
    ...(onEventSourceClose ? { onEventSourceClose } : {}),
  });
  t.after(() => bridge.stop());
  const session = registry.start({
    agent: "codex",
    providerSessionId: "thread_next_input",
    cwd: "/workspace",
    status: "running",
    turns: [runningTurn()],
  });
  return { bridge, client, registry, session, successfulTurns };
}

function emitCodex(client, status = "completed", turnId = "turn_1", error) {
  client.emit("event", {
    type: "turn-completed",
    threadId: "thread_next_input",
    turnId,
    status,
    ...(error ? { error } : {}),
    observedAt: now,
  });
}

test("Codex reports only genuinely completed turns", (t) => {
  const completed = codexFixture(t);
  emitCodex(completed.client);
  assert.deepEqual(completed.successfulTurns, [[completed.session.id, "turn_1"]]);
  completed.bridge.stop();

  const failed = codexFixture(t);
  emitCodex(failed.client, "failed", "turn_1", "provider failed");
  assert.deepEqual(failed.successfulTurns, []);
  failed.bridge.stop();

  const interrupted = codexFixture(t);
  emitCodex(interrupted.client, "interrupted");
  assert.deepEqual(interrupted.successfulTurns, []);

  const closed = codexFixture(t);
  closed.client.emit("event", { type: "thread-closed", threadId: "thread_next_input" });
  assert.deepEqual(closed.successfulTurns, []);
});

test("duplicate Codex completion events generate one suggestion", async (t) => {
  let generated = 0;
  let coordinator;
  const state = codexFixture(t, (sessionId, providerTurnId) => coordinator?.observeSuccessfulTurn(sessionId, providerTurnId));
  coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: state.registry,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => {
      generated += 1;
      return JSON.stringify({ suggestion: "继续补齐测试" });
    },
  });
  t.after(() => coordinator.dispose());
  emitCodex(state.client);
  emitCodex(state.client);
  await wait(30);
  assert.equal(generated, 1);
  assert.equal(state.registry.get(state.session.id)?.nextInputSuggestion?.text, "继续补齐测试");
});

test("a Codex connection reset cancels an in-flight suggestion", async (t) => {
  let coordinator;
  let release;
  let generated = 0;
  const state = codexFixture(
    t,
    (sessionId, providerTurnId) => coordinator?.observeSuccessfulTurn(sessionId, providerTurnId),
    () => coordinator?.cancelPending(),
  );
  coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: state.registry,
    isEnabled: () => true,
    debounceMs: 5,
    generate: () => new Promise((resolve) => {
      generated += 1;
      release = resolve;
    }),
  });
  t.after(() => coordinator.dispose());
  emitCodex(state.client);
  await wait(20);
  assert.equal(generated, 1);
  state.client.emit("disconnect");
  release(JSON.stringify({ suggestion: "迟到建议" }));
  await wait(20);
  assert.equal(state.registry.get(state.session.id)?.nextInputSuggestion, undefined);
});

function openCodeFixture(t, options = {}) {
  const registry = registryFixture(t);
  const successfulTurns = [];
  let status = "busy";
  const providerSession = {
    id: "ses_next_input",
    directory: "/workspace",
    title: "Next input adapter",
    version: "1.18.21",
    time: { created: 1_760_000_000_000, updated: 1_760_000_000_010 },
  };
  const userMessage = (id = "msg_user", text = "继续修复") => ({
    info: { id, sessionID: providerSession.id, role: "user", time: { created: 1_760_000_000_001 } },
    parts: [{ id: `part_${id}`, sessionID: providerSession.id, messageID: id, type: "text", text }],
  });
  const assistantMessage = (parentID = "msg_user", text = "已修复") => ({
    info: {
      id: `msg_assistant_${parentID}`,
      sessionID: providerSession.id,
      role: "assistant",
      parentID,
      time: { created: 1_760_000_000_002, completed: 1_760_000_000_003 },
    },
    parts: [{
      id: `part_assistant_${parentID}`,
      sessionID: providerSession.id,
      messageID: `msg_assistant_${parentID}`,
      type: "text",
      text,
    }],
  });
  let messages = [userMessage(), assistantMessage()];
  const client = {
    health: async () => ({ healthy: true, version: "1.19.4" }),
    subscribeGlobal: async (_listener, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    getSession: async () => providerSession,
    listGlobalSessions: async () => ({ data: [providerSession] }),
    listSessions: async () => [providerSession],
    status: async () => ({ [providerSession.id]: status === "busy" ? { type: "busy" } : { type: "idle" } }),
    messages: async () => messages,
    permissions: async () => [],
    promptAsync: async () => undefined,
    abort: async () => true,
  };
  const bridge = new OpenCodeSessionBridge(registry, {
    connection: () => ({ endpoint: "http://unused", headers: {} }),
    workspaceRoots: () => ["/workspace"],
    ...(options.closedProviderSessionIds ? { closedProviderSessionIds: options.closedProviderSessionIds } : {}),
    onSuccessfulTurn: (sessionId, providerTurnId) => successfulTurns.push([sessionId, providerTurnId]),
  });
  bridge.client = client;
  t.after(() => bridge.close());
  return {
    bridge,
    registry,
    providerSession,
    successfulTurns,
    setStatus: (value) => { status = value; },
    setMessages: (value) => { messages = value; },
    addTurn: (id = "msg_user_2", text = "再检查一次") => { messages = [...messages, userMessage(id, text), assistantMessage(id, "检查完成")]; },
    client,
  };
}

test("OpenCode reports a settled idle turn once and ignores duplicate reconciles", async (t) => {
  const state = openCodeFixture(t);
  await state.bridge.readSession(state.providerSession.id);
  assert.deepEqual(state.successfulTurns, []);
  state.setStatus("idle");
  await state.bridge.readSession(state.providerSession.id);
  assert.deepEqual(state.successfulTurns, [[state.registry.getByProviderSessionId("opencode", state.providerSession.id).id, "msg_user"]]);
  await state.bridge.readSession(state.providerSession.id);
  assert.equal(state.successfulTurns.length, 1);
});

test("OpenCode interruptions and session errors suppress the failed turn", async (t) => {
  const interrupted = openCodeFixture(t);
  await interrupted.bridge.readSession(interrupted.providerSession.id);
  await interrupted.bridge.interrupt(interrupted.registry.getByProviderSessionId("opencode", interrupted.providerSession.id));
  interrupted.setStatus("idle");
  await interrupted.bridge.readSession(interrupted.providerSession.id);
  assert.deepEqual(interrupted.successfulTurns, []);

  const errored = openCodeFixture(t);
  await errored.bridge.readSession(errored.providerSession.id);
  await errored.bridge.onGlobalEvent({
    directory: "/workspace",
    payload: {
      type: "session.error",
      properties: {
        sessionID: errored.providerSession.id,
        error: { name: "ProviderError", data: { message: "provider failed" } },
      },
    },
  });
  errored.setStatus("idle");
  await errored.bridge.readSession(errored.providerSession.id);
  assert.deepEqual(errored.successfulTurns, []);
  assert.equal(errored.registry.getByProviderSessionId("opencode", errored.providerSession.id)?.status, "idle");
});

test("a new OpenCode prompt clears error suppression for the next settled turn", async (t) => {
  const state = openCodeFixture(t);
  await state.bridge.readSession(state.providerSession.id);
  await state.bridge.onGlobalEvent({
    directory: "/workspace",
    payload: {
      type: "session.error",
      properties: {
        sessionID: state.providerSession.id,
        error: { name: "ProviderError", data: { message: "provider failed" } },
      },
    },
  });
  await state.bridge.startMessage(state.registry.getByProviderSessionId("opencode", state.providerSession.id), { message: "再检查一次", messageId: "msg_user_2" });
  state.addTurn();
  state.setStatus("idle");
  await state.bridge.readSession(state.providerSession.id);
  assert.deepEqual(state.successfulTurns.map(([, turnId]) => turnId), ["msg_user_2"]);
});

test("a closed OpenCode session is not re-adopted into a suggestion", async (t) => {
  const closedIds = new Set();
  const state = openCodeFixture(t, { closedProviderSessionIds: () => closedIds });
  await state.bridge.readSession(state.providerSession.id);
  closedIds.add(state.providerSession.id);
  await state.bridge.onGlobalEvent({
    directory: "/workspace",
    payload: { type: "session.deleted", properties: { sessionID: state.providerSession.id } },
  });
  state.setStatus("idle");
  await state.bridge.readSession(state.providerSession.id);
  assert.deepEqual(state.successfulTurns, []);
  assert.equal(state.registry.getByProviderSessionId("opencode", state.providerSession.id), undefined);
});
