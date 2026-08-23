import { z } from "zod";
import {
  AiSessionApprovalInputSchema,
  AiSessionActionResultSchema,
  AiSessionCreateRefInputSchema,
  AiSessionCreateResultSchema,
  AiSessionForkInputSchema,
  AiSessionForkResultSchema,
  AiSessionDeltaResponseSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryListSchema,
  AiSessionTimelineSchema,
  AiSessionTurnTimelineSchema,
  AiSessionMentionCatalogSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionMessageRefInputSchema,
  AiSessionOpenAppInputSchema,
  AiSessionOpenAppResultSchema,
  AiSessionQueueEditInputSchema,
  AiSessionQueueReorderInputSchema,
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
  type AiSessionForkInput,
  type AiSessionCommandInput,
  type AiSessionMessageAttachmentRef,
  type AiSessionPermissionMode,
  type AiSessionQueueEditInput,
  type AiSessionQueueReorderInput,
  type AiSessionReference,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { RepositoryAiSessionWorkspaceSchema } from "@task-handoff/protocol/repository";

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
    list(signal?: AbortSignal, instanceId?: string) {
      const query = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : "";
      return requestData(`/api/ai-sessions${query}`, ControlPlaneAiSessionsSchema, { signal });
    },
    refresh(signal?: AbortSignal) {
      return requestData("/api/ai-sessions?refresh=true", ControlPlaneAiSessionsSchema, { signal });
    },
    delta(instanceId: string, streamId: string, sinceRevision: number, signal?: AbortSignal) {
      const query = new URLSearchParams({ instanceId, streamId, sinceRevision: String(sinceRevision) });
      return requestData(`/api/ai-sessions?${query}`, AiSessionDeltaResponseSchema, { signal });
    },
    history(instanceId: string, signal?: AbortSignal, agents: readonly string[] = ["codex", "claude", "opencode"]) {
      const query = agents.length ? `?agents=${encodeURIComponent(agents.join(","))}` : "";
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history${query}`, AiSessionHistoryListSchema, { signal });
    },
    historyDetail(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history/${encodeURIComponent(aiSessionId)}`, AiSessionHistoryDetailSchema, { signal });
    },
    detail(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
      return requestData(sessionRoute(instanceId, aiSessionId), AiSessionStatusSchema, { signal });
    },
    timeline(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/timeline`, AiSessionTimelineSchema, { signal });
    },
    turnTimeline(instanceId: string, aiSessionId: string, turnId: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/turns/${encodeURIComponent(turnId)}/timeline`, AiSessionTurnTimelineSchema, { signal });
    },
    resume(instanceId: string, aiSessionId: string) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/resume`, AiSessionResumeResultSchema, json("POST"));
    },
    create(instanceId: string, input: AiSessionCreateRefInput) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions`, AiSessionCreateResultSchema, json("POST", AiSessionCreateRefInputSchema.parse(input)));
    },
    fork(instanceId: string, aiSessionId: string, input: AiSessionForkInput) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/fork`, AiSessionForkResultSchema, json("POST", AiSessionForkInputSchema.parse(input)));
    },
    workspace(instanceId: string, cwdFolderId?: string, signal?: AbortSignal) {
      const query = cwdFolderId ? `?${new URLSearchParams({ cwdFolderId })}` : "";
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/workspace${query}`, RepositoryAiSessionWorkspaceSchema, { signal });
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
    editQueue(instanceId: string, sessionId: string, queueId: string, input: AiSessionQueueEditInput) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}`, AiSessionStatusSchema, json("PATCH", AiSessionQueueEditInputSchema.parse(input)));
    },
    reorderQueue(instanceId: string, sessionId: string, input: AiSessionQueueReorderInput) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/reorder`, AiSessionStatusSchema, json("PATCH", AiSessionQueueReorderInputSchema.parse(input)));
    },
    async uploadAttachment(input: { instanceId: string; sessionId: string; scopeType?: "session" | "create-request"; kind: "image" | "file"; name: string; mime: string; data: string }, onProgress?: (progress: number) => void) {
      onProgress?.(0);
      const content = await fetch(input.data).then((response) => response.blob());
      const query = new URLSearchParams({
        scopeType: input.scopeType || "session",
        scopeId: input.sessionId,
        kind: input.kind,
        name: input.name,
        mime: input.mime,
        size: String(content.size),
      });
      let response: { data: z.infer<typeof AiSessionUploadedAttachmentSchema> };
      try {
        response = await transport.request(
          `/api/controlled-instances/${encodeURIComponent(input.instanceId)}/ai-session-attachments/drafts?${query}`,
          DataSchema(AiSessionUploadedAttachmentSchema),
          { method: "POST", headers: { "content-type": "application/octet-stream" }, body: content },
          onProgress,
        );
      } catch (error) {
        if (!isMissingScopedAttachmentUploadRoute(error)) throw error;
        // Compatibility for v0.0.21: its public upload endpoint accepts the same
        // attachment content and scopes create requests by clientRequestId.
        response = await transport.request(
          "/api/ai-session-attachments",
          DataSchema(AiSessionUploadedAttachmentSchema),
          json("POST", {
            instanceId: input.instanceId,
            sessionId: input.sessionId,
            kind: input.kind,
            name: input.name,
            mime: input.mime,
            data: input.data,
          }),
          onProgress,
        );
      }
      onProgress?.(1);
      return response.data;
    },
    mentionCatalog(instanceId: string, sessionId: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/mentions`, AiSessionMentionCatalogSchema, { signal });
    },
    searchMentionFiles(instanceId: string, sessionId: string, query: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/mentions/files`, AiSessionMentionFileSearchSchema, json("POST", { query }, signal));
    },
  };
}

function isMissingScopedAttachmentUploadRoute(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 404
    || candidate.status === 405
    || candidate.code === "ROUTE_NOT_FOUND"
    || candidate.code === "HTTP_404";
}

export type ControlPlaneAiSessions = z.infer<typeof ControlPlaneAiSessionsSchema>;
export type ControlPlaneAiSessionSummary = z.infer<typeof ControlPlaneAiSessionSummarySchema>;
export type ControlPlaneAiSessionsSnapshot = z.infer<typeof ControlPlaneAiSessionsSnapshotSchema>;
export type AiSessionUploadedAttachment = z.infer<typeof AiSessionUploadedAttachmentSchema>;
