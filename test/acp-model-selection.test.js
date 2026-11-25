const assert = require("node:assert/strict");
const { once, EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AcpSessionProvider } = require("../packages/ai-session-runtime/src/acp.ts");
const { AiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { AiSessionTimelineStore } = require("../packages/ai-session-runtime/src/ai-session/timeline-store.ts");

async function harness(agent, mode) {
  const cwd = await mkdtemp(join(tmpdir(), `taskhandoff-acp-model-${agent}-`));
  const registry = new AiSessionRegistry({ dir: join(cwd, "sessions") });
  const changes = new EventEmitter();
  const stop = registry.onChange(() => changes.emit("change"));
  const fixture = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  const provider = new AcpSessionProvider(agent, registry, () => ({
    executable: process.execPath,
    args: mode ? [fixture, mode] : [fixture],
    env: {},
  }), () => undefined, new AiSessionTimelineStore(join(cwd, "timeline")));
  return {
    cwd, registry, provider, changes,
    async dispose() { stop(); await provider.close(); await rm(cwd, { recursive: true, force: true }); },
  };
}

async function waitForSession(registry, changes, id, status) {
  const deadline = Date.now() + 10_000;
  while (registry.get(id)?.status !== status) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${status}`);
    await once(changes, "change");
  }
}

async function promptText(provider, registry, changes, session, message) {
  const { turnId } = await provider.startMessage(session, { message });
  await waitForSession(registry, changes, session.id, "idle");
  const { items } = await provider.turnTimeline(registry.get(session.id), turnId);
  return items.find((item) => item.type === "ai-message")?.text;
}

const selection = (upstreamName) => ({
  modelEntityId: "demo", modelName: upstreamName === "model-b" ? "Model B" : "Model A", modelUpstreamName: upstreamName,
});

test("ACP model selection applies configOptions, legacy models, and dsh JSON values", { timeout: 20_000 }, async () => {
  const cases = [
    { agent: "commandcode", mode: "commandcode", expected: "task-handoff-demo/model-b" },
    { agent: "gemini", mode: "legacy-models", expected: "model-b" },
    { agent: "dsh", mode: "dsh-json", expected: JSON.stringify(["task-handoff-demo", "model-b"]) },
  ];
  for (const item of cases) {
    const context = await harness(item.agent, item.mode);
    try {
      const created = await context.provider.createSession({ cwd: context.cwd, modelSelection: selection("model-b") });
      assert.equal(created.modelSelection?.modelUpstreamName, "model-b");
      const session = context.registry.start({ ...created, agent: item.agent });
      assert.equal(await promptText(context.provider, context.registry, context.changes, session, "selected-model"), item.expected);
      await context.provider.updateModelSelection(context.registry.get(session.id), selection("model-a"));
      assert.equal(context.registry.get(session.id).modelSelection?.modelUpstreamName, "model-a");
      assert.equal(
        await promptText(context.provider, context.registry, context.changes, context.registry.get(session.id), "selected-model"),
        item.expected.replace("model-b", "model-a"),
      );
    } finally {
      await context.dispose();
    }
  }
});

test("ACP reasoning effort selects and switches through thought_level options", { timeout: 15_000 }, async () => {
  const context = await harness("commandcode", "commandcode");
  try {
    const created = await context.provider.createSession({
      cwd: context.cwd,
      modelSelection: selection("model-a"),
      reasoningEffort: "high",
    });
    assert.equal(created.reasoningEffort, "high");
    let session = context.registry.start({ ...created, agent: "commandcode" });
    assert.equal(await promptText(context.provider, context.registry, context.changes, session, "selected-effort"), "high");
    await context.provider.updateReasoningEffort(context.registry.get(session.id), "low");
    assert.equal(context.registry.get(session.id).reasoningEffort, "low");
    session = context.registry.get(session.id);
    assert.equal(await promptText(context.provider, context.registry, context.changes, session, "selected-effort"), "low");
  } finally {
    await context.dispose();
  }
});

test("ACP keeps an empty provider-default reasoning option after model selection", { timeout: 15_000 }, async () => {
  const context = await harness("dsh", "dsh-empty-effort-current");
  try {
    const created = await context.provider.createSession({
      cwd: context.cwd,
      modelSelection: selection("model-b"),
      reasoningEffort: "high",
    });
    assert.equal(created.reasoningEffort, "high");
    const session = context.registry.start({ ...created, agent: "dsh" });
    assert.equal(await promptText(context.provider, context.registry, context.changes, session, "selected-effort"), "high");
  } finally {
    await context.dispose();
  }
});

test("ACP Gemini accepts configured models that legacy availableModels omits", { timeout: 15_000 }, async () => {
  const context = await harness("gemini", "legacy-unlisted-model");
  try {
    const created = await context.provider.createSession({ cwd: context.cwd, modelSelection: selection("model-b") });
    assert.equal(created.modelSelection?.modelUpstreamName, "model-b");
    const session = context.registry.start({ ...created, agent: "gemini" });
    assert.equal(await promptText(context.provider, context.registry, context.changes, session, "selected-model"), "model-b");
    await context.provider.updateModelSelection(context.registry.get(session.id), selection("model-a"));
    assert.equal(
      await promptText(context.provider, context.registry, context.changes, context.registry.get(session.id), "selected-model"),
      "model-a",
    );
  } finally {
    await context.dispose();
  }
});

test("ACP Gemini requires a new session when changing model entities", { timeout: 15_000 }, async () => {
  const context = await harness("gemini", "legacy-unlisted-model");
  try {
    const created = await context.provider.createSession({ cwd: context.cwd, modelSelection: selection("model-a") });
    const session = context.registry.start({ ...created, agent: "gemini" });
    await assert.rejects(
      context.provider.updateModelSelection(context.registry.get(session.id), {
        ...selection("model-b"),
        modelEntityId: "other-entity",
      }),
      { code: "AI_SESSION_MODEL_SELECTION_UNSUPPORTED" },
    );
    await context.provider.updateModelSelection(context.registry.get(session.id), selection("model-b"));
  } finally {
    await context.dispose();
  }
});

test("ACP rejects model switching while a turn is active", { timeout: 15_000 }, async () => {
  const context = await harness("commandcode", "commandcode");
  try {
    const created = await context.provider.createSession({ cwd: context.cwd, modelSelection: selection("model-a") });
    const session = context.registry.start({ ...created, agent: "commandcode" });
    await context.provider.startMessage(session, { message: "approval" });
    await waitForSession(context.registry, context.changes, session.id, "waiting");
    await assert.rejects(
      context.provider.updateModelSelection(context.registry.get(session.id), selection("model-b")),
      { code: "AI_SESSION_MODEL_SELECTION_CONFLICT" },
    );
    await context.provider.interrupt(context.registry.get(session.id));
  } finally {
    await context.dispose();
  }
});
