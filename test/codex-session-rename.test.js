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
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");

class RenameClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }
  async start() {}
  stop() {}
  async listLoadedThreadIds() { return ["thread-rename"]; }
  async setThreadName(threadId, name) { this.calls.push(["set", threadId, name]); }
  async readThread(threadId) {
    this.calls.push(["read", threadId]);
    return { id: threadId, name: "Provider name", cwd: "/workspace", status: { type: "idle" } };
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-rename-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = createAiSessionRegistry({ dir: path.join(root, "registry") });
  const client = new RenameClient();
  const bridge = new CodexAppServerSessionBridge(registry, client);
  const session = registry.start({ agent: "codex", providerSessionId: "thread-rename", title: "Original", status: "idle" });
  return { registry, client, bridge, session };
}

test("Codex rename updates only the AI Session title", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await state.bridge.renameSession(state.session, "  Renamed  "), { title: "Renamed", authority: "adapter" });
  assert.equal(state.registry.get(state.session.id).title, "Renamed");
  assert.deepEqual(state.client.calls, []);
});

test("Codex rename persists an empty AI Session title without clearing the provider name", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await state.bridge.renameSession(state.session, "   "), { title: "", authority: "adapter" });
  assert.equal(state.registry.get(state.session.id).title, undefined);
  assert.deepEqual(state.client.calls, []);

  state.client.emit("event", { type: "thread-name", threadId: "thread-rename", name: "Provider renamed later" });
  assert.equal(state.registry.get(state.session.id).title, undefined);
});
