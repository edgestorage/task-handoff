import { z } from "zod";
import {
  ChatBridgeConfigSchema,
  ChatChannelSchema,
  ChatSessionBindingSchema,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();

/** Bridge reads must never surface the channel credential; `token` is write-only. */
const PublicChatBridgeSchema = ChatBridgeConfigSchema.omit({ token: true })
  .extend({ tokenSet: z.boolean().optional() })
  .strip();

const ChatGatewayStatusSchema = z.object({
  running: z.boolean(),
  bridges: z.array(z.object({
    id: z.string(),
    channel: ChatChannelSchema,
    name: z.string(),
    running: z.boolean(),
    tokenSet: z.boolean(),
    defaultChatId: z.string().optional(),
    lastUpdateId: z.number().optional(),
    error: z.string().optional(),
  }).strip()).default([]),
}).strip();

export function createControlPlaneChatGatewayApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const bridgePath = (bridgeId: string) => `/api/chat-gateway/bridges/${encodeURIComponent(bridgeId)}`;
  return {
    status(signal?: AbortSignal) {
      return requestData("/api/chat-gateway/status", ChatGatewayStatusSchema, { signal });
    },
    listBridges(signal?: AbortSignal) {
      return requestData("/api/chat-gateway/bridges", z.array(PublicChatBridgeSchema), { signal });
    },
    createBridge(input: unknown) {
      return requestData("/api/chat-gateway/bridges", PublicChatBridgeSchema, jsonRequest("POST", input));
    },
    updateBridge(bridgeId: string, input: unknown) {
      return requestData(bridgePath(bridgeId), PublicChatBridgeSchema, jsonRequest("PATCH", input));
    },
    startBridge(bridgeId: string) {
      return requestData(`${bridgePath(bridgeId)}/start`, ChatGatewayStatusSchema, jsonRequest("POST", {}));
    },
    stopBridge(bridgeId: string) {
      return requestData(`${bridgePath(bridgeId)}/stop`, ChatGatewayStatusSchema, jsonRequest("POST", {}));
    },
    removeBridge(bridgeId: string) {
      return requestData(bridgePath(bridgeId), z.object({ deleted: z.boolean() }).strict(), jsonRequest("DELETE"));
    },
    listSessions(signal?: AbortSignal) {
      return requestData("/api/chat/sessions", z.array(ChatSessionBindingSchema), { signal });
    },
    getSession(sessionId: string, signal?: AbortSignal) {
      return requestData(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, ChatSessionBindingSchema, { signal });
    },
  };
}

export type ControlPlaneChatGatewayApi = ReturnType<typeof createControlPlaneChatGatewayApi>;
