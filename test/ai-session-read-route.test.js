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
const { AiSessionReadResultSchema } = require("../packages/protocol/src/ai-sessions.ts");

const instanceId = "inst_read_route";
const registrationToken = "instance-registration-token";

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
    TASK_HANDOFF_RUNTIME_KIND: undefined,
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) value === undefined ? delete process.env[key] : process.env[key] = value;
  return () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

async function createRuntime() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-read-route-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const app = await createWebApp({
    staticDir: path.join(dataRoot, "missing-static"),
    logger: false,
    appRuntime: new AppRuntimeManager(paths),
    aiSessionRegistry: aiSessions,
    codexAppServer: {
      id: "read-route-stub",
      agent: "codex",
      refresh() {},
      stop() {},
      async ensureReady() {},
      supportsThreadSettingsUpdate: () => true,
      supportsProviderReload: () => false,
    },
  });
  return { dataRoot, aiSessions, app, restore };
}

test("the controlled-instance read route clears unread and returns the settled session identity", async () => {
  const { aiSessions, app, restore } = await createRuntime();
  try {
    const session = aiSessions.start({ agent: "codex", status: "running" }, { timestamp: "2026-07-25T00:00:00.000Z" });
    aiSessions.complete(session.id, "done");
    const settled = aiSessions.get(session.id);
    assert.equal(settled.unread, true);

    const response = await app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/read` });
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
    const result = AiSessionReadResultSchema.parse(response.json().data);
    assert.deepEqual(result, { sessionId: session.id, unread: false });
    assert.equal(aiSessions.get(session.id).unread, false);
    assert.equal(aiSessions.get(session.id).updatedAt, settled.updatedAt);
  } finally {
    await app.close();
    restore();
  }
});

test("the controlled-instance read route reports an unknown session as not found", async () => {
  const { app, restore } = await createRuntime();
  try {
    const response = await app.inject({ method: "POST", url: "/api/ai-sessions/ais_missing/read" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "AI_SESSION_NOT_FOUND");
  } finally {
    await app.close();
    restore();
  }
});
