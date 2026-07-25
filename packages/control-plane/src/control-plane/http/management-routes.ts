import type { FastifyInstance } from "fastify";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneChatGatewayRuntime } from "../chat/gateway/runtime.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import type { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
import type { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import type { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import type { AiSessionUnreadStore } from "../sessions/ai-session-unread-store.ts";
import type {
  ControlPlaneNodeAgentTunnelTransport,
  ControlPlaneNodeEventSubscriber,
} from "../nodes/tunnel.ts";
import { registerCatalogRoutes } from "./catalog-routes.ts";
import { registerChatGatewayRoutes } from "./chat-gateway-routes.ts";
import { registerInstanceRoutes } from "./instance-routes.ts";
import { registerNodeRoutes } from "./node-routes.ts";
import { registerSessionRoutes } from "./session-routes.ts";
import { registerTriggerRoutes } from "./trigger-routes.ts";

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
  aiSessionUnread: AiSessionUnreadStore;
  chatGateway: ControlPlaneChatGatewayRuntime;
  aiSessionAttachments: AiSessionAttachmentStore;
  nodeAgentTunnel: ControlPlaneNodeAgentTunnelTransport;
  nodeEventSubscriber: ControlPlaneNodeEventSubscriber;
  errorPayload: ErrorPayload;
};

export function registerControlPlaneManagementRoutes(options: RegisterControlPlaneManagementRoutesOptions) {
  const {
    app,
    service,
    events,
    appSessionAggregator,
    aiSessionAggregator,
    aiSessionUnread,
    chatGateway,
    aiSessionAttachments,
    nodeAgentTunnel,
    nodeEventSubscriber,
    errorPayload,
  } = options;

  registerCatalogRoutes({ app, service, events });
  registerNodeRoutes({ app, service, events, nodeAgentTunnel, nodeEventSubscriber, errorPayload });
  registerInstanceRoutes({ app, service, events });
  registerSessionRoutes({ app, service, events, appSessionAggregator, aiSessionAggregator, aiSessionUnread, aiSessionAttachments });
  registerTriggerRoutes({ app, service, events });
  registerChatGatewayRoutes({ app, service, chatGateway });
}
