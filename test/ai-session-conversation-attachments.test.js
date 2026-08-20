const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const { AiSessionConversationAttachmentStore } = require("../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-attachments-"));
}

function inlineAttachment(id, data = "same bytes") {
  return {
    id,
    kind: "image",
    name: `${id}.png`,
    mime: "image/png",
    size: Buffer.byteLength(data),
    source: { type: "inline", data: Buffer.from(data).toString("base64") },
  };
}

test("controlled-instance attachment store deduplicates immutable content and expires content without deleting metadata", () => {
  const dataDir = tempDir();
  let now = Date.parse("2026-08-20T00:00:00.000Z");
  const store = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now, retentionDays: 30 });
  const first = store.stageMessage({ sessionId: "session-a", messageId: "message-a", attachments: [inlineAttachment("input-a")] });
  const second = store.stageMessage({ sessionId: "session-a", messageId: "message-b", attachments: [inlineAttachment("input-b")] });
  assert.equal(fs.readdirSync(path.join(dataDir, "ai-session-attachments", "blobs")).length, 1);
  assert.equal(fs.statSync(path.join(dataDir, "ai-session-attachments")).mode & 0o777, 0o700);
  store.commitMessage("session-a", "message-a", "turn-a");
  store.commitMessage("session-a", "message-b", "turn-b");
  assert.equal(store.content("session-a", "message-a", first.attachments[0].id).attachment.contentState, "available");
  assert.throws(() => store.content("session-b", "message-a", first.attachments[0].id), { code: "AI_SESSION_ATTACHMENT_NOT_FOUND" });
  now += 31 * 24 * 60 * 60 * 1000;
  store.gc();
  assert.equal(store.attachmentMetadata("session-a", "message-a", first.attachments[0].id).contentState, "expired");
  assert.equal(store.attachmentMetadata("session-a", "message-b", second.attachments[0].id).contentState, "expired");
  assert.throws(() => store.content("session-a", "message-a", first.attachments[0].id), { code: "AI_SESSION_ATTACHMENT_EXPIRED", statusCode: 410 });
});

test("runtime-path content is snapshotted inside the session workspace and survives source removal", () => {
  const dataDir = tempDir();
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace);
  const source = path.join(workspace, "report.txt");
  fs.writeFileSync(source, "retained report");
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const staged = store.stageMessage({
    sessionId: "session-a",
    messageId: "message-a",
    runtimePathRoot: workspace,
    attachments: [{ id: "input", kind: "file", name: "report.txt", mime: "text/plain", size: 15, source: { type: "runtime-path", path: source } }],
  });
  fs.unlinkSync(source);
  assert.equal(fs.readFileSync(staged.providerAttachments[0].retainedPath, "utf8"), "retained report");
  const outside = path.join(dataDir, "outside.txt");
  fs.writeFileSync(outside, "outside");
  assert.throws(() => store.stageMessage({
    sessionId: "session-a",
    messageId: "message-b",
    runtimePathRoot: workspace,
    attachments: [{ id: "outside", kind: "file", name: "outside.txt", mime: "text/plain", size: 7, source: { type: "runtime-path", path: outside } }],
  }), { code: "AI_SESSION_RUNTIME_PATH_OUTSIDE_WORKSPACE" });
});

test("attachment store restores staged input as retryable draft and expires it without replay", () => {
  const dataDir = tempDir();
  let now = Date.parse("2026-08-20T00:00:00.000Z");
  const staged = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now })
    .stageMessage({ sessionId: "session-a", messageId: "message-a", attachments: [inlineAttachment("input-a")] });
  now += 24 * 60 * 60 * 1000 + 1;
  const restored = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now });
  assert.equal(restored.attachmentMetadata("session-a", "message-a", staged.attachments[0].id), undefined);
  assert.equal(fs.readdirSync(path.join(dataDir, "ai-session-attachments", "blobs")).length, 0);
});

test("attachment store rejects capacity overflow and isolates corrupt persisted entries", () => {
  const capacityDir = tempDir();
  const constrained = new AiSessionConversationAttachmentStore({ dataDir: capacityDir }, { maxBytes: 3 });
  assert.throws(() => constrained.stageMessage({
    sessionId: "session-a",
    messageId: "message-a",
    attachments: [inlineAttachment("input-a", "four")],
  }), { code: "AI_SESSION_ATTACHMENT_STORAGE_FULL", statusCode: 507 });

  const dataDir = tempDir();
  const warnings = [];
  const first = new AiSessionConversationAttachmentStore({ dataDir });
  const staged = first.stageMessage({ sessionId: "session-a", messageId: "message-a", attachments: [inlineAttachment("input-a")] });
  first.commitMessage("session-a", "message-a", "turn-a");
  const manifestDir = path.join(dataDir, "ai-session-attachments", "manifests");
  fs.writeFileSync(path.join(manifestDir, "corrupt.json"), "{not json");
  fs.writeFileSync(path.join(dataDir, "ai-session-attachments", "blobs", "orphan.tmp"), "orphan");
  const reopened = new AiSessionConversationAttachmentStore({ dataDir }, { onWarning: (warning) => warnings.push(warning) });
  assert.equal(reopened.attachmentMetadata("session-a", "message-a", staged.attachments[0].id).contentState, "available");
  assert.equal(fs.existsSync(path.join(dataDir, "ai-session-attachments", "blobs", "orphan.tmp")), false);
  assert.ok(warnings.some((warning) => warning.includes("corrupt.json")));
});

test("retention changes delete only expired content and never resurrect it", () => {
  const dataDir = tempDir();
  let now = Date.parse("2026-08-20T00:00:00.000Z");
  const store = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now, retentionDays: 30 });
  const staged = store.stageMessage({ sessionId: "session-a", messageId: "message-a", attachments: [inlineAttachment("input-a")] });
  store.commitMessage("session-a", "message-a", "turn-a");
  now += 5 * 24 * 60 * 60 * 1000;
  assert.equal(store.setRetentionDays(10).expiredContent, 0);
  assert.equal(store.attachmentMetadata("session-a", "message-a", staged.attachments[0].id).contentState, "available");
  assert.equal(store.setRetentionDays(3).expiredContent, 1);
  assert.equal(store.attachmentMetadata("session-a", "message-a", staged.attachments[0].id).contentState, "expired");
  store.setRetentionDays(30);
  assert.equal(store.attachmentMetadata("session-a", "message-a", staged.attachments[0].id).contentState, "expired");

  const zero = store.stageMessage({ sessionId: "session-a", messageId: "message-zero", attachments: [inlineAttachment("input-zero", "zero")] });
  store.setRetentionDays(0);
  store.commitMessage("session-a", "message-zero", "turn-zero");
  assert.equal(store.attachmentMetadata("session-a", "message-zero", zero.attachments[0].id).contentState, "expired");
});

test("streamed drafts persist once, enforce scope, and become staged message handles", async () => {
  const dataDir = tempDir();
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const draft = await store.createDraft({
    scopeType: "session",
    scopeId: "session-a",
    kind: "file",
    name: "report.txt",
    mime: "text/plain",
    size: 15,
    source: Readable.from(["retained report"]),
  });
  assert.equal(draft.size, 15);
  assert.throws(() => store.stageDrafts({
    scopeType: "session",
    scopeId: "session-b",
    sessionId: "session-b",
    messageId: "message-b",
    attachmentIds: [draft.id],
  }), { code: "AI_SESSION_ATTACHMENT_DRAFT_NOT_FOUND" });
  const staged = store.stageDrafts({
    scopeType: "session",
    scopeId: "session-a",
    sessionId: "session-a",
    messageId: "message-a",
    attachmentIds: [draft.id],
  });
  assert.equal(fs.readFileSync(staged.providerAttachments[0].retainedPath, "utf8"), "retained report");
  assert.equal(store.cancelDraft("session", "session-a", draft.id), false);
  store.commitMessage("session-a", "message-a", "turn-a");
  assert.equal(store.content("session-a", "message-a", draft.id).attachment.name, "report.txt");
});

test("streamed draft rejects declared-size mismatch without leaving content", async () => {
  const dataDir = tempDir();
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  await assert.rejects(() => store.createDraft({
    scopeType: "create-request",
    scopeId: "create-a",
    kind: "file",
    name: "bad.txt",
    mime: "text/plain",
    size: 2,
    source: Readable.from(["too long"]),
  }), { code: "AI_SESSION_ATTACHMENT_SIZE_MISMATCH" });
  assert.equal(fs.readdirSync(path.join(dataDir, "ai-session-attachments", "blobs")).length, 0);
  assert.equal(fs.readdirSync(path.join(dataDir, "ai-session-attachments", "drafts")).length, 0);
});
