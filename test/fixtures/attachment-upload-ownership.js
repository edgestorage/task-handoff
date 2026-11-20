const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { PassThrough, Readable } = require("node:stream");
require("./attachment-route-parity.js"); // Reuse the existing TS/workspace loader.
const { AiSessionConversationAttachmentStore } = require("../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts");
const { AiSessionAttachmentDraftStreams } = require("../../packages/ai-session-runtime/src/ai-session-attachment-draft-streams.ts");

async function observeUploadOwnership(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-ownership-parity-"));
  const originalWriteStream = fs.createWriteStream;
  const startedAt = Date.now();
  const clock = () => startedAt;
  const opened = [];
  const writers = [];
  const creations = [];
  let streams;
  let resolveTransition;
  const transition = new Promise(resolve => { resolveTransition = resolve; });
  let pendingError;
  let pendingEnd = false;
  let oldSource;
  let released = false;
  function releaseOld() {
    released = true;
    if (pendingError) oldSource.destroy(pendingError);
    else if (pendingEnd) oldSource.end();
  }
  // Observe real filesystem open, without replacing any I/O or return value.
  fs.createWriteStream = function (...args) {
    const writer = originalWriteStream.apply(this, args);
    writers.push(writer);
    opened.push(once(writer, "open"));
    return writer;
  };
  try {
    const store = new AiSessionConversationAttachmentStore({ dataDir: root }, { now: clock });
    streams = new AiSessionAttachmentDraftStreams(input => {
      if (creations.length === 0) {
        // Model delayed delivery of the old request's terminal signal. The
        // actual store pipeline/cleanup remains pending until B's file opens.
        oldSource = new PassThrough();
        input.source.pipe(oldSource, { end: false });
        input.source.on("error", error => {
          pendingError = error; resolveTransition();
          if (released) oldSource.destroy(error);
        });
        input.source.on("end", () => {
          pendingEnd = true; resolveTransition();
          if (released) oldSource.end();
        });
        input = { ...input, source: oldSource };
      }
      const creation = store.createDraft(input);
      creations.push(creation.then(value => ({ value }), error => ({ error })));
      return creation;
    });
    const firstId = "cia_000000000000000000000001";
    const survivorId = scenario.sameId ? firstId : "cia_000000000000000000000002";
    const input = attachmentId => ({ attachmentId, scopeType: "create-request", scopeId: "source-test",
      kind: "file", name: "notes.txt", mime: "text/plain", size: 3 });
    await streams.begin(input(firstId));
    await opened[0];
    if (!scenario.sameId) { await streams.begin(input(survivorId)); await opened[1]; }
    let first;
    if (scenario.action === "fail") {
      await assert.rejects(streams.append(firstId, 0, Readable.from([Buffer.from("TOOLONG")])),
        { code: "AI_SESSION_ATTACHMENT_SIZE_MISMATCH" });
      first = await streams.complete(firstId).then(() => assert.fail("failed upload completed"), error => ({
        code: error.code, message: error.message, statusCode: error.statusCode,
      }));
    } else if (scenario.action === "cancel") {
      first = streams.cancel(firstId);
    } else {
      first = streams.complete(firstId).then(() => assert.fail("short upload completed"), error => ({
        code: error.code, message: error.message, statusCode: error.statusCode,
      }));
    }
    await transition;
    if (scenario.sameId) { await streams.begin(input(survivorId)); await opened[1]; }
    releaseOld();
    const old = await creations[0];
    assert.ok(old.error, "old pipeline must settle before B completes");
    first = await first;
    const offset = await streams.append(survivorId, 0, Readable.from([Buffer.from("ABC")]));
    assert.equal(offset.offset, 3);
    const draft = await streams.complete(survivorId);
    assert.equal(draft.id, survivorId);
    const manifestPath = path.join(root, "ai-session-attachments", "drafts", `${survivorId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const blobPath = path.join(root, "ai-session-attachments", "blobs", manifest.blobHash);
    const hex = fs.readFileSync(blobPath).toString("hex");
    const sha256 = crypto.createHash("sha256").update(Buffer.from("ABC")).digest("hex");
    assert.equal(hex, "414243");
    assert.equal(manifest.blobHash, sha256);
    const reopened = new AiSessionConversationAttachmentStore({ dataDir: root }, { now: clock });
    const staged = reopened.stageDrafts({ scopeType: "create-request", scopeId: "source-test",
      sessionId: "ses_upload", messageId: "msg_upload", attachmentIds: [survivorId] });
    assert.equal(staged.attachments[0].id, survivorId);
    const result = { first, offset, survivor: { id: draft.id, size: draft.size, hex, sha256,
      scopeType: manifest.scopeType, scopeId: manifest.scopeId,
      ttlMs: Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt) },
      reopenedHex: fs.readFileSync(staged.providerAttachments[0].retainedPath).toString("hex"),
      remainingBlobs: fs.readdirSync(path.join(root, "ai-session-attachments", "blobs")).sort() };
    return result;
  } finally {
    streams?.dispose();
    releaseOld();
    // Await every owned pipeline before deleting its directory, including when
    // a business assertion fails; do not leave cleanup racing later test cases.
    await Promise.all(creations);
    for (const writer of writers) writer.destroy();
    fs.createWriteStream = originalWriteStream;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { observeUploadOwnership };
