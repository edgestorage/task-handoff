import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChatChannelSchema, ChatGatewayMessageSchema } from "@task-handoff/protocol/control-plane";
import { ControlPlaneChatGatewayRuntime } from "../chat/gateway/runtime.ts";
import { ControlPlaneService } from "../application/service.ts";
import { UpdateChatBridgeInputSchema } from "../chat/bridges/inputs.ts";
import { IdParamsSchema } from "./route-params.ts";

type ChatGatewayActionInput = Parameters<ControlPlaneService["handleChatGatewayAction"]>[0];

export type RegisterChatGatewayRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  chatGateway: ControlPlaneChatGatewayRuntime;
};

const ChatGatewayActionSchema = z.object({
  source: z.object({
    channel: ChatChannelSchema,
    bridgeId: z.string().trim().min(1).max(120).optional(),
    chatSessionId: z.string().trim().min(1).max(240),
    userId: z.string().trim().max(240).optional(),
  }).strict(),
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ai-session"),
      index: z.number().int().nonnegative(),
    }).strict(),
    z.object({
      type: z.literal("instance-app-menu"),
      instanceId: z.string().trim().min(1).max(120),
    }).strict(),
    z.object({
      type: z.literal("launch-app"),
      instanceId: z.string().trim().min(1).max(120),
      appId: z.string().trim().min(1).max(120),
    }).strict(),
    z.object({
      type: z.literal("pending-decision"),
      routeId: z.string().trim().min(1).max(120),
      decision: z.enum(["allow", "deny", "skip"]),
    }).strict(),
  ]),
}).strict();

function parseChatGatewayActionInput(input: unknown): ChatGatewayActionInput {
  const parsed = ChatGatewayActionSchema.parse(input);
  if (!parsed.action) {
    throw new Error("Chat gateway action is required.");
  }
  return {
    source: parsed.source,
    action: parsed.action,
  };
}

export function registerChatGatewayRoutes({ app, service, chatGateway }: RegisterChatGatewayRoutesOptions) {
  app.get("/api/chat/sessions", async () => ({ data: service.listChatSessions() }));
  app.get("/api/chat/sessions/:id", async (request) => ({ data: service.requireChatSession(IdParamsSchema.parse(request.params).id) }));
  app.get("/api/chat-gateway/status", async () => ({ data: chatGateway.status() }));
  app.post("/api/chat-gateway/poll-ai-sessions", async () => ({ data: await chatGateway.pollAiSessionsNow() }));
  app.get("/api/chat-gateway/bridges", async () => ({ data: service.listChatBridges() }));
  app.post("/api/chat-gateway/bridges", async (request) => ({ data: service.createChatBridge(request.body) }));
  app.patch("/api/chat-gateway/bridges/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const previous = service.requireChatBridge(id);
    const body = UpdateChatBridgeInputSchema.parse(request.body);
    const updated = service.updateChatBridge(id, request.body);
    const enabled = typeof body.enabled === "boolean"
      ? body.enabled
      : undefined;
    app.log.info({
      component: "control-plane-chat-gateway",
      action: "bridge-patch",
      bridgeId: id,
      hasEnabled: enabled !== undefined,
      requestedEnabled: enabled,
      previousEnabled: previous.enabled,
      updatedEnabled: service.requireChatBridge(id).enabled,
    }, "chat gateway bridge state changed");
    if (enabled !== undefined && enabled !== previous.enabled) {
      if (enabled) {
        chatGateway.startBridge(id);
      } else {
        chatGateway.stopBridge(id);
      }
    }
    return { data: updated };
  });
  app.post("/api/chat-gateway/bridges/:id/start", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const previous = service.requireChatBridge(id);
    service.updateChatBridge(id, { enabled: true });
    app.log.info({
      component: "control-plane-chat-gateway",
      action: "bridge-start-request",
      bridgeId: id,
      previousEnabled: previous.enabled,
      updatedEnabled: service.requireChatBridge(id).enabled,
    }, "chat gateway bridge state changed");
    return { data: chatGateway.startBridge(id) };
  });
  app.post("/api/chat-gateway/bridges/:id/stop", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const previous = service.requireChatBridge(id);
    service.updateChatBridge(id, { enabled: false });
    app.log.info({
      component: "control-plane-chat-gateway",
      action: "bridge-stop-request",
      bridgeId: id,
      previousEnabled: previous.enabled,
      updatedEnabled: service.requireChatBridge(id).enabled,
    }, "chat gateway bridge state changed");
    return { data: chatGateway.stopBridge(id) };
  });
  app.delete("/api/chat-gateway/bridges/:id", async (request) => ({ data: { deleted: service.deleteChatBridge(IdParamsSchema.parse(request.params).id) } }));
  app.post("/api/chat-gateway/messages", { bodyLimit: 64 * 1024 * 1024 }, async (request) => ({ data: await service.handleChatGatewayMessage(ChatGatewayMessageSchema.parse(request.body)) }));
  app.post("/api/chat-gateway/actions", async (request) => ({ data: await service.handleChatGatewayAction(parseChatGatewayActionInput(request.body)) }));
  app.get("/api/pending-routes", async () => ({ data: await service.listPendingRoutes() }));
}
