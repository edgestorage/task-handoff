import { z } from "zod";
import {
  AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES,
  AiSessionApprovalInputSchema,
  AiSessionActionCompatibleResponseSchema,
  AiSessionCreateRefInputSchema,
  AiSessionCreateResultSchema,
  AiSessionForkInputSchema,
  AiSessionForkResultSchema,
  AiSessionDeltaResponseSchema,
  AiSessionsSyncResponseSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryListSchema,
  AiSessionTimelineSchema,
  AiSessionTimelineReadSchema,
  AiSessionTimelineSyncInputSchema,
  AiSessionTimelineSyncReadSchema,
  AiSessionTurnTimelineSchema,
  AiSessionTurnTimelineReadSchema,
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
  AiSessionAttachmentDraftSchema,
  AiSessionAttachmentDraftStreamOffsetSchema,
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

const CompatibleAiSessionTimelineReadSchema = z.union([
  AiSessionTimelineReadSchema,
  AiSessionTimelineSchema.transform((timeline) => ({
    kind: "updated" as const,
    revision: `legacy:${timeline.generatedAt}`,
    timeline,
  })),
]);

const CompatibleAiSessionTurnTimelineReadSchema = z.union([
  AiSessionTurnTimelineReadSchema,
  AiSessionTurnTimelineSchema.transform((timeline) => ({
    kind: "updated" as const,
    revision: `legacy:${timeline.generatedAt}`,
    timeline,
  })),
]);

function attachmentArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

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

export type AiSessionAttachmentUploadInput = {
  instanceId: string;
  sessionId: string;
  scopeType?: "session" | "create-request";
  kind: "image" | "file";
  name: string;
  mime: string;
} & (
  | { data: string; bytes?: never; chunks?: never; size?: never }
  | { bytes: Uint8Array; data?: never; chunks?: never; size?: never }
  | { chunks: AsyncIterable<Uint8Array>; size: number; data?: never; bytes?: never }
);

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
    sync(instances: ReadonlyArray<{ instanceId: string; streamId: string; revision: number }>, signal?: AbortSignal) {
      const query = new URLSearchParams({ hierarchy: "subagents" });
      return requestData(`/api/ai-sessions/sync?${query}`, AiSessionsSyncResponseSchema, jsonRequest("POST", { instances: [...instances] }, signal));
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
    timeline(instanceId: string, aiSessionId: string, revision?: string, signal?: AbortSignal) {
      const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/timeline${query}`, CompatibleAiSessionTimelineReadSchema, { signal });
    },
    turnTimeline(instanceId: string, aiSessionId: string, turnId: string, revision?: string, signal?: AbortSignal) {
      const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/turns/${encodeURIComponent(turnId)}/timeline${query}`, CompatibleAiSessionTurnTimelineReadSchema, { signal });
    },
    syncTimeline(instanceId: string, aiSessionId: string, knownItems: ReadonlyArray<{ id: string; revision: string }>, signal?: AbortSignal) {
      const input = AiSessionTimelineSyncInputSchema.parse({ knownItems });
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/timeline/sync`, AiSessionTimelineSyncReadSchema, jsonRequest("POST", input, signal));
    },
    syncTurnTimeline(instanceId: string, aiSessionId: string, turnId: string, knownItems: ReadonlyArray<{ id: string; revision: string }>, signal?: AbortSignal) {
      const input = AiSessionTimelineSyncInputSchema.parse({ knownItems });
      return requestData(`${sessionRoute(instanceId, aiSessionId)}/turns/${encodeURIComponent(turnId)}/timeline/sync`, AiSessionTimelineSyncReadSchema, jsonRequest("POST", input, signal));
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
    async uploadAttachment(input: AiSessionAttachmentUploadInput, onProgress?: (progress: number) => void) {
      onProgress?.(0);
      if ("chunks" in input) {
        return uploadAttachmentChunks(transport, input as AiSessionAttachmentUploadInput & { chunks: AsyncIterable<Uint8Array>; size: number }, onProgress);
      }
      // Native clients pass the file bytes directly. Only the browser/legacy
      // callers decode data URLs; React Native rejects large data: fetches
      // before the upload transport is ever entered.
      const bytes = "bytes" in input ? input.bytes : undefined;
      const data = "data" in input ? input.data : undefined;
      if (!bytes && !data) throw attachmentStreamError("AI_SESSION_ATTACHMENT_CONTENT_REQUIRED", "Attachment content is required.");
      const fetched = bytes ? undefined : await fetch(data!).then((response) => response.arrayBuffer()) as ArrayBuffer | Iterable<number>;
      const content = bytes
        ? attachmentArrayBuffer(bytes)
        : fetched instanceof ArrayBuffer ? fetched : new Uint8Array(Array.from(fetched!)).buffer;
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
        if (!("data" in input) || !input.data || !isMissingScopedAttachmentUploadRoute(error)) throw error;
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

async function uploadAttachmentChunks(
  transport: ControlPlaneClientTransport,
  input: AiSessionAttachmentUploadInput & { chunks: AsyncIterable<Uint8Array>; size: number },
  onProgress?: (progress: number) => void,
) {
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw attachmentStreamError("AI_SESSION_ATTACHMENT_SIZE_INVALID", "Attachment size must be a positive integer.");
  }
  const query = new URLSearchParams({
    scopeType: input.scopeType || "session",
    scopeId: input.sessionId,
    kind: input.kind,
    name: input.name,
    mime: input.mime,
    size: String(input.size),
  });
  const streamRoute = `/api/controlled-instances/${encodeURIComponent(input.instanceId)}/ai-session-attachments/draft-streams`;
  let created = false;
  let attachmentId: string | undefined;
  try {
    const started = (await transport.request(
      `${streamRoute}?${query}`,
      DataSchema(AiSessionAttachmentDraftStreamOffsetSchema),
      { method: "POST" },
    )).data;
    created = true;
    attachmentId = started.attachmentId;
    if (started.offset !== 0) throw attachmentStreamError("AI_SESSION_ATTACHMENT_OFFSET_MISMATCH", "The Control Plane returned an invalid attachment upload offset.", 502);

    let offset = 0;
    let received = 0;
    const chunkRoute = `${streamRoute}/${encodeURIComponent(attachmentId)}`;
    for await (const value of input.chunks) {
      if (!(value instanceof Uint8Array)) throw attachmentStreamError("AI_SESSION_ATTACHMENT_CHUNK_INVALID", "Attachment chunks must be Uint8Array values.");
      for (let start = 0; start < value.byteLength; start += AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES) {
        const chunk = value.subarray(start, Math.min(start + AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES, value.byteLength));
        if (chunk.byteLength === 0) continue;
        received += chunk.byteLength;
        if (received > input.size) throw attachmentStreamError("AI_SESSION_ATTACHMENT_SIZE_MISMATCH", "Attachment content exceeded its declared size.", 400);
        const acknowledged = (await transport.request(
          `${chunkRoute}?offset=${offset}`,
          DataSchema(AiSessionAttachmentDraftStreamOffsetSchema),
          { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk as unknown as BodyInit },
        )).data;
        if (acknowledged.attachmentId !== attachmentId || acknowledged.offset !== offset + chunk.byteLength) {
          throw attachmentStreamError("AI_SESSION_ATTACHMENT_OFFSET_MISMATCH", "The Control Plane returned an invalid attachment upload offset.", 502);
        }
        offset = acknowledged.offset;
        if (offset < input.size) onProgress?.(offset / input.size);
      }
    }
    if (received !== input.size) throw attachmentStreamError("AI_SESSION_ATTACHMENT_SIZE_MISMATCH", "Attachment content did not match its declared size.", 400);
    const draft = (await transport.request(
      `${chunkRoute}/complete`,
      DataSchema(AiSessionAttachmentDraftSchema),
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    )).data;
    onProgress?.(1);
    return draft;
  } catch (error) {
    if (created && attachmentId) {
      void transport.request(
        `${streamRoute}/${encodeURIComponent(attachmentId)}`,
        DataSchema(z.object({}).passthrough()),
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    throw error;
  }
}

function attachmentStreamError(code: string, message: string, status?: number) {
  return Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status }) });
}

export type ControlPlaneAiSessions = z.infer<typeof ControlPlaneAiSessionsSchema>;
export type ControlPlaneAiSessionSummary = z.infer<typeof ControlPlaneAiSessionSummarySchema>;
export type ControlPlaneAiSessionsSnapshot = z.infer<typeof ControlPlaneAiSessionsSnapshotSchema>;
export type AiSessionUploadedAttachment = z.infer<typeof AiSessionUploadedAttachmentSchema>;
