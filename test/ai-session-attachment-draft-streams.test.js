const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const { AiSessionAttachmentDraftStreams } = require("../packages/ai-session-runtime/src/ai-session-attachment-draft-streams.ts");
const { AiSessionConversationAttachmentStore } = require("../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts");
const {
  AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES,
  AiSessionAttachmentDraftStreamCreateInputSchema,
  AiSessionAttachmentDraftStreamOffsetSchema,
} = require("../packages/protocol/src/ai-sessions.ts");

const attachmentId = "cia_1234567890abcdef12345678";

test("draft stream owns offset transitions and completion cleanup", async () => {
  let stored = Buffer.alloc(0);
  const streams = new AiSessionAttachmentDraftStreams(async ({ id, kind, name, mime, size, source }) => {
    const chunks = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    stored = Buffer.concat(chunks);
    assert.equal(stored.length, size);
    return { id, kind, name, mime, size, expiresAt: "2026-08-22T00:00:00.000Z" };
  });
  const input = AiSessionAttachmentDraftStreamCreateInputSchema.parse({
    attachmentId,
    scopeType: "session",
    scopeId: "session-1",
    kind: "file",
    name: "asset.bin",
    mime: "application/octet-stream",
    size: 4,
  });
  assert.deepEqual(await streams.begin(input), { attachmentId, offset: 0 });
  await assert.rejects(() => streams.append(attachmentId, 1, Readable.from([Buffer.from("no")])), (error) => error.code === "AI_SESSION_ATTACHMENT_OFFSET_MISMATCH");
  const offset = await streams.append(attachmentId, 0, Readable.from([Buffer.from("data")]));
  assert.deepEqual(AiSessionAttachmentDraftStreamOffsetSchema.parse(offset), { attachmentId, offset: 4 });
  assert.equal((await streams.complete(attachmentId)).id, attachmentId);
  assert.deepEqual(stored, Buffer.from("data"));
  await assert.rejects(() => streams.complete(attachmentId), (error) => error.code === "AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND");
});

test("draft stream surfaces creation failures before accepting chunks", async () => {
  const streams = new AiSessionAttachmentDraftStreams(async () => {
    throw Object.assign(new Error("storage full"), { code: "AI_SESSION_ATTACHMENT_STORAGE_FULL", statusCode: 507 });
  });
  await assert.rejects(() => streams.begin(AiSessionAttachmentDraftStreamCreateInputSchema.parse({
    attachmentId,
    scopeType: "session",
    scopeId: "session-1",
    kind: "file",
    name: "asset.bin",
    mime: "application/octet-stream",
    size: AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES,
  })), (error) => error.code === "AI_SESSION_ATTACHMENT_STORAGE_FULL");
  await assert.rejects(() => streams.append(attachmentId, 0, Readable.from([Buffer.alloc(AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES)])), (error) => error.code === "AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND");
});

test("draft stream rejects files above the controlled-instance limit before accepting chunks", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-draft-stream-limit-"));
  try {
    const store = new AiSessionConversationAttachmentStore({ dataDir }, { maxFileAttachmentBytes: 4 });
    const streams = new AiSessionAttachmentDraftStreams((input) => store.createDraft(input));
    await assert.rejects(() => streams.begin(AiSessionAttachmentDraftStreamCreateInputSchema.parse({
      attachmentId,
      scopeType: "session",
      scopeId: "session-1",
      kind: "file",
      name: "asset.bin",
      mime: "application/octet-stream",
      size: 4,
    })), { code: "AI_SESSION_ATTACHMENTS_TOO_LARGE", statusCode: 413 });
    await assert.rejects(() => streams.append(attachmentId, 0, Readable.from([Buffer.from("data")])), {
      code: "AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND",
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("draft stream rejects concurrent offset transitions", async () => {
  const streams = new AiSessionAttachmentDraftStreams(async ({ id, kind, name, mime, size, source }) => {
    for await (const _chunk of source) {}
    return { id, kind, name, mime, size, expiresAt: "2026-08-22T00:00:00.000Z" };
  });
  await streams.begin(AiSessionAttachmentDraftStreamCreateInputSchema.parse({
    attachmentId,
    scopeType: "session",
    scopeId: "session-1",
    kind: "file",
    name: "asset.bin",
    mime: "application/octet-stream",
    size: 1,
  }));
  const first = streams.append(attachmentId, 0, Readable.from([Buffer.from("A")]));
  await assert.rejects(() => streams.append(attachmentId, 0, Readable.from([Buffer.from("B")])), (error) => error.code === "AI_SESSION_ATTACHMENT_UPLOAD_BUSY");
  assert.deepEqual(await first, { attachmentId, offset: 1 });
  await streams.complete(attachmentId);
});

test("draft stream chunk limit is the single protocol value", () => {
  assert.equal(AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES, 256 * 1024);
  assert.deepEqual(AiSessionAttachmentDraftStreamOffsetSchema.parse({ attachmentId, offset: 4, futureField: true }), { attachmentId, offset: 4 });
});
