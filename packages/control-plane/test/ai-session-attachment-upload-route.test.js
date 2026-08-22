import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { registerSessionRoutes } from "../src/control-plane/http/session-routes.ts";
import { AiSessionAttachmentCache } from "../src/control-plane/sessions/ai-session-attachment-cache.ts";

function streamedJson(data, status = 200) {
  const response = new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
  return { status, headers: Object.fromEntries(response.headers), body: response.body };
}

test("managed upload forwards bounded chunks while retaining a non-blocking cache copy", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-upload-route-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  const cache = new AiSessionAttachmentCache(dataDir, { maxBytes: 2 * 1024 * 1024 });
  const downstream = [];
  let attachmentId;
  const service = {
    async proxyInstanceHttp(_instanceId, route, init) {
      if (route === "/api/ai-session-attachments/draft-streams") {
        attachmentId = JSON.parse(init.body).attachmentId;
        return streamedJson({ attachmentId, offset: 0 }, 201);
      }
      if (route.endsWith("/complete")) {
        return streamedJson({ id: attachmentId, kind: "file", name: "asset.bin", mime: "application/octet-stream", size: downstream.reduce((sum, chunk) => sum + chunk.length, 0), expiresAt: "2026-08-21T00:00:00.000Z" });
      }
      if (init.method === "PUT") {
        downstream.push(Buffer.from(init.body));
        return streamedJson({ attachmentId, offset: downstream.reduce((sum, chunk) => sum + chunk.length, 0) });
      }
      return streamedJson({ removed: true });
    },
  };
  registerSessionRoutes({
    app,
    service,
    events: { publish() {} },
    appSessionAggregator: {},
    aiSessionAggregator: {},
    aiSessionUnread: {},
    aiSessionAttachments: {},
    aiSessionAttachmentCache: cache,
  });
  const content = Buffer.alloc(700 * 1024, 7);
  const query = new URLSearchParams({ scopeType: "session", scopeId: "session-1", kind: "file", name: "asset.bin", mime: "application/octet-stream", size: String(content.length) });
  const response = await app.inject({ method: "POST", url: `/api/controlled-instances/instance-1/ai-session-attachments/drafts?${query}`, headers: { "content-type": "application/octet-stream" }, payload: content });
  assert.equal(response.statusCode, 201);
  const uploaded = response.json().data;
  assert.match(uploaded.id, /^cia_[a-f0-9]{24}$/);
  assert.ok(downstream.length >= 3);
  assert.ok(downstream.every((chunk) => chunk.length <= 256 * 1024));
  assert.deepEqual(Buffer.concat(downstream), content);

  cache.bind({ instanceId: "instance-1", attachmentId: uploaded.id, scopeId: "session-1", sessionId: "session-1", messageId: "message-1" });
  let cached;
  for (let attempt = 0; attempt < 20 && !cached; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    cached = cache.get({ instanceId: "instance-1", sessionId: "session-1", messageId: "message-1", attachmentId: uploaded.id });
  }
  assert.ok(cached);
  assert.deepEqual(fs.readFileSync(cached.path), content);
});

test("managed upload reports malformed controlled-instance responses as a bad gateway", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-upload-protocol-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  app.setErrorHandler((error, _request, reply) => reply.code(error.statusCode || 500).send({ error: { code: error.code, message: error.message } }));
  registerSessionRoutes({
    app,
    service: {
      async proxyInstanceHttp(_instanceId, route) {
        return route.includes("draft-streams") && !route.match(/\/cia_[^/]+$/)
          ? streamedJson({ offset: 0 }, 201)
          : streamedJson({ removed: true });
      },
    },
    events: { publish() {} },
    appSessionAggregator: {},
    aiSessionAggregator: {},
    aiSessionUnread: {},
    aiSessionAttachments: {},
    aiSessionAttachmentCache: new AiSessionAttachmentCache(dataDir),
  });
  const query = new URLSearchParams({ scopeType: "session", scopeId: "session-1", kind: "file", name: "asset.bin", mime: "application/octet-stream", size: "1" });
  const response = await app.inject({ method: "POST", url: `/api/controlled-instances/instance-1/ai-session-attachments/drafts?${query}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("a") });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "AI_SESSION_ATTACHMENT_PROTOCOL_INVALID");
});

test("message actions resolve attachment retention only for managed upload references", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-session-message-retention-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  let retentionLookups = 0;
  registerSessionRoutes({
    app,
    service: {
      async sendAiSessionMessage(_instanceId, _sessionId, _message, _mode, attachments) {
        const attachmentId = attachments.find((attachment) => attachment.source.type === "upload-ref")?.id;
        return {
          session: {
            turns: attachmentId ? [{ userMessages: [{ id: "message-1", attachments: [{ id: attachmentId }] }] }] : [],
            queue: { items: [] },
          },
        };
      },
      async requireControlledInstance() {
        retentionLookups += 1;
        return { config: { aiSessionAttachmentRetentionDays: 7 } };
      },
    },
    events: { publish() {} },
    appSessionAggregator: {},
    aiSessionAggregator: {},
    aiSessionUnread: {},
    aiSessionAttachments: { resolveRefs() { return []; } },
    aiSessionAttachmentCache: new AiSessionAttachmentCache(dataDir),
  });

  const plain = await app.inject({
    method: "POST",
    url: "/api/controlled-instances/instance-1/ai-sessions/session-1/messages",
    payload: { message: "plain message" },
  });
  assert.equal(plain.statusCode, 200);
  assert.equal(retentionLookups, 0);

  const managed = await app.inject({
    method: "POST",
    url: "/api/controlled-instances/instance-1/ai-sessions/session-1/messages",
    payload: { message: "with attachment", attachments: [{ id: "cia_1234567890abcdef12345678", source: { type: "upload-ref" } }] },
  });
  assert.equal(managed.statusCode, 200);
  assert.equal(retentionLookups, 1);
});
