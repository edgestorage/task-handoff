import { z } from "zod";
import {
  AiSessionApprovalInputSchema,
  AiSessionActionResultSchema,
  AiSessionCreateRefInputSchema,
  AiSessionCreateResultSchema,
  AiSessionDeltaResponseSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryListSchema,
  AiSessionMentionCatalogSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionMessageRefInputSchema,
  AiSessionOpenAppInputSchema,
  AiSessionOpenAppResultSchema,
  AiSessionCloseInputSchema,
  AiSessionCloseResultSchema,
  AiSessionCommandInputSchema,
  AiSessionCommandResultSchema,
  AiSessionResumeResultSchema,
  AiSessionSummarySchema,
  AiSessionStatusSchema,
  AiSessionUnreadStateSchema,
  AiSessionsSnapshotSchema,
  type AiSessionCreateRefInput,
  type AiSessionCommandInput,
  type AiSessionMessageAttachmentRef,
  type AiSessionPermissionMode,
  type AiSessionReference,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

export const ControlPlaneAiSessionSummarySchema = AiSessionSummarySchema.extend({
  unread: z.boolean().default(false),
});
export const ControlPlaneAiSessionsSnapshotSchema = AiSessionsSnapshotSchema.extend({
  sessions: z.array(ControlPlaneAiSessionSummarySchema),
});
export const ControlPlaneAiSessionsSchema = z.object({
  updatedAt: z.string().datetime(),
  instances: z.array(z.object({
    instanceId: z.string().trim().min(1).max(160),
    streamId: z.string().trim().min(1).max(240),
    aiSessions: ControlPlaneAiSessionsSnapshotSchema,
    revision: z.number().int().nonnegative().optional(),
    lastEventAt: z.string().datetime().optional(),
  }).strict()),
}).strict();

export const AiSessionUploadedAttachmentSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(["image", "file"]),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  expiresAt: z.string().datetime().optional(),
}).strict();

export function createControlPlaneAiSessionsApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const json = (method: string, body?: unknown, signal?: AbortSignal): RequestInit => ({
    method,
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const sessionRoute = (instanceId: string, sessionId: string) => `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}`;

  return {
    list(signal?: AbortSignal) {
      return requestData("/api/ai-sessions", ControlPlaneAiSessionsSchema, { signal });
    },
    refresh(signal?: AbortSignal) {
      return requestData("/api/ai-sessions?refresh=true", ControlPlaneAiSessionsSchema, { signal });
    },
    delta(instanceId: string, streamId: string, sinceRevision: number, signal?: AbortSignal) {
      const query = new URLSearchParams({ instanceId, streamId, sinceRevision: String(sinceRevision) });
      return requestData(`/api/ai-sessions?${query}`, AiSessionDeltaResponseSchema, { signal });
    },
    history(instanceId: string, signal?: AbortSignal) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history`, AiSessionHistoryListSchema, { signal });
    },
    historyDetail(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history/${encodeURIComponent(aiSessionId)}`, AiSessionHistoryDetailSchema, { signal });
    },
    resume(instanceId: string, aiSessionId: string) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/resume`, AiSessionResumeResultSchema, json("POST"));
    },
    create(instanceId: string, input: AiSessionCreateRefInput) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions`, AiSessionCreateResultSchema, json("POST", AiSessionCreateRefInputSchema.parse(input)));
    },
    openApp(instanceId: string, aiSessionId: string, clientRequestId: string) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/open-app`, AiSessionOpenAppResultSchema, json("POST", AiSessionOpenAppInputSchema.parse({ clientRequestId })));
    },
    close(instanceId: string, aiSessionId: string, clientRequestId: string) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/close`, AiSessionCloseResultSchema, json("POST", AiSessionCloseInputSchema.parse({ clientRequestId })));
    },
    executeCommand(instanceId: string, sessionId: string, input: AiSessionCommandInput) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/commands`, AiSessionCommandResultSchema, json("POST", AiSessionCommandInputSchema.parse(input)));
    },
    markRead(instanceId: string, sessionId: string, sessionUpdatedAt: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/read`, AiSessionUnreadStateSchema, json("POST", { sessionUpdatedAt }));
    },
    sendMessage(instanceId: string, sessionId: string, input: {
      message: string;
      mode?: AiSessionSendMode;
      attachments?: AiSessionMessageAttachmentRef[];
      references?: AiSessionReference[];
      permissionMode?: AiSessionPermissionMode;
    }) {
      const body = AiSessionMessageRefInputSchema.parse({
        ...input,
        attachments: input.attachments ?? [],
        references: input.references ?? [],
      });
      return requestData(`${sessionRoute(instanceId, sessionId)}/messages`, AiSessionActionResultSchema, json("POST", body));
    },
    approval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") {
      return requestData(`${sessionRoute(instanceId, sessionId)}/approval`, AiSessionActionResultSchema, json("POST", AiSessionApprovalInputSchema.parse({ decision })));
    },
    interrupt(instanceId: string, sessionId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/interrupt`, AiSessionActionResultSchema, json("POST"));
    },
    steerQueue(instanceId: string, sessionId: string, queueId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}/steer`, AiSessionActionResultSchema, json("POST"));
    },
    retryQueue(instanceId: string, sessionId: string, queueId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}/retry`, AiSessionStatusSchema, json("POST"));
    },
    removeQueue(instanceId: string, sessionId: string, queueId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}`, AiSessionStatusSchema, { method: "DELETE" });
    },
    uploadAttachment(input: { instanceId: string; sessionId: string; kind: "image" | "file"; name: string; mime: string; data: string }) {
      return requestData("/api/ai-session-attachments", AiSessionUploadedAttachmentSchema, json("POST", input));
    },
    mentionCatalog(instanceId: string, sessionId: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/mentions`, AiSessionMentionCatalogSchema, { signal });
    },
    searchMentionFiles(instanceId: string, sessionId: string, query: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/mentions/files`, AiSessionMentionFileSearchSchema, json("POST", { query }, signal));
    },
  };
}

export type ControlPlaneAiSessions = z.infer<typeof ControlPlaneAiSessionsSchema>;
export type ControlPlaneAiSessionSummary = z.infer<typeof ControlPlaneAiSessionSummarySchema>;
export type ControlPlaneAiSessionsSnapshot = z.infer<typeof ControlPlaneAiSessionsSnapshotSchema>;
export type AiSessionUploadedAttachment = z.infer<typeof AiSessionUploadedAttachmentSchema>;
