import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AiSessionApprovalInputSchema, AiSessionMessageRefInputSchema } from "@task-handoff/protocol/ai-sessions";
import { ControlPlaneService } from "./service.ts";
import { ControlPlaneChatGatewayRuntime } from "./chat-gateway.ts";
import { ControlPlaneEventBus } from "./events.ts";
import type { ControlPlaneAiSessionAggregator } from "./ai-session-aggregator.ts";
import type { ControlPlaneAppSessionAggregator } from "./app-session-aggregator.ts";
import { AiSessionAttachmentStore } from "./ai-session-attachments.ts";
import {
  ControlPlaneNodeAgentTunnelTransport,
  ControlPlaneNodeEventSubscriber,
} from "./node-agent-tunnel.ts";
import {
  InstanceSessionParamsSchema,
  InstanceSessionQueueParamsSchema,
  InstanceSessionTriggerConfigParamsSchema,
  InstanceTriggerConfigParamsSchema,
  IdParamsSchema,
  TriggerConfigParamsSchema,
} from "./server-route-params.ts";
import { registerCatalogRoutes } from "./server-catalog-routes.ts";
import { registerChatGatewayRoutes } from "./server-chat-gateway-routes.ts";
import { registerNodeRoutes } from "./server-node-routes.ts";

type ErrorPayload = (error: unknown) => {
  statusCode: number;
  code: string;
  message: string;
};

export type RegisterControlPlaneManagementRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  events: ControlPlaneEventBus;
  appSessionAggregator: ControlPlaneAppSessionAggregator;
  aiSessionAggregator: ControlPlaneAiSessionAggregator;
  chatGateway: ControlPlaneChatGatewayRuntime;
  aiSessionAttachments: AiSessionAttachmentStore;
  nodeAgentTunnel: ControlPlaneNodeAgentTunnelTransport;
  nodeEventSubscriber: ControlPlaneNodeEventSubscriber;
  errorPayload: ErrorPayload;
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

const ConfigSyncParamsSchema = z.object({
  id: z.string().trim().min(1),
  direction: z.enum(["import", "export"]),
  preset: z.string().trim().min(1).max(120),
});

export function registerControlPlaneManagementRoutes({
  app,
  service,
  events,
  appSessionAggregator,
  aiSessionAggregator,
  chatGateway,
  aiSessionAttachments,
  nodeAgentTunnel,
  nodeEventSubscriber,
  errorPayload,
}: RegisterControlPlaneManagementRoutesOptions) {
  registerCatalogRoutes({ app, service, events });
  registerNodeRoutes({ app, service, events, nodeAgentTunnel, nodeEventSubscriber, errorPayload });

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

  app.get("/api/controlled-instances", async () => ({ data: await service.listControlledInstances() }));
  app.post("/api/controlled-instances", async (request, reply) => {
    const instance = await service.createControlledInstance(request.body);
    events.publish("instance.created", { instanceId: instance.id });
    return reply.code(201).send({ data: instance });
  });
  app.get("/api/controlled-instances/:id", async (request) => ({ data: await service.requireControlledInstance(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/controlled-instances/:id", async (request) => {
    const instance = await service.updateControlledInstance(IdParamsSchema.parse(request.params).id, request.body);
    events.publish("instance.updated", { instanceId: instance.id });
    return { data: instance };
  });
  app.delete("/api/controlled-instances/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const deleted = await service.deleteControlledInstance(id);
    events.publish("instance.deleted", { instanceId: id, deleted });
    return { data: { deleted } };
  });
  app.post("/api/controlled-instances/:id/start", async (request) => {
    const instance = await service.startControlledInstance(IdParamsSchema.parse(request.params).id);
    events.publish("instance.started", { instanceId: instance.id });
    return { data: instance };
  });
  app.post("/api/controlled-instances/:id/stop", async (request) => {
    const instance = await service.stopControlledInstance(IdParamsSchema.parse(request.params).id);
    events.publish("instance.stopped", { instanceId: instance.id });
    return { data: instance };
  });
  app.post("/api/controlled-instances/:id/restart", async (request) => {
    const instance = await service.restartControlledInstance(IdParamsSchema.parse(request.params).id);
    events.publish("instance.restarted", { instanceId: instance.id });
    return { data: instance };
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
    const result = await service.sendAiSessionMessage(params.id, params.sessionId, parsed.message, parsed.mode, attachments);
    events.publish("instance.ai-session.message-sent", { instanceId: params.id, sessionId: params.sessionId });
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
  app.get("/api/config-sync/presets", async () => ({ data: service.listConfigSyncPresets() }));
  app.post("/api/controlled-instances/:id/config-sync/:direction/:preset", async (request) => {
    const params = ConfigSyncParamsSchema.parse(request.params);
    const result = await service.syncInstanceConfig(params.id, params.direction, params.preset);
    events.publish("instance.config-synced", { instanceId: params.id, direction: params.direction, preset: params.preset });
    return { data: result };
  });

  app.get("/api/instance-board", async () => {
    const result = await service.boardWithDiagnostics();
    return { data: result.items, meta: { nodeErrors: result.nodeErrors } };
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
  app.get("/api/triggers", async () => ({ data: await service.listTriggers() }));
  app.post("/api/triggers", async (request, reply) => {
    const trigger = service.createTrigger(request.body);
    events.publish("trigger.created", { configHash: trigger.configHash });
    return reply.code(201).send({ data: trigger });
  });
  app.delete("/api/triggers/:configHash", async (request) => {
    const params = TriggerConfigParamsSchema.parse(request.params);
    const result = await service.deleteTrigger(params.configHash);
    events.publish("trigger.deleted", { configHash: params.configHash });
    return { data: result };
  });
  app.post("/api/triggers/:configHash/apply", async (request) => {
    const params = TriggerConfigParamsSchema.parse(request.params);
    const result = await service.applyTrigger(params.configHash, request.body || {});
    events.publish("trigger.applied", { configHash: params.configHash });
    return { data: result };
  });
  app.get("/api/controlled-instances/:id/triggers", async (request) => {
    const params = IdParamsSchema.parse(request.params);
    return { data: await service.listInstanceTriggers(params.id) };
  });
  app.post("/api/controlled-instances/:id/ai-sessions/:sessionId/triggers", async (request) => {
    const params = InstanceSessionParamsSchema.parse(request.params);
    const result = await service.bindAiSessionTrigger(params.id, params.sessionId, request.body || {});
    events.publish("instance.ai-session.trigger-bound", { instanceId: params.id, sessionId: params.sessionId });
    return { data: result };
  });
  app.delete("/api/controlled-instances/:id/ai-sessions/:sessionId/triggers/:configHash", async (request) => {
    const params = InstanceSessionTriggerConfigParamsSchema.parse(request.params);
    const result = await service.unbindAiSessionTrigger(params.id, params.sessionId, params.configHash);
    events.publish("instance.ai-session.trigger-unbound", { instanceId: params.id, sessionId: params.sessionId, configHash: params.configHash });
    return { data: result };
  });
  app.post("/api/controlled-instances/:id/triggers/:configHash/run", async (request) => {
    const params = InstanceTriggerConfigParamsSchema.parse(request.params);
    const result = await service.runInstanceTrigger(params.id, params.configHash, request.body || {});
    events.publish("instance.trigger.run", { instanceId: params.id, configHash: params.configHash });
    return { data: result };
  });

  registerChatGatewayRoutes({ app, service, chatGateway });
}
