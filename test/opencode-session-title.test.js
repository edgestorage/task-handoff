const assert = require("node:assert/strict");
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
const { OpenCodeSessionBridge } = require("../packages/ai-session-runtime/src/opencode.ts");
const { requestControlledAiSessionTitle } = require("../packages/controlled-instance/src/web/session-title-model.ts");

const DEFAULT_TITLE = "New session - 2026-11-01T13:52:51.866Z";
const MODEL_SELECTION = {
  modelEntityId: "mdl_title",
  modelName: "Title model",
  modelUpstreamName: "upstream-title-model",
};

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function titleFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-title-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const calls = [];
  const diagnostics = [];
  const sessions = new Map();
  const messages = new Map();
  const generateTitle = options.generateTitle || (async () => '{"title":"Fix OpenCode titles"}');
  const fake = {
    health: async () => ({ healthy: true, version: "1.19.4" }),
    subscribeGlobal: async (_listener, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    createSession: async (directory, model) => {
      const session = {
        id: "ses_title",
        directory,
        title: options.title || DEFAULT_TITLE,
        version: "1.19.4",
        ...(options.parentID ? { parentID: options.parentID } : {}),
        ...(model ? { model: { id: model.modelID, providerID: model.providerID, variant: model.variant } } : {}),
        time: { created: 1_760_000_000_000, updated: 1_760_000_000_001 },
      };
      sessions.set(session.id, session);
      messages.set(session.id, []);
      return session;
    },
    getSession: async (id) => sessions.get(id),
    status: async () => ({}),
    messages: async (id) => messages.get(id) || [],
    permissions: async () => [],
    renameSession: async (id, directory, title) => {
      calls.push(["rename", id, directory, title]);
      const updated = { ...sessions.get(id), title, time: { ...sessions.get(id).time, updated: 1_760_000_000_100 } };
      sessions.set(id, updated);
      return updated;
    },
    promptAsync: async (...args) => calls.push(["prompt", ...args]),
    setPermission: async (...args) => calls.push(["set-permission", ...args]),
    abort: async () => true,
  };
  const bridge = new OpenCodeSessionBridge(registry, {
    connection: () => ({ endpoint: "http://unused", headers: {} }),
    workspaceRoots: () => ["/workspace"],
    resolveModelSelection: () => ({ providerID: "task-handoff-mdl_title", modelID: "upstream-title-model" }),
    projectModelSelection: () => MODEL_SELECTION,
    generateTitle: async (input) => {
      calls.push(["generate", input]);
      return generateTitle(input);
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  bridge.client = fake;
  t.after(() => bridge.close());
  return { bridge, calls, diagnostics, messages, registry, sessions };
}

function userMessage(text = "请修复 OpenCode 的自动标题") {
  return [{
    info: { id: "msg_user", sessionID: "ses_title", role: "user", time: { created: 1_760_000_000_010 } },
    parts: [{ id: "part_user", sessionID: "ses_title", messageID: "msg_user", type: "text", text }],
  }];
}

async function createAndReadWithPrompt(state) {
  const created = await state.bridge.createSession({
    cwd: "/workspace/project",
    modelSelection: MODEL_SELECTION,
    reasoningEffort: "high",
  });
  state.messages.set(created.providerSessionId, userMessage());
  await state.bridge.readSession(created.providerSessionId);
  return state.registry.getByProviderSessionId("opencode", created.providerSessionId);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for asynchronous OpenCode title generation.");
}

test("OpenCode generates a title with the session's selected model and reasoning effort", async (t) => {
  const state = titleFixture(t);
  const session = await createAndReadWithPrompt(state);
  await waitFor(() => state.registry.get(session.id)?.title === "Fix OpenCode titles");

  const generated = state.calls.find(([kind]) => kind === "generate")[1];
  assert.deepEqual(generated.modelSelection, MODEL_SELECTION);
  assert.equal(generated.reasoningEffort, "high");
  assert.match(generated.prompt, /请修复 OpenCode 的自动标题/);
  assert.equal(generated.outputSchema.required[0], "title");
  assert.deepEqual(state.calls.find(([kind]) => kind === "rename"), [
    "rename",
    "ses_title",
    "/workspace/project",
    "Fix OpenCode titles",
  ]);
  assert.equal(state.sessions.get("ses_title").title, "Fix OpenCode titles");
  assert.equal(state.registry.get(session.id).title, "Fix OpenCode titles");
});

test("OpenCode title generation is attempted once per session", async (t) => {
  const state = titleFixture(t);
  const session = await createAndReadWithPrompt(state);
  await waitFor(() => state.registry.get(session.id)?.title === "Fix OpenCode titles");
  await state.bridge.readSession("ses_title");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.filter(([kind]) => kind === "generate").length, 1);
});

test("manual OpenCode rename wins over an in-flight generated title", async (t) => {
  const pending = deferred();
  const state = titleFixture(t, { generateTitle: () => pending.promise });
  const session = await createAndReadWithPrompt(state);
  await waitFor(() => state.calls.some(([kind]) => kind === "generate"));

  await state.bridge.renameSession(state.registry.get(session.id), "Chosen by user");
  pending.resolve('{"title":"Late automatic title"}');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.sessions.get("ses_title").title, "Chosen by user");
  assert.equal(state.registry.get(session.id).title, "Chosen by user");
  assert.equal(state.calls.filter(([kind]) => kind === "rename").length, 1);
});

test("an external OpenCode rename cancels an in-flight generated title", async (t) => {
  const pending = deferred();
  const state = titleFixture(t, { generateTitle: () => pending.promise });
  const session = await createAndReadWithPrompt(state);
  await waitFor(() => state.calls.some(([kind]) => kind === "generate"));

  state.sessions.set("ses_title", { ...state.sessions.get("ses_title"), title: "Renamed in OpenCode" });
  await state.bridge.onGlobalEvent({
    directory: "/workspace/project",
    payload: {
      type: "session.updated",
      properties: { info: { id: "ses_title", title: "Renamed in OpenCode" } },
    },
  });
  pending.resolve('{"title":"Late automatic title"}');
  await waitFor(() => state.registry.get(session.id)?.title === "Renamed in OpenCode");

  assert.equal(state.sessions.get("ses_title").title, "Renamed in OpenCode");
  assert.equal(state.registry.get(session.id).title, "Renamed in OpenCode");
  assert.equal(state.calls.some(([kind]) => kind === "rename"), false);
});

test("non-default and subagent OpenCode sessions never generate titles", async (t) => {
  const titled = titleFixture(t, { title: "Manual title" });
  await createAndReadWithPrompt(titled);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(titled.calls.some(([kind]) => kind === "generate"), false);

  const child = titleFixture(t, { parentID: "ses_parent" });
  await createAndReadWithPrompt(child);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.calls.some(([kind]) => kind === "generate"), false);
});

test("malformed OpenCode title output is diagnostic-only", async (t) => {
  const state = titleFixture(t, { generateTitle: async () => "not json" });
  const session = await createAndReadWithPrompt(state);
  await waitFor(() => state.diagnostics.some(({ code }) => code === "OPENCODE_SESSION_TITLE_GENERATION_FAILED"));
  await state.bridge.readSession("ses_title");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.calls.filter(([kind]) => kind === "generate").length, 1);
  assert.equal(state.sessions.get("ses_title").title, DEFAULT_TITLE);
  assert.equal(state.registry.get(session.id).title, DEFAULT_TITLE);
});

test("controlled title requests prefer Responses and preserve canonical reasoning effort", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: '{"title":"Generated title"}' }] }],
    }), { status: 200 });
  };
  const catalog = {
    protocolVersion: "2026-10-02",
    instanceId: "inst_title",
    updatedAt: "2026-11-01T00:00:00.000Z",
    entities: [{
      id: "mdl_title",
      protocols: ["openai-chat-completions", "openai-responses"],
      modelNames: [{ name: "Title model", upstreamName: "upstream-title-model", order: 0 }],
      routes: [
        { protocol: "openai-chat-completions", baseUrl: "http://relay.test/entities/mdl_title/chat/v1" },
        { protocol: "openai-responses", baseUrl: "http://relay.test/entities/mdl_title/responses/v1" },
      ],
    }],
  };
  const title = await requestControlledAiSessionTitle({
    catalog,
    modelSelection: MODEL_SELECTION,
    reasoningEffort: "none",
    prompt: "Generate a title",
    outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    env: { TASK_HANDOFF_REGISTRATION_TOKEN: "instance-token" },
    fetchImpl,
  });

  assert.equal(title, '{"title":"Generated title"}');
  assert.equal(requests[0].url, "http://relay.test/entities/mdl_title/responses/v1/responses");
  assert.equal(requests[0].init.headers.authorization, "Bearer instance-token");
  assert.equal(requests[0].body.model, "upstream-title-model");
  assert.deepEqual(requests[0].body.reasoning, { effort: "none" });
  assert.equal(requests[0].body.text.format.type, "json_schema");
});

test("controlled title requests fall back to Chat Completions without remapping effort", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Chat title"}' } }] }), { status: 200 });
  };
  const catalog = {
    protocolVersion: "2026-10-02",
    instanceId: "inst_title",
    updatedAt: "2026-11-01T00:00:00.000Z",
    entities: [{
      id: "mdl_title",
      protocols: ["openai-chat-completions"],
      modelNames: [{ name: "Title model", upstreamName: "upstream-title-model", order: 0 }],
      routes: [{ protocol: "openai-chat-completions", baseUrl: "http://relay.test/entities/mdl_title/chat/v1" }],
    }],
  };
  const title = await requestControlledAiSessionTitle({
    catalog,
    modelSelection: MODEL_SELECTION,
    reasoningEffort: "none",
    prompt: "Generate a title",
    outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    env: { TASK_HANDOFF_REGISTRATION_TOKEN: "instance-token" },
    fetchImpl,
  });

  assert.equal(title, '{"title":"Chat title"}');
  assert.equal(requests[0].url, "http://relay.test/entities/mdl_title/chat/v1/chat/completions");
  assert.equal(requests[0].body.reasoning_effort, "none");
  assert.equal(requests[0].body.response_format.type, "json_schema");
});

test("controlled title requests keep direct-catalog credentials inside the instance", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ output_text: '{"title":"Direct title"}' }), { status: 200 });
  };
  const title = await requestControlledAiSessionTitle({
    catalog: {
      protocolVersion: "2026-08-27",
      instanceId: "inst_title",
      updatedAt: "2026-11-01T00:00:00.000Z",
      entities: [{
        id: "mdl_title",
        endpoint: "https://models.example.test/v1",
        key: "upstream-key",
        protocols: ["openai-responses"],
        modelNames: [{ name: "Title model", upstreamName: "upstream-title-model", order: 0 }],
      }],
    },
    modelSelection: MODEL_SELECTION,
    prompt: "Generate a title",
    outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    env: {},
    fetchImpl,
  });

  assert.equal(title, '{"title":"Direct title"}');
  assert.equal(requests[0].url, "https://models.example.test/v1/responses");
  assert.equal(requests[0].init.headers.authorization, "Bearer upstream-key");
});
