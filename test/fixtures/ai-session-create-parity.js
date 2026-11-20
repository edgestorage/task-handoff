const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("../workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
const { AiSessionController } = require("../../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionCreateCoordinator } = require("../../packages/ai-session-runtime/src/ai-session-create.ts");
const { createAiSessionRegistry } = require("../../packages/ai-session-runtime/src/ai-session-registry.ts");

// This is a coordinator contract projection, not a full HTTP/WS snapshot.
// Only random session/message identities are mapped, bijectively per scenario.
// Provider IDs, call order, message bytes, null/missing and state are retained.
// Timestamps/revisions are not observed here; U02 owns ordered event transport.
function createProjection() {
  const identities = new Map();
  const identity = (kind, id) => {
    assert.ok(id, `${kind} identity is present`);
    if (!identities.has(id)) {
      const count = [...identities.values()].filter((v) => v.startsWith(`$${kind}`)).length;
      identities.set(id, `$${kind}${count + 1}`);
    }
    return identities.get(id);
  };
  const sessions = (owner) => owner.all().map((session) => ({
    id: identity("session", session.id),
    providerSessionId: session.providerSessionId,
    creationSource: session.creationSource,
    cwdFolderId: session.cwdFolderId,
    status: session.status,
    phase: session.phase,
    reasoningEffort: session.reasoningEffort ?? null,
    userPrompt: session.userPrompt ?? null,
    activeTurnId: session.activeTurnId ?? null,
    messages: (session.turns || []).flatMap((turn) => (turn.userMessages || []).map((message) => ({
      id: identity("message", message.id), text: message.text,
    }))),
  }));
  const resultProjection = (result) => ({ ...result, aiSessionId: identity("session", result.aiSessionId) });
  return { identity, sessions, resultProjection };
}

async function observeNodeCreate(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-create-parity-"));
  let stop;
  try {
    const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
    const controller = new AiSessionController(registry);
    const { identity, sessions, resultProjection } = createProjection();
    let lastChange = null;
    stop = registry.onChange(() => { lastChange = sessions(registry); });
    const calls = [];
    const capability = {
      agent: "codex", actions: {}, timeline: {},
      ...(scenario.selectAtCreate === undefined ? {} : { reasoningEffort: { selectAtCreate: scenario.selectAtCreate } }),
    };
    controller.register({
      agent: "codex",
      async createSession(input) {
        calls.push({ action: "create", reasoningEffort: input.reasoningEffort ?? null });
        if (scenario.failure === "create") throw Object.assign(new Error("provider create rejected"), { code: "PROVIDER_REJECTED", statusCode: 409 });
        return { providerSessionId: "thread-create-parity", cwd: input.cwd, reasoningEffort: input.reasoningEffort, creationSource: "ai-session" };
      },
      async startMessage(session, input) {
        calls.push({ action: "start", sessionId: identity("session", session.id), providerSessionId: session.providerSessionId,
          messageId: identity("message", input.messageId), message: input.message });
        if (scenario.failure === "start") throw new Error("provider start rejected");
        if (scenario.failure === "timeout") return new Promise(() => {});
        registry.patch(session.id, {
          status: "running", phase: "thinking", activeTurnId: "turn-create-parity", userPrompt: input.message,
          turns: [{ id: "turn-create-parity", providerTurnId: "turn-create-parity", status: "running", phase: "thinking",
            userMessages: [{ id: input.messageId, text: input.message, attachments: [] }] }],
        });
        return { session: registry.get(session.id), provider: "codex", action: "send", turnId: "turn-create-parity" };
      },
      async deleteSession(providerSessionId) { calls.push({ action: "delete", providerSessionId }); },
      async unsubscribeSession(providerSessionId) { calls.push({ action: "unsubscribe", providerSessionId }); },
    });
    const operationStorePath = path.join(root, "operations.json");
    const options = { registry, controller, getProviderCapability: () => capability, operationStorePath, materializationTimeoutMs: 10 };
    const input = { agent: "codex", cwd: root, cwdFolderId: "folder-create-parity", message: "Start", clientRequestId: "request-create-parity",
      ...(scenario.reasoningEffort ? { reasoningEffort: scenario.reasoningEffort } : {}) };
    let result = null;
    let error = null;
    try { result = resultProjection(await new AiSessionCreateCoordinator(options).create(input)); }
    catch (failure) { error = { code: failure.code, message: failure.message, statusCode: failure.statusCode }; }
    const authoritative = sessions(registry);
    const restored = sessions(createAiSessionRegistry({ dir: path.join(root, "sessions") }));
    const completed = fs.existsSync(operationStorePath) ? JSON.parse(fs.readFileSync(operationStorePath, "utf8")).completed.map((entry) => ({
      clientRequestId: entry.clientRequestId, result: resultProjection(entry.result),
    })) : [];
    let replay = null;
    if (result) replay = resultProjection(await new AiSessionCreateCoordinator(options).create(input));
    return { result, error, calls, sessions: authoritative, restored, completed, replay, lastChange };
  } finally {
    stop?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}


function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Lifecycle test barrier did not complete.")), 1000);
  })]); } finally { clearTimeout(timer); }
}
async function observeNodeCreateLifecycle(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-create-lifecycle-"));
  const entered = deferred();
  const release = deferred();
  const upstreamDone = deferred();
  const { identity, sessions, resultProjection } = createProjection();
  let stop;
  let operation;
  try {
    const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
    const controller = new AiSessionController(registry);
    const calls = [];
    let lastChange = null;
    stop = registry.onChange(() => { lastChange = sessions(registry); });
    controller.register({
      agent: "codex",
      async createSession(input) {
        calls.push({ action: "create", reasoningEffort: null });
        if (scenario.kind === "drop-create") { entered.resolve(); await release.promise; }
        return { providerSessionId: "thread-create-parity", cwd: input.cwd, creationSource: "ai-session" };
      },
      async startMessage(session, input) {
        calls.push({ action: "start", sessionId: identity("session", session.id), providerSessionId: session.providerSessionId,
          messageId: identity("message", input.messageId), message: input.message });
        if (scenario.kind === "interrupt-active") registry.patch(session.id, {status: "running", phase: "thinking", activeTurnId: "turn-create-parity"});
        if (scenario.kind !== "drop-create") {
          entered.resolve();
          await release.promise;
        }
        // Model the production provider's control acknowledgement through the
        // authoritative reducer. A bare snapshot has no control source and
        // cannot replace a turn already published by create/interrupt activity.
        if (registry.get(session.id)) registry.applyRealtimeEvent(session.id, {
          kind: "send-ack", activeTurnId: "turn-create-parity", providerTurnId: "turn-create-parity",
          userPrompt: input.message,
          userMessage: { id: input.messageId, text: input.message, attachments: [] },
          source: "control",
        });
        upstreamDone.resolve();
        return { session: registry.get(session.id), provider: "codex", action: "send", turnId: "turn-create-parity" };
      },
      async interrupt(session) {
        calls.push({action: "interrupt", providerSessionId: session.providerSessionId});
        throw Object.assign(new Error("provider interrupt rejected"), {code: "PROVIDER_INTERRUPT_REJECTED", statusCode: 503});
      },
      async deleteSession(providerSessionId) { calls.push({action: "delete", providerSessionId}); },
      async unsubscribeSession(providerSessionId) { calls.push({action: "unsubscribe", providerSessionId}); },
    });
    const operationStorePath = path.join(root, "operations.json");
    const coordinator = new AiSessionCreateCoordinator({ registry, controller, operationStorePath,
      materializationTimeoutMs: scenario.kind.includes("timeout") ? 20 : 1000 });
    const input = {agent: "codex", cwd: root, cwdFolderId: "folder-create-parity", message: "Start", clientRequestId: "request-create-parity"};
    // Losing an HTTP waiter does not cancel the coordinator's Promise. Observe its
    // settlement without submitting a new create, just as the owner must do.
    operation = coordinator.create(input).then(
      result => ({result: resultProjection(result), error: null}),
      error => ({result: null, error: {code: error.code, message: error.message, statusCode: error.statusCode}}),
    );
    await bounded(entered.promise);
    let interruptError = null;
    if (scenario.kind.startsWith("interrupt")) {
      try { await controller.interrupt(registry.all()[0].id); }
      catch (error) { interruptError = {code: error.code, message: error.message, statusCode: error.statusCode}; }
    }
    const timesOut = scenario.kind.includes("timeout");
    if (!timesOut) release.resolve();
    const outcome = await bounded(operation);
    const beforeRetry = {
      sessions: sessions(registry),
      restored: sessions(createAiSessionRegistry({dir: path.join(root, "sessions")})),
      completed: fs.existsSync(operationStorePath) ? JSON.parse(fs.readFileSync(operationStorePath, "utf8")).completed.map(record => ({
        clientRequestId: record.clientRequestId, result: resultProjection(record.result),
      })) : [],
      lastChange,
    };
    let replay = null;
    if (scenario.kind === "drop-create" || scenario.kind === "drop-start") replay = resultProjection(await coordinator.create(input));
    if (timesOut) {
      release.resolve();
      await bounded(upstreamDone.promise);
      // Drain the resolved start Promise's continuation, without another request.
      await new Promise(resolve => setImmediate(resolve));
    }
    return { finishedWithoutWaiter: true, interruptError, outcome: scenario.kind.startsWith("drop") ? null : outcome, calls, beforeRetry, replay,
      afterLateAck: timesOut ? {sessions: sessions(registry), operationFileExists: fs.existsSync(operationStorePath), lastChange} : null };
  } finally {
    release.resolve();
    if (operation) await bounded(operation);
    stop?.();
    fs.rmSync(root, {recursive: true, force: true});
  }
}


async function observeNodeSendLifecycle(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-send-lifecycle-"));
  const entered = deferred();
  const release = deferred();
  const { identity, sessions } = createProjection();
  let operation;
  let stop;
  try {
    const registry = createAiSessionRegistry({dir: path.join(root, "sessions")});
    const session = registry.applyAdapterSnapshot({source: "control", agent: "codex", creationSource: "ai-session",
      appId: "codex-app-server", providerSessionId: "thread-send-parity", cwd: root, cwdFolderId: "folder-create-parity", status: "idle", phase: "unknown"});
    identity("session", session.id);
    const controller = new AiSessionController(registry);
    const calls = [];
    let lastChange = null;
    stop = registry.onChange(() => { lastChange = sessions(registry); });
    controller.register({
      agent: "codex",
      async startMessage(current, input) {
        const attempt = calls.length + 1;
        calls.push({action: "start", sessionId: identity("session", current.id), providerSessionId: current.providerSessionId,
          messageId: identity("message", input.messageId), message: input.message});
        if (attempt === 1) { entered.resolve(); await release.promise; }
        if (attempt === 1 && scenario.failFirst) throw Object.assign(new Error("provider send rejected"), {code: "PROVIDER_SEND_REJECTED", statusCode: 503});
        const turnId = `turn-send-${attempt}`;
        registry.patch(current.id, {status: "running", phase: "thinking", activeTurnId: turnId, userPrompt: input.message,
          turns: [...(registry.get(current.id).turns || []), {id: turnId, providerTurnId: turnId, status: "running", phase: "thinking",
            userMessages: [{id: input.messageId, text: input.message, attachments: []}]}]});
        return {session: registry.get(current.id), provider: "codex", action: "send", turnId};
      },
    });
    const input = {message: "Start", ...(scenario.noKey ? {} : {clientRequestId: "request-send-parity"})};
    // JS keeps the pending operation running even after its HTTP waiter leaves.
    operation = controller.sendMessage(session.id, input).then(() => true, () => true);
    await bounded(entered.promise);
    release.resolve();
    await bounded(operation);
    const beforeRetry = {sessions: sessions(registry), restored: sessions(createAiSessionRegistry({dir: path.join(root, "sessions")}))};
    const outcome = async (promise) => {
      try {
        const result = await bounded(promise);
        return {result: {action: result.action, sessionId: identity("session", result.session.id),
          providerSessionId: result.session.providerSessionId, turnId: result.turnId}, error: null};
      } catch (error) { return {result: null, error: {code: error.code, message: error.message, statusCode: error.statusCode}}; }
    };
    const retry = scenario.noKey ? null : await outcome(controller.sendMessage(session.id, input));
    // The provider is now idle, so a different key must reach a new start rather
    // than being parked behind an abandoned controller session lock.
    registry.patch(session.id, {status: "idle", phase: "unknown", activeTurnId: undefined});
    const followUp = await outcome(controller.sendMessage(session.id, {message: "Follow up", clientRequestId: "request-send-next"}));
    return {finishedWithoutWaiter: true, beforeRetry, retry, followUp, calls,
      sessions: sessions(registry), restored: sessions(createAiSessionRegistry({dir: path.join(root, "sessions")})), lastChange};
  } finally {
    release.resolve();
    if (operation) await bounded(operation);
    stop?.();
    fs.rmSync(root, {recursive: true, force: true});
  }
}
module.exports = { observeNodeCreate, observeNodeCreateLifecycle, observeNodeSendLifecycle };
