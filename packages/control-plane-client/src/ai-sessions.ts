import { z } from "zod";
import {
  AiSessionApprovalInputSchema,
  AiSessionActionCompatibleResponseSchema,
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
  AiSessionModelSelectionActionResponseSchema,
  AiSessionModelSelectionInputSchema,
  AiSessionReasoningEffortActionResponseSchema,
  AiSessionReasoningEffortInputSchema,
  AiSessionWorkspaceCheckoutInputSchema,
  AiSessionRenameInputSchema,
  AiSessionRenameResultSchema,
  AiSessionOpenAppInputSchema,
  AiSessionOpenAppResultSchema,
  AiSessionQueueEditInputSchema,
  AiSessionQueuePauseInputSchema,
  AiSessionQueueReorderInputSchema,
  AiSessionCloseInputSchema,
  AiSessionCloseResultSchema,
  AiSessionClearResultSchema,
  AiSessionCommandInputSchema,
  AiSessionCommandResultSchema,
  AiSessionResumeInputSchema,
  AiSessionResumeResultSchema,
  AiSessionSummarySchema,
  AiSessionTranscriptSchema,
  AiSessionDetailReadSchema,
  AiSessionTurnIndexReadSchema,
  AiSessionTurnBodyReadSchema,
  AiSessionQueueMutationResponseSchema,
  AiSessionReadResultSchema,
  AiSessionsSnapshotSchema,
  type AiSessionCreateRefInput,
  type AiSessionForkInput,
  type AiSessionCommandInput,
  type AiSessionMessageAttachmentRef,
  type AiSessionModelSelection,
  type AiSessionReasoningEffort,
  type AiSessionRenameInput,
  type AiSessionPermissionMode,
  type AiSessionQueueEditInput,
  type AiSessionQueueReorderInput,
  type AiSessionReference,
  type AiSessionResumeInput,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { RepositoryAiSessionWorkspaceSchema } from "@task-handoff/protocol/repository";
import { StoryContentListSchema, StoryContentPreviewSchema } from "@task-handoff/protocol/stories";
import { jsonRequest } from "./json-request.ts";
import { binaryUnsupported } from "./errors.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

// The Control Plane projection is the protocol AI session model: `unread` is
// owned by the controlled-instance session runtime and now travels with it.
export const ControlPlaneAiSessionSummarySchema = AiSessionSummarySchema;
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
  const sessionRoute = (instanceId: string, sessionId: string) => `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}`;

  return {
    list(signal?: AbortSignal, instanceId?: string) {
      const query = new URLSearchParams({ hierarchy: "subagents" });
      if (instanceId) query.set("instanceId", instanceId);
      return requestData(`/api/ai-sessions?${query}`, ControlPlaneAiSessionsSchema, { signal });
    },
    refresh(signal?: AbortSignal, instanceId?: string) {
      const query = new URLSearchParams({ refresh: "true" });
      query.set("hierarchy", "subagents");
      if (instanceId) query.set("instanceId", instanceId);
      return requestData(`/api/ai-sessions?${query}`, ControlPlaneAiSessionsSchema, { signal });
    },
    delta(instanceId: string, streamId: string, sinceRevision: number, signal?: AbortSignal) {
      const query = new URLSearchParams({ instanceId, streamId, sinceRevision: String(sinceRevision), hierarchy: "subagents" });
      return requestData(`/api/ai-sessions?${query}`, AiSessionDeltaResponseSchema, { signal });
    },
    history(instanceId: string, signal?: AbortSignal, agents: readonly string[] = ["codex", "claude", "opencode"]) {
      const query = new URLSearchParams({ hierarchy: "subagents" });
      if (agents.length) query.set("agents", agents.join(","));
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history?${query}`, AiSessionHistoryListSchema, { signal });
    },
    historyDetail(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history/${encodeURIComponent(aiSessionId)}?hierarchy=subagents`, AiSessionHistoryDetailSchema, { signal });
    },
    detail(instanceId: string, aiSessionId: string, revision?: string, signal?: AbortSignal) {
      const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
      return requestData(`${sessionRoute(instanceId, aiSessionId)}${query}`, AiSessionDetailReadSchema, { signal });
    },
    turnIndex(instanceId: string, aiSessionId: string, revision?: string, signal?: AbortSignal) {
      const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/turns${query}`, AiSessionTurnIndexReadSchema, { signal });
    },
    turnBody(instanceId: string, aiSessionId: string, turnId: string, revision?: string, signal?: AbortSignal) {
      const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/turns/${encodeURIComponent(turnId)}${query}`, AiSessionTurnBodyReadSchema, { signal });
    },
    timeline(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/timeline`, AiSessionTimelineSchema, { signal });
    },
    turnTimeline(instanceId: string, aiSessionId: string, turnId: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/turns/${encodeURIComponent(turnId)}/timeline`, AiSessionTurnTimelineSchema, { signal });
    },
    resume(instanceId: string, aiSessionId: string, input: AiSessionResumeInput = {}) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/resume`, AiSessionResumeResultSchema, jsonRequest("POST", AiSessionResumeInputSchema.parse(input)));
    },
    create(instanceId: string, input: AiSessionCreateRefInput) {
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions`, AiSessionCreateResultSchema, jsonRequest("POST", AiSessionCreateRefInputSchema.parse(input)));
    },
    updateModelSelection(instanceId: string, aiSessionId: string, clientRequestId: string, modelSelection: AiSessionModelSelection) {
      const body = AiSessionModelSelectionInputSchema.parse({ clientRequestId, modelSelection });
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/model-selection`, AiSessionModelSelectionActionResponseSchema, jsonRequest("PUT", body));
    },
    updateReasoningEffort(instanceId: string, aiSessionId: string, clientRequestId: string, reasoningEffort: AiSessionReasoningEffort) {
      const body = AiSessionReasoningEffortInputSchema.parse({ clientRequestId, reasoningEffort });
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/reasoning-effort`, AiSessionReasoningEffortActionResponseSchema, jsonRequest("PUT", body));
    },
    rename(instanceId: string, aiSessionId: string, input: AiSessionRenameInput) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/title`, AiSessionRenameResultSchema, jsonRequest("PUT", AiSessionRenameInputSchema.parse(input)));
    },
    fork(instanceId: string, aiSessionId: string, input: AiSessionForkInput) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/fork`, AiSessionForkResultSchema, jsonRequest("POST", AiSessionForkInputSchema.parse(input)));
    },
    workspace(instanceId: string, cwdFolderId?: string, signal?: AbortSignal) {
      const query = cwdFolderId ? `?${new URLSearchParams({ cwdFolderId })}` : "";
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/workspace${query}`, RepositoryAiSessionWorkspaceSchema, { signal });
    },
    checkoutWorkspaceBranch(instanceId: string, input: { cwdFolderId?: string; branch: string }) {
      const body = AiSessionWorkspaceCheckoutInputSchema.parse(input);
      return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/workspace/checkout`, RepositoryAiSessionWorkspaceSchema, jsonRequest("POST", body));
    },
    openApp(instanceId: string, aiSessionId: string, clientRequestId: string) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/open-app`, AiSessionOpenAppResultSchema, jsonRequest("POST", AiSessionOpenAppInputSchema.parse({ clientRequestId })));
    },
    close(instanceId: string, aiSessionId: string, clientRequestId: string) {
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/close`, AiSessionCloseResultSchema, jsonRequest("POST", AiSessionCloseInputSchema.parse({ clientRequestId })));
    },
    clear(instanceId: string, aiSessionId: string) {
      return requestData(sessionRoute(instanceId, aiSessionId), AiSessionClearResultSchema, { method: "DELETE" });
    },
    executeCommand(instanceId: string, sessionId: string, input: AiSessionCommandInput) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/commands`, AiSessionCommandResultSchema, jsonRequest("POST", AiSessionCommandInputSchema.parse(input)));
    },
    markRead(instanceId: string, sessionId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/read`, AiSessionReadResultSchema, jsonRequest("POST", {}));
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
      return requestData(`${sessionRoute(instanceId, sessionId)}/messages`, AiSessionActionCompatibleResponseSchema, jsonRequest("POST", body));
    },
    approval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") {
      return requestData(`${sessionRoute(instanceId, sessionId)}/approval`, AiSessionActionCompatibleResponseSchema, jsonRequest("POST", AiSessionApprovalInputSchema.parse({ decision })));
    },
    interrupt(instanceId: string, sessionId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/interrupt`, AiSessionActionCompatibleResponseSchema, jsonRequest("POST", {}));
    },
    steerQueue(instanceId: string, sessionId: string, queueId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}/steer`, AiSessionActionCompatibleResponseSchema, jsonRequest("POST", {}));
    },
    retryQueue(instanceId: string, sessionId: string, queueId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}/retry`, AiSessionQueueMutationResponseSchema, jsonRequest("POST", {}));
    },
    removeQueue(instanceId: string, sessionId: string, queueId: string) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}`, AiSessionQueueMutationResponseSchema, { method: "DELETE" });
    },
    editQueue(instanceId: string, sessionId: string, queueId: string, input: AiSessionQueueEditInput) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}`, AiSessionQueueMutationResponseSchema, jsonRequest("PATCH", AiSessionQueueEditInputSchema.parse(input)));
    },
    reorderQueue(instanceId: string, sessionId: string, input: AiSessionQueueReorderInput) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/reorder`, AiSessionQueueMutationResponseSchema, jsonRequest("PATCH", AiSessionQueueReorderInputSchema.parse(input)));
    },
    pauseQueue(instanceId: string, sessionId: string, input: { paused: boolean }) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/queue/pause`, AiSessionQueueMutationResponseSchema, jsonRequest("POST", AiSessionQueuePauseInputSchema.parse(input)));
    },
    async uploadAttachment(input: { instanceId: string; sessionId: string; scopeType?: "session" | "create-request"; kind: "image" | "file"; name: string; mime: string; data: string }, onProgress?: (progress: number) => void) {
      onProgress?.(0);
      const content = await fetch(input.data).then((response) => response.arrayBuffer());
      const query = new URLSearchParams({
        scopeType: input.scopeType || "session",
        scopeId: input.sessionId,
        kind: input.kind,
        name: input.name,
        mime: input.mime,
        size: String(content.byteLength),
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
          jsonRequest("POST", {
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
    transcript(instanceId: string, sessionId: string, tail?: number, signal?: AbortSignal) {
      const query = tail === undefined ? "" : `?tail=${encodeURIComponent(String(tail))}`;
      return requestData(`${sessionRoute(instanceId, sessionId)}/transcript${query}`, AiSessionTranscriptSchema, { signal });
    },
    storyContent(instanceId: string, sessionId: string, signal?: AbortSignal) {
      return requestData(
        `${sessionRoute(instanceId, sessionId)}/story-content`,
        z.object({ storyId: z.string().trim().min(1), documents: StoryContentListSchema.shape.documents }).strict(),
        { signal },
      );
    },
    storyContentPreview(instanceId: string, sessionId: string, storyPath: string, signal?: AbortSignal) {
      return requestData(
        `${sessionRoute(instanceId, sessionId)}/story-content/preview?storyPath=${encodeURIComponent(storyPath)}`,
        StoryContentPreviewSchema,
        { signal },
      );
    },
    searchMentionFiles(instanceId: string, sessionId: string, query: string, signal?: AbortSignal) {
      return requestData(`${sessionRoute(instanceId, sessionId)}/mentions/files`, AiSessionMentionFileSearchSchema, jsonRequest("POST", { query }, signal));
    },
    async attachmentContent(instanceId: string, sessionId: string, messageId: string, attachmentId: string) {
      if (!transport.requestBinary) throw binaryUnsupported();
      return transport.requestBinary(`${sessionRoute(instanceId, sessionId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/content`);
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
