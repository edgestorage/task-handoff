const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { Readable } = require("node:stream");
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

const { AiSessionController } = require("../packages/ai-session-runtime/src/ai-session-control.ts");
const { AiSessionConversationAttachmentStore } = require("../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");

function inlineAttachment(id, kind, name, mime, content) {
  return {
    id,
    kind,
    name,
    mime,
    size: Buffer.byteLength(content),
    source: { type: "inline", encoding: "base64", data: Buffer.from(content).toString("base64") },
  };
}

test("queued message editing retains, adds, and removes image and file attachments", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-queue-edit-"));
  const attachmentStore = new AiSessionConversationAttachmentStore({ dataDir });
  const registry = createAiSessionRegistry({
    dir: path.join(dataDir, "ai-sessions"),
    conversationAttachments: attachmentStore,
  });
  const controller = new AiSessionController(registry);
  const session = registry.start({ agent: "codex", status: "running", phase: "thinking" });
  const queued = await controller.sendMessage(session.id, {
    message: "inspect",
    mode: "queue",
    attachments: [inlineAttachment("image-input", "image", "capture.png", "image/png", "image")],
  });
  const original = registry.get(session.id).queue.items.find((item) => item.id === queued.queueId);

  const edited = controller.editQueuedMessage(session.id, original.id, 1, "inspect both", {
    retainedAttachmentIds: [original.attachments[0].id],
    attachments: [inlineAttachment("file-input", "file", "notes.txt", "text/plain", "notes")],
    draftAttachmentIds: [],
    draftScopeType: "session",
    draftScopeId: session.id,
  });
  const editedItem = edited.queue.items.find((item) => item.id === original.id);
  assert.equal(editedItem.message, "inspect both");
  assert.deepEqual(editedItem.attachments.map((attachment) => attachment.kind), ["image", "file"]);
  assert.equal(registry.queuedMessageDispatch(original.id).attachments.length, 2);

  const cleared = controller.editQueuedMessage(session.id, original.id, 2, "text only", {
    retainedAttachmentIds: [],
    attachments: [],
    draftAttachmentIds: [],
    draftScopeType: "session",
    draftScopeId: session.id,
  });
  assert.deepEqual(cleared.queue.items.find((item) => item.id === original.id).attachments, []);
  assert.deepEqual(registry.queuedMessageDispatch(original.id).attachments, []);
});


test("queue removal preserves its revision and attachments when draft recovery fails", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-queue-rollback-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const registry = createAiSessionRegistry({ dir: path.join(dataDir, "ai-sessions"), conversationAttachments: store });
  const controller = new AiSessionController(registry);
  const session = registry.start({ agent: "codex", status: "running", phase: "thinking" });
  const draft = await store.createDraft({ scopeType: "session", scopeId: session.id, kind: "file", name: "retry.txt", mime: "text/plain", size: 5, source: Readable.from(["retry"]) });
  const queued = await controller.sendMessage(session.id, { message: "retry", mode: "queue", draftAttachmentIds: [draft.id], draftScopeType: "session", draftScopeId: session.id });
  const before = structuredClone(registry.get(session.id).queue);
  const item = before.items.find((item) => item.id === queued.queueId);
  const draftDir = path.join(dataDir, "ai-session-attachments", "drafts");
  fs.rmdirSync(draftDir);
  fs.writeFileSync(draftDir, "blocked");
  assert.throws(() => controller.removeQueuedMessage(session.id, queued.queueId));
  assert.deepEqual(registry.get(session.id).queue, before);
  assert.equal(store.content(session.id, item.messageId, draft.id).attachment.contentState, "available");
  assert.ok(fs.existsSync(path.join(dataDir, "ai-session-attachments", "manifests", `${draft.id}.json`)));
  fs.unlinkSync(draftDir);
  fs.mkdirSync(draftDir);
  controller.removeQueuedMessage(session.id, queued.queueId);
  assert.equal(registry.get(session.id).queue.items.length, 0);
  assert.equal(registry.get(session.id).queue.revision, before.revision + 1);
  assert.equal(store.cancelDraft("session", session.id, draft.id), true);
});
