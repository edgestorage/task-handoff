const assert = require("node:assert/strict");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("../../../test/workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AcpSessionProvider } = require("../src/acp.ts");
const { AiSessionRegistry } = require("../src/ai-session-registry.ts");
const { AiSessionTimelineStore } = require("../src/ai-session/timeline-store.ts");

const fixture = join(__dirname, "../../../test/fixtures/fake-acp-story-agent.mjs");

function providerFor(root, capture, env = {}, snapshot = true) {
  const registry = new AiSessionRegistry({ dir: join(root, "sessions") });
  const provider = new AcpSessionProvider(
    "gemini",
    registry,
    () => ({ executable: process.execPath, args: [fixture], env: { ...env, FAKE_ACP_CAPTURE: capture } }),
    () => {},
    new AiSessionTimelineStore(join(root, "timeline")),
    true,
    snapshot ? { instructionSnapshotPath: join(root, "story-instructions.json") } : {},
  );
  return { provider, registry };
}

function captured(capture) {
  return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("ACP session/new appends Story instructions through the native system prompt", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const { provider } = providerFor(root, capture);
  try {
    const created = await provider.createSession({ cwd: root, appendedPrompt: "Story rules" });
    assert.equal(created.providerSessionId, "story-acp-session");
    const requests = captured(capture);
    assert.deepEqual(requests[0].params.systemPrompt, {
      mode: "append",
      content: [{ type: "text", text: "Story rules" }],
    });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP leaves the first user prompt unchanged and reports the original user message", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const { provider, registry } = providerFor(root, capture);
  try {
    const created = await provider.createSession({ cwd: root, appendedPrompt: "Story rules" });
    const session = registry.start({ ...created, agent: "gemini" });
    await provider.startMessage(session, { message: "hello" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (captured(capture).some((request) => request.method === "session/prompt")) break;
      await delay(20);
    }
    const requests = captured(capture);
    const prompt = requests.find((request) => request.method === "session/prompt");
    assert.deepEqual(prompt.params.prompt, [{ type: "text", text: "hello" }]);
    assert.ok(!JSON.stringify(prompt.params).includes("Story rules"));
    const { items } = await provider.timeline(registry.get(session.id));
    assert.deepEqual(items.filter((item) => item.type === "user-message").map((item) => item.text), ["hello"]);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP rejects Story instructions when the Agent does not advertise systemPrompt support", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const { provider } = providerFor(root, capture, { FAKE_ACP_SYSTEM_PROMPT: "absent" });
  try {
    await assert.rejects(provider.createSession({ cwd: root, appendedPrompt: "Story rules" }), {
      code: "AI_SESSION_STORY_CONTEXT_UNSUPPORTED",
    });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP surfaces a structured error when the Agent rejects append mode", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const { provider } = providerFor(root, capture, { FAKE_ACP_REJECT_PROMPT: "1" });
  try {
    await assert.rejects(provider.createSession({ cwd: root, appendedPrompt: "Story rules" }), {
      code: "AI_SESSION_PROVIDER_UNAVAILABLE",
    });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP replays the persisted Story instruction snapshot on session/load", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const first = providerFor(root, capture);
  const created = await first.provider.createSession({ cwd: root, appendedPrompt: "Story rules" });
  await first.provider.close();
  const second = providerFor(root, capture);
  try {
    await second.provider.restore(created.providerSessionId, root);
    const load = captured(capture).find((request) => request.method === "session/load");
    assert.deepEqual(load.params.systemPrompt, {
      mode: "append",
      content: [{ type: "text", text: "Story rules" }],
    });
  } finally {
    await second.provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP rejects restoring a Story snapshot when the Agent no longer advertises systemPrompt", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const first = providerFor(root, capture);
  const created = await first.provider.createSession({ cwd: root, appendedPrompt: "Story rules" });
  await first.provider.close();
  const second = providerFor(root, capture, { FAKE_ACP_SYSTEM_PROMPT: "absent" });
  try {
    await assert.rejects(second.provider.restore(created.providerSessionId, root), {
      code: "AI_SESSION_STORY_CONTEXT_UNSUPPORTED",
    });
  } finally {
    await second.provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP omits the system prompt when no Story instructions were requested", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskhandoff-acp-story-"));
  const capture = join(root, "capture.jsonl");
  const { provider } = providerFor(root, capture);
  try {
    await provider.createSession({ cwd: root });
    const requests = captured(capture);
    assert.equal(requests[0].params.systemPrompt, undefined);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
