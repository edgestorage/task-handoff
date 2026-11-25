const assert = require("node:assert/strict");
const { once, EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
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
const { acpPermissionModes } = require("../packages/ai-session-runtime/src/acp-model.ts");
const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { AiSessionTimelineStore } = require("../packages/ai-session-runtime/src/ai-session/timeline-store.ts");

test("ACP provider actions resolve only the current session's request", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "taskhandoff-acp-provider-"));
  const fixture = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  const registry = new AiSessionRegistry({ dir: join(cwd, "sessions") });
  const changes = new EventEmitter();
  const stop = registry.onChange(() => changes.emit("change"));
  const deltas = [];
  let fixtureMode;
  const stores = ["gemini", "commandcode", "dsh"].map((agent) => new AiSessionTimelineStore(join(cwd, "timeline", agent)));
  const providers = ["gemini", "commandcode", "dsh"].map((agent, index) => new AcpSessionProvider(
    agent, registry, () => ({ executable: process.execPath, args: fixtureMode ? [fixture, fixtureMode] : [fixture], env: {} }),
    ({ delta }) => deltas.push(delta),
    stores[index],
  ));
  try {
    const [gemini, commandCode, dsh] = await Promise.all(providers.map(async (provider) => {
      const created = await provider.createSession({ cwd });
      return registry.start({ ...created, agent: provider.agent });
    }));
    assert.equal(gemini.providerSessionId, commandCode.providerSessionId);
    assert.equal(dsh.providerSessionId, commandCode.providerSessionId);
    const waitFor = async (status) => {
      while (registry.get(commandCode.id)?.status !== status) await once(changes, "change");
    };
    await providers[1].startMessage(commandCode, { message: "approval" });
    await waitFor("waiting");
    assert.equal(registry.get(gemini.id)?.status, "idle");
    assert.equal(registry.get(dsh.id)?.status, "idle");
    const approval = registry.get(commandCode.id).actions.approvalRequest;
    assert.deepEqual(approval.decisions, ["allow"]);
    assert.deepEqual(registry.snapshot().sessions.find(({ id }) => id === commandCode.id).actions.approvalRequest, approval);
    assert.equal(JSON.parse(readFileSync(registry.sessionPath(commandCode.id), "utf8")).actions.approvalRequest, undefined);
    await assert.rejects(providers[1].resolveApproval(commandCode, "allow", "stale"), { code: "AI_SESSION_APPROVAL_STALE" });
    await assert.rejects(providers[1].resolveApproval(commandCode, "deny", approval.id), { code: "AI_SESSION_APPROVAL_UNSUPPORTED" });
    await providers[1].resolveApproval(commandCode, "allow", approval.id);
    await waitFor("idle");
    assert.deepEqual(deltas, ["before approval", "approve-once"]);
    await providers[1].startMessage(commandCode, { message: "cancel" });
    await waitFor("waiting");
    await assert.rejects(providers[1].resolveApproval(commandCode, "allow", approval.id), { code: "AI_SESSION_APPROVAL_STALE" });
    await Promise.all([providers[1].interrupt(commandCode), providers[1].interrupt(commandCode)]);
    assert.equal(registry.get(commandCode.id)?.status, "idle");
    await assert.rejects(providers[1].resolveApproval(commandCode, "allow"), { code: "AI_SESSION_APPROVAL_NOT_FOUND" });
    const { turnId } = await providers[1].startMessage(commandCode, { message: "tools" });
    await waitFor("idle");
    const { items } = await providers[1].turnTimeline(commandCode, turnId);
    assert.deepEqual(items.map((item) => item.type), ["user-message", "ai-message", "activity", "ai-message"]);
    assert.equal(items[1].text, "before");
    assert.equal(items[2].status, "completed");
    assert.equal(items[2].output, "tool output");
    assert.equal(items[3].text, "after");
    assert.deepEqual((await providers[0].timeline(gemini)).items, []);
    await providers[1].startMessage(commandCode, { message: "exit-pending" });
    await waitFor("waiting");
    await waitFor("failed");
    assert.equal(registry.get(commandCode.id).actions.approvalRequest, undefined);
    assert.equal(registry.get(gemini.id)?.status, "idle");
    assert.equal(registry.get(dsh.id)?.status, "idle");
    await providers[1].close();
    assert.equal(registry.get(commandCode.id).actions.send, false);
    const retained = (await providers[1].timeline(commandCode)).items;
    const deltaCount = deltas.length;
    for (fixtureMode of ["no-load", "failed-load"]) {
      await assert.rejects(providers[1].restore(commandCode.providerSessionId, cwd), { code: "AI_SESSION_RESUME_UNAVAILABLE" });
      assert.deepEqual((await providers[1].timeline(commandCode)).items, retained);
    }
    fixtureMode = undefined;
    await providers[1].restore(commandCode.providerSessionId, cwd);
    assert.deepEqual((await providers[1].timeline(commandCode)).items, retained);
    assert.equal(deltas.length, deltaCount);
    await providers[1].close();
    stores[1].replace(commandCode.providerSessionId, [{ id: "turn-known", turnId: "turn-known", type: "user-message", text: "known prompt" }]);
    fixtureMode = "replay-known";
    await providers[1].restore(commandCode.providerSessionId, cwd);
    assert.deepEqual((await providers[1].timeline(commandCode)).items.map((item) => item.text), ["known prompt", "recovered reply"]);
    assert.equal(deltas.length, deltaCount);
    await providers[1].startMessage(commandCode, { message: "approval" });
    await waitFor("waiting");
    await assert.rejects(providers[1].resolveApproval(commandCode, "allow", approval.id), { code: "AI_SESSION_APPROVAL_STALE" });
    const restoredApproval = registry.get(commandCode.id).actions.approvalRequest;
    await providers[1].resolveApproval(commandCode, "allow", restoredApproval.id);
    await waitFor("idle");
  } finally {
    stop();
    await Promise.all(providers.map((provider) => provider.close()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP sends image and file attachments with user-message metadata", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "taskhandoff-acp-attachments-"));
  const fixture = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  const registry = new AiSessionRegistry({ dir: join(cwd, "sessions") });
  const store = new AiSessionTimelineStore(join(cwd, "timeline"));
  const changes = new EventEmitter();
  const stop = registry.onChange(() => changes.emit("change"));
  const provider = new AcpSessionProvider(
    "commandcode", registry,
    () => ({ executable: process.execPath, args: [fixture, "image"], env: {} }),
    () => {},
    store,
  );
  try {
    const filePath = join(cwd, "notes.txt");
    await writeFile(filePath, "notes");
    const created = await provider.createSession({ cwd });
    const session = registry.start({ ...created, agent: "commandcode" });
    const attachments = [
      { id: "att-file", kind: "file", name: "notes.txt", mime: "text/plain", size: 5, source: { type: "runtime-path", path: filePath } },
      { id: "att-image", kind: "image", name: "pixel.png", mime: "image/png", size: 4, source: { type: "inline", encoding: "base64", data: Buffer.from([137, 80, 78, 71]).toString("base64") } },
    ];
    const userMessageAttachments = attachments.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size, contentState: "available" }));
    const result = await provider.startMessage(session, { message: "attachments", attachments, userMessageAttachments });
    while (registry.get(session.id)?.status !== "idle") await once(changes, "change");
    assert.equal(registry.get(session.id)?.actions.rename, true);
    assert.equal(registry.get(session.id)?.queue.pendingCount, 0);
    const renamed = await provider.renameSession(registry.get(session.id), "Renamed ACP session");
    assert.equal(renamed.authority, "adapter");
    assert.equal(registry.get(session.id)?.title, "Renamed ACP session");
    const { items } = await provider.turnTimeline(registry.get(session.id), result.turnId);
    assert.deepEqual(items.map((item) => item.type), ["user-message", "ai-message"]);
    assert.equal(items[0].text, "attachments");
    assert.deepEqual(items[0].attachments, userMessageAttachments);
    assert.match(items[1].text, /^text,resource_link,image:image\/png$/);
  } finally {
    stop();
    await provider.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP projects tool calls into reusable Timeline activities", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "taskhandoff-acp-tools-"));
  const fixture = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  const registry = new AiSessionRegistry({ dir: join(cwd, "sessions") });
  const store = new AiSessionTimelineStore(join(cwd, "timeline"));
  const changes = new EventEmitter();
  const stop = registry.onChange(() => changes.emit("change"));
  const realtime = [];
  const provider = new AcpSessionProvider(
    "gemini", registry,
    () => ({ executable: process.execPath, args: [fixture, "tool-kinds"], env: {} }),
    () => {},
    store,
  );
  const unsubscribe = provider.subscribeTimelineItems(({ item }) => {
    if (item.type === "activity") realtime.push(item);
  });
  try {
    const created = await provider.createSession({ cwd });
    const session = registry.start({ ...created, agent: "gemini" });
    const action = await provider.startMessage(session, { message: "tool-kinds" });
    while (registry.get(session.id)?.status !== "idle") await once(changes, "change");
    const { items } = await provider.turnTimeline(registry.get(session.id), action.turnId);
    assert.deepEqual(items.map((item) => item.type), [
      "user-message", "ai-message",
      "activity", "activity", "activity", "activity", "activity", "activity", "activity",
      "ai-message",
    ]);
    const [list, read, edit, search, exec, fetch, other] = items.filter((item) => item.type === "activity");
    assert.deepEqual([list.activityKind, list.title, list.summary, list.paths, list.output], [
      "fileList", "List", "/root", ["/root"], "- /root/notes.txt",
    ]);
    assert.deepEqual([read.activityKind, read.title, read.summary, read.paths, read.output], [
      "fileRead", "Read", "notes.txt", ["/root/notes.txt"], "alpha",
    ]);
    assert.deepEqual([edit.activityKind, edit.title, edit.paths], [
      "fileChange", "File change", ["/root/notes.txt"],
    ]);
    const [change] = JSON.parse(edit.output);
    assert.equal(change.path, "/root/notes.txt");
    assert.equal(change.kind, "update");
    assert.match(change.diff, /-before/);
    assert.match(change.diff, /\+after/);
    assert.deepEqual([search.activityKind, search.title, search.summary, search.paths], [
      "fileSearch", "Search", "needle in /root", ["/root"],
    ]);
    assert.deepEqual([exec.activityKind, exec.title, exec.input, exec.output, exec.exitCode], [
      "commandExecution", "Command", "printf hi", "hi", 0,
    ]);
    assert.deepEqual([fetch.activityKind, fetch.title, fetch.summary, fetch.output], [
      "webFetch", "Fetch URL", "https://example.com/docs", "page",
    ]);
    const think = realtime.filter((item) => item.activityKind === "reasoning").at(-1);
    assert.deepEqual([think.activityKind, think.title, think.output], ["reasoning", "Reasoning", "reasoned"]);
    assert.deepEqual([other.activityKind, other.title, other.input, other.output], [
      "dynamicToolCall", "Custom tool", '{"value":1}', '{"ok":true}',
    ]);
    assert.ok([list, read, edit, search, exec, fetch, other].every((item) => item.status === "completed"));
    assert.equal(items.at(-1).text, "after");
  } finally {
    unsubscribe();
    stop();
    await provider.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP queued messages dispatch through the generic queue controller", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "taskhandoff-acp-queue-"));
  const fixture = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  const registry = new AiSessionRegistry({ dir: join(cwd, "sessions") });
  const store = new AiSessionTimelineStore(join(cwd, "timeline"));
  const changes = new EventEmitter();
  const stop = registry.onChange(() => changes.emit("change"));
  const provider = new AcpSessionProvider("commandcode", registry, () => ({ executable: process.execPath, args: [fixture], env: {} }), () => {}, store);
  const controller = new AiSessionController(registry);
  controller.register(provider);
  try {
    const created = await provider.createSession({ cwd });
    const session = registry.start({ ...created, agent: "commandcode" });
    await controller.sendMessage(session.id, { message: "approval" });
    while (registry.get(session.id)?.status !== "waiting") await once(changes, "change");
    const queued = await controller.sendMessage(session.id, { message: "queued", mode: "queue" });
    assert.equal(queued.action, "queue");
    assert.equal(registry.get(session.id)?.queue.pendingCount, 1);
    const approval = registry.get(session.id).actions.approvalRequest;
    await provider.resolveApproval(registry.get(session.id), "allow", approval.id);
    while (registry.get(session.id)?.status !== "idle") await once(changes, "change");
    await controller.sendNextQueuedMessage(session.id);
    while (registry.get(session.id)?.status !== "idle") await once(changes, "change");
    assert.equal(registry.get(session.id)?.queue.pendingCount, 0);
    const { items } = await provider.timeline(registry.get(session.id));
    assert.deepEqual(items.filter((item) => item.type === "user-message").map((item) => item.text), ["approval", "queued"]);
  } finally {
    stop();
    await provider.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP permission modes follow each Agent's negotiated session modes", { timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "taskhandoff-acp-permissions-"));
  const fixture = join(__dirname, "fixtures", "fake-acp-agent.mjs");
  assert.deepEqual(acpPermissionModes("gemini"), ["ask", "auto-review", "full-access"]);
  assert.deepEqual(acpPermissionModes("commandcode"), ["ask", "auto-review", "full-access"]);
  assert.deepEqual(acpPermissionModes("dsh"), []);

  const open = async (agent, fixtureMode, permissionMode) => {
    const registry = new AiSessionRegistry({ dir: join(cwd, agent, "sessions") });
    const store = new AiSessionTimelineStore(join(cwd, agent, "timeline"));
    const changes = new EventEmitter();
    const stop = registry.onChange(() => changes.emit("change"));
    const provider = new AcpSessionProvider(
      agent, registry,
      () => ({ executable: process.execPath, args: [fixture, fixtureMode], env: {} }),
      () => {},
      store,
    );
    const created = await provider.createSession({ cwd, permissionMode });
    const session = registry.start({ ...created, agent });
    const prompt = async (message, mode) => {
      const action = await provider.startMessage(registry.get(session.id), { message, permissionMode: mode });
      while (registry.get(session.id)?.status !== "idle") await once(changes, "change");
      const { items } = await provider.turnTimeline(registry.get(session.id), action.turnId);
      return items.filter((item) => item.type === "ai-message").map((item) => item.text).join("");
    };
    return { provider, session, prompt, close: async () => { stop(); await provider.close(); } };
  };

  const gemini = await open("gemini", "gemini-modes", "auto-review");
  const commandCode = await open("commandcode", "commandcode-modes", "full-access");
  const dsh = await open("dsh", "dsh-json");
  try {
    assert.equal(await gemini.prompt("selected-mode"), "autoEdit");
    assert.equal(await gemini.prompt("selected-mode", "full-access"), "yolo");
    assert.equal(await gemini.prompt("selected-mode", "ask"), "default");
    assert.equal(await gemini.prompt("selected-mode", "auto-review"), "autoEdit");

    assert.equal(await commandCode.prompt("selected-mode"), "bypass");
    assert.equal(await commandCode.prompt("selected-mode", "ask"), "default");
    assert.equal(await commandCode.prompt("selected-mode", "auto-review"), "auto-accept");

    await assert.rejects(
      dsh.provider.startMessage(dsh.session, { message: "selected-mode", permissionMode: "ask" }),
      { code: "AI_SESSION_PERMISSION_MODE_UNAVAILABLE" },
    );
    assert.equal(dsh.session.status, "idle");
  } finally {
    await Promise.all([gemini.close(), commandCode.close(), dsh.close()]);
    await rm(cwd, { recursive: true, force: true });
  }
});
