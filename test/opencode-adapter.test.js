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
const { AiSessionDiscoveryCoordinator } = require("../packages/ai-session-runtime/src/ai-session-discovery.ts");
const { AiSessionProviderRegistry } = require("../packages/ai-session-runtime/src/ai-session-provider-registry.ts");
const { AiSessionHistoryListSchema } = require("../packages/protocol/src/ai-sessions.ts");
const { aiSessionProviderCapability, normalizeControlledInstanceCapabilities } = require("../packages/protocol/src/control-plane.ts");
const { directoryAiSessionProviderCapability } = require("../packages/protocol/src/control-plane-directory.ts");
const { consumeOpenCodeSse, OpenCodeClient } = require("../packages/ai-session-runtime/src/opencode/client.ts");
const { projectOpenCodeSession } = require("../packages/ai-session-runtime/src/opencode/projector.ts");
const {
  OpenCodePermissionSchema,
  OpenCodeSessionSchema,
  OpenCodeSessionStatusSchema,
} = require("../packages/ai-session-runtime/src/opencode/wire.ts");
const { OpenCodeSessionBridge } = require("../packages/ai-session-runtime/src/opencode.ts");
const { createOpenCodeRuntime } = require("../packages/app-runtime/src/managed-app-definitions/opencode/runtime.ts");

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

for (const version of ["1.18.20", "1.18.21"]) {
  test(`OpenCode ${version} wire fixture sanitizes into the current minimal contract`, () => {
    const value = fixture(`opencode-v${version}-session.json`);
    assert.equal(OpenCodeSessionSchema.parse(value.session).version, version);
    assert.equal(OpenCodeSessionStatusSchema.parse(value.status).type, version === "1.18.20" ? "busy" : "retry");
    const permission = OpenCodePermissionSchema.parse(value.permission);
    assert.equal(permission.action, version === "1.18.20" ? "bash" : "edit");
    assert.deepEqual(permission.resources, value.permission.patterns);
  });
}

test("provider registry is the single registration and capability source", async () => {
  const controlled = [];
  const discovered = [];
  const provider = { agent: "opencode", interrupt: async () => undefined };
  const capability = {
    agent: "opencode",
    actions: { create: true, send: true, queue: true, steer: false, interrupt: true, archive: true, delete: true, fork: true, approvalDecisions: ["allow", "deny"] },
    timeline: { sessionRead: true, turnRead: true, liveItems: true },
  };
  const providers = new AiSessionProviderRegistry(
    { register: (value) => controlled.push(value.agent) },
    { register: (value) => discovered.push(value.id) },
  );
  providers.register({ agent: "opencode", controlProvider: provider, discoveryProvider: { id: "opencode-discovery", refresh: async () => undefined }, capability });
  assert.deepEqual(controlled, ["opencode"]);
  assert.deepEqual(discovered, ["opencode-discovery"]);
  assert.deepEqual(providers.capabilities(), [capability]);
  assert.throws(() => providers.register({ agent: "opencode", controlProvider: provider, capability }), /Duplicate/);
});

test("provider registry projects version-dependent capabilities on every read", () => {
  let settingsSupported = false;
  const provider = { agent: "codex", interrupt: async () => undefined };
  const providers = new AiSessionProviderRegistry(
    { register: () => undefined },
    { register: () => undefined },
  );
  providers.register({
    agent: "codex",
    controlProvider: provider,
    capability: () => ({
      agent: "codex",
      actions: { create: true, send: true, queue: true, steer: true, interrupt: true, archive: true, delete: true, fork: true, approvalDecisions: ["allow", "deny", "skip"] },
      timeline: { sessionRead: true, turnRead: true, liveItems: true },
      modelSelection: { selectModelAtCreate: true, selectProviderAtCreate: true, switchModelWithinProvider: settingsSupported, switchProviderDuringSession: false },
      reasoningEffort: { selectAtCreate: settingsSupported, updateDuringSession: settingsSupported },
    }),
  });
  assert.equal(providers.capability("codex").reasoningEffort.selectAtCreate, false);
  assert.equal(providers.capabilities()[0].modelSelection.switchModelWithinProvider, false);
  assert.equal(providers.capabilities()[0].reasoningEffort.updateDuringSession, false);
  settingsSupported = true;
  assert.equal(providers.capability("codex").reasoningEffort.selectAtCreate, true);
  assert.equal(providers.capabilities()[0].modelSelection.switchModelWithinProvider, true);
  assert.equal(providers.capabilities()[0].reasoningEffort.updateDuringSession, true);
});

test("AI session discovery isolates provider failures", async () => {
  const failures = [];
  const calls = [];
  const coordinator = new AiSessionDiscoveryCoordinator((failure) => failures.push(failure));
  coordinator.register({ id: "unavailable-opencode", refresh: async () => { throw Object.assign(new Error("missing"), { code: "APP_DEPENDENCY_MISSING" }); } });
  coordinator.register({ id: "codex", refresh: async () => calls.push("codex") });

  await coordinator.refresh({ registry: {}, appSessions: [] });

  assert.deepEqual(calls, ["codex"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].providerId, "unavailable-opencode");
  assert.equal(failures[0].error.code, "APP_DEPENDENCY_MISSING");
});

test("v0.0.21 capability omission disables only provider features while current history accepts OpenCode", () => {
  const legacy = normalizeControlledInstanceCapabilities({ features: { appRuntime: true } });
  assert.equal(legacy.features.appRuntime, true);
  assert.deepEqual(legacy.features.aiSessionProviders, []);
  assert.equal(aiSessionProviderCapability(legacy, "opencode"), undefined);
  assert.equal(directoryAiSessionProviderCapability({ aiSessionTimeline: {} }, "opencode"), undefined);
  const parsed = AiSessionHistoryListSchema.parse({ items: [{
    id: "history-opencode",
    agent: "opencode",
    creationSource: "ai-session",
    providerSessionId: "ses_history",
    cwd: "/workspace/project",
    lastActiveAt: "2026-08-23T00:00:00.000Z",
    archivedAt: "2026-08-23T00:00:01.000Z",
  }] });
  assert.equal(parsed.items[0].agent, "opencode");
});

test("OpenCode projector derives waiting approval, turns, tools, patches, retries, and deterministic ids", () => {
  const projection = projectOpenCodeSession({
    session: {
      id: "ses_1", directory: "/workspace/project", title: "Adapter", version: "1.18.21",
      time: { created: 1700000000000, updated: 1700000005000 },
    },
    status: { type: "retry", attempt: 1, message: "retrying", next: 1700000006000 },
    permissions: [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["git status"] }],
    messages: [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 1700000001000 } },
        parts: [
          { id: "prt_user", sessionID: "ses_1", messageID: "msg_user", type: "text", text: "Inspect" },
          { id: "prt_file", sessionID: "ses_1", messageID: "msg_user", type: "file", mime: "text/plain", filename: "a.txt", url: "file:///workspace/project/a.txt" },
        ],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1700000002000 } },
        parts: [
          { id: "prt_text", sessionID: "ses_1", messageID: "msg_assistant", type: "text", text: "Working" },
          { id: "prt_tool", sessionID: "ses_1", messageID: "msg_assistant", type: "tool", tool: "bash", state: { status: "running", input: { command: "git status" }, time: { start: 1700000003000 } } },
          { id: "prt_patch", sessionID: "ses_1", messageID: "msg_assistant", type: "patch", files: ["src/a.ts"] },
          { id: "prt_retry", sessionID: "ses_1", messageID: "msg_assistant", type: "retry", attempt: 1, error: { data: { message: "rate limited" } } },
        ],
      },
    ],
  });
  assert.equal(projection.snapshot.status, "waiting");
  assert.equal(projection.snapshot.phase, "approval");
  assert.equal(projection.snapshot.activeTurnId, "msg_user");
  assert.equal(projection.snapshot.actions.approval, true);
  assert.equal(projection.snapshot.turns[0].status, "waiting");
  assert.equal(projection.turnByMessageId.get("msg_assistant"), "msg_user");
  assert.deepEqual(projection.timeline.map((item) => item.id), ["msg_user", "prt_text", "prt_tool", "prt_patch", "prt_retry"]);
  assert.equal(projection.timeline.find((item) => item.id === "prt_tool").status, "running");
});

test("OpenCode projector takes authoritative model settings from the latest user message", () => {
  const projection = projectOpenCodeSession({
    session: {
      id: "ses_model", directory: "/workspace", title: "Model", model: { id: "old", providerID: "provider_old", variant: "medium" },
      time: { created: 1700000000000, updated: 1700000001000 },
    },
    status: { type: "idle" },
    permissions: [],
    messages: [{
      info: {
        id: "msg_model", sessionID: "ses_model", role: "user", time: { created: 1700000001000 },
        model: { providerID: "provider_new", modelID: "new", variant: "high" },
      },
      parts: [{ id: "part_model", sessionID: "ses_model", messageID: "msg_model", type: "text", text: "Use it" }],
    }],
    projectModelSelection: (providerID, modelID) => ({ modelEntityId: providerID, modelName: modelID }),
  });
  assert.deepEqual(projection.snapshot.modelSelection, { modelEntityId: "provider_new", modelName: "new" });
  assert.equal(projection.snapshot.reasoningEffort, "high");
});

test("OpenCode retry state stays out of the assistant summary and clears stale activity", () => {
  const registry = createAiSessionRegistry({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-retry-")) });
  registry.applyAdapterSnapshot({
    agent: "opencode",
    creationSource: "ai-session",
    providerSessionId: "ses_retry",
    cwd: "/workspace",
    status: "running",
    phase: "thinking",
    summary: "stale retry message",
  });
  const projection = projectOpenCodeSession({
    session: {
      id: "ses_retry", directory: "/workspace", title: "Retry",
      time: { created: 1700000000000, updated: 1700000001000 },
    },
    status: { type: "retry", attempt: 2, message: "retrying provider", next: 1700000002000 },
    permissions: [],
    messages: [{
      info: { id: "msg_retry", sessionID: "ses_retry", role: "user", time: { created: 1700000000000 } },
      parts: [{ id: "part_retry", sessionID: "ses_retry", messageID: "msg_retry", type: "text", text: "Try it" }],
    }],
  });

  assert.equal(projection.snapshot.summary, undefined);
  assert.equal(projection.snapshot.replaceActivity, true);
  assert.equal(registry.applyAdapterSnapshot(projection.snapshot).summary, undefined);
});

test("OpenCode stages model settings until a real prompt applies them", async () => {
  const registry = createAiSessionRegistry({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-settings-")) });
  const session = registry.start({
    agent: "opencode",
    creationSource: "ai-session",
    providerSessionId: "ses_settings",
    cwd: "/workspace",
    status: "idle",
    modelSelection: { modelEntityId: "provider_old", modelName: "old" },
    reasoningEffort: "medium",
  });
  const prompts = [];
  const bridge = new OpenCodeSessionBridge(registry, {
    connection: () => ({ endpoint: "http://unused", headers: {} }),
    workspaceRoots: () => ["/workspace"],
    resolveModelSelection: (selection) => ({ providerID: selection.modelEntityId, modelID: selection.modelName }),
  });
  bridge.client = { promptAsync: async (...args) => prompts.push(args) };

  await bridge.updateModelSelection(session, { modelEntityId: "provider_new", modelName: "new" });
  await bridge.updateReasoningEffort(session, "high");
  assert.deepEqual(registry.get(session.id).modelSelection, { modelEntityId: "provider_old", modelName: "old" });
  assert.equal(registry.get(session.id).reasoningEffort, "medium");

  await bridge.startMessage(registry.get(session.id), {
    message: "Apply settings",
    messageId: "msg_settings",
    attachments: [],
    userMessageAttachments: [],
  });
  assert.deepEqual(prompts[0][4], { providerID: "provider_new", modelID: "new", variant: "high" });
  assert.deepEqual(registry.get(session.id).modelSelection, { modelEntityId: "provider_old", modelName: "old" });
  assert.equal(registry.get(session.id).reasoningEffort, "medium");
  bridge.close();
});

test("OpenCode global SSE accepts CRLF frames and sync events without properties", async () => {
  const received = [];
  const frames = [
    `data: ${JSON.stringify({ payload: { type: "server.connected", id: "evt_connected", properties: {} } })}\n\n`,
    `data: ${JSON.stringify({ directory: "/workspace", payload: { type: "sync", id: "evt_1", syncEvent: {} } })}\r\n\r\n`,
    `data: ${JSON.stringify({ directory: "/workspace", payload: { type: "session.status", properties: { sessionID: "ses_1" } } })}\n\n`,
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const abort = new AbortController();
  await consumeOpenCodeSse(stream, (event) => {
    received.push(event.payload.type);
    if (received.length === 3) abort.abort();
  }, abort.signal);
  assert.deepEqual(received, ["server.connected", "sync", "session.status"]);
});

test("OpenCode global discovery requests child sessions", async () => {
  const originalFetch = global.fetch;
  let requestUrl;
  global.fetch = async (url) => {
    requestUrl = new URL(String(url));
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new OpenCodeClient(() => ({ endpoint: "http://opencode.test", headers: {} }));
    await client.listGlobalSessions();
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requestUrl.pathname, "/experimental/session");
  assert.equal(requestUrl.searchParams.has("roots"), false);
  assert.equal(requestUrl.searchParams.get("archived"), "false");
});

test("OpenCode discovery restores forks and converges archived sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-discovery-"));
  const registry = createAiSessionRegistry({ dir: root });
  registry.start({ agent: "opencode", providerSessionId: "ses_archived", cwd: "/workspace/project", title: "Archived" });
  const child = {
    id: "ses_child",
    parentID: "ses_parent",
    directory: "/workspace/project",
    title: "Fork",
    version: "1.18.21",
    time: { created: 1700000000000, updated: 1700000001000 },
  };
  const bridge = new OpenCodeSessionBridge(registry, {
    connection: () => ({ endpoint: "http://unused", headers: {} }),
    workspaceRoots: () => ["/workspace"],
  });
  bridge.client = {
    health: async () => ({ healthy: true, version: "1.18.21" }),
    subscribeGlobal: async (_listener, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    listGlobalSessions: async () => ({ data: [child] }),
    getSession: async (id) => id === "ses_archived"
      ? { id, directory: "/workspace/project", title: "Archived", version: "1.18.21", time: { created: 1699999999000, updated: 1700000000000, archived: 1700000000500 } }
      : child,
    status: async () => ({}),
    messages: async () => [],
    permissions: async () => [],
  };

  await bridge.refresh({ registry, appSessions: [] });
  assert.equal(registry.getByProviderSessionId("opencode", "ses_archived"), undefined);
  assert.equal(registry.getByProviderSessionId("opencode", "ses_child").lineage.parentProviderSessionId, "ses_parent");

  await bridge.onGlobalEvent({
    directory: "/workspace/project",
    payload: { type: "session.updated", properties: { info: { ...child, time: { ...child.time, archived: 1700000002000 } } } },
  });
  assert.equal(registry.getByProviderSessionId("opencode", "ses_child"), undefined);
  bridge.close();
});

test("OpenCode version diagnostics are visible, non-blocking, and deduplicated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-version-"));
  const diagnostics = [];
  const bridge = new OpenCodeSessionBridge(createAiSessionRegistry({ dir: root }), {
    connection: () => ({ endpoint: "http://unused", headers: {} }),
    workspaceRoots: () => ["/workspace"],
    onDiagnostic: (event) => diagnostics.push(event),
  });
  bridge.client = {
    health: async () => ({ healthy: true, version: "1.19.0" }),
    subscribeGlobal: async (_listener, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
  };
  await bridge.ensureReady();
  await bridge.ensureReady();
  assert.deepEqual(diagnostics, [{ code: "OPENCODE_VERSION_UNVERIFIED", version: "1.19.0" }]);
  bridge.close();
});

test("OpenCode bridge implements lifecycle, attachments, inclusive-turn fork, and permission replies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-"));
  const registry = createAiSessionRegistry({ dir: root });
  const calls = [];
  const sessions = new Map();
  const messages = new Map();
  const permissions = new Map();
  const fake = {
    health: async () => ({ healthy: true, version: "1.18.21" }),
    subscribeGlobal: async (_listener, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    createSession: async (directory) => {
      const session = { id: "ses_created", directory, title: "Created", version: "1.18.21", time: { created: Date.now(), updated: Date.now() } };
      sessions.set(session.id, session); messages.set(session.id, []); return session;
    },
    getSession: async (id) => sessions.get(id),
    status: async () => ({}),
    messages: async (id) => messages.get(id) || [],
    permissions: async () => [...permissions.values()],
    promptAsync: async (...args) => calls.push(["prompt", ...args]),
    forkSession: async (id, directory, messageID) => {
      calls.push(["fork", id, directory, messageID]);
      const session = { id: "ses_fork", parentID: id, directory, title: "Fork", version: "1.18.21", time: { created: Date.now(), updated: Date.now() } };
      sessions.set(session.id, session); messages.set(session.id, []); return session;
    },
    replyPermission: async (...args) => { calls.push(["permission", ...args]); permissions.clear(); return true; },
    abort: async (...args) => { calls.push(["abort", ...args]); return true; },
    archiveSession: async (...args) => { calls.push(["archive", ...args]); return sessions.get(args[0]); },
    deleteSession: async (...args) => { calls.push(["delete", ...args]); sessions.delete(args[0]); return true; },
  };
  const bridge = new OpenCodeSessionBridge(registry, { connection: () => ({ endpoint: "http://unused", headers: {} }), workspaceRoots: () => ["/workspace"] });
  bridge.client = fake;
  const created = await bridge.createSession({ cwd: "/workspace/project" });
  const session = registry.getByProviderSessionId("opencode", created.providerSessionId);
  const runtimeFile = "/workspace/project/input.txt";
  await bridge.startMessage(session, {
    message: "Hello",
    messageId: "msg_new",
    userMessageAttachments: [],
    attachments: [
      { id: "inline", kind: "file", name: "inline.txt", mime: "text/plain", size: 5, source: { type: "inline", encoding: "base64", data: "aGVsbG8=" } },
      { id: "runtime", kind: "file", name: "input.txt", mime: "text/plain", size: 18, source: { type: "runtime-path", path: runtimeFile } },
    ],
  });
  assert.deepEqual(calls[0].slice(0, 4), ["prompt", "ses_created", "/workspace/project", "msg_new"]);
  assert.equal(calls[0][4][1].url, "data:text/plain;base64,aGVsbG8=");
  assert.equal(calls[0][4][2].url, "file:///workspace/project/input.txt");
  await assert.rejects(() => bridge.startMessage(session, {
    message: "Outside",
    messageId: "msg_outside",
    attachments: [{ id: "outside", kind: "file", name: "outside.txt", mime: "text/plain", size: 1, source: { type: "runtime-path", path: "/tmp/outside.txt" } }],
  }), /inside the session workspace/i);

  messages.set("ses_created", [
    { info: { id: "msg_a", sessionID: "ses_created", role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "msg_b", sessionID: "ses_created", role: "assistant", parentID: "msg_a", time: { created: 2, completed: 3 } }, parts: [] },
    { info: { id: "msg_c", sessionID: "ses_created", role: "user", time: { created: 4 } }, parts: [] },
  ]);
  const fork = await bridge.forkSession({ source: session, throughTurnId: "msg_a", providerThroughTurnId: "msg_a" });
  assert.deepEqual(calls.find((call) => call[0] === "fork"), ["fork", "ses_created", "/workspace/project", "msg_c"]);
  assert.equal(registry.getByProviderSessionId("opencode", fork.providerSessionId).lineage.throughTurnId, "msg_a");
  await bridge.readSession(fork.providerSessionId);
  assert.equal(registry.getByProviderSessionId("opencode", fork.providerSessionId).lineage.throughTurnId, "msg_a");

  permissions.set("per_1", { id: "per_1", sessionID: "ses_created", action: "bash", resources: ["pwd"] });
  await bridge.resolveApproval(registry.getByProviderSessionId("opencode", "ses_created"), "allow");
  assert.deepEqual(calls.find((call) => call[0] === "permission"), ["permission", "per_1", "/workspace/project", "once"]);
  permissions.set("per_2", { id: "per_2", sessionID: "ses_created", action: "edit", resources: ["src/a.ts"] });
  await bridge.resolveApproval(registry.getByProviderSessionId("opencode", "ses_created"), "deny");
  assert.deepEqual(calls.find((call) => call[0] === "permission" && call[1] === "per_2"), ["permission", "per_2", "/workspace/project", "reject"]);
  await assert.rejects(() => bridge.resolveApproval(session, "skip"), /no equivalent/i);

  await bridge.interrupt(registry.getByProviderSessionId("opencode", "ses_created"));
  assert.deepEqual(calls.find((call) => call[0] === "abort"), ["abort", "ses_created", "/workspace/project"]);
  assert.equal(await bridge.activeSessionExists("ses_created"), true);
  await bridge.archiveSession("ses_created");
  assert.deepEqual(calls.find((call) => call[0] === "archive"), ["archive", "ses_created", "/workspace/project"]);
  await bridge.deleteSession("ses_fork");
  assert.deepEqual(calls.find((call) => call[0] === "delete"), ["delete", "ses_fork", "/workspace/project"]);
  bridge.close();
});

test("OpenCode shared runtime keeps Basic auth private and attaches TTY sessions to the owned server", () => {
  const child = Object.assign(new (require("node:events").EventEmitter)(), { killed: false, exitCode: null, pid: 4321 });
  let readiness;
  const stopped = [];
  const runtime = createOpenCodeRuntime({
    paths: { logDir: fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-log-")) },
    allocatePort: () => 43210,
    hasCommand: () => true,
    spawnLogged: () => child,
    stopProcessTree: (value) => stopped.push(value),
    waitForHttp: (url, headers) => { readiness = { url, headers }; },
  });
  const app = { id: "opencode", command: "opencode" };
  const publicInfo = runtime.sharedResource.ensure({ app, cwd: "/workspace", env: {} });
  const connection = runtime.sharedResource.privateConnection();
  assert.equal(publicInfo.details.endpoint, "http://127.0.0.1:43210");
  assert.equal(JSON.stringify(publicInfo).includes("Authorization"), false);
  assert.equal(readiness.headers.Authorization, connection.headers.Authorization);
  const launch = runtime.prepareTtyLaunch({ app, sessionId: "app_1", command: "opencode", cwd: "/workspace", env: {}, launchArgs: [], resumeArgs: ["--session", "ses_1"] });
  assert.deepEqual(launch.args, ["attach", "http://127.0.0.1:43210", "--dir", "/workspace", "--session", "ses_1"]);
  assert.equal(launch.env.OPENCODE_CLIENT, "task-handoff");
  runtime.stopAll();
  assert.equal(stopped.length, 1);
});
