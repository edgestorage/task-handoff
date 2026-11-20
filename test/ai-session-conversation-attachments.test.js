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

test("legacy provider-part attachment ids resolve to the message's durable manifest", () => {
  const dataDir = tempDir();
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const staged = store.stageMessage({
    sessionId: "session-a",
    messageId: "message-a",
    attachments: [inlineAttachment("input-a", "image bytes")],
  });
  store.commitMessage("session-a", "message-a", "turn-a");

  const resolved = store.resolveMessageAttachments("session-a", "message-a", [{
    id: "prt_provider_part",
    kind: "image",
    name: "input-a.png",
    mime: "image/png",
    size: 0,
    contentState: "available",
  }]);
  assert.deepEqual(resolved, staged.attachments);
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

test("queued message edits can retain stored attachments under a new message identity", () => {
  const dataDir = tempDir();
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const original = store.stageMessage({
    sessionId: "session-a",
    messageId: "message-a",
    attachments: [inlineAttachment("input-a", "image bytes")],
  });
  const replacement = store.stageMessage({
    sessionId: "session-a",
    messageId: "message-b",
    retainedAttachmentIds: [original.attachments[0].id],
  });

  assert.equal(fs.readFileSync(store.content("session-a", "message-a", original.attachments[0].id).path, "utf8"), "image bytes");
  assert.equal(replacement.attachments.length, 1);
  assert.notEqual(replacement.attachments[0].id, original.attachments[0].id);
  assert.equal(replacement.attachments[0].name, original.attachments[0].name);
  assert.equal(fs.readFileSync(replacement.providerAttachments[0].retainedPath, "utf8"), "image bytes");
  assert.equal(fs.readdirSync(path.join(dataDir, "ai-session-attachments", "blobs")).length, 1);
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

test("uncommitted manifests expire after one day while shared committed content survives", (t) => {
  for (const mode of ["staged", "rollback", "restart", "expired restart"]) {
    const dataDir = tempDir();
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const createdAt = Date.parse("2026-11-04T00:00:00.000Z");
    let now = createdAt;
    let store = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now });
    const stage = (messageId, data) => store.stageMessage({ sessionId: "ses_1", messageId, attachments: [inlineAttachment("input_1", data)] });
    const committed = stage("committed", "shared");
    store.commitMessage("ses_1", "committed", "turn_1");
    const shared = stage("shared", "shared");
    const unique = stage("unique", "unique");
    if (mode === "rollback") {
      assert.equal(store.rollbackMessage("ses_1", "shared"), 1);
      assert.equal(store.rollbackMessage("ses_1", "unique"), 1);
    } else if (mode === "restart") {
      store = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now });
    }
    now = createdAt + 24 * 60 * 60 * 1000 - 1;
    assert.deepEqual(store.gc(), { removedDrafts: 0, expiredContent: 0 }, mode);
    assert.equal(store.attachmentsForMessage("ses_1", "unique").length, 1);
    now += 1;
    if (mode === "expired restart") {
      store = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now });
    } else {
      assert.deepEqual(store.gc(), { removedDrafts: 2, expiredContent: 0 }, mode);
    }
    for (const [messageId, staged] of [["shared", shared], ["unique", unique]]) {
      assert.deepEqual(store.attachmentsForMessage("ses_1", messageId), []);
      assert.equal(fs.existsSync(path.join(dataDir, "ai-session-attachments", "manifests", `${staged.attachments[0].id}.json`)), false);
    }
    assert.equal(fs.existsSync(unique.providerAttachments[0].retainedPath), false);
    assert.equal(fs.readFileSync(store.content("ses_1", "committed", committed.attachments[0].id).path, "utf8"), "shared");
    assert.deepEqual(store.gc(), { removedDrafts: 0, expiredContent: 0 }, mode);
  }
});

test("claiming requires every attachment to belong to the same session and message", (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const first = store.stageMessage({ sessionId: "ses_1", messageId: "first", attachments: [inlineAttachment("input_1", "first")] });
  const second = store.stageMessage({ sessionId: "ses_1", messageId: "second", attachments: [inlineAttachment("input_2", "second")] });
  const firstId = first.attachments[0].id;
  store.rollbackMessage("ses_1", "first");
  store.rollbackMessage("ses_1", "second");
  for (const [sessionId, messageId, ids] of [
    ["ses_1", "first", []],
    ["other_session", "first", [firstId]],
    ["ses_1", "other_message", [firstId]],
    ["ses_1", "first", [firstId, "missing"]],
    ["ses_1", "first", [firstId, second.attachments[0].id]],
  ]) {
    assert.equal(store.claimMessageAttachments(sessionId, messageId, ids), false);
    assert.throws(() => store.content("ses_1", "first", firstId), { statusCode: 404 });
  }
  assert.equal(store.claimMessageAttachments("ses_1", "first", [firstId]), true);
  assert.equal(store.content("ses_1", "first", firstId).attachment.contentState, "available");
  assert.equal(store.rollbackMessage("ses_1", "first"), 1);
  assert.throws(() => store.content("ses_1", "first", firstId), { statusCode: 404 });
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

test("controlled-instance attachment store enforces the live file upload limit", async () => {
  const dataDir = tempDir();
  const store = new AiSessionConversationAttachmentStore({ dataDir }, { maxFileAttachmentBytes: 5 });
  await assert.rejects(() => store.createDraft({
    scopeType: "session",
    scopeId: "session-a",
    kind: "file",
    name: "too-large.txt",
    mime: "text/plain",
    size: 5,
    source: Readable.from(["12345"]),
  }), { code: "AI_SESSION_ATTACHMENTS_TOO_LARGE", statusCode: 413 });

  const accepted = await store.createDraft({
    scopeType: "session",
    scopeId: "session-a",
    kind: "file",
    name: "accepted.txt",
    mime: "text/plain",
    size: 4,
    source: Readable.from(["1234"]),
  });
  assert.equal(accepted.size, 4);

  store.setMaxFileAttachmentBytes(4);
  assert.throws(() => store.stageMessage({
    sessionId: "session-a",
    messageId: "message-inline",
    attachments: [{
      id: "inline-file",
      kind: "file",
      name: "inline.txt",
      mime: "text/plain",
      size: 4,
      source: { type: "inline", encoding: "base64", data: Buffer.from("1234").toString("base64") },
    }],
  }), { code: "AI_SESSION_ATTACHMENTS_TOO_LARGE", statusCode: 413 });
});

test("failed create-request dispatch restores its upload draft for a new session retry", async () => {
  const dataDir = tempDir();
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const draft = await store.createDraft({
    scopeType: "create-request",
    scopeId: "create-retry",
    kind: "file",
    name: "retry.txt",
    mime: "text/plain",
    size: 5,
    source: Readable.from(["retry"]),
  });
  store.stageDrafts({
    scopeType: "create-request",
    scopeId: "create-retry",
    sessionId: "failed-session",
    messageId: "failed-message",
    attachmentIds: [draft.id],
  });
  assert.equal(store.rollbackMessage("failed-session", "failed-message"), 1);
  assert.equal(store.attachmentMetadata("failed-session", "failed-message", draft.id), undefined);

  const restored = new AiSessionConversationAttachmentStore({ dataDir });
  const retried = restored.stageDrafts({
    scopeType: "create-request",
    scopeId: "create-retry",
    sessionId: "retry-session",
    messageId: "retry-message",
    attachmentIds: [draft.id],
  });
  assert.equal(retried.attachments[0].id, draft.id);
  assert.equal(fs.readFileSync(retried.providerAttachments[0].retainedPath, "utf8"), "retry");
});

test("process restart restores a consumed upload as a real retryable draft", async () => {
  const dataDir = tempDir();
  const first = new AiSessionConversationAttachmentStore({ dataDir });
  const draft = await first.createDraft({
    scopeType: "create-request",
    scopeId: "create-restart",
    kind: "file",
    name: "restart.txt",
    mime: "text/plain",
    size: 7,
    source: Readable.from(["restart"]),
  });
  first.stageDrafts({
    scopeType: "create-request",
    scopeId: "create-restart",
    sessionId: "interrupted-session",
    messageId: "interrupted-message",
    attachmentIds: [draft.id],
  });

  const restored = new AiSessionConversationAttachmentStore({ dataDir });
  const retried = restored.stageDrafts({
    scopeType: "create-request",
    scopeId: "create-restart",
    sessionId: "retry-session",
    messageId: "retry-message",
    attachmentIds: [draft.id],
  });
  assert.equal(retried.attachments[0].id, draft.id);
  assert.equal(fs.readFileSync(retried.providerAttachments[0].retainedPath, "utf8"), "restart");
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

test("completed drafts keep one day of retention across rollback and collection", async (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const createdAt = Date.parse("2026-11-04T00:00:00.000Z");
  let now = createdAt;
  const store = new AiSessionConversationAttachmentStore({ dataDir }, { now: () => now });
  const draft = await store.createDraft({ scopeType: "session", scopeId: "ses_1", kind: "file", name: "notes.txt", mime: "text/plain", size: 5, source: Readable.from(["hello"]) });
  assert.equal(Date.parse(draft.expiresAt), createdAt + 24 * 60 * 60 * 1000);
  now += 60 * 60 * 1000;
  assert.equal(store.gc().removedDrafts, 0);
  store.stageDrafts({ scopeType: "session", scopeId: "ses_1", sessionId: "ses_1", messageId: "msg_1", attachmentIds: [draft.id] });
  store.rollbackMessage("ses_1", "msg_1");
  const files = fs.readdirSync(path.join(dataDir, "ai-session-attachments", "drafts"));
  const restored = JSON.parse(fs.readFileSync(path.join(dataDir, "ai-session-attachments", "drafts", files[0]), "utf8"));
  assert.equal(restored.expiresAt, draft.expiresAt);
  now = createdAt + 24 * 60 * 60 * 1000;
  assert.equal(store.gc().removedDrafts, 1);
});

test("failed draft persistence removes unowned content and preserves committed shared content", async (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const committed = store.stageMessage({ sessionId: "ses_1", messageId: "committed", attachments: [inlineAttachment("input_1", "shared")] });
  store.commitMessage("ses_1", "committed");
  const draftDir = path.join(dataDir, "ai-session-attachments", "drafts");
  fs.rmdirSync(draftDir);
  fs.writeFileSync(draftDir, "blocked");
  for (const content of ["unique", "shared"]) {
    await assert.rejects(() => store.createDraft({ id: "att_0123456789abcdef01234567", scopeType: "session", scopeId: "ses_1", kind: "file", name: "notes.txt", mime: "text/plain", size: content.length, source: Readable.from([content]) }));
    assert.equal(fs.readdirSync(path.join(dataDir, "ai-session-attachments", "blobs")).length, 1);
    assert.equal(fs.readFileSync(committed.providerAttachments[0].retainedPath, "utf8"), "shared");
  }
  fs.unlinkSync(draftDir);
  fs.mkdirSync(draftDir);
  assert.equal((await store.createDraft({ id: "att_0123456789abcdef01234567", scopeType: "session", scopeId: "ses_1", kind: "file", name: "notes.txt", mime: "text/plain", size: 6, source: Readable.from(["unique"]) })).size, 6);
});

test("failed rollback preserves the durable owner until draft recovery succeeds", async (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AiSessionConversationAttachmentStore({ dataDir });
  const draft = await store.createDraft({ scopeType: "session", scopeId: "ses_1", kind: "file", name: "notes.txt", mime: "text/plain", size: 5, source: Readable.from(["retry"]) });
  store.stageDrafts({ scopeType: "session", scopeId: "ses_1", sessionId: "ses_1", messageId: "msg_retry", attachmentIds: [draft.id] });
  const draftDir = path.join(dataDir, "ai-session-attachments", "drafts");
  fs.rmdirSync(draftDir);
  fs.writeFileSync(draftDir, "blocked");
  assert.throws(() => store.rollbackMessage("ses_1", "msg_retry"));
  assert.ok(fs.existsSync(path.join(dataDir, "ai-session-attachments", "manifests", `${draft.id}.json`)));
  assert.equal(store.content("ses_1", "msg_retry", draft.id).attachment.contentState, "available");
  fs.unlinkSync(draftDir);
  fs.mkdirSync(draftDir);
  const restored = new AiSessionConversationAttachmentStore({ dataDir });
  assert.equal(restored.cancelDraft("session", "ses_1", draft.id), true);
});
