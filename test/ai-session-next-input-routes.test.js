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
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

const instanceId = "inst_next_input_route";
const registrationToken = "instance-registration-token";
const now = "2026-11-25T00:00:00.000Z";
const authorization = { authorization: `Bearer ${registrationToken}` };

function pathsFor(root) {
  return {
    configPath: path.join(root, "config.json"), dataDir: root, appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"), runtimeDir: path.join(root, "runtime"), eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"), logDir: path.join(root, "logs"), webTokenPath: path.join(root, "web-token"),
  };
}

function setEnvironment(paths) {
  const patch = {
    TASK_HANDOFF_CONFIG: paths.configPath,
    TASK_HANDOFF_DATA_DIR: paths.dataDir,
    TASK_HANDOFF_APP_CATALOG_DIR: paths.appCatalogDir,
    TASK_HANDOFF_APP_SESSION_DIR: paths.appSessionsDir,
    TASK_HANDOFF_RUNTIME_DIR: paths.runtimeDir,
    TASK_HANDOFF_EVENTS_DIR: paths.eventsDir,
    TASK_HANDOFF_ARTIFACT_DIR: paths.artifactDir,
    TASK_HANDOFF_LOG_DIR: paths.logDir,
    TASK_HANDOFF_WEB_TOKEN_FILE: paths.webTokenPath,
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_WORKSPACE_ROOTS: paths.dataDir,
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_INSTANCE_ID: instanceId,
    TASK_HANDOFF_REGISTRATION_TOKEN: registrationToken,
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: undefined,
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: undefined,
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_ENABLED: undefined,
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_REASONING_EFFORT: undefined,
    TASK_HANDOFF_RUNTIME_KIND: undefined,
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) value === undefined ? delete process.env[key] : process.env[key] = value;
  return () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

async function createRuntime() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-next-input-routes-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const app = await createWebApp({
    staticDir: path.join(dataRoot, "missing-static"),
    logger: false,
    appRuntime: new AppRuntimeManager(paths),
    aiSessionRegistry: aiSessions,
    codexAppServer: {
      id: "next-input-route-stub",
      agent: "codex",
      refresh() {},
      stop() {},
      async ensureReady() {},
      supportsThreadSettingsUpdate: () => true,
      supportsProviderReload: () => false,
    },
  });
  return { aiSessions, app, restore };
}

function idleSession(aiSessions, providerSessionId = "thread") {
  return aiSessions.start({
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId,
    status: "idle",
    turns: [{
      id: "turn_1",
      userPrompt: "问题",
      summary: "回答",
      lastMessage: "回答",
      status: "completed",
      completedAt: "2026-11-25T00:00:30.000Z",
      updatedAt: "2026-11-25T00:00:30.000Z",
    }],
  }, { timestamp: now });
}

const suggestion = { text: "继续补齐测试", turnId: "turn_1", generatedAt: "2026-11-25T00:01:00.000Z" };

test("AI session state strips suggestions unless the consumer opts in explicitly", async () => {
  const { aiSessions, app, restore } = await createRuntime();
  try {
    const session = idleSession(aiSessions);
    aiSessions.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion });
    const stripped = await app.inject({ method: "GET", url: "/api/ai-sessions/state?hierarchy=subagents" });
    assert.equal(stripped.statusCode, 200);
    assert.equal(stripped.json().data.snapshot.sessions[0].nextInputSuggestion, undefined);

    const kept = await app.inject({ method: "GET", url: "/api/ai-sessions/state?hierarchy=subagents&nextInputSuggestion=1" });
    assert.equal(kept.statusCode, 200);
    assert.deepEqual(kept.json().data.snapshot.sessions[0].nextInputSuggestion, suggestion);

    const list = await app.inject({ method: "GET", url: "/api/ai-sessions" });
    assert.equal(list.json().data.snapshot.sessions[0].nextInputSuggestion, undefined);
    const listKept = await app.inject({ method: "GET", url: "/api/ai-sessions?nextInputSuggestion=1" });
    assert.deepEqual(listKept.json().data.snapshot.sessions[0].nextInputSuggestion, suggestion);
  } finally {
    await app.close();
    restore();
  }
});

test("the suggestion settings route requires the instance registration token", async () => {
  const { app, restore } = await createRuntime();
  try {
    const denied = await app.inject({ method: "PUT", url: "/api/internal/ai-session-next-input-suggestion-settings", payload: { enabled: true } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "AI_SESSION_NEXT_INPUT_SUGGESTION_SETTINGS_FORBIDDEN");
    const invalid = await app.inject({ method: "PUT", url: "/api/internal/ai-session-next-input-suggestion-settings", headers: authorization, payload: { enabled: "yes" } });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
    restore();
  }
});

test("disabling the setting clears every persisted suggestion immediately", async () => {
  const { aiSessions, app, restore } = await createRuntime();
  try {
    const first = idleSession(aiSessions, "thread-1");
    const second = idleSession(aiSessions, "thread-2");
    for (const session of [first, second]) aiSessions.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion });
    assert.equal(aiSessions.snapshot().sessions.filter((session) => session.nextInputSuggestion).length, 2);

    const disabled = await app.inject({ method: "PUT", url: "/api/internal/ai-session-next-input-suggestion-settings", headers: authorization, payload: { enabled: false } });
    assert.equal(disabled.statusCode, 200);
    assert.deepEqual(disabled.json().data, { applied: true, enabled: false, reasoningEffort: "none" });
    assert.equal(aiSessions.snapshot().sessions.filter((session) => session.nextInputSuggestion).length, 0);

    const enabled = await app.inject({ method: "PUT", url: "/api/internal/ai-session-next-input-suggestion-settings", headers: authorization, payload: { enabled: true } });
    assert.equal(enabled.statusCode, 200);
    assert.deepEqual(enabled.json().data, { applied: true, enabled: true, reasoningEffort: "none" });
  } finally {
    await app.close();
    restore();
  }
});

test("reasoning mode defaults to none, survives an omitted field, and clears stale suggestions on change", async () => {
  const { aiSessions, app, restore } = await createRuntime();
  try {
    const session = idleSession(aiSessions);
    aiSessions.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion });
    assert.equal(aiSessions.snapshot().sessions[0].nextInputSuggestion.text, suggestion.text);

    const high = await app.inject({
      method: "PUT",
      url: "/api/internal/ai-session-next-input-suggestion-settings",
      headers: authorization,
      payload: { enabled: true, reasoningEffort: "high" },
    });
    assert.equal(high.statusCode, 200);
    assert.deepEqual(high.json().data, { applied: true, enabled: true, reasoningEffort: "high" });
    assert.equal(aiSessions.snapshot().sessions[0].nextInputSuggestion, undefined);

    const omitted = await app.inject({
      method: "PUT",
      url: "/api/internal/ai-session-next-input-suggestion-settings",
      headers: authorization,
      payload: { enabled: true },
    });
    assert.equal(omitted.statusCode, 200);
    assert.deepEqual(omitted.json().data, { applied: true, enabled: true, reasoningEffort: "high" });

    const followSession = await app.inject({
      method: "PUT",
      url: "/api/internal/ai-session-next-input-suggestion-settings",
      headers: authorization,
      payload: { enabled: true, reasoningEffort: "session" },
    });
    assert.equal(followSession.statusCode, 200);
    assert.deepEqual(followSession.json().data, { applied: true, enabled: true, reasoningEffort: "session" });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/internal/ai-session-next-input-suggestion-settings",
      headers: authorization,
      payload: { enabled: true, reasoningEffort: "future" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "AI_SESSION_NEXT_INPUT_SUGGESTION_SETTINGS_INVALID");
  } finally {
    await app.close();
    restore();
  }
});
