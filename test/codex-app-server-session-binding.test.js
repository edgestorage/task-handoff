const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const test = require("node:test");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  CodexAppServerSessionBinding,
  codexAppServerSocketPath,
} = require("../packages/ai-session-runtime/src/codex-app-server/session/binding.ts");

test("Codex app-server binding selects a running Codex socket", () => {
  const sessions = [
    { id: "stopped", appId: "codex", status: "stopped", ai: { appServer: { socketPath: "/tmp/stopped.sock" } } },
    { id: "claude", appId: "claude", status: "running", ai: { appServer: { socketPath: "/tmp/claude.sock" } } },
    { id: "codex", appId: "codex", status: "running", ai: { appServer: { socketPath: "/tmp/codex.sock" } } },
  ];

  assert.equal(codexAppServerSocketPath(sessions), "/tmp/codex.sock");
});

test("Codex app-server binding resolves only explicit thread metadata on its active socket", () => {
  const binding = new CodexAppServerSessionBinding();
  assert.equal(binding.update([
    {
      id: "app-one",
      appId: "codex",
      status: "running",
      ai: {
        activeThreadId: "thread-active",
        threadIds: ["thread-active", "thread-known", 42],
        appServer: { socketPath: "/tmp/codex.sock", command: "/opt/codex/bin/codex" },
      },
    },
    {
      id: "app-other-socket",
      appId: "codex",
      status: "running",
      ai: { threadIds: ["thread-other"], appServer: { socketPath: "/tmp/other.sock" } },
    },
  ]), "/tmp/codex.sock");

  assert.equal(binding.command, "/opt/codex/bin/codex");
  assert.equal(binding.appSessionIdForThread("thread-active"), "app-one");
  assert.equal(binding.appSessionIdForThread("thread-known"), "app-one");
  assert.equal(binding.appSessionIdForThread("thread-other"), undefined);
  assert.equal(binding.appSessionIdForThread("thread-unknown"), undefined);
});

test("Codex app-server binding safely projects historical runtime values", () => {
  const binding = new CodexAppServerSessionBinding();
  const mutableThreadIds = ["thread-before"];

  assert.doesNotThrow(() => binding.update([
    null,
    42,
    { id: "bad-ai", appId: "codex", status: "running", ai: "old-shape" },
    { id: "bad-server", appId: "codex", status: "running", ai: { appServer: [] } },
    {
      id: "valid",
      appId: "codex",
      status: "running",
      unknownFutureField: true,
      ai: {
        threadIds: mutableThreadIds,
        appServer: { socketPath: "/tmp/valid.sock", future: true },
      },
    },
  ]));
  mutableThreadIds.push("thread-after");

  assert.equal(binding.socketPath, "/tmp/valid.sock");
  assert.equal(binding.appSessionIdForThread("thread-before"), "valid");
  assert.equal(binding.appSessionIdForThread("thread-after"), undefined);

  binding.clear();
  assert.equal(binding.socketPath, undefined);
  assert.equal(binding.command, undefined);
  assert.equal(binding.appSessionIdForThread("thread-before"), undefined);
});

test("Codex app-server binding tolerates snapshots without command", () => {
  const binding = new CodexAppServerSessionBinding();

  binding.update([{
    id: "legacy",
    appId: "codex",
    status: "running",
    ai: { appServer: { socketPath: "/tmp/legacy.sock" } },
  }]);

  assert.equal(binding.socketPath, "/tmp/legacy.sock");
  assert.equal(binding.command, undefined);
});
