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
const { AiSessionCloseCoordinator } = require("../packages/ai-session-runtime/src/ai-session-close.ts");
const { AiSessionHistoryStore } = require("../packages/ai-session-runtime/src/ai-session-history-store.ts");
const { AiSessionOpenAppCoordinator } = require("../packages/ai-session-runtime/src/ai-session-open-app.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { CodexAppServerClient } = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");

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
