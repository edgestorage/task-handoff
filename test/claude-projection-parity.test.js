const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const test = require("node:test");
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
const { ClaudeControlSockSessionBridge } = require("../packages/ai-session-runtime/src/claude-control-sock.ts");
const { appendAttachmentPaths } = require("../packages/ai-session-runtime/src/ai-session-attachments.ts");
const { hasClaudeDaemonJob, replyClaudeDaemonJob, killClaudeDaemonJob, subscribeClaudeDaemonJob } = require("../packages/core/src/core/claude-control-sock.ts");
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/ai-session/tests/fixtures/claude-projection-parity.json"), "utf8"));

for (const kind of ["discovery", "subscriptions"]) {
  test(`Claude ${kind} matches shared Node/Rust provider fixtures`, async () => {
    for (const fixture of fixtures[kind]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parity-"));
      const registry = createAiSessionRegistry({ dir: path.join(root, "sessions") });
      let onMessage;
      const bridge = new ClaudeControlSockSessionBridge(registry, {
        list: async () => ({ ok: true, jobs: [fixture.job || { short: "a1b2c3d4", sessionId: "claude-parity-provider", state: "running", detail: "working" }] }),
        subscribe: (_short, input) => { onMessage = input.onMessage; return () => {}; },
        reply: async () => ({ ok: true }),
        kill: async () => ({ ok: true }),
      });
      try {
        await bridge.refresh({ registry, appSessions: [{ id: "aps_parity", appId: "claude", title: "Claude", status: "running", ai: { claude: { short: "a1b2c3d4", controlSock: "/tmp/claude-parity.sock" } } }] });
        if (fixture.message) onMessage(fixture.message);
        const session = registry.list()[0];
        assert.deepEqual({ status: session.status, phase: session.phase, providerState: session.providerMeta?.state ?? null, stateSource: session.providerMeta?.stateSource ?? null }, fixture.expected, fixture.name);
      } finally {
        bridge.stop();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test("Claude attachment fallback matches shared Node/Rust message fixtures", () => {
  for (const fixture of fixtures.messages) {
    let actual = appendAttachmentPaths(fixture.message, fixture.files);
    if (!actual.endsWith("\n")) actual += "\n";
    assert.equal(actual, fixture.expected, fixture.name);
  }
});

test("Claude control operations validate worker short before connecting", () => {
  for (const short of ["", "A1B2C3D4", "a1b2c3d", "a1b2c3d45", "a1b2c3dg", " a1b2c3d4 "]) {
    for (const call of [() => hasClaudeDaemonJob(short), () => replyClaudeDaemonJob(short, "hello"), () => killClaudeDaemonJob(short), () => subscribeClaudeDaemonJob(short)]) {
      assert.throws(call, /short id must be 8 hex chars/, short);
    }
  }
});

test("Claude control failures match shared Node/Rust error fixtures", async () => {
  for (const fixture of fixtures.errors) {
    const bridge = new ClaudeControlSockSessionBridge({}, {
      reply: async () => fixture.response,
      kill: async () => fixture.response,
    });
    const method = { send: "startMessage", steer: "steerMessage", interrupt: "interrupt" }[fixture.action];
    await assert.rejects(
      () => bridge[method]({ providerMeta: { short: "a1b2c3d4" } }, { message: "hello" }),
      (error) => { assert.deepEqual({ code: error.code, message: error.message }, fixture.expected); return true; },
    );
  }
});
