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
const { AiSessionTimelineReadSchema, AiSessionTimelineSyncReadSchema } = require("../packages/protocol/src/ai-sessions.ts");

const instanceId = "inst_timeline_read_route";
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
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-session-timeline-read-route-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  let items = [{
    id: "message_1",
    turnId: "turn_1",
    type: "ai-message",
    text: "Before switching",
  }];
  const app = await createWebApp({
    staticDir: path.join(dataRoot, "missing-static"),
    logger: false,
    appRuntime: new AppRuntimeManager(paths),
    aiSessionRegistry: aiSessions,
    codexAppServer: {
      id: "timeline-read-route-stub",
      agent: "codex",
      refresh() {},
      stop() {},
      async ensureReady() {},
      supportsThreadSettingsUpdate: () => false,
      supportsProviderReload: () => false,
      async timeline(session) {
        return {
          sessionId: session.id,
          providerSessionId: session.providerSessionId || "thread_timeline",
          items,
          generatedAt: new Date().toISOString(),
        };
      },
      async turnTimeline(session, turnId) {
        return {
          sessionId: session.id,
          turnId,
          items: items.filter((item) => item.turnId === turnId),
          generatedAt: new Date().toISOString(),
        };
      },
    },
  });
  return {
    aiSessions,
    app,
    restore,
    setItems(next) { items = next; },
  };
}

test("Controlled-instance Timeline reads use content revisions for conditional recovery", async () => {
  const { aiSessions, app, restore, setItems } = await createRuntime();
  try {
    const session = aiSessions.start({ agent: "codex", status: "running" }, { timestamp: "2026-10-24T00:00:00.000Z" });
    const firstResponse = await app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}/timeline` });
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    const first = AiSessionTimelineReadSchema.parse(firstResponse.json().data);
    assert.equal(first.kind, "updated");
    assert.equal(first.timeline.items.length, 1);

    const unchangedResponse = await app.inject({
      method: "GET",
      url: `/api/ai-sessions/${session.id}/timeline?revision=${encodeURIComponent(first.revision)}`,
    });
    assert.equal(unchangedResponse.statusCode, 200, unchangedResponse.body);
    assert.deepEqual(AiSessionTimelineReadSchema.parse(unchangedResponse.json().data), {
      kind: "not-modified",
      revision: first.revision,
    });

    setItems([
      ...first.timeline.items,
      { id: "command_2", turnId: "turn_1", type: "activity", activityKind: "commandExecution", title: "After switching", status: "completed" },
    ]);
    const changedResponse = await app.inject({
      method: "GET",
      url: `/api/ai-sessions/${session.id}/timeline?revision=${encodeURIComponent(first.revision)}`,
    });
    assert.equal(changedResponse.statusCode, 200, changedResponse.body);
    const changed = AiSessionTimelineReadSchema.parse(changedResponse.json().data);
    assert.equal(changed.kind, "updated");
    assert.notEqual(changed.revision, first.revision);
    assert.deepEqual(changed.timeline.items.map((item) => item.id), ["message_1", "command_2"]);
  } finally {
    await app.close();
    restore();
  }
});

test("Controlled-instance Timeline sync returns only changed items", async () => {
  const { aiSessions, app, restore, setItems } = await createRuntime();
  try {
    const session = aiSessions.start({ agent: "codex", status: "running" }, { timestamp: "2026-10-24T00:00:00.000Z" });
    const sync = async (knownItems) => app.inject({
      method: "POST",
      url: `/api/ai-sessions/${session.id}/timeline/sync`,
      payload: { knownItems },
    });

    const firstResponse = await sync([]);
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    const first = AiSessionTimelineSyncReadSchema.parse(firstResponse.json().data);
    assert.equal(first.kind, "snapshot");
    assert.deepEqual(first.items.map((entry) => entry.item.id), ["message_1"]);
    const knownAfterSnapshot = first.items.map((entry) => ({ id: entry.item.id, revision: entry.revision }));

    const unchangedResponse = await sync(knownAfterSnapshot);
    assert.deepEqual(AiSessionTimelineSyncReadSchema.parse(unchangedResponse.json().data), {
      kind: "not-modified",
      revision: first.revision,
    });

    const largeOutput = "unchanged-large-output\n".repeat(4_000);
    setItems([
      {
        id: "message_1",
        turnId: "turn_1",
        type: "ai-message",
        text: "Before switching",
      },
      {
        id: "command_large",
        turnId: "turn_1",
        type: "activity",
        activityKind: "commandExecution",
        title: "Large command",
        status: "completed",
        output: largeOutput,
      },
      {
        id: "message_2",
        turnId: "turn_1",
        type: "ai-message",
        text: "Emitted while another session was open",
      },
    ]);
    const changedResponse = await sync(knownAfterSnapshot);
    assert.equal(changedResponse.statusCode, 200, changedResponse.body);
    const changed = AiSessionTimelineSyncReadSchema.parse(changedResponse.json().data);
    assert.equal(changed.kind, "delta");
    assert.deepEqual(changed.upserted.map((entry) => entry.item.id), ["command_large", "message_2"]);
    assert.equal(changed.order, undefined);
    assert.deepEqual(changed.removed, []);
    assert.doesNotMatch(changedResponse.body, /Before switching/);

    const knownAfterDelta = [
      ...knownAfterSnapshot,
      ...changed.upserted.map((entry) => ({ id: entry.item.id, revision: entry.revision })),
    ];
    setItems([
      { id: "message_1", turnId: "turn_1", type: "ai-message", text: "Edited while away" },
      {
        id: "command_large",
        turnId: "turn_1",
        type: "activity",
        activityKind: "commandExecution",
        title: "Large command",
        status: "completed",
        output: largeOutput,
      },
    ]);
    const editedResponse = await sync(knownAfterDelta);
    const edited = AiSessionTimelineSyncReadSchema.parse(editedResponse.json().data);
    assert.equal(edited.kind, "delta");
    assert.deepEqual(edited.upserted.map((entry) => entry.item.id), ["message_1"]);
    assert.deepEqual(edited.removed, ["message_2"]);
    assert.equal(edited.order, undefined);
    assert.doesNotMatch(editedResponse.body, /unchanged-large-output/);

    const turnResponse = await app.inject({
      method: "POST",
      url: `/api/ai-sessions/${session.id}/turns/turn_1/timeline/sync`,
      payload: { knownItems: [] },
    });
    assert.equal(turnResponse.statusCode, 200, turnResponse.body);
    const turn = AiSessionTimelineSyncReadSchema.parse(turnResponse.json().data);
    assert.equal(turn.kind, "snapshot");
    assert.deepEqual(turn.items.map((entry) => entry.item.id), ["message_1", "command_large"]);
  } finally {
    await app.close();
    restore();
  }
});

test("Controlled-instance Timeline sync sends order only when it cannot be derived", async () => {
  const { aiSessions, app, restore, setItems } = await createRuntime();
  try {
    const session = aiSessions.start({ agent: "codex", status: "running" }, { timestamp: "2026-10-24T00:00:00.000Z" });
    const sync = async (knownItems) => app.inject({
      method: "POST",
      url: `/api/ai-sessions/${session.id}/timeline/sync`,
      payload: { knownItems },
    });
    const item = (id, text) => ({ id, turnId: "turn_1", type: "ai-message", text });

    setItems([item("message_a", "A"), item("message_b", "B")]);
    const snapshot = AiSessionTimelineSyncReadSchema.parse((await sync([])).json().data);
    assert.equal(snapshot.kind, "snapshot");
    const known = snapshot.items.map((entry) => ({ id: entry.item.id, revision: entry.revision }));

    setItems([item("message_a", "A"), item("message_middle", "Middle"), item("message_b", "B")]);
    const inserted = AiSessionTimelineSyncReadSchema.parse((await sync(known)).json().data);
    assert.equal(inserted.kind, "delta");
    assert.deepEqual(inserted.upserted.map((entry) => entry.item.id), ["message_middle"]);
    assert.deepEqual(inserted.order, ["message_a", "message_middle", "message_b"]);

    const knownAfterInsert = inserted.order.map((id) => {
      const existing = known.find((entry) => entry.id === id);
      const added = inserted.upserted.find((entry) => entry.item.id === id);
      return existing || { id, revision: added.revision };
    });
    setItems([item("message_b", "B"), item("message_a", "A")]);
    const reordered = AiSessionTimelineSyncReadSchema.parse((await sync(knownAfterInsert)).json().data);
    assert.equal(reordered.kind, "delta");
    assert.deepEqual(reordered.removed, ["message_middle"]);
    assert.deepEqual(reordered.order, ["message_b", "message_a"]);
  } finally {
    await app.close();
    restore();
  }
});
