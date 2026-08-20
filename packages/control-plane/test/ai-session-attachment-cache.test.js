import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AiSessionAttachmentCache } from "../src/control-plane/sessions/ai-session-attachment-cache.ts";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-attachment-cache-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, cache: new AiSessionAttachmentCache(dataDir, options) };
}

function put(cache, dataDir, input = {}) {
  const sourcePath = path.join(dataDir, `source-${Math.random()}`);
  const content = input.content || Buffer.from("cached attachment");
  fs.writeFileSync(sourcePath, content);
  return cache.putFile({
    instanceId: input.instanceId || "instance-1",
    scopeType: "session",
    scopeId: input.sessionId || "session-1",
    attachmentId: input.attachmentId || "attachment-1",
    sessionId: input.sessionId || "session-1",
    messageId: input.messageId || "message-1",
    kind: "file",
    name: "notes.txt",
    mime: "text/plain",
    size: content.length,
    sourcePath,
    cacheUntil: input.cacheUntil,
  });
}

test("cache entries are isolated by instance and exact message ownership", (t) => {
  const { dataDir, cache } = fixture(t);
  const entry = put(cache, dataDir);
  assert.ok(entry);
  assert.equal(fs.statSync(entry.path).mode & 0o777, 0o600);
  assert.ok(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", attachmentId: "attachment-1" }));
  assert.equal(cache.get({ instanceId: "instance-2", sessionId: "session-1", messageId: "message-1", attachmentId: "attachment-1" }), undefined);
  assert.equal(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "other", attachmentId: "attachment-1" }), undefined);
});

test("effective expiration is the earlier of controlled-instance retention and 24 hours", (t) => {
  let now = Date.parse("2026-08-20T00:00:00Z");
  const { dataDir, cache } = fixture(t, { now: () => now });
  put(cache, dataDir, { cacheUntil: now + 60_000 });
  now += 60_001;
  assert.equal(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", attachmentId: "attachment-1" }), undefined);
});

test("capacity uses LRU eviction and instance invalidation removes derived copies", (t) => {
  let now = Date.parse("2026-08-20T00:00:00Z");
  const { dataDir, cache } = fixture(t, { now: () => now, maxBytes: 8 });
  put(cache, dataDir, { attachmentId: "old", content: Buffer.from("1234") });
  now += 1_000;
  put(cache, dataDir, { attachmentId: "new", messageId: "message-2", content: Buffer.from("567890") });
  assert.equal(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", attachmentId: "old" }), undefined);
  assert.ok(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-2", attachmentId: "new" }));
  cache.removeInstance("instance-1");
  assert.equal(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-2", attachmentId: "new" }), undefined);
});

test("best-effort branch abandons on backpressure without publishing a partial cache entry", async (t) => {
  const { cache } = fixture(t, { maxBytes: 4 * 1024 * 1024 });
  const writer = cache.beginBestEffortWrite({
    instanceId: "instance-1",
    scopeType: "session",
    scopeId: "session-1",
    attachmentId: "attachment-stream",
    sessionId: "session-1",
    messageId: "message-1",
    kind: "file",
    name: "large.bin",
    mime: "application/octet-stream",
    size: 2 * 1024 * 1024,
  });
  assert.ok(writer);
  assert.equal(writer.offer(Buffer.alloc(2 * 1024 * 1024)), false);
  assert.equal(await writer.finish(), undefined);
  assert.equal(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", attachmentId: "attachment-stream" }), undefined);
});

test("message binding may arrive before the non-blocking upload cache branch finishes", async (t) => {
  const { cache } = fixture(t, { maxBytes: 1024 });
  const writer = cache.beginBestEffortWrite({
    instanceId: "instance-1",
    scopeType: "session",
    scopeId: "session-1",
    attachmentId: "cia_pending",
    kind: "file",
    name: "pending.txt",
    mime: "text/plain",
    size: 4,
  });
  assert.ok(writer);
  assert.equal(cache.bind({ instanceId: "instance-1", attachmentId: "cia_pending", scopeId: "session-1", sessionId: "session-1", messageId: "message-1" }), false);
  assert.equal(writer.offer(Buffer.from("done")), true);
  await writer.finish();
  assert.ok(cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", attachmentId: "cia_pending" }));
});

test("concurrent best-effort writers reserve the global cache budget", (t) => {
  const { cache } = fixture(t, { maxBytes: 6 });
  const first = cache.beginBestEffortWrite({ instanceId: "instance-1", scopeType: "session", scopeId: "session-1", attachmentId: "one", kind: "file", name: "one", mime: "application/octet-stream", size: 4 });
  const second = cache.beginBestEffortWrite({ instanceId: "instance-1", scopeType: "session", scopeId: "session-1", attachmentId: "two", kind: "file", name: "two", mime: "application/octet-stream", size: 4 });
  assert.ok(first);
  assert.equal(second, undefined);
  first.abort();
  const retried = cache.beginBestEffortWrite({ instanceId: "instance-1", scopeType: "session", scopeId: "session-1", attachmentId: "two", kind: "file", name: "two", mime: "application/octet-stream", size: 4 });
  assert.ok(retried);
  retried.abort();
});
