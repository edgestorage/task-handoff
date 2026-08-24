import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import { AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES, AI_SESSION_ATTACHMENT_UPLOAD_BODY_LIMIT, AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES, AiSessionApprovalInputSchema, AiSessionAttachmentDraftSchema, AiSessionAttachmentDraftStreamCreateInputSchema, AiSessionAttachmentDraftStreamOffsetSchema, AiSessionAttachmentDraftUploadQuerySchema, AiSessionCloseInputSchema, AiSessionCommandInputSchema, AiSessionCreateRefInputSchema, AiSessionForkInputSchema, AiSessionMentionFileSearchInputSchema, AiSessionMessageRefInputSchema, AiSessionOpenAppInputSchema, AiSessionQueueEditInputSchema, AiSessionQueueReorderInputSchema, AiSessionUnreadEventType, isAiSessionInlineImageMime } from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import type { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
import type { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import type { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import type { AiSessionAttachmentCache } from "../sessions/ai-session-attachment-cache.ts";
import type { AiSessionUnreadStore } from "../sessions/ai-session-unread-store.ts";
import { appendServerTiming, serverTimingDuration, traceId as normalizedTraceId, TRACE_ID_HEADER, type RequestTimingDiagnostics } from "../../shared/http/server-timing.ts";
import {
  IdParamsSchema,
  InstanceSessionParamsSchema,
  InstanceSessionAttachmentParamsSchema,
  InstanceSessionTurnParamsSchema,
  InstanceSessionQueueParamsSchema,
} from "./route-params.ts";
import { assertRequestInstanceVisible, requestVisibleInstanceIds } from "./access-projection.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

const AiSessionWorkspaceQuerySchema = z.object({ cwdFolderId: z.string().trim().min(1).max(120).optional() }).strict();

export type RegisterSessionRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
  appSessionAggregator: ControlPlaneAppSessionAggregator;
  aiSessionAggregator: ControlPlaneAiSessionAggregator;
  aiSessionUnread: AiSessionUnreadStore;
  aiSessionAttachments: AiSessionAttachmentStore;
  aiSessionAttachmentCache: AiSessionAttachmentCache;
};

const AppLaunchRequestSchema = z
  .object({
    appId: z.string().trim().min(1).max(120).default("terminal-tty"),
    cwdFolderId: z.string().trim().min(1).max(120).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .default({ appId: "terminal-tty", options: {} });

const AppSessionRenameRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
  })
  .strict();

const AppSessionAccessRevokeRequestSchema = z
  .object({ token: z.string().trim().min(1).max(512) })
  .strict();

const EmptyRequestSchema = z.object({}).strict();

function attachmentName(disposition: string | undefined, fallback: string) {
  if (!disposition) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch {}
  }
  const quoted = /filename="([^"]+)"/i.exec(disposition)?.[1];
  return quoted || fallback;
}

async function proxyData(response: { status: number; body: ReadableStream<Uint8Array> | null }) {
  let payload: { data?: unknown; error?: { code?: string; message?: string } } = {};
  if (response.body) {
    try { payload = await new Response(response.body).json() as typeof payload; } catch {}
  }
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(payload.error?.message || `Controlled instance attachment request failed with HTTP ${response.status}.`), {
      statusCode: response.status,
      code: payload.error?.code || "AI_SESSION_ATTACHMENT_UPLOAD_FAILED",
    });
  }
  return payload.data;
}

function parseAttachmentProtocolResponse<T>(schema: z.ZodType<T>, value: unknown, phase: string) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw Object.assign(new Error(`Controlled instance returned an invalid attachment ${phase} response: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`).join("; ")}`), {
    statusCode: 502,
    code: "AI_SESSION_ATTACHMENT_PROTOCOL_INVALID",
  });
}

export function registerSessionRoutes({
  app,
  service,
  events,
  appSessionAggregator,
  aiSessionAggregator,
  aiSessionUnread,
  aiSessionAttachments,
  aiSessionAttachmentCache,
}: RegisterSessionRoutesOptions) {
  app.get("/api/app-sessions", async (request) => {
    const query = z.object({
      refresh: z.string().optional(),
      instanceId: z.string().trim().min(1).optional(),
      streamId: z.string().trim().min(1).optional(),
      sinceRevision: z.string().optional(),
    }).parse(request.query || {});
    if (query.instanceId) await assertRequestInstanceVisible(service, request, query.instanceId);
    if (query.sinceRevision !== undefined) {
      const sinceRevision = Number(query.sinceRevision);
      if (!Number.isInteger(sinceRevision) || sinceRevision < 0) {
        const error = new Error("sinceRevision must be a non-negative integer.");
        Object.assign(error, { statusCode: 400, code: "APP_SESSION_DELTA_INVALID" });
        throw error;
      }
      if (!query.streamId) {
        const error = new Error("streamId is required with sinceRevision.");
        Object.assign(error, { statusCode: 400, code: "APP_SESSION_DELTA_INVALID" });
        throw error;
      }
      return { data: await appSessionAggregator.delta({ instanceId: query.instanceId, streamId: query.streamId, sinceRevision }) };
    }
    const view = await appSessionAggregator.list({
      refresh: query.refresh === "true" || query.refresh === "1",
      instanceId: query.instanceId,
    });
    const visibleInstanceIds = await requestVisibleInstanceIds(service, request);
    return { data: {
      ...view,
      instances: view.instances.filter((entry) => visibleInstanceIds.has(entry.instanceId) && (!query.instanceId || entry.instanceId === query.instanceId)),
    } };
  });

  app.post("/api/controlled-instances/:id/apps/sessions", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const parsed = AppLaunchRequestSchema.parse(request.body);
    const session = await service.launchAppSession(params.id, parsed.appId, { ...parsed.options, ...(parsed.cwdFolderId ? { cwdFolderId: parsed.cwdFolderId } : {}) });
    events.publish("instance.app-session.launched", { instanceId: params.id, sessionId: typeof session.id === "string" ? session.id : undefined, appId: parsed.appId });
    return { data: session };
  });
  app.post("/api/controlled-instances/:id/apps/sessions/:sessionId/stop", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const session = await service.stopAppSession(params.id, params.sessionId);
    events.publish("instance.app-session.stopped", { instanceId: params.id, sessionId: params.sessionId });
    return { data: session };
  });
  app.patch("/api/controlled-instances/:id/apps/sessions/:sessionId", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AppSessionRenameRequestSchema.parse(request.body);
    const session = await service.renameAppSession(params.id, params.sessionId, parsed.title);
    events.publish("instance.app-session.renamed", { instanceId: params.id, sessionId: params.sessionId, title: parsed.title });
    return { data: session };
  });
  app.post("/api/controlled-instances/:id/apps/sessions/:sessionId/access", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    EmptyRequestSchema.parse(request.body || {});
    const actor = controlPlaneRequestActor(request);
    const access = await service.createAppSessionAccessToken({
      instanceId: params.id,
      sessionId: params.sessionId,
      ...(actor?.type === "user" ? {
        authorization: {
          userId: actor.userId,
          authorizationRevision: actor.authorizationRevision,
        },
      } : {}),
    });
    return {
      data: {
        mode: access.mode,
        url: `/apps/access/${access.mode}?token=${encodeURIComponent(access.token)}`,
        token: access.token,
        expiresAt: access.expiresAt,
      },
    };
  });
  app.delete("/api/controlled-instances/:id/apps/sessions/:sessionId/access", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const input = AppSessionAccessRevokeRequestSchema.parse(request.body || {});
    service.revokeAppSessionAccessToken(input.token, { instanceId: params.id, sessionId: params.sessionId });
    return { data: { revoked: true } };
  });
  app.get("/api/controlled-instances/:id/app-sessions", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const view = await appSessionAggregator.list();
    const entry = view.instances.find((item) => item.instanceId === params.id);
    return { data: entry?.appSessions || { runningCount: 0, problemCount: 0, sessions: [], updatedAt: new Date().toISOString() } };
  });
  app.get<{ Querystring: { agents?: string } }>("/api/controlled-instances/:id/ai-sessions/history", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const agents = request.query.agents?.split(",").map((agent) => agent.trim()).filter(Boolean);
    return { data: await service.listAiSessionHistory(params.id, agents) };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/history/:sessionId", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    return { data: await service.getAiSessionHistoryDetail(params.id, params.sessionId) };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/:sessionId", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    return { data: await service.getAiSessionDetail(params.id, params.sessionId) };
  });
  app.post<{ Params: { id: string }; Querystring: Record<string, unknown>; Body: Readable }>("/api/controlled-instances/:id/ai-session-attachments/drafts", { bodyLimit: AI_SESSION_ATTACHMENT_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const params = IdParamsSchema.parse(request.params);
    const input = AiSessionAttachmentDraftUploadQuerySchema.parse(request.query);
    const instance = await service.requireControlledInstance(params.id, true);
    const maxFileAttachmentBytes = instance.config.aiSessionMaxFileAttachmentBytes ?? AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES;
    if (input.kind === "file" && input.size >= maxFileAttachmentBytes) {
      throw Object.assign(new Error(`File attachment must be smaller than ${maxFileAttachmentBytes} bytes.`), {
        statusCode: 413,
        code: "AI_SESSION_ATTACHMENTS_TOO_LARGE",
      });
    }
    const attachmentId = `cia_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const target = "/api/ai-session-attachments/draft-streams";
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const cacheWriter = aiSessionAttachmentCache.beginBestEffortWrite({
      instanceId: params.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      attachmentId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      size: input.size,
      cacheUntil: Date.now() + 24 * 60 * 60 * 1000,
    });
    let offset = 0;
    try {
      const started = parseAttachmentProtocolResponse(AiSessionAttachmentDraftStreamOffsetSchema, await proxyData(await service.proxyInstanceHttp(params.id, target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(AiSessionAttachmentDraftStreamCreateInputSchema.parse({ attachmentId, ...input })),
        signal: controller.signal,
      })), "start");
      if (started.attachmentId !== attachmentId || started.offset !== 0) {
        throw Object.assign(new Error("Controlled instance returned an invalid attachment upload offset."), { statusCode: 502, code: "AI_SESSION_ATTACHMENT_OFFSET_MISMATCH" });
      }
      for await (const raw of request.body) {
        const received = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        for (let start = 0; start < received.length; start += AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES) {
          const chunk = received.subarray(start, Math.min(start + AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES, received.length));
          cacheWriter?.offer(chunk);
          const acknowledged = parseAttachmentProtocolResponse(AiSessionAttachmentDraftStreamOffsetSchema, await proxyData(await service.proxyInstanceHttp(params.id, `${target}/${encodeURIComponent(attachmentId)}?offset=${offset}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream", "content-length": String(chunk.length) },
            body: chunk,
            signal: controller.signal,
          })), "chunk");
          const expectedOffset = offset + chunk.length;
          if (acknowledged.attachmentId !== attachmentId || acknowledged.offset !== expectedOffset) {
            throw Object.assign(new Error("Controlled instance returned an invalid attachment upload offset."), { statusCode: 502, code: "AI_SESSION_ATTACHMENT_OFFSET_MISMATCH" });
          }
          offset = acknowledged.offset;
        }
      }
      const draft = parseAttachmentProtocolResponse(AiSessionAttachmentDraftSchema, await proxyData(await service.proxyInstanceHttp(params.id, `${target}/${encodeURIComponent(attachmentId)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      })), "completion");
      void cacheWriter?.finish();
      return reply.code(201).send({ data: draft });
    } catch (error) {
      cacheWriter?.abort();
      void service.proxyInstanceHttp(params.id, `${target}/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }).catch(() => undefined);
      // Compatibility for v0.0.21: an older controlled instance has no draft
      // stream routes. Keep its bounded legacy upload-ref flow until N-1 ages out.
      if (offset === 0
        && error && typeof error === "object"
        && "statusCode" in error && error.statusCode === 404
        && (!("code" in error) || error.code !== "AI_SESSION_NOT_FOUND")) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const raw of request.body) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length;
          if (size > input.size) throw Object.assign(new Error("Attachment content exceeded its declared size."), { statusCode: 400, code: "AI_SESSION_ATTACHMENT_SIZE_MISMATCH" });
          chunks.push(chunk);
        }
        if (size !== input.size) throw Object.assign(new Error("Attachment content did not match its declared size."), { statusCode: 400, code: "AI_SESSION_ATTACHMENT_SIZE_MISMATCH" });
        return reply.code(201).send({ data: aiSessionAttachments.upload({
          instanceId: params.id,
          sessionId: input.scopeId,
          kind: input.kind,
          name: input.name,
          mime: input.mime,
          data: Buffer.concat(chunks).toString("base64"),
        }) });
      }
      throw error;
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });
  app.get("/api/controlled-instances/:id/ai-sessions/:sessionId/messages/:messageId/attachments/:attachmentId/content", async (request, reply) => {
    const params = InstanceSessionAttachmentParamsSchema.parse(request.params);
    const cached = aiSessionAttachmentCache.get({
      instanceId: params.id,
      sessionId: params.sessionId,
      messageId: params.messageId,
      attachmentId: params.attachmentId,
    });
    if (cached) {
      reply.header("Content-Type", cached.mime);
      reply.header("Content-Length", String(cached.size));
      if (cached.etag) reply.header("ETag", cached.etag);
      reply.header("Cache-Control", "private, max-age=0, must-revalidate");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Accept-Ranges", "none");
      reply.header("Content-Disposition", cached.disposition || `${cached.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(cached.name)}`);
      if (cached.etag && request.headers["if-none-match"] === cached.etag) return reply.code(304).send();
      return reply.send(fs.createReadStream(cached.path));
    }
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    const response = await service.proxyInstanceHttp(
      params.id,
      `/api/ai-sessions/${encodeURIComponent(params.sessionId)}/messages/${encodeURIComponent(params.messageId)}/attachments/${encodeURIComponent(params.attachmentId)}/content`,
      { method: "GET", signal: controller.signal },
    );
    const cacheUntilHeader = response.headers["x-task-handoff-attachment-cache-until"];
    const attachmentSizeHeader = response.headers["x-task-handoff-attachment-size"];
    for (const [key, value] of Object.entries(response.headers)) {
      if (!["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "x-task-handoff-attachment-cache-until", "x-task-handoff-attachment-size"].includes(key.toLowerCase())) {
        reply.header(key, value);
      }
    }
    if (!response.body) return reply.code(response.status).send();
    const readable = Readable.fromWeb(response.body as never);
    const declaredSize = Number(attachmentSizeHeader || response.headers["content-length"]);
    if (response.status === 200 && Number.isInteger(declaredSize) && declaredSize > 0) reply.header("Content-Length", String(declaredSize));
    const cacheUntil = Number(cacheUntilHeader);
    const mime = response.headers["content-type"] || "application/octet-stream";
    const disposition = response.headers["content-disposition"];
    const cacheWriter = response.status === 200 && Number.isInteger(declaredSize) && declaredSize > 0 && Number.isFinite(cacheUntil)
      ? aiSessionAttachmentCache.beginBestEffortWrite({
        instanceId: params.id,
        scopeType: "session",
        scopeId: params.sessionId,
        attachmentId: params.attachmentId,
        sessionId: params.sessionId,
        messageId: params.messageId,
        kind: isAiSessionInlineImageMime(mime) ? "image" : "file",
        name: attachmentName(disposition, params.attachmentId),
        mime,
        size: declaredSize,
        ...(disposition ? { disposition } : {}),
        ...(response.headers.etag ? { etag: response.headers.etag } : {}),
        cacheUntil,
      })
      : undefined;
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        cacheWriter?.offer(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        void cacheWriter?.finish();
        callback();
      },
    });
    reply.raw.once("close", () => {
      readable.destroy();
      if (!readable.readableEnded) cacheWriter?.abort();
    });
    return reply.code(response.status).send(readable.pipe(tee));
  });
  app.get("/api/controlled-instances/:id/ai-sessions/:sessionId/timeline", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    return { data: await service.getAiSessionTimeline(params.id, params.sessionId) };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/:sessionId/turns/:turnId/timeline", async (request) => {
    const params = InstanceSessionTurnParamsSchema.parse(request.params);
    return { data: await service.getAiSessionTurnTimeline(params.id, params.sessionId, params.turnId) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/resume", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    EmptyRequestSchema.parse(request.body || {});
    const result = await service.resumeAiSession(params.id, params.sessionId);
    events.publish("instance.ai-session.resumed", {
      instanceId: params.id,
      sessionId: result.aiSessionId,
      providerSessionId: result.providerSessionId,
      appSessionId: result.appSessionId,
      disposition: result.disposition,
    });
    return { data: result };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/workspace", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const query = AiSessionWorkspaceQuerySchema.parse(request.query || {});
    return { data: await service.inspectAiSessionWorkspace(params.id, query.cwdFolderId) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const parsed = AiSessionCreateRefInputSchema.parse(request.body || {});
    const legacyRefs = parsed.attachments.filter((attachment) => attachment.source.type !== "upload-ref" || !attachment.id.startsWith("cia_"));
    const legacyAttachments = aiSessionAttachments.resolveRefs(legacyRefs, params.id, parsed.clientRequestId);
    const resolvedById = new Map(legacyAttachments.map((attachment) => [attachment.id, attachment]));
    const attachments = parsed.attachments.map((attachment) => attachment.source.type === "upload-ref" && attachment.id.startsWith("cia_")
      ? attachment
      : resolvedById.get(attachment.id)!).filter(Boolean);
    const result = await service.createAiSession(params.id, { ...parsed, attachments });
    const attachmentIds = new Set(parsed.attachments.filter((attachment) => attachment.source.type === "upload-ref" && attachment.id.startsWith("cia_")).map((attachment) => attachment.id));
    if (attachmentIds.size) {
      const retainedDays = (await service.requireControlledInstance(params.id, true)).config.aiSessionAttachmentRetentionDays ?? 30;
      void service.getAiSessionDetail(params.id, result.aiSessionId).then((session) => {
        const messageId = session.turns?.flatMap((turn) => turn.userMessages || [])
          .find((message) => message.attachments.some((attachment) => attachmentIds.has(attachment.id)))?.id;
        if (!messageId) return;
        for (const attachmentId of attachmentIds) aiSessionAttachmentCache.bind({
          instanceId: params.id,
          attachmentId,
          scopeId: parsed.clientRequestId,
          sessionId: result.aiSessionId,
          messageId,
          cacheUntil: Date.now() + retainedDays * 24 * 60 * 60 * 1000,
        });
      }).catch(() => undefined);
    }
    events.publish("instance.ai-session.created", { instanceId: params.id, sessionId: result.aiSessionId, providerSessionId: result.providerSessionId, clientRequestId: parsed.clientRequestId });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/open-app", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionOpenAppInputSchema.parse(request.body || {});
    const result = await service.openAiSessionApp(params.id, params.sessionId, parsed.clientRequestId);
    events.publish("instance.ai-session.app-opened", { instanceId: params.id, sessionId: params.sessionId, appSessionId: result.appSessionId });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/fork", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionForkInputSchema.parse(request.body || {});
    const result = await service.forkAiSession(params.id, params.sessionId, parsed);
    events.publish("instance.ai-session.forked", { instanceId: params.id, sourceSessionId: params.sessionId, sessionId: result.aiSessionId, providerSessionId: result.providerSessionId, clientRequestId: parsed.clientRequestId });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/close", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionCloseInputSchema.parse(request.body || {});
    const result = await service.closeAiSession(params.id, params.sessionId, parsed.clientRequestId);
    events.publish("instance.ai-session.closed", { instanceId: params.id, sessionId: params.sessionId, providerSessionId: result.providerSessionId });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/messages", async (request, reply) => {
    const startedAt = performance.now();
    const traceId = normalizedTraceId(request.headers[TRACE_ID_HEADER], String(request.id));
    let upstreamTiming: RequestTimingDiagnostics | undefined;
    const finishTiming = (outcome: "completed" | "failed") => {
      const controlPlaneMs = performance.now() - startedAt;
      const serverTiming = appendServerTiming(
        upstreamTiming?.serverTiming,
        serverTimingDuration("control_plane", controlPlaneMs),
      );
      reply.header(TRACE_ID_HEADER, traceId);
      reply.header("server-timing", serverTiming);
      request.log.info({
        traceId,
        instanceId: (request.params as { id?: string }).id,
        sessionId: (request.params as { sessionId?: string }).sessionId,
        outcome,
        controlPlaneMs,
        nodeTransportMs: upstreamTiming?.nodeTransportMs,
        serverTiming,
      }, "AI session message request timing");
    };
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionMessageRefInputSchema.parse(request.body || {});
    const legacyRefs = parsed.attachments.filter((attachment) => attachment.source.type !== "upload-ref" || !attachment.id.startsWith("cia_"));
    const legacyAttachments = aiSessionAttachments.resolveRefs(legacyRefs, params.id, params.sessionId);
    const resolvedById = new Map(legacyAttachments.map((attachment) => [attachment.id, attachment]));
    const attachments = parsed.attachments.map((attachment) => attachment.source.type === "upload-ref" && attachment.id.startsWith("cia_")
      ? attachment
      : resolvedById.get(attachment.id)!).filter(Boolean);
    let result: Awaited<ReturnType<typeof service.sendAiSessionMessage>>;
    try {
      result = await service.sendAiSessionMessage(
        params.id,
        params.sessionId,
        parsed.message,
        parsed.mode,
        attachments,
        parsed.references,
        parsed.permissionMode,
        { traceId, onTiming: (timing) => { upstreamTiming = timing; } },
      );
    } catch (error) {
      finishTiming("failed");
      throw error;
    }
    const attachmentIds = new Set(parsed.attachments.filter((attachment) => attachment.source.type === "upload-ref" && attachment.id.startsWith("cia_")).map((attachment) => attachment.id));
    const messageId = result.session.turns?.flatMap((turn) => turn.userMessages || [])
      .find((message) => message.attachments.some((attachment) => attachmentIds.has(attachment.id)))?.id
      || result.session.queue.items.find((item) => item.id === result.queueId)?.messageId;
    if (attachmentIds.size && messageId) {
      const retainedDays = (await service.requireControlledInstance(params.id, true)).config.aiSessionAttachmentRetentionDays ?? 30;
      const cacheUntil = Date.now() + retainedDays * 24 * 60 * 60 * 1000;
      for (const attachmentId of attachmentIds) aiSessionAttachmentCache.bind({
        instanceId: params.id,
        attachmentId,
        scopeId: params.sessionId,
        sessionId: params.sessionId,
        messageId,
        cacheUntil,
      });
    }
    events.publish("instance.ai-session.message-sent", { instanceId: params.id, sessionId: params.sessionId });
    finishTiming("completed");
    return { data: result };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/:sessionId/mentions", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    return { data: await service.aiSessionMentionCatalog(params.id, params.sessionId) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/mentions/files", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const input = AiSessionMentionFileSearchInputSchema.parse(request.body || {});
    return { data: await service.searchAiSessionMentionFiles(params.id, params.sessionId, input.query) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/commands", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const input = AiSessionCommandInputSchema.parse(request.body || {});
    const result = await service.executeAiSessionCommand(params.id, params.sessionId, input);
    events.publish("instance.ai-session.command-executed", { instanceId: params.id, sessionId: params.sessionId, command: input.command });
    return { data: result };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/:sessionId/queue", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    return { data: await service.aiSessionQueue(params.id, params.sessionId) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/queue/:queueId/steer", async (request) => {
    const params = InstanceSessionQueueParamsSchema.parse(request.params);
    const result = await service.steerAiSessionQueuedMessage(params.id, params.sessionId, params.queueId);
    events.publish("instance.ai-session.message-sent", { instanceId: params.id, sessionId: params.sessionId });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/queue/:queueId/retry", async (request) => {
    const params = InstanceSessionQueueParamsSchema.parse(request.params);
    return { data: await service.retryAiSessionQueuedMessage(params.id, params.sessionId, params.queueId) };
  });
  app.delete("/api/controlled-instances/:id/ai-sessions/:sessionId/queue/:queueId", async (request) => {
    const params = InstanceSessionQueueParamsSchema.parse(request.params);
    return { data: await service.removeAiSessionQueuedMessage(params.id, params.sessionId, params.queueId) };
  });
  app.patch("/api/controlled-instances/:id/ai-sessions/:sessionId/queue/:queueId", async (request) => {
    const params = InstanceSessionQueueParamsSchema.parse(request.params);
    const input = AiSessionQueueEditInputSchema.parse(request.body || {});
    return { data: await service.editAiSessionQueuedMessage(params.id, params.sessionId, params.queueId, input) };
  });
  app.patch("/api/controlled-instances/:id/ai-sessions/:sessionId/queue/reorder", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const input = AiSessionQueueReorderInputSchema.parse(request.body || {});
    return { data: await service.reorderAiSessionQueuedMessages(params.id, params.sessionId, input) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/interrupt", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const result = await service.interruptAiSession(params.id, params.sessionId);
    events.publish("instance.ai-session.interrupted", { instanceId: params.id, sessionId: params.sessionId });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/approval", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionApprovalInputSchema.parse(request.body || {});
    const result = await service.resolveAiSessionApproval(params.id, params.sessionId, parsed.decision);
    events.publish("instance.ai-session.approval-resolved", { instanceId: params.id, sessionId: params.sessionId, decision: parsed.decision });
    return { data: result };
  });

  app.get("/api/ai-sessions", async (request, reply) => {
    const query = request.query as { refresh?: string; sinceRevision?: string; instanceId?: string; streamId?: string };
    if (query.instanceId) await assertRequestInstanceVisible(service, request, query.instanceId);
    if (query.sinceRevision !== undefined) {
      const sinceRevision = Number(query.sinceRevision);
      if (!Number.isInteger(sinceRevision) || sinceRevision < 0) {
        return reply.code(400).send({ error: "invalid_since_revision" });
      }
      try {
        if (!query.streamId) return reply.code(400).send({ error: "stream_id_required" });
        return { data: await aiSessionAggregator.delta({ instanceId: query.instanceId, streamId: query.streamId, sinceRevision }) };
      } catch (error) {
        if ((error as Error).message === "AI_SESSION_DELTA_INSTANCE_ID_REQUIRED") {
          return reply.code(400).send({ error: "instance_id_required" });
        }
        throw error;
      }
    }
    const fullView = await aiSessionAggregator.list({
      refresh: query.refresh === "true" || query.refresh === "1",
      instanceId: query.instanceId,
    });
    const visibleInstanceIds = await requestVisibleInstanceIds(service, request);
    const view = {
      ...fullView,
      instances: fullView.instances.filter((entry) => visibleInstanceIds.has(entry.instanceId) && (!query.instanceId || entry.instanceId === query.instanceId)),
    };
    for (const entry of view.instances) aiSessionUnread.reconcile(entry.instanceId, entry.aiSessions);
    return { data: {
      ...view,
      instances: view.instances.map((entry) => ({ ...entry, aiSessions: aiSessionUnread.decorate(entry.instanceId, entry.aiSessions) })),
    } };
  });

  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/read", async (request, reply) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const input = z.object({ sessionUpdatedAt: z.string().datetime() }).strict().parse(request.body || {});
    const view = await aiSessionAggregator.list();
    const entry = view.instances.find((item) => item.instanceId === params.id);
    const session = entry?.aiSessions.sessions.find((item) => item.id === params.sessionId);
    if (!entry || !session) return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session was not found." } });
    aiSessionUnread.reconcile(params.id, entry.aiSessions);
    const state = aiSessionUnread.markRead(params.id, params.sessionId, input.sessionUpdatedAt);
    if (!state) return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session was not found." } });
    events.publish(AiSessionUnreadEventType.Updated, state, {
      topic: "ai.sessions",
      scope: { instanceId: params.id, sessionId: params.sessionId },
    });
    return { data: state };
  });
}
