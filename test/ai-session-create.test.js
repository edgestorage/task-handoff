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
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionCreateCoordinator } = require("../packages/ai-session-runtime/src/ai-session-create.ts");
const { AiSessionForkCoordinator } = require("../packages/ai-session-runtime/src/ai-session-fork.ts");
const { AiSessionCloseCoordinator } = require("../packages/ai-session-runtime/src/ai-session-close.ts");
const { AiSessionHistoryStore } = require("../packages/ai-session-runtime/src/ai-session-history-store.ts");
const { AiSessionOpenAppCoordinator } = require("../packages/ai-session-runtime/src/ai-session-open-app.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const {
  CodexAppServerClient,
  CodexAppServerRpcError,
  codexThreadForkCapabilities,
} = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");

function runtime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-create-"));
  const registry = createAiSessionRegistry({ dir: root });
  const controller = new AiSessionController(registry);
  return { registry, controller };
}

test("AI session create coordinator deduplicates a request through its first provider turn", async () => {
  const { registry, controller } = runtime();
  let creates = 0;
  let turns = 0;
  let release;
  controller.register({
    agent: "codex",
    async createSession({ cwd }) {
      creates += 1;
      return { providerSessionId: "thread-direct", cwd, creationSource: "ai-session" };
    },
    async startMessage(session, input) {
      turns += 1;
      await new Promise((resolve) => { release = resolve; });
      return { session, provider: "codex", action: "send" };
    },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const coordinator = new AiSessionCreateCoordinator({ registry, controller });
  const input = { agent: "codex", cwd: "/workspace", cwdFolderId: "folder-project", message: "Start", clientRequestId: "create-1" };
  const first = coordinator.create(input);
  const second = coordinator.create(input);
  assert.throws(
    () => coordinator.create({ ...input, message: "Different input" }),
    (error) => error.code === "AI_SESSION_CREATE_REQUEST_CONFLICT" && error.statusCode === 409,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  assert.equal(turns, 1);
  release();
  const [created, concurrent] = await Promise.all([first, second]);
  assert.deepEqual(concurrent, created);
  assert.equal(registry.get(created.aiSessionId).creationSource, "ai-session");
  assert.equal(registry.get(created.aiSessionId).appSessionId, undefined);
  assert.equal(registry.get(created.aiSessionId).cwdFolderId, "folder-project");
  assert.equal((await coordinator.create(input)).disposition, "already-created");
  assert.throws(
    () => coordinator.create({ ...input, cwd: "/different-workspace" }),
    (error) => error.code === "AI_SESSION_CREATE_REQUEST_CONFLICT" && error.statusCode === 409,
  );
  assert.equal(creates, 1);
});

test("AI session create coordinator restores committed request identity after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-create-store-"));
  const operationStorePath = path.join(root, "operations.json");
  const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
  const controller = new AiSessionController(registry);
  let creates = 0;
  controller.register({
    id: "codex-restart",
    agent: "codex",
    async createSession(input) {
      creates += 1;
      return { providerSessionId: "provider-restart", cwd: input.cwd, creationSource: "ai-session" };
    },
    async startMessage() {},
  });
  const input = { agent: "codex", cwd: root, message: "Persist this turn.", clientRequestId: "request-restart" };
  const first = await new AiSessionCreateCoordinator({ registry, controller, operationStorePath }).create(input);
  const restored = await new AiSessionCreateCoordinator({ registry, controller, operationStorePath }).create(input);
  assert.equal(creates, 1);
  assert.equal(restored.disposition, "already-created");
  assert.equal(restored.aiSessionId, first.aiSessionId);
  assert.equal(restored.providerSessionId, first.providerSessionId);
});

test("AI session create coordinator removes the projection and provider thread when the first turn fails", async () => {
  const { registry, controller } = runtime();
  const deleted = [];
  const diagnostics = [];
  controller.register({
    agent: "codex",
    async createSession({ cwd }) { return { providerSessionId: "thread-failed", cwd, creationSource: "ai-session" }; },
    async startMessage() { throw new Error("turn/start failed"); },
    async deleteSession(id) { deleted.push(id); },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const coordinator = new AiSessionCreateCoordinator({ registry, controller, onDiagnostic: (entry) => diagnostics.push(entry) });
  await assert.rejects(
    coordinator.create({ agent: "codex", cwd: "/workspace", message: "Start", clientRequestId: "create-failed" }),
    (error) => error.code === "AI_SESSION_MATERIALIZATION_FAILED",
  );
  assert.deepEqual(deleted, ["thread-failed"]);
  assert.deepEqual(registry.all(), []);
  assert.equal(diagnostics[0].providerSessionId, "thread-failed");
});

test("AI session Fork creates an independent Direct session and deduplicates the request", async () => {
  const { registry, controller } = runtime();
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    appId: "codex-app-server",
    appSessionId: "shared-runtime",
    providerSessionId: "thread-source",
    cwd: "/workspace",
    actions: { send: true, fork: true },
    status: "idle",
  });
  const calls = [];
  controller.register({
    agent: "codex",
    async forkSession(input) {
      calls.push(input);
      const providerSessionId = `thread-fork-${calls.length}`;
      const lineage = { kind: "fork", parentProviderSessionId: input.source.providerSessionId, ...(input.throughTurnId ? { throughTurnId: input.throughTurnId } : {}) };
      registry.applyAdapterSnapshot({
        agent: "codex",
        creationSource: "ai-session",
        appId: "codex-app-server",
        providerSessionId,
        cwd: input.cwd,
        lineage,
        actions: { send: true, fork: true },
        status: "idle",
      });
      return { providerSessionId, cwd: input.cwd || input.source.cwd, creationSource: "ai-session", lineage };
    },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const coordinator = new AiSessionForkCoordinator({ registry, controller });
  const input = { clientRequestId: "fork-1", workspace: { mode: "current" } };
  const first = await coordinator.fork(source.id, input);
  const repeated = await coordinator.fork(source.id, input);

  assert.equal(first.disposition, "created");
  assert.equal(repeated.disposition, "already-created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, undefined);
  assert.equal(calls[0].providerThroughTurnId, undefined);
  assert.equal(registry.get(first.aiSessionId).appSessionId, undefined);
  assert.deepEqual(registry.get(first.aiSessionId).lineage, { kind: "fork", parentProviderSessionId: "thread-source" });
  assert.equal(registry.get(source.id).providerSessionId, "thread-source");
  assert.throws(
    () => coordinator.fork(source.id, { ...input, workspace: { mode: "managed-worktree" } }),
    (error) => error.code === "AI_SESSION_FORK_IDEMPOTENCY_CONFLICT",
  );
});

test("AI session Fork persists completed idempotency and creates independent branches for new request ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-fork-store-"));
  const operationStorePath = path.join(root, "operations.json");
  const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
  const controller = new AiSessionController(registry);
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread-fork-source",
    cwd: root,
    actions: { fork: true },
    status: "idle",
  });
  let calls = 0;
  controller.register({
    agent: "codex",
    async forkSession(input) {
      calls += 1;
      const providerSessionId = `thread-persisted-fork-${calls}`;
      registry.applyAdapterSnapshot({
        agent: "codex",
        creationSource: "ai-session",
        providerSessionId,
        cwd: input.cwd || input.source.cwd,
        lineage: { kind: "fork", parentProviderSessionId: input.source.providerSessionId },
        status: "idle",
      });
      return { providerSessionId, cwd: input.cwd || input.source.cwd, creationSource: "ai-session" };
    },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const coordinator = new AiSessionForkCoordinator({ registry, controller, operationStorePath });
  const input = { clientRequestId: "fork-persisted", workspace: { mode: "current" } };
  const [first, concurrent] = await Promise.all([coordinator.fork(source.id, input), coordinator.fork(source.id, input)]);
  const restored = await new AiSessionForkCoordinator({ registry, controller, operationStorePath }).fork(source.id, input);
  const independent = await coordinator.fork(source.id, { ...input, clientRequestId: "fork-independent" });

  assert.deepEqual(concurrent, first);
  assert.equal(restored.disposition, "already-created");
  assert.equal(restored.aiSessionId, first.aiSessionId);
  assert.notEqual(independent.aiSessionId, first.aiSessionId);
  assert.notEqual(independent.providerSessionId, first.providerSessionId);
  assert.equal(calls, 2);
});

test("AI session Fork resumes a provider-created saga stage through provider discovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-fork-provider-stage-"));
  const operationStorePath = path.join(root, "operations.json");
  const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
  const controller = new AiSessionController(registry);
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread-stage-source",
    cwd: root,
    actions: { fork: true },
    status: "idle",
  });
  const input = { clientRequestId: "fork-provider-stage", workspace: { mode: "current" } };
  const crypto = require("node:crypto");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ clientRequestId: input.clientRequestId, sourceSessionId: source.id, workspace: input.workspace })).digest("hex");
  fs.writeFileSync(operationStorePath, JSON.stringify({ version: 1, operations: [{
    clientRequestId: input.clientRequestId,
    fingerprint,
    sourceSessionId: source.id,
    input,
    stage: "provider-created",
    cwd: root,
    providerSessionId: "thread-stage-fork",
  }] }));
  let reads = 0;
  controller.register({
    agent: "codex",
    async readSession(providerSessionId) {
      reads += 1;
      registry.applyAdapterSnapshot({
        agent: "codex",
        creationSource: "ai-session",
        providerSessionId,
        cwd: root,
        lineage: { kind: "fork", parentProviderSessionId: "thread-stage-source" },
        status: "idle",
      });
    },
    async forkSession() { throw new Error("restored provider stage must not fork again"); },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });

  const result = await new AiSessionForkCoordinator({ registry, controller, operationStorePath }).fork(source.id, input);
  assert.equal(reads, 1);
  assert.equal(result.providerSessionId, "thread-stage-fork");
  assert.equal(result.creationSource, "ai-session");
});

test("AI session Fork sanitizes restored saga records before using internal identities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-fork-invalid-store-"));
  const operationStorePath = path.join(root, "operations.json");
  const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
  const controller = new AiSessionController(registry);
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread-invalid-store-source",
    cwd: root,
    actions: { fork: true },
    status: "idle",
  });
  const input = { clientRequestId: "fork-invalid-store", workspace: { mode: "current" } };
  const fingerprint = require("node:crypto").createHash("sha256")
    .update(JSON.stringify({ clientRequestId: input.clientRequestId, sourceSessionId: source.id, workspace: input.workspace }))
    .digest("hex");
  fs.writeFileSync(operationStorePath, JSON.stringify({ version: 1, operations: [{
    clientRequestId: input.clientRequestId,
    fingerprint,
    sourceSessionId: source.id,
    input,
    stage: "workspace-prepared",
    cwd: root,
    providerSessionId: "thread-must-not-be-restored",
  }] }));
  let forks = 0;
  controller.register({
    agent: "codex",
    async forkSession(forkInput) {
      forks += 1;
      registry.applyAdapterSnapshot({
        agent: "codex",
        creationSource: "ai-session",
        providerSessionId: "thread-sanitized-fork",
        cwd: forkInput.source.cwd,
        status: "idle",
      });
      return { providerSessionId: "thread-sanitized-fork", cwd: forkInput.source.cwd, creationSource: "ai-session" };
    },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const diagnostics = [];
  const result = await new AiSessionForkCoordinator({ registry, controller, operationStorePath, onDiagnostic: (entry) => diagnostics.push(entry) }).fork(source.id, input);

  assert.equal(forks, 1);
  assert.equal(result.providerSessionId, "thread-sanitized-fork");
  assert.equal(diagnostics[0].code, "AI_SESSION_FORK_STORE_RECORD_INVALID");
});

test("AI session Fork compensates provider and managed worktree after projection timeout", async () => {
  const { registry, controller } = runtime();
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread-compensation-source",
    cwd: "/workspace/project/subfolder",
    actions: { fork: true },
    status: "idle",
  });
  const deleted = [];
  const removed = [];
  const diagnostics = [];
  controller.register({
    agent: "codex",
    async forkSession(input) {
      assert.equal(input.cwd, "/managed/worktree/subfolder");
      return { providerSessionId: "thread-unprojected", cwd: input.cwd, creationSource: "ai-session" };
    },
    async deleteSession(id) { deleted.push(id); throw new Error("delete unavailable"); },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const coordinator = new AiSessionForkCoordinator({
    registry,
    controller,
    materializationTimeoutMs: 5,
    prepareManagedWorktree: async () => ({ cwd: "/managed/worktree/subfolder", worktreeId: "worktree-fork" }),
    removeManagedWorktree: async (_source, worktreeId) => { removed.push(worktreeId); return true; },
    onDiagnostic: (entry) => diagnostics.push(entry),
  });

  await assert.rejects(
    coordinator.fork(source.id, { clientRequestId: "fork-compensate", workspace: { mode: "managed-worktree" } }),
    (error) => error.code === "AI_SESSION_FORK_PROJECTION_FAILED" && error.statusCode === 502,
  );
  assert.deepEqual(deleted, ["thread-unprojected"]);
  assert.deepEqual(removed, ["worktree-fork"]);
  assert.equal(registry.getByProviderSessionId("codex", "thread-unprojected"), undefined);
  assert.equal(diagnostics[0].clientRequestId, "fork-compensate");
  assert.equal(diagnostics[0].providerSessionId, "thread-unprojected");
  assert.equal(diagnostics[0].worktreeId, "worktree-fork");
  assert.match(diagnostics[0].cleanupFailures[0], /delete unavailable/);
});

test("AI session Fork rejects invalid turn and managed-worktree history combinations", async () => {
  const { registry, controller } = runtime();
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread-source-invalid",
    cwd: "/workspace",
    actions: { fork: true },
    status: "idle",
  });
  registry.applyRealtimeEvent(source.id, { kind: "turn-started", activeTurnId: "turn-running", providerTurnId: "provider-running", source: "realtime" });
  controller.register({ agent: "codex", async forkSession() { throw new Error("must not run"); }, async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; } });
  const coordinator = new AiSessionForkCoordinator({ registry, controller });
  await assert.rejects(
    coordinator.fork(source.id, { clientRequestId: "fork-running", throughTurnId: "turn-running", workspace: { mode: "current" } }),
    (error) => error.code === "AI_SESSION_FORK_INVALID_TURN_STATE",
  );
  await assert.rejects(
    coordinator.fork(source.id, { clientRequestId: "fork-worktree-history", throughTurnId: "turn-running", workspace: { mode: "managed-worktree" } }),
    (error) => error.code === "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
  );
});

test("AI session Fork maps an inclusive completed turn and does not mutate a busy source", async () => {
  const { registry, controller } = runtime();
  const source = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread-busy-source",
    cwd: "/workspace",
    actions: { fork: true },
    status: "idle",
  });
  registry.applyRealtimeEvent(source.id, { kind: "turn-started", activeTurnId: "turn-completed", providerTurnId: "provider-turn-completed", source: "realtime" });
  registry.applyRealtimeEvent(source.id, { kind: "user-message", activeTurnId: "turn-completed", providerTurnId: "provider-turn-completed", userPrompt: "First request", source: "realtime" });
  registry.applyRealtimeEvent(source.id, { kind: "turn-completed", activeTurnId: "turn-completed", status: "idle", text: "Completed", source: "realtime" });
  registry.applyRealtimeEvent(source.id, { kind: "turn-started", activeTurnId: "turn-running", providerTurnId: "provider-turn-running", source: "realtime" });
  registry.applyRealtimeEvent(source.id, { kind: "user-message", activeTurnId: "turn-running", providerTurnId: "provider-turn-running", userPrompt: "Second request", source: "realtime" });
  const calls = [];
  controller.register({
    agent: "codex",
    async forkSession(input) {
      calls.push(input);
      registry.applyAdapterSnapshot({
        agent: "codex",
        creationSource: "ai-session",
        providerSessionId: "thread-through-turn",
        cwd: input.source.cwd,
        lineage: { kind: "fork", parentProviderSessionId: input.source.providerSessionId, throughTurnId: input.throughTurnId },
        status: "idle",
      });
      return { providerSessionId: "thread-through-turn", cwd: input.source.cwd, creationSource: "ai-session", lineage: { kind: "fork", parentProviderSessionId: input.source.providerSessionId, throughTurnId: input.throughTurnId } };
    },
    async interrupt() { throw new Error("Fork must not interrupt the source"); },
  });

  const result = await new AiSessionForkCoordinator({ registry, controller }).fork(source.id, {
    clientRequestId: "fork-through-turn",
    throughTurnId: "turn-completed",
    workspace: { mode: "current" },
  });

  assert.equal(calls[0].providerThroughTurnId, "provider-turn-completed");
  assert.equal(calls[0].throughTurnId, "turn-completed");
  assert.equal(calls[0].cwd, undefined);
  assert.equal(result.providerSessionId, "thread-through-turn");
  assert.equal(registry.get(source.id).status, "running");
  assert.equal(registry.get(source.id).activeTurnId, "turn-running");
});

test("Codex bridge Fork projects forkedFromId without using thread sessionId as identity", async () => {
  const { registry } = runtime();
  class FakeClient extends EventEmitter {
    async start() {}
    stop() {}
    async listLoadedThreadIds() { return []; }
    async resumeThread(threadId) { return { id: threadId, cwd: "/workspace", turns: [] }; }
    threadForkCapabilities() { return { fullHistory: true, throughTurn: true }; }
    async forkThread(options) {
      this.options = options;
      return { id: "thread-forked", sessionId: "shared-app-runtime", forkedFromId: "thread-source", cwd: options.cwd || "/workspace", ephemeral: false, turns: [] };
    }
  }
  const source = registry.applyAdapterSnapshot({ agent: "codex", providerSessionId: "thread-source", cwd: "/workspace", actions: { fork: true }, status: "idle" });
  const bridge = new CodexAppServerSessionBridge(registry, new FakeClient());
  await bridge.sync();
  const result = await bridge.forkSession({ source, cwd: "/workspace" });
  const forked = registry.getByProviderSessionId("codex", "thread-forked");

  assert.equal(result.providerSessionId, "thread-forked");
  assert.equal(forked.providerSessionId, "thread-forked");
  assert.equal(registry.getByProviderSessionId("codex", "shared-app-runtime"), undefined);
  assert.deepEqual(forked.lineage, { kind: "fork", parentProviderSessionId: "thread-source" });
});

test("Codex bridge creates a persistent Direct thread on the shared client", async () => {
  const { registry } = runtime();
  class FakeClient extends EventEmitter {
    async start() {}
    stop() {}
    async listLoadedThreadIds() { return []; }
    async startThread(options) {
      this.options = options;
      const thread = { id: "thread-bridge", cwd: options.cwd, ephemeral: false, status: { type: "idle" }, turns: [] };
      this.emit("event", { type: "thread", thread });
      return thread;
    }
  }
  const client = new FakeClient();
  const bridge = new CodexAppServerSessionBridge(registry, client, { threadStartDefaults: { model: "gpt-test", modelProvider: "openai" } });
  await bridge.sync();
  const result = await bridge.createSession({ cwd: "/workspace/project", permissionMode: "auto-review" });
  assert.deepEqual(result, { providerSessionId: "thread-bridge", cwd: "/workspace/project", creationSource: "ai-session" });
  assert.deepEqual(client.options, {
    cwd: "/workspace/project",
    runtimeWorkspaceRoots: ["/workspace/project"],
    model: "gpt-test",
    modelProvider: "openai",
    permissions: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", permissions: ":workspace" },
  });
  assert.equal(registry.getByProviderSessionId("codex", "thread-bridge").creationSource, "ai-session");
});

test("Codex Direct creation starts its first turn without resuming or reading the new thread", async () => {
  const { registry, controller } = runtime();
  const calls = [];
  class FakeClient extends EventEmitter {
    async start() {}
    stop() {}
    async listLoadedThreadIds() {
      calls.push(["loaded-list"]);
      return [];
    }
    async startThread(options) {
      calls.push(["thread-start", options.cwd]);
      return { id: "thread-new", cwd: options.cwd, ephemeral: false, status: { type: "idle" }, turns: [] };
    }
    async resumeThread(threadId) {
      calls.push(["thread-resume", threadId]);
      throw new Error("rollout is still empty");
    }
    async startTurn(threadId, message) {
      calls.push(["turn-start", threadId, message]);
      return { turnId: "turn-new" };
    }
    async readThread(threadId) {
      calls.push(["thread-read", threadId]);
      throw new Error("rollout is still empty");
    }
  }

  const bridge = new CodexAppServerSessionBridge(registry, new FakeClient());
  controller.register(bridge);
  const created = await new AiSessionCreateCoordinator({ registry, controller }).create({
    agent: "codex",
    cwd: "/workspace/project",
    message: "Start safely",
    clientRequestId: "create-new-thread",
  });

  assert.equal(created.providerSessionId, "thread-new");
  assert.deepEqual(calls, [
    ["thread-start", "/workspace/project"],
    ["turn-start", "thread-new", "Start safely"],
  ]);
  assert.equal(registry.get(created.aiSessionId).activeTurnId, "turn-new");
});

test("Codex app-server client sends strict thread lifecycle requests", async () => {
  const client = new CodexAppServerClient();
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-client", cwd: "/workspace", ephemeral: false } };
    return {};
  };
  await client.startThread({ cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] });
  await client.archiveThread("thread-client");
  await client.unarchiveThread("thread-client");
  await client.deleteThread("thread-client");
  await client.unsubscribeThread("thread-client");
  assert.deepEqual(requests.map((entry) => entry.method), [
    "thread/start", "thread/archive", "thread/unarchive", "thread/delete", "thread/unsubscribe",
  ]);
  assert.equal(requests[0].params.ephemeral, false);
  assert.equal(requests[0].params.threadSource, "user");
  assert.equal(requests[0].params.cwd, "/workspace");
});

test("Codex app-server capability gate follows released thread/fork wire versions", () => {
  assert.deepEqual(codexThreadForkCapabilities(undefined), { fullHistory: false, throughTurn: false });
  assert.deepEqual(codexThreadForkCapabilities("codex-cli/0.79.0 (Darwin)"), { fullHistory: false, throughTurn: false });
  assert.deepEqual(codexThreadForkCapabilities("codex-cli/0.128.0 (Darwin)"), { fullHistory: false, throughTurn: false });
  assert.deepEqual(codexThreadForkCapabilities("codex-cli/0.129.0 (Darwin)"), { fullHistory: true, throughTurn: false });
  assert.deepEqual(codexThreadForkCapabilities("codex-cli/0.142.0 (Darwin)"), { fullHistory: true, throughTurn: false });
  assert.deepEqual(codexThreadForkCapabilities("codex-cli/0.143.0-alpha.32 (Darwin)"), { fullHistory: true, throughTurn: true });
});

test("Codex app-server client sends only stable thread/fork params", async () => {
  const client = new CodexAppServerClient();
  client.serverUserAgent = "codex-cli/0.143.0-alpha.32 (Darwin)";
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: "thread-fork", cwd: "/workspace-fork", ephemeral: false } };
  };

  await client.forkThread({ threadId: "thread-source", lastTurnId: "turn-2", cwd: "/workspace-fork" });

  assert.deepEqual(requests, [{
    method: "thread/fork",
    params: { threadId: "thread-source", lastTurnId: "turn-2", cwd: "/workspace-fork", ephemeral: false },
  }]);
  assert.equal("runtimeWorkspaceRoots" in requests[0].params, false);
  assert.equal("path" in requests[0].params, false);
});

test("Codex app-server client disables Fork after structured method-not-found", async () => {
  const client = new CodexAppServerClient();
  client.serverUserAgent = "codex-cli/0.143.0-alpha.32 (Darwin)";
  client.request = async () => {
    throw new CodexAppServerRpcError("Method not found", -32601);
  };

  await assert.rejects(() => client.forkThread({ threadId: "thread-source" }), (error) => error.rpcCode === -32601);
  assert.deepEqual(client.threadForkCapabilities(), { fullHistory: false, throughTurn: false });
});

test("Codex app-server client verifies active thread identity across unfiltered pages", async () => {
  const client = new CodexAppServerClient();
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (params.cursor === null) return { data: [{ id: "thread-other" }], nextCursor: "page-2" };
    return { data: [{ id: "thread-target" }], nextCursor: null };
  };

  assert.equal(await client.activeThreadExists("thread-target"), true);
  assert.deepEqual(requests.map((entry) => entry.params.searchTerm), [null, null]);
  assert.deepEqual(requests.map((entry) => entry.params.cursor), [null, "page-2"]);
});

test("Codex app-server client fails closed when active thread pagination repeats", async () => {
  const client = new CodexAppServerClient();
  client.request = async () => ({ data: [], nextCursor: "same-page" });
  await assert.rejects(
    () => client.activeThreadExists("thread-target"),
    /repeated cursor/,
  );
});

test("Open App resumes the original Direct identity and deduplicates concurrent requests", async () => {
  const { registry } = runtime();
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "thread-open",
    cwd: "/workspace",
    status: "idle",
  });
  let starts = 0;
  const apps = [];
  const coordinator = new AiSessionOpenAppCoordinator({
    registry,
    appSessions: () => apps,
    startApp: async (trusted) => {
      starts += 1;
      assert.equal(trusted.providerSessionId, "thread-open");
      apps.push({ id: "app-open", status: "running" });
      setImmediate(() => registry.applyAdapterSnapshot({
        agent: "codex",
        creationSource: "app-session",
        appId: "codex",
        appSessionId: "app-open",
        providerSessionId: "thread-open",
        cwd: "/workspace",
        status: "idle",
      }));
      return apps[0];
    },
    stopApp: () => {},
    bindingTimeoutMs: 100,
  });
  const [first, second] = await Promise.all([coordinator.open(session.id), coordinator.open(session.id)]);
  assert.deepEqual(second, first);
  assert.equal(first.appSessionId, "app-open");
  assert.equal(starts, 1);
  assert.equal(registry.get(session.id).creationSource, "ai-session");
  assert.equal((await coordinator.open(session.id)).disposition, "already-open");
});

test("App exit closes an App-owned AI session", async () => {
  const { registry, controller } = runtime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-close-"));
  const history = new AiSessionHistoryStore({ dataDir: root });
  const archived = [];
  const stopped = [];
  controller.register({
    agent: "codex",
    async archiveSession(id) { archived.push(id); },
    async unsubscribeSession() {},
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "app-session",
    appId: "codex",
    appSessionId: "app-close",
    providerSessionId: "thread-close",
    cwd: "/workspace",
    status: "idle",
  });
  const coordinator = new AiSessionCloseCoordinator({
    registry,
    controller,
    history,
    stopApp: async (id) => { stopped.push(id); },
  });
  const [manual, appExit] = await Promise.all([
    coordinator.close(session.id),
    coordinator.closeForAppSession("app-close"),
  ]);
  assert.deepEqual(appExit, manual);
  assert.deepEqual(archived, ["thread-close"]);
  assert.deepEqual(stopped, ["app-close"]);
  assert.equal(registry.get(session.id), undefined);
  assert.equal(history.get(session.id).creationSource, "app-session");
  assert.equal((await coordinator.close(session.id)).disposition, "already-closed");
});

test("App exit preserves a Direct AI session that was opened in the App", async () => {
  const { registry, controller } = runtime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-direct-app-exit-"));
  const archived = [];
  const stopped = [];
  controller.register({
    agent: "codex",
    async archiveSession(id) { archived.push(id); },
    async unsubscribeSession() {},
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "ai-session",
    appId: "codex",
    appSessionId: "app-direct",
    providerSessionId: "thread-direct",
    cwd: "/workspace",
    status: "idle",
  });
  const coordinator = new AiSessionCloseCoordinator({
    registry,
    controller,
    history: new AiSessionHistoryStore({ dataDir: root }),
    stopApp: async (id) => { stopped.push(id); },
  });

  assert.equal(coordinator.closeForAppSession("app-direct"), undefined);
  assert.deepEqual(archived, []);
  assert.deepEqual(stopped, []);
  assert.equal(registry.get(session.id).providerSessionId, "thread-direct");
  assert.equal(registry.get(session.id).creationSource, "ai-session");
});

test("Close AI Session restores the authoritative current session when provider archive fails", async () => {
  const { registry, controller } = runtime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-close-fail-"));
  controller.register({
    agent: "codex",
    async archiveSession() { throw new Error("archive failed"); },
    async resumeSession() {},
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "thread-close-fail",
    cwd: "/workspace",
    status: "idle",
  });
  const coordinator = new AiSessionCloseCoordinator({
    registry,
    controller,
    history: new AiSessionHistoryStore({ dataDir: root }),
    stopApp: () => {},
  });
  await assert.rejects(coordinator.close(session.id), (error) => error.code === "AI_SESSION_CLOSE_FAILED");
  assert.equal(registry.get(session.id).actions?.send, undefined);
  assert.equal(registry.get(session.id).providerSessionId, "thread-close-fail");
});

test("Close AI Session completes when provider archive reports a session that is already absent", async () => {
  const { registry, controller } = runtime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-close-absent-"));
  const resumed = [];
  const diagnostics = [];
  controller.register({
    agent: "codex",
    async archiveSession() { throw new Error("provider rejected archive"); },
    async activeSessionExists() { return false; },
    async resumeSession(id) { resumed.push(id); },
    async interrupt(session) { return { session, provider: "codex", action: "interrupt" }; },
  });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "thread-already-absent",
    cwd: "/workspace",
    status: "idle",
  });
  const history = new AiSessionHistoryStore({ dataDir: root });
  const coordinator = new AiSessionCloseCoordinator({
    registry,
    controller,
    history,
    stopApp: () => {},
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal((await coordinator.close(session.id)).disposition, "closed");
  assert.equal(registry.get(session.id), undefined);
  assert.ok(history.get(session.id));
  assert.deepEqual(resumed, []);
  assert.equal(diagnostics[0].code, "AI_SESSION_CLOSE_PROVIDER_ALREADY_ABSENT");
});
