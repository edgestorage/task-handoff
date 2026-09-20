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

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

function codexBridgeStub() {
  return {
    id: "story-ai-session-read-codex-stub",
    agent: "codex",
    refresh() {},
    async ensureReady() {},
    async sync() {},
    stop() {},
    supportsThreadSettingsUpdate() { return false; },
    async readSession() {},
    async archiveSession() {},
    async deleteSession() {},
    async unsubscribeSession() {},
    async mentionCatalog() { return { candidates: [], diagnostics: [] }; },
    async searchMentionFiles() { return { candidates: [], complete: true }; },
    async executeCommand() { throw new Error("not used"); },
    async startMessage() { throw new Error("not used"); },
    async interrupt() { throw new Error("not used"); },
    async turnTimeline(session, turnId) {
      return {
        sessionId: session.id,
        turnId,
        generatedAt: "2026-09-20T00:00:00.000Z",
        items: [
          {
            id: "message_user",
            turnId,
            type: "user-message",
            text: "Read release.txt",
            attachments: [{
              id: "attachment_release",
              kind: "file",
              name: "release.txt",
              mime: "text/plain",
              size: 12,
              contentState: "available",
            }],
          },
          {
            id: "activity_read",
            turnId,
            type: "activity",
            activityKind: "tool",
            title: "Read",
            status: "completed",
            input: '{"path":"release.txt"}',
            output: "release contents",
          },
          { id: "message_ai", turnId, type: "ai-message", text: "Ready" },
        ],
      };
    },
  };
}

test("controlled instance exposes current Story AI Session reads only to its node-agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-session-read-"));
  const patch = {
    TASK_HANDOFF_DATA_DIR: path.join(root, "data"),
    TASK_HANDOFF_LOG_DIR: path.join(root, "logs"),
    TASK_HANDOFF_RUNTIME_DIR: path.join(root, "runtime"),
    TASK_HANDOFF_APP_SESSION_DIR: path.join(root, "app-sessions"),
    TASK_HANDOFF_EVENTS_DIR: path.join(root, "events"),
    TASK_HANDOFF_ARTIFACT_DIR: path.join(root, "artifacts"),
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_REGISTRATION_TOKEN: "registration-token",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_WEB_AUTH: "off",
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, patch);
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const session = registry.start({
    agent: "codex",
    providerSessionId: "thread_1",
    cwd: "/workspace",
    status: "idle",
    turns: [{ id: "turn_1", userPrompt: "Read release.txt", lastMessage: "Ready", status: "completed", revision: 1 }],
  }, { suppressPromptTurn: true });
  const app = await createWebApp({
    staticDir: path.join(root, "missing-static"),
    logger: false,
    aiSessionRegistry: registry,
    codexAppServer: codexBridgeStub(),
  });
  try {
    const forbidden = await app.inject({ method: "GET", url: `/api/internal/node-agent/story-ai-sessions/${session.id}` });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const headers = { authorization: "Bearer registration-token" };
    const detail = await app.inject({ method: "GET", url: `/api/internal/node-agent/story-ai-sessions/${session.id}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().data.detail.id, session.id);
    assert.equal(detail.json().data.turnIndex.turns[0].id, "turn_1");

    const turn = await app.inject({ method: "GET", url: `/api/internal/node-agent/story-ai-sessions/${session.id}/turns/turn_1`, headers });
    assert.equal(turn.statusCode, 200, turn.body);
    assert.equal(turn.json().data.body.turn.userPrompt, "Read release.txt");
    assert.equal(turn.json().data.timeline.turnId, "turn_1");
    assert.equal(turn.json().data.timeline.items[0].attachments[0].name, "release.txt");
    assert.equal(turn.json().data.timeline.items[1].input, '{"path":"release.txt"}');
    assert.equal(turn.json().data.timeline.items[1].output, "release contents");

    const missing = await app.inject({ method: "GET", url: "/api/internal/node-agent/story-ai-sessions/closed_history", headers });
    assert.equal(missing.statusCode, 404, missing.body);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
