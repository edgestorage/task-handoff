import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AiSessionApprovalInputSchema, AiSessionCommandInputSchema, AiSessionMentionFileSearchInputSchema, AiSessionMessageRefInputSchema } from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import type { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
import type { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import type { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import {
  IdParamsSchema,
  InstanceSessionParamsSchema,
  InstanceSessionQueueParamsSchema,
} from "./route-params.ts";

export type RegisterSessionRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
  appSessionAggregator: ControlPlaneAppSessionAggregator;
  aiSessionAggregator: ControlPlaneAiSessionAggregator;
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

export function registerSessionRoutes({
  app,
  service,
  events,
  appSessionAggregator,
  aiSessionAggregator,
  aiSessionAttachments,
}: RegisterSessionRoutesOptions) {
  app.get("/api/app-sessions", async (request) => {
    const query = z.object({
      refresh: z.string().optional(),
      includeTombstones: z.string().optional(),
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
    return { data: await appSessionAggregator.list({
      refresh: query.refresh === "true" || query.refresh === "1",
      includeTombstones: query.includeTombstones === "true" || query.includeTombstones === "1",
    }) };
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
  app.get("/api/controlled-instances/:id/app-sessions", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    const view = await appSessionAggregator.list();
    const entry = view.instances.find((item) => item.instanceId === params.id);
    return { data: entry?.appSessions || { runningCount: 0, problemCount: 0, sessions: [], updatedAt: new Date().toISOString() } };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/messages", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const parsed = AiSessionMessageRefInputSchema.parse(request.body || {});
    const attachments = aiSessionAttachments.resolveRefs(parsed.attachments, params.id, params.sessionId);
    const result = await service.sendAiSessionMessage(params.id, params.sessionId, parsed.message, parsed.mode, attachments, parsed.references);
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
    return { data: await aiSessionAggregator.list({ refresh: query.refresh === "true" || query.refresh === "1" }) };
  });
}
