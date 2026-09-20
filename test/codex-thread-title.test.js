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

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerSessionBridge, CodexAppServerClient } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const {
  CODEX_THREAD_TITLE_PROMPT_MAX_BYTES,
  codexThreadTitlePrompt,
  parseCodexThreadTitle,
} = require("../packages/ai-session-runtime/src/codex-app-server/session/title-generator.ts");

class TitleClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.title = options.title;
    this.calls = [];
  }
  async start() {}
  stop() {}
  async listLoadedThreadIds() { return ["thread-title"]; }
  async startThread(options) {
    this.calls.push(["start", options]);
    return {
      id: "thread-title",
      cwd: options.cwd,
      model: options.model || "selected-model",
      modelProvider: options.modelProvider || "selected-provider",
      reasoningEffort: options.reasoningEffort,
      status: { type: "idle" },
      turns: [],
    };
  }
  async readThread(threadId) {
    this.calls.push(["read", threadId]);
    return {
      id: threadId,
      cwd: "/workspace",
      name: this.title,
      status: { type: "idle" },
      turns: [],
      ...(this.options.omitThreadModel ? {} : { model: "selected-model", modelProvider: "selected-provider" }),
    };
  }
  async runEphemeralStructuredTurn(options) {
    this.calls.push(["generate", options]);
    return this.options.generate ? this.options.generate(options) : '{"title":"Fix session title"}';
  }
  async setThreadName(threadId, title) { this.calls.push(["set", threadId, title]); }
}

function fixture(t, clientOptions = {}, fixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-title-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const client = new TitleClient(clientOptions);
  const diagnostics = [];
  const bridge = new CodexAppServerSessionBridge(registry, client, {
    resolveModelSelection: (selection) => ({
      model: selection.modelName,
      modelProvider: `provider:${selection.modelEntityId}`,
    }),
    ...(fixtureOptions.withoutModelSelection ? {} : {
      projectModelSelection: (modelProvider, model) => ({
        modelEntityId: modelProvider.replace(/^provider:/, ""),
        modelName: model,
      }),
    }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(() => bridge.stop());
  const existingSession = registry.start({
    agent: "codex",
    providerSessionId: "thread-title",
    cwd: "/workspace",
    status: "idle",
    ...(fixtureOptions.withoutModelSelection
      ? {}
      : { modelSelection: { modelEntityId: "entity-one", modelName: "session-model" } }),
    reasoningEffort: "high",
  });
  return { bridge, client, diagnostics, registry, existingSession };
}

async function createFreshSession(state, withModelSelection = true) {
  await state.bridge.createSession({
    cwd: "/workspace",
    ...(withModelSelection ? { modelSelection: { modelEntityId: "entity-one", modelName: "session-model" } } : {}),
    reasoningEffort: "high",
  });
  return state.registry.getByProviderSessionId("codex", "thread-title");
}

function emitUserMessage(client, status = "completed", threadId = "thread-title", turnId = "turn-one") {
  client.emit("event", {
    type: "user-message",
    threadId,
    turnId,
    itemId: `item-${turnId}`,
    timelineItem: { status },
    text: "请修复会话标题生成",
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for asynchronous title generation.");
}

test("Codex title generation uses the AI Session's exact selected model and provider", async (t) => {
  const state = fixture(t);
  state.registry.discard(state.existingSession.id);
  const session = await createFreshSession(state);
  emitUserMessage(state.client);
  await waitFor(() => state.registry.get(session.id)?.title === "Fix session title");

  const generated = state.client.calls.find(([method]) => method === "generate")[1];
  assert.equal(generated.model, "session-model");
  assert.equal(generated.modelProvider, "provider:entity-one");
  assert.equal(generated.reasoningEffort, "high");
  assert.equal(state.registry.get(session.id).title, "Fix session title");
  assert.equal(state.client.calls.some(([method]) => method === "set"), false);
});

test("Codex title generation uses thread model settings for legacy sessions without a selection", async (t) => {
  const state = fixture(t, {}, { withoutModelSelection: true });
  state.registry.discard(state.existingSession.id);
  const session = await createFreshSession(state, false);
  emitUserMessage(state.client);
  await waitFor(() => state.registry.get(session.id)?.title === "Fix session title");

  const generated = state.client.calls.find(([method]) => method === "generate")[1];
  assert.equal(generated.model, "selected-model");
  assert.equal(generated.modelProvider, "selected-provider");
});

test("Codex title generation waits for completion and deduplicates user-message events", async (t) => {
  let finish;
  const state = fixture(t, { generate: () => new Promise((resolve) => { finish = resolve; }) });
  state.registry.discard(state.existingSession.id);
  const session = await createFreshSession(state);
  emitUserMessage(state.client, "inProgress");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.client.calls.some(([method]) => method === "generate"), false);

  emitUserMessage(state.client);
  emitUserMessage(state.client);
  await waitFor(() => state.client.calls.some(([method]) => method === "generate"));
  assert.equal(state.client.calls.filter(([method]) => method === "generate").length, 1);
  finish('{"title":"Name one session"}');
  await waitFor(() => state.registry.get(session.id)?.title === "Name one session");
});

test("Codex title generation ignores an existing provider name", async (t) => {
  const state = fixture(t, { title: "Manual name" });
  state.registry.discard(state.existingSession.id);
  const session = await createFreshSession(state);
  emitUserMessage(state.client);
  await waitFor(() => state.registry.get(session.id)?.title === "Fix session title");
  assert.equal(state.client.title, "Manual name");
});

test("manual rename wins over a late generated Codex title", async (t) => {
  let finish;
  const state = fixture(t, { generate: () => new Promise((resolve) => { finish = resolve; }) });
  state.registry.discard(state.existingSession.id);
  const session = await createFreshSession(state);
  emitUserMessage(state.client);
  await waitFor(() => state.client.calls.some(([method]) => method === "generate"));

  await state.bridge.renameSession(session, "Chosen by user");
  finish('{"title":"Late automatic title"}');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.registry.get(session.id).title, "Chosen by user");
  assert.equal(state.client.calls.some(([method]) => method === "set"), false);
});

test("malformed Codex title output is diagnostic-only", async (t) => {
  const state = fixture(t, { generate: async () => "not json" });
  state.registry.discard(state.existingSession.id);
  await createFreshSession(state);
  emitUserMessage(state.client);
  await waitFor(() => state.diagnostics.some(({ code }) => code === "CODEX_THREAD_TITLE_GENERATION_FAILED"));
  emitUserMessage(state.client, "completed", "thread-title", "turn-two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.client.calls.filter(([method]) => method === "generate").length, 1);
  assert.equal(state.client.calls.some(([method]) => method === "set"), false);
});

test("existing sessions are never eligible for automatic title generation", async (t) => {
  const state = fixture(t);
  emitUserMessage(state.client, "completed", "thread-title", "turn-two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.client.calls.some(([method]) => method === "generate"), false);
  assert.equal(state.registry.get(state.existingSession.id).title, undefined);
});

test("clearing a generated title never re-arms later turns or reconnects", async (t) => {
  const state = fixture(t);
  state.registry.discard(state.existingSession.id);
  const session = await createFreshSession(state);
  emitUserMessage(state.client);
  await waitFor(() => state.registry.get(session.id)?.title === "Fix session title");
  await state.bridge.renameSession(state.registry.get(session.id), "");

  emitUserMessage(state.client, "completed", "thread-title", "turn-two");
  await new Promise((resolve) => setImmediate(resolve));
  state.client.emit("disconnect");
  await state.bridge.ensureReady();
  emitUserMessage(state.client, "completed", "thread-title", "turn-three");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.registry.get(session.id).title, undefined);
  assert.equal(state.client.calls.filter(([method]) => method === "generate").length, 1);
});

test("ephemeral title threads are not projected as AI Sessions", async (t) => {
  const state = fixture(t);
  state.client.emit("event", {
    type: "thread",
    thread: { id: "temporary-title", cwd: "/workspace", ephemeral: true, status: { type: "idle" } },
  });
  emitUserMessage(state.client, "completed", "temporary-title");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.registry.getByProviderSessionId("codex", "temporary-title"), undefined);
  assert.equal(state.client.calls.some(([method]) => method === "generate"), false);
});

test("Codex title prompt and structured response normalization stay bounded", () => {
  const prompt = codexThreadTitlePrompt("标题".repeat(1_000));
  assert.ok(Buffer.byteLength(prompt, "utf8") <= CODEX_THREAD_TITLE_PROMPT_MAX_BYTES);
  assert.equal(parseCodexThreadTitle('{"title":"  `Fix   title!`  "}'), "Fix title");
  assert.equal(parseCodexThreadTitle('{"title":"valid","extra":true}'), undefined);
});

test("Codex client isolates and cleans up an ephemeral structured title turn", async () => {
  const client = new CodexAppServerClient({ command: "codex" });
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") return { config: { mcp_servers: { dangerous: { command: "tool" } } } };
    if (method === "thread/start") {
      return {
        thread: { id: "temporary-title", ephemeral: true },
        model: "session-model",
        modelProvider: "session-provider",
        sandbox: { type: "readOnly" },
      };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "temporary-title",
            turnId: "temporary-turn",
            item: { type: "agentMessage", text: '{"title":"Generated title"}' },
          },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: { threadId: "temporary-title", turn: { id: "temporary-turn", status: "completed" } },
        });
      });
      return { turn: { id: "temporary-turn" } };
    }
    return {};
  };

  const response = await client.runEphemeralStructuredTurn({
    cwd: "/workspace",
    model: "session-model",
    modelProvider: "session-provider",
    reasoningEffort: "high",
    prompt: "Generate title",
    outputSchema: { type: "object" },
  });

  assert.equal(response, '{"title":"Generated title"}');
  assert.deepEqual(requests.map(({ method }) => method), ["config/read", "thread/start", "turn/start", "thread/unsubscribe"]);
  const start = requests[1].params;
  assert.equal(start.model, "session-model");
  assert.equal(start.modelProvider, "session-provider");
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, "read-only");
  assert.deepEqual(start.runtimeWorkspaceRoots, []);
  assert.deepEqual(start.dynamicTools, []);
  assert.deepEqual(start.environments, []);
  assert.equal(start.config["mcp_servers.dangerous.enabled"], false);
  assert.equal("mcp_servers" in start.config, false);
  assert.equal(requests[2].params.effort, "high");
});

test("Codex client rejects MCP names that cannot be safely disabled with a dotted override", async () => {
  const client = new CodexAppServerClient({ command: "codex" });
  client.request = async (method) => {
    if (method === "config/read") return { config: { mcp_servers: { "unsafe.name": { command: "tool" } } } };
    assert.fail(`unexpected request after unsafe MCP config: ${method}`);
  };

  await assert.rejects(() => client.runEphemeralStructuredTurn({
    cwd: "/workspace",
    model: "session-model",
    modelProvider: "session-provider",
    prompt: "Generate title",
    outputSchema: { type: "object" },
  }), /cannot be represented as a thread config path/);
});
