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

const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { SessionRenameIntentStore, SessionTitleCoordinator } = require("../packages/ai-session-runtime/src/session-title-coordinator.ts");
const { AiSessionProviderCapabilitySchema, supportsAiSessionProviderRename } = require("../packages/protocol/src/ai-session-provider-capabilities.ts");
const { AiSessionRenameInputSchema, AiSessionStatusSchema } = require("../packages/protocol/src/ai-sessions.ts");

function fixture(agent = "opencode") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-session-title-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const controller = new AiSessionController(registry);
  const appSessions = new Map([["app-1", { id: "app-1", title: "Original", marker: "preserved" }]]);
  const renameCalls = [];
  const diagnostics = [];
  controller.register({
    agent,
    async renameSession(session, title) {
      renameCalls.push({ sessionId: session.id, title });
      registry.patch(session.id, { title: title || undefined });
      return { title, authority: agent === "codex" ? "adapter" : "provider" };
    },
    async interrupt(session) { return { session, provider: agent, action: "interrupt" }; },
  });
  const session = registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent,
    appId: agent,
    appSessionId: "app-1",
    providerSessionId: `${agent}-provider-1`,
    title: "Original",
    status: "idle",
    actions: { rename: true },
  });
  const appRuntime = {
    getSession(id) { return appSessions.get(id); },
    rename(id, title) {
      const current = appSessions.get(id);
      if (!current) throw Object.assign(new Error("missing"), { code: "APP_SESSION_NOT_FOUND" });
      const updated = { ...current, title };
      appSessions.set(id, updated);
      return updated;
    },
  };
  const intents = new SessionRenameIntentStore(root);
  const coordinator = new SessionTitleCoordinator({
    registry,
    controller,
    appRuntime,
    intents,
    isAppDerivedTitle: (candidate) => candidate.agent === "claude" && Boolean(candidate.appSessionId),
    isIndependentTitle: (candidate) => candidate.agent === "codex",
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { root, registry, controller, appSessions, appRuntime, intents, coordinator, session, renameCalls, diagnostics };
}

test("rename protocol accepts an empty reset title while v0.0.31 titles and missing capability remain readable", () => {
  assert.deepEqual(AiSessionRenameInputSchema.parse({ title: "  Renamed  ", clientRequestId: "request-1" }), { title: "Renamed", clientRequestId: "request-1" });
  assert.deepEqual(AiSessionRenameInputSchema.parse({ title: "   ", clientRequestId: "request-clear" }), { title: "", clientRequestId: "request-clear" });
  assert.throws(() => AiSessionRenameInputSchema.parse({ title: "x", clientRequestId: "request-1", extra: true }));
  assert.equal(AiSessionStatusSchema.parse({
    id: "legacy", agent: "codex", title: "x".repeat(240), status: "idle", phase: "unknown",
    startedAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
    counters: {}, queue: {},
  }).title.length, 240);
  const capability = AiSessionProviderCapabilitySchema.parse({ agent: "codex", actions: {}, timeline: {} });
  assert.equal(capability.actions.rename, false);
  assert.equal(supportsAiSessionProviderRename(capability), false);
  const legacyActions = AiSessionStatusSchema.parse({
    id: "legacy-actions", agent: "codex", status: "waiting", phase: "approval",
    startedAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
    counters: {}, queue: {},
    actions: { send: true, interrupt: true, approval: true, close: true },
  }).actions;
  assert.equal(legacyActions.rename, undefined);
  assert.equal(legacyActions.send, true);
  assert.equal(legacyActions.interrupt, true);
  assert.equal(legacyActions.approval, true);
  assert.equal(legacyActions.close, true);
});

test("an empty Codex title clears the custom title without changing its App Session", async (t) => {
  const state = fixture("codex");
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  state.registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex",
    appSessionId: "app-1",
    providerSessionId: "codex-provider-1",
    title: "Original",
    userPrompt: "Default prompt title",
    status: "idle",
    actions: { rename: true },
  });

  const renamed = await state.coordinator.renameAiSession(state.session.id, {
    title: "",
    expectedTitle: "Original",
    clientRequestId: "rename-clear",
  });

  assert.equal(renamed.title, "");
  assert.equal(state.registry.get(state.session.id).title, undefined);
  assert.equal(state.appSessions.get("app-1").title, "Original");
  assert.deepEqual(state.renameCalls, [{ sessionId: state.session.id, title: "" }]);
  assert.deepEqual(state.intents.list(), []);
});

test("Codex AI Session and App Session renames remain independent", async (t) => {
  const state = fixture("codex");
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));

  await state.coordinator.renameAiSession(state.session.id, {
    title: "AI only",
    expectedTitle: "Original",
    clientRequestId: "rename-ai-only",
  });
  assert.equal(state.registry.get(state.session.id).title, "AI only");
  assert.equal(state.appSessions.get("app-1").title, "Original");

  const app = await state.coordinator.renameAppSession("app-1", "App only", { expectedTitle: "Original" });
  assert.equal(app.title, "App only");
  assert.equal(state.registry.get(state.session.id).title, "AI only");
  assert.deepEqual(state.renameCalls, [{ sessionId: state.session.id, title: "AI only" }]);
});

test("AI and App entry points converge through the provider adapter", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));

  const renamed = await state.coordinator.renameAiSession(state.session.id, {
    title: "From AI",
    expectedTitle: "Original",
    clientRequestId: "rename-ai",
  });
  assert.equal(renamed.title, "From AI");
  assert.equal(state.registry.get(state.session.id).title, "From AI");
  assert.equal(state.appSessions.get("app-1").title, "From AI");
  assert.deepEqual(state.renameCalls, [{ sessionId: state.session.id, title: "From AI" }]);
  const completed = state.diagnostics.find((diagnostic) => diagnostic.code === "AI_SESSION_RENAME_COMPLETED");
  assert.match(completed.operationId, /^rename_/);
  assert.equal(completed.clientRequestId, "rename-ai");
  assert.equal(completed.aiSessionId, state.session.id);
  assert.equal(completed.appSessionId, "app-1");
  assert.equal(completed.providerSessionId, "opencode-provider-1");

  const app = await state.coordinator.renameAppSession("app-1", "From App", {
    expectedTitle: "From AI",
    clientRequestId: "rename-app",
  });
  assert.equal(app.title, "From App");
  assert.equal(app.marker, "preserved");
  assert.equal(state.registry.get(state.session.id).title, "From App");
  assert.equal(state.renameCalls.length, 2);
  assert.deepEqual(state.intents.list(), []);
});

test("app-derived Claude title updates both projections without provider rename", async (t) => {
  const state = fixture("claude");
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));

  await state.coordinator.renameAiSession(state.session.id, {
    title: "Claude title",
    expectedTitle: "Original",
    clientRequestId: "rename-claude",
  });

  assert.equal(state.appSessions.get("app-1").title, "Claude title");
  assert.equal(state.registry.get(state.session.id).title, "Claude title");
  assert.deepEqual(state.renameCalls, []);
});

test("serialized competing renames reject stale expected titles", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));

  const first = state.coordinator.renameAiSession(state.session.id, { title: "First", expectedTitle: "Original", clientRequestId: "first" });
  const second = state.coordinator.renameAiSession(state.session.id, { title: "Second", expectedTitle: "Original", clientRequestId: "second" });
  await first;
  await assert.rejects(second, (error) => error.code === "AI_SESSION_RENAME_CONFLICT" && error.statusCode === 409);
  assert.equal(state.registry.get(state.session.id).title, "First");
  assert.equal(state.appSessions.get("app-1").title, "First");
});

test("an authority-confirmed intent survives replica failure and recovers after restart", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  const originalRename = state.appRuntime.rename;
  state.appRuntime.rename = () => { throw Object.assign(new Error("disk unavailable"), { code: "APP_SESSION_PERSIST_FAILED", statusCode: 503 }); };

  await assert.rejects(
    state.coordinator.renameAiSession(state.session.id, { title: "Recover me", expectedTitle: "Original", clientRequestId: "recover" }),
    /disk unavailable/,
  );
  assert.equal(state.registry.get(state.session.id).title, "Recover me");
  assert.equal(state.intents.list()[0].phase, "authority-confirmed");

  state.appRuntime.rename = originalRename;
  const restored = new SessionTitleCoordinator({
    registry: state.registry,
    controller: state.controller,
    appRuntime: state.appRuntime,
    intents: new SessionRenameIntentStore(state.root),
  });
  await restored.recover();
  assert.equal(state.appSessions.get("app-1").title, "Recover me");
  assert.deepEqual(new SessionRenameIntentStore(state.root).list(), []);
});

test("a provider rejection before acceptance removes the prepared intent", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  state.controller.register({
    agent: "opencode",
    async renameSession() { throw Object.assign(new Error("provider rejected"), { code: "PROVIDER_REJECTED", statusCode: 400 }); },
    async interrupt(session) { return { session, provider: "opencode", action: "interrupt" }; },
  });

  await assert.rejects(
    state.coordinator.renameAiSession(state.session.id, { title: "Rejected", expectedTitle: "Original", clientRequestId: "rejected" }),
    /provider rejected/,
  );
  assert.equal(state.registry.get(state.session.id).title, "Original");
  assert.equal(state.appSessions.get("app-1").title, "Original");
  assert.deepEqual(state.intents.list(), []);
});

test("background retry completes an authority-confirmed replica write", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  const originalRename = state.appRuntime.rename;
  let failing = true;
  state.appRuntime.rename = (...args) => {
    if (failing) throw Object.assign(new Error("disk unavailable"), { code: "APP_SESSION_PERSIST_FAILED", statusCode: 503 });
    return originalRename(...args);
  };
  const coordinator = new SessionTitleCoordinator({
    registry: state.registry,
    controller: state.controller,
    appRuntime: state.appRuntime,
    intents: state.intents,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 20,
  });

  await assert.rejects(
    coordinator.renameAiSession(state.session.id, { title: "Retry me", expectedTitle: "Original", clientRequestId: "retry" }),
    /disk unavailable/,
  );
  failing = false;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(state.appSessions.get("app-1").title, "Retry me");
  assert.deepEqual(state.intents.list(), []);
});

test("recovery preserves a newer external provider title and supersedes the old intent", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  const originalRename = state.appRuntime.rename;
  state.appRuntime.rename = () => { throw Object.assign(new Error("disk unavailable"), { statusCode: 503 }); };
  await assert.rejects(
    state.coordinator.renameAiSession(state.session.id, { title: "Old target", expectedTitle: "Original", clientRequestId: "old-target" }),
    /disk unavailable/,
  );
  state.registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex",
    appSessionId: "app-1",
    providerSessionId: "codex-provider-1",
    title: "External title",
  });
  state.appRuntime.rename = originalRename;

  await new SessionTitleCoordinator({
    registry: state.registry,
    controller: state.controller,
    appRuntime: state.appRuntime,
    intents: state.intents,
  }).recover();
  assert.equal(state.registry.get(state.session.id).title, "External title");
  assert.equal(state.appSessions.get("app-1").title, "External title");
  assert.deepEqual(state.intents.list(), []);
  assert.equal(state.renameCalls.filter((call) => call.title === "Old target").length, 1);
});

test("an external provider title creates a recoverable intent when the App replica fails", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  state.registry.applyAdapterSnapshot({
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex",
    appSessionId: "app-1",
    providerSessionId: "codex-provider-1",
    title: "External title",
    actions: { rename: true },
  });
  const originalRename = state.appRuntime.rename;
  state.appRuntime.rename = () => { throw Object.assign(new Error("disk unavailable"), { statusCode: 503 }); };

  await assert.rejects(state.coordinator.observeProviderTitle(state.session.id), /disk unavailable/);
  assert.equal(state.intents.list()[0].phase, "authority-confirmed");
  assert.equal(state.intents.list()[0].targetTitle, "External title");
  state.appRuntime.rename = originalRename;
  await new SessionTitleCoordinator({
    registry: state.registry,
    controller: state.controller,
    appRuntime: state.appRuntime,
    intents: state.intents,
  }).recover();
  assert.equal(state.appSessions.get("app-1").title, "External title");
  assert.deepEqual(state.intents.list(), []);
});

test("one AppSession bound to multiple AI sessions fails closed with stable identities", async (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  state.registry.store.save({
    ...state.registry.get(state.session.id),
    id: "ais_historical_duplicate",
    agent: "opencode",
    appId: "opencode",
    providerSessionId: "opencode-provider-2",
  });

  assert.throws(
    () => state.coordinator.renameAppSession("app-1", "Ambiguous"),
    (error) => error.code === "AI_SESSION_RENAME_BINDING_CONFLICT" && error.statusCode === 409,
  );
  assert.equal(state.appSessions.get("app-1").title, "Original");
  assert.deepEqual(state.renameCalls, []);
});
