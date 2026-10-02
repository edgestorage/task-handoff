const assert = require("node:assert/strict");
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

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");
const { ControlPlanePersistenceMaintenance } = require("../packages/control-plane/src/control-plane/persistence/maintenance.ts");
const {
  decodePersistedAiSession,
  encodePersistedAiSession,
} = require("../packages/ai-session-runtime/src/ai-session/persistence.ts");

function runtime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-unread-"));
  return { root, registry: createAiSessionRegistry({ dir: root }) };
}

test("AI session unread derives from lifecycle transitions and explicit patches win", () => {
  const { registry } = runtime();
  const session = registry.start({ agent: "codex", status: "running" });
  assert.equal(session.unread, false);

  assert.equal(registry.complete(session.id, "done").unread, true);
  assert.equal(registry.patch(session.id, { status: "running" }).unread, false);
  assert.equal(registry.fail(session.id, new Error("boom")).unread, true);
  assert.equal(registry.patch(session.id, { status: "waiting" }).unread, false);
  assert.equal(registry.patch(session.id, { status: "idle" }).unread, true);

  assert.equal(registry.patch(session.id, { status: "running", unread: true }).unread, true);
  assert.equal(registry.patch(session.id, { status: "idle", unread: false }).unread, false);
  assert.equal(registry.patch(session.id, { unread: true }).unread, true);
});

test("AI session markRead clears unread without advancing updatedAt and is idempotent", () => {
  const { registry } = runtime();
  const session = registry.start({ agent: "codex", status: "running" }, { timestamp: "2026-07-25T00:00:00.000Z" });
  registry.complete(session.id, "done");
  const settled = registry.get(session.id);
  assert.equal(settled.unread, true);

  const read = registry.markRead(session.id);
  assert.equal(read.unread, false);
  assert.equal(read.updatedAt, settled.updatedAt);

  const again = registry.markRead(session.id);
  assert.equal(again.unread, false);
  assert.equal(again.updatedAt, settled.updatedAt);
  assert.equal(registry.markRead("missing"), undefined);
});

test("AI session unread persists across registry restarts and legacy records decode as read", () => {
  const { root, registry } = runtime();
  const session = registry.start({ agent: "codex", status: "running" });
  registry.complete(session.id, "done");

  const persisted = JSON.parse(fs.readFileSync(registry.sessionPath(session.id), "utf8"));
  assert.equal(persisted.unread, true);
  assert.equal(registry.snapshot().sessions.find((item) => item.id === session.id).unread, true);
  assert.equal(registry.get(session.id).unread, true);

  const restored = createAiSessionRegistry({ dir: root });
  assert.equal(restored.get(session.id).unread, true);
  assert.equal(restored.markRead(session.id).unread, false);
  assert.equal(createAiSessionRegistry({ dir: root }).get(session.id).unread, false);

  const { unread: _unread, ...legacyRecord } = persisted;
  const legacy = decodePersistedAiSession(legacyRecord);
  assert.equal(legacy.unread, false);
  assert.equal(encodePersistedAiSession(legacy).unread, false);
});

test("AI session restoreHistory keeps an existing unread state", () => {
  const { registry } = runtime();
  const session = registry.start({ agent: "codex", status: "running" }, { timestamp: "2026-07-25T00:00:00.000Z" });
  registry.complete(session.id, "done");

  const restored = registry.restoreHistory({
    id: session.id,
    agent: "codex",
    creationSource: "app-session",
    providerSessionId: "provider-1",
    lastActiveAt: "2026-07-25T00:00:00.000Z",
  });
  assert.equal(restored.unread, true);
});

test("control-plane maintenance retires the legacy unread projection directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-unread-retire-"));
  const paths = controlPlaneStorePaths(root);
  fs.mkdirSync(path.join(root, "ai-session-unread"), { recursive: true });
  fs.writeFileSync(path.join(root, "ai-session-unread", "instance_1.json"), "{}\n");

  new ControlPlanePersistenceMaintenance(paths).run();

  assert.equal(fs.existsSync(path.join(root, "ai-session-unread")), false);
  assert.equal(fs.readdirSync(path.join(root, "retired-persistence")).some((entry) => entry.endsWith("-ai-session-unread")), true);
});
