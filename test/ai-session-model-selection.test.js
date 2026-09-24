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

const instanceId = "inst_model_selection";
const registrationToken = "instance-registration-token";

function pathsFor(root) {
  return {
    configPath: path.join(root, "config.json"), dataDir: root, appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"), runtimeDir: path.join(root, "runtime"), eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"), logDir: path.join(root, "logs"), webTokenPath: path.join(root, "web-token"),
  };
}

function setEnvironment(paths, catalog) {
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
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: catalog === undefined ? undefined : JSON.stringify(catalog),
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) value === undefined ? delete process.env[key] : process.env[key] = value;
  return () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

function catalogWith(entities) {
  return { protocolVersion: "2026-08-27", instanceId, entities, updatedAt: "2026-09-24T00:00:00.000Z" };
}

function codexModel(id, name) {
  return {
    id,
    endpoint: "https://models.example/v1",
    key: "instance-secret-key",
    protocols: ["openai-responses"],
    modelNames: [{ name, order: 0 }],
  };
}

function codexBridgeStub(switches) {
  return {
    id: "model-selection-codex-stub",
    agent: "codex",
    refresh() {},
    stop() {},
    async ensureReady() {},
    supportsThreadSettingsUpdate: () => true,
    async updateModelSelection(session, selection) {
      switches.push({ sessionId: session.id, selection });
      return selection;
    },
  };
}

async function createRuntime() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-model-selection-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths, catalogWith([codexModel("mdl_current", "gpt-5.6-sol")]));
  const switches = [];
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const app = await createWebApp({
    staticDir: path.join(dataRoot, "missing-static"),
    logger: false,
    appRuntime: new AppRuntimeManager(paths),
    aiSessionRegistry: aiSessions,
    codexAppServer: codexBridgeStub(switches),
  });
  // A stored selection whose entity was removed upstream: the runtime holds the
  // catalogue but the session still points at the previous model identity.
  const session = aiSessions.start({
    agent: "codex",
    creationSource: "ai-session",
    cwd: dataRoot,
    status: "idle",
    modelSelection: { modelEntityId: "mdl_removed", modelName: "gpt-5.5" },
  });
  return { dataRoot, aiSessions, app, restore, session, switches };
}

test("switching an AI session to a model the instance holds is accepted", async () => {
  const { app, restore, session, switches } = await createRuntime();
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/api/ai-sessions/${session.id}/model-selection`,
      payload: { clientRequestId: "switch-to-current", modelSelection: { modelEntityId: "mdl_current", modelName: "gpt-5.6-sol" } },
    });
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
    assert.deepEqual(response.json().data, { sessionId: session.id, accepted: true });
    assert.deepEqual(switches, [{ sessionId: session.id, selection: { modelEntityId: "mdl_current", modelName: "gpt-5.6-sol" } }]);
  } finally {
    await app.close();
    restore();
  }
});

test("a switch target the instance does not hold is reported as a target problem, not as the session's previous model", async () => {
  const { app, restore, session, switches } = await createRuntime();
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/api/ai-sessions/${session.id}/model-selection`,
      payload: { clientRequestId: "switch-to-missing", modelSelection: { modelEntityId: "mdl_unknown", modelName: "gpt-5.6-sol" } },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "AI_SESSION_MODEL_TARGET_UNAVAILABLE");
    assert.doesNotMatch(response.json().error.message, /previously selected|previous/);
    assert.equal(switches.length, 0);
  } finally {
    await app.close();
    restore();
  }
});

test("a live catalog push heals a switch target the runtime had not loaded", async () => {
  const { app, restore, session, switches } = await createRuntime();
  try {
    const rejected = await app.inject({
      method: "PUT",
      url: `/api/ai-sessions/${session.id}/model-selection`,
      payload: { clientRequestId: "switch-before-heal", modelSelection: { modelEntityId: "mdl_fresh", modelName: "gpt-5.6-terra" } },
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, "AI_SESSION_MODEL_TARGET_UNAVAILABLE");

    const pushed = await app.inject({
      method: "PUT",
      url: "/api/internal/model-catalog",
      headers: { authorization: `Bearer ${registrationToken}` },
      payload: catalogWith([codexModel("mdl_current", "gpt-5.6-sol"), codexModel("mdl_fresh", "gpt-5.6-terra")]),
    });
    assert.equal(pushed.statusCode, 200, JSON.stringify(pushed.json()));

    const accepted = await app.inject({
      method: "PUT",
      url: `/api/ai-sessions/${session.id}/model-selection`,
      payload: { clientRequestId: "switch-after-heal", modelSelection: { modelEntityId: "mdl_fresh", modelName: "gpt-5.6-terra" } },
    });
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.json()));
    assert.deepEqual(switches, [{ sessionId: session.id, selection: { modelEntityId: "mdl_fresh", modelName: "gpt-5.6-terra" } }]);
  } finally {
    await app.close();
    restore();
  }
});

test("the instance model catalog diagnostic requires the registration token and never projects credentials", async () => {
  const { app, restore } = await createRuntime();
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/internal/model-catalog" });
    assert.equal(anonymous.statusCode, 403);
    assert.equal(anonymous.json().error.code, "MANAGED_MODEL_CATALOG_FORBIDDEN");

    const authorized = await app.inject({
      method: "GET",
      url: "/api/internal/model-catalog",
      headers: { authorization: `Bearer ${registrationToken}` },
    });
    assert.equal(authorized.statusCode, 200);
    const { source, loadedAt, catalog } = authorized.json().data;
    assert.equal(source, "environment");
    assert.ok(loadedAt);
    assert.deepEqual(catalog.entities, [{
      id: "mdl_current",
      protocols: ["openai-responses"],
      modelNames: [{ name: "gpt-5.6-sol", order: 0 }],
    }]);
    assert.equal(JSON.stringify(authorized.json()).includes("instance-secret-key"), false);
    assert.equal(JSON.stringify(authorized.json()).includes("models.example"), false);
  } finally {
    await app.close();
    restore();
  }
});
