const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("../../../test/workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { CodexAppServerClient } = require("../src/codex-app-server/client/client.ts");
const { OpenCodeSessionBridge } = require("../src/opencode.ts");
const { OpenCodeClient } = require("../src/opencode/client.ts");

const parity = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/story-context-provider-parity.json"), "utf8"));
const storyInstructions = parity.appendedPrompt;

test("Codex keeps Story instructions on thread/start and out of turn/start", async () => {
  const requests = [];
  const client = new CodexAppServerClient({ resolveVersion: async () => "0.161.0" });
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-story", cwd: "/tmp/workspace", status: { type: "idle" } } };
    }
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    throw new Error(`unexpected request: ${method}`);
  };

  await client.startThread({ cwd: "/tmp/workspace", developerInstructions: storyInstructions });
  await client.startTurn("thread-story", "user request");

  const start = requests.find((request) => request.method === "thread/start");
  const turn = requests.find((request) => request.method === "turn/start");
  assert.equal(start.params.developerInstructions, parity.appendedPrompt);
  assert.equal(turn.params.developerInstructions, undefined);
  assert.deepEqual(turn.params.input, [{ type: "text", text: parity.userMessage, text_elements: [] }]);
});

test("Codex never re-sends Story instructions through thread/resume or thread/fork", async () => {
  const requests = [];
  const client = new CodexAppServerClient({ resolveVersion: async () => "0.165.0" });
  client.capabilityVersion = () => "0.165.0";
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/resume") {
      return { thread: { id: "thread-existing", cwd: "/tmp/workspace", status: { type: "idle" } } };
    }
    if (method === "thread/fork") {
      return { thread: { id: "thread-forked", cwd: "/tmp/workspace", status: { type: "idle" } } };
    }
    throw new Error(`unexpected request: ${method}`);
  };

  await client.resumeThread("thread-existing", { model: "gpt-5" });
  await client.forkThread({ threadId: "thread-existing", cwd: "/tmp/workspace" });

  for (const request of requests) assert.equal(request.params.developerInstructions, undefined);
});

test("OpenCode sends Story instructions only through prompt_async.system", async () => {
  const calls = [];
  const client = new OpenCodeClient(async () => ({ endpoint: "http://127.0.0.1:1", headers: {} }));
  client.request = async (requestPath, _schema, options) => {
    calls.push({ path: requestPath, body: options?.body });
    return {};
  };

  await client.promptAsync("s1", "/tmp/workspace", "m1", [{ type: "text", text: parity.userMessage }], undefined, storyInstructions);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/session/s1/prompt_async");
  assert.deepEqual(calls[0].body, {
    messageID: "m1",
    parts: [{ type: "text", text: parity.userMessage }],
    system: parity.appendedPrompt,
  });
});

test("OpenCode persists and restores the provider-private Story instruction snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-story-"));
  const snapshot = path.join(root, "opencode-story-instructions.json");
  try {
    const bridge = new OpenCodeSessionBridge({}, {
      connection: async () => ({ endpoint: "http://127.0.0.1:1", headers: {} }),
      workspaceRoots: () => ["/tmp/workspace"],
      instructionSnapshotPath: snapshot,
    });
    bridge.ensureReady = async () => undefined;
    bridge.reconcile = async () => undefined;
    bridge.armTitleGeneration = () => undefined;
    bridge.client = {
      createSession: async () => ({ id: "s1", directory: "/tmp/workspace" }),
      deleteSession: async () => undefined,
    };

    await bridge.createSession({ cwd: "/tmp/workspace", appendedPrompt: storyInstructions });
    assert.deepEqual(JSON.parse(fs.readFileSync(snapshot, "utf8")), {
      version: 1,
      sessions: { s1: storyInstructions },
    });

    const restored = new OpenCodeSessionBridge({}, {
      connection: async () => ({ endpoint: "http://127.0.0.1:1", headers: {} }),
      workspaceRoots: () => ["/tmp/workspace"],
      instructionSnapshotPath: snapshot,
    });
    const promptCalls = [];
    restored.client = { promptAsync: async (...args) => promptCalls.push(args) };
    restored.scheduleReconcile = () => undefined;
    await restored.submitMessage({
      providerSessionId: "s1",
      cwd: "/tmp/workspace",
    }, {
      message: "after restart",
      messageId: "m2",
      attachments: [],
      references: [],
    });

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0][5], storyInstructions);
    assert.deepEqual(promptCalls[0][3], [{ type: "text", text: "after restart" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
