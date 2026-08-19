import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AiSessionApprovalInputSchema, AiSessionCloseInputSchema, AiSessionCommandInputSchema, AiSessionCreateRefInputSchema, AiSessionForkInputSchema, AiSessionMentionFileSearchInputSchema, AiSessionMessageRefInputSchema, AiSessionOpenAppInputSchema, AiSessionQueueEditInputSchema, AiSessionQueueReorderInputSchema, AiSessionUnreadEventType } from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import type { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
import type { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import type { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import type { AiSessionUnreadStore } from "../sessions/ai-session-unread-store.ts";
import {
  IdParamsSchema,
  InstanceSessionParamsSchema,
  InstanceSessionTurnParamsSchema,
  InstanceSessionQueueParamsSchema,
} from "./route-params.ts";

const AiSessionWorkspaceQuerySchema = z.object({ cwdFolderId: z.string().trim().min(1).max(120).optional() }).strict();

export type RegisterSessionRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
  appSessionAggregator: ControlPlaneAppSessionAggregator;
  aiSessionAggregator: ControlPlaneAiSessionAggregator;
  aiSessionUnread: AiSessionUnreadStore;
  aiSessionAttachments: AiSessionAttachmentStore;
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

export function registerSessionRoutes({
  app,
  service,
  events,
  appSessionAggregator,
  aiSessionAggregator,
  aiSessionUnread,
  aiSessionAttachments,
}: RegisterSessionRoutesOptions) {
  app.get("/api/app-sessions", async (request) => {
    const query = z.object({
      refresh: z.string().optional(),
      instanceId: z.string().trim().min(1).optional(),
      streamId: z.string().trim().min(1).optional(),
      sinceRevision: z.string().optional(),
    }).parse(request.query || {});
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
    });
    return { data: query.instanceId ? { ...view, instances: view.instances.filter((entry) => entry.instanceId === query.instanceId) } : view };
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
    const access = await service.createAppSessionAccessToken({ instanceId: params.id, sessionId: params.sessionId });
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
  app.get("/api/controlled-instances/:id/ai-sessions/history", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    return { data: await service.listAiSessionHistory(params.id) };
  });
  app.get("/api/controlled-instances/:id/ai-sessions/history/:sessionId", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    return { data: await service.getAiSessionHistoryDetail(params.id, params.sessionId) };
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
    const attachments = aiSessionAttachments.resolveRefs(parsed.attachments, params.id, parsed.clientRequestId);
    const result = await service.createAiSession(params.id, { ...parsed, attachments });
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
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/messages", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionMessageRefInputSchema.parse(request.body || {});
    const attachments = aiSessionAttachments.resolveRefs(parsed.attachments, params.id, params.sessionId);
    const result = await service.sendAiSessionMessage(params.id, params.sessionId, parsed.message, parsed.mode, attachments, parsed.references, parsed.permissionMode);
    events.publish("instance.ai-session.message-sent", { instanceId: params.id, sessionId: params.sessionId });
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
    const fullView = await aiSessionAggregator.list({ refresh: query.refresh === "true" || query.refresh === "1" });
    const view = query.instanceId ? { ...fullView, instances: fullView.instances.filter((entry) => entry.instanceId === query.instanceId) } : fullView;
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
