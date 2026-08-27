import {
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AiSessionActionCompatibleResponseSchema,
  AiSessionCreateResultSchema,
  AiSessionForkResultSchema,
  AiSessionCloseResultSchema,
  AiSessionOpenAppResultSchema,
  AiSessionCommandResultSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryListSchema,
  AiSessionTimelineSchema,
  AiSessionTurnTimelineSchema,
  AiSessionMentionCatalogSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionQueueSchema,
  AiSessionQueueEditInputSchema,
  AiSessionQueueReorderInputSchema,
  AiSessionResumeResultSchema,
  AiSessionModelSelectionActionResponseSchema,
  AiSessionReasoningEffortActionResponseSchema,
  AiSessionStatusSchema,
  AiSessionDetailSchema,
  AiSessionDetailReadSchema,
  AiSessionTurnIndexSchema,
  AiSessionTurnIndexReadSchema,
  AiSessionTurnBodySchema,
  AiSessionTurnBodyReadSchema,
  AiSessionQueueMutationResponseSchema,
  type AiSessionActionResponse,
  type AiSessionCommandInput,
  type AiSessionCommandResult,
  type AiSessionCreateResult,
  type AiSessionForkInput,
  type AiSessionForkResult,
  type AiSessionCloseResult,
  type AiSessionOpenAppResult,
  type AiSessionHistoryDetail,
  type AiSessionHistoryList,
  type AiSessionTimeline,
  type AiSessionTurnTimeline,
  type AiSessionMessageAttachment,
  type AiSessionMessageAttachmentRef,
  type AiSessionPermissionMode,
  type AiSessionReference,
  type AiSessionResumeResult,
  type AiSessionSendMode,
  type AiSessionStatus,
  type AiSessionModelSelection,
  type AiSessionReasoningEffort,
  type AiSessionTurn,
} from "@task-handoff/protocol/ai-sessions";
import {
  aiSessionProviderCapability,
  aiSessionTimelineCapabilityAgents,
  supportsAiSessionWorkspaceSelection,
  type ControlledInstance,
  type NodeRuntime,
} from "@task-handoff/protocol/control-plane";
import { normalizeAiSessionModelSelectionCapabilities, normalizeAiSessionReasoningEffortCapabilities } from "@task-handoff/protocol/ai-session-provider-capabilities";
import { parseResponse } from "@task-handoff/protocol/response-validation";
import { TRACE_ID_HEADER, type RequestTimingDiagnostics } from "../../shared/http/server-timing.ts";
import {
  RepositoryAiSessionWorkspaceSchema,
  type RepositoryAiSessionGitSelection,
  type RepositoryAiSessionWorkspace,
} from "@task-handoff/protocol/repository";
import { z } from "zod";
import { createHash } from "node:crypto";

type AiSessionActionServiceOptions = {
  requireInstance: (instanceId: string) => Promise<ControlledInstance>;
  request: (
    instance: ControlledInstance,
    route: string,
    init?: RequestInit,
    onTiming?: (diagnostics: RequestTimingDiagnostics) => void,
  ) => Promise<unknown>;
  requireRuntime: (nodeId: string, runtimeId: string) => Promise<NodeRuntime>;
};

function projectAiSessionDetail(session: AiSessionStatus) {
  return AiSessionDetailSchema.parse({
    id: session.id,
    appBindingKeys: session.appBindingKeys,
    cwd: session.cwd,
    error: session.error,
    providerMeta: session.providerMeta,
    queue: session.queue,
    subAgents: session.subAgents,
  });
}

function projectAiSessionTurnIndexEntry(turn: AiSessionTurn) {
  return {
    id: turn.id,
    providerTurnId: turn.providerTurnId,
    status: turn.status,
    phase: turn.phase,
    revision: turn.revision,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    completedAt: turn.completedAt,
    bodyRevision: legacyAiSessionTurnBodyRevision(turn),
  };
}

function legacyAiSessionTurnBodyRevision(turn: AiSessionTurn) {
  return createHash("sha256").update(JSON.stringify(turn)).digest("base64url").slice(0, 22);
}

export class AiSessionActionService {
  private readonly options: AiSessionActionServiceOptions;
  private resumeSnapshotRefreshFailures = 0;
  private lastResumeSnapshotRefreshFailure: { instanceId: string; aiSessionId: string; code: string; message: string; occurredAt: string } | undefined;

  constructor(options: AiSessionActionServiceOptions) {
    this.options = options;
  }

  async resolveApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip"): Promise<AiSessionActionResponse> {
    return parseResponse(AiSessionActionCompatibleResponseSchema, await this.post(instanceId, sessionRoute(sessionId, "approval"), { decision }));
  }

  async listHistory(instanceId: string, agents?: readonly string[]): Promise<AiSessionHistoryList> {
    const query = agents?.length ? `?agents=${encodeURIComponent(agents.join(","))}` : "";
    return parseResponse(AiSessionHistoryListSchema, await this.get(instanceId, `/ai-sessions/history${query}`));
  }

  async historyDetail(instanceId: string, aiSessionId: string): Promise<AiSessionHistoryDetail> {
    return parseResponse(AiSessionHistoryDetailSchema, await this.get(instanceId, `/ai-sessions/history/${encodeURIComponent(aiSessionId)}`));
  }

  async detail(instanceId: string, aiSessionId: string, revision?: string) {
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
    const response = await this.get(instanceId, `/ai-sessions/${encodeURIComponent(aiSessionId)}${query}`);
    const current = AiSessionDetailReadSchema.safeParse(response);
    if (current.success) return current.data;
    // Compatibility for v0.0.23: project the legacy full status into the new
    // metadata-only detail model. Turn bodies are recovered separately.
    const legacy = parseResponse(AiSessionStatusSchema, response);
    const legacyRevision = `legacy:${legacy.updatedAt}`;
    return AiSessionDetailReadSchema.parse({
      kind: revision === legacyRevision ? "not-modified" : "updated",
      revision: legacyRevision,
      ...(revision === legacyRevision ? {} : { detail: projectAiSessionDetail(legacy) }),
    });
  }

  async turnIndex(instanceId: string, aiSessionId: string, revision?: string) {
    const query = new URLSearchParams({ projection: "index" });
    if (revision) query.set("revision", revision);
    try {
      return parseResponse(AiSessionTurnIndexReadSchema, await this.get(instanceId, `${sessionRoute(aiSessionId, "turns")}?${query}`));
    } catch (error) {
      if (!splitAiSessionReadUnavailable(error)) throw error;
      // Compatibility for v0.0.23: the old endpoint ignores projection=index
      // and the old server has no single-Turn route. Derive both projections
      // from its complete detail response only at this compatibility boundary.
      const legacy = await this.legacyStatus(instanceId, aiSessionId);
      const legacyRevision = `legacy:${legacy.updatedAt}`;
      if (revision === legacyRevision) return AiSessionTurnIndexReadSchema.parse({ kind: "not-modified", revision: legacyRevision });
      const index = AiSessionTurnIndexSchema.parse({
        sessionId: legacy.id,
        revision: legacyRevision,
        turns: (legacy.turns || []).filter((turn) => (
          turn.userPrompt?.trim()
          || turn.lastMessage?.trim()
          || turn.summary?.trim()
          || turn.contextCompactions?.length
        )).map(projectAiSessionTurnIndexEntry),
      });
      return AiSessionTurnIndexReadSchema.parse({ kind: "updated", revision: legacyRevision, index });
    }
  }

  async turnBody(instanceId: string, aiSessionId: string, turnId: string, revision?: string) {
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
    try {
      return parseResponse(AiSessionTurnBodyReadSchema, await this.get(instanceId, `${sessionRoute(aiSessionId, "turns")}/${encodeURIComponent(turnId)}${query}`));
    } catch (error) {
      if (!splitAiSessionReadUnavailable(error)) throw error;
      const legacy = await this.legacyStatus(instanceId, aiSessionId);
      const turn = (legacy.turns || []).find((candidate) => candidate.id === turnId || candidate.providerTurnId === turnId);
      if (!turn) throw new Error(`AI session Turn ${turnId} was not found.`);
      const legacyRevision = legacyAiSessionTurnBodyRevision(turn);
      if (revision === legacyRevision) return AiSessionTurnBodyReadSchema.parse({ kind: "not-modified", revision: legacyRevision });
      const body = AiSessionTurnBodySchema.parse({ sessionId: legacy.id, revision: legacyRevision, turn });
      return AiSessionTurnBodyReadSchema.parse({ kind: "updated", revision: legacyRevision, body });
    }
  }

  private async legacyStatus(instanceId: string, aiSessionId: string) {
    return parseResponse(AiSessionStatusSchema, await this.get(instanceId, `/ai-sessions/${encodeURIComponent(aiSessionId)}`));
  }

  async timeline(instanceId: string, aiSessionId: string): Promise<AiSessionTimeline> {
    const instance = await this.options.requireInstance(instanceId);
    if (!instanceSupportsAiSessionTimeline(instance)) {
      throw aiSessionTimelineUnsupported();
    }
    return parseResponse(AiSessionTimelineSchema, await this.options.request(
      instance,
      sessionRoute(aiSessionId, "timeline"),
      { method: "GET" },
    ));
  }

  async turnTimeline(instanceId: string, aiSessionId: string, turnId: string): Promise<AiSessionTurnTimeline> {
    const instance = await this.options.requireInstance(instanceId);
    if (!instanceSupportsAiSessionTurnTimeline(instance)) {
      throw aiSessionTurnTimelineUnsupported();
    }
    return parseResponse(AiSessionTurnTimelineSchema, await this.options.request(
      instance,
      `${sessionRoute(aiSessionId, "turns")}/${encodeURIComponent(turnId)}/timeline`,
      { method: "GET" },
    ));
  }

  async resume(instanceId: string, aiSessionId: string): Promise<AiSessionResumeResult> {
    return parseResponse(AiSessionResumeResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "resume"), {}));
  }

  async create(
    instanceId: string,
    input: {
      agent: string;
      cwd: { type: "runtime-path"; path: string };
      cwdFolderId?: string;
      gitSelection?: RepositoryAiSessionGitSelection;
      message: string;
      attachments?: Array<AiSessionMessageAttachment | AiSessionMessageAttachmentRef>;
      references?: AiSessionReference[];
      permissionMode?: AiSessionPermissionMode;
      clientRequestId: string;
      modelSelection?: AiSessionModelSelection;
      reasoningEffort?: AiSessionReasoningEffort;
    },
  ): Promise<AiSessionCreateResult> {
    assertAiSessionAttachmentsWithinLimit((input.attachments || []).filter((attachment): attachment is AiSessionMessageAttachment => attachment.source.type !== "upload-ref"));
    const instance = await this.options.requireInstance(instanceId);
    if (input.modelSelection) {
      const capability = normalizeAiSessionModelSelectionCapabilities(aiSessionProviderCapability(instance.capabilities, input.agent));
      if (!capability.selectModelAtCreate) {
        throw Object.assign(new Error(`${input.agent} does not support selecting a model at creation.`), {
          statusCode: 409,
          code: "AI_SESSION_MODEL_SELECTION_UNSUPPORTED",
        });
      }
    }
    if (input.reasoningEffort) {
      const capability = normalizeAiSessionReasoningEffortCapabilities(aiSessionProviderCapability(instance.capabilities, input.agent));
      if (!capability.selectAtCreate) {
        throw Object.assign(new Error(`${input.agent} does not support selecting reasoning effort at creation.`), {
          statusCode: 409,
          code: "AI_SESSION_REASONING_EFFORT_UNSUPPORTED",
        });
      }
    }
    const supportsWorkspaceSelection = instanceSupportsAiSessionWorkspaceSelection(instance);
    if (input.gitSelection && !supportsWorkspaceSelection) {
      throw aiSessionWorkspaceSelectionUnsupported();
    }
    const effectivePermissionMode = input.permissionMode
      || (input.agent === "codex" ? instance.config.defaultCodexPermissionMode : undefined);
    const route = input.gitSelection ? "/repository/ai-session-workspace/create" : "/ai-sessions";
    const { cwdFolderId, ...baseInput } = input;
    const result = parseResponse(AiSessionCreateResultSchema, await this.options.request(instance, route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...baseInput,
        // Compatibility for v0.0.21: its strict controlled-instance create schema does not accept cwdFolderId.
        ...(supportsWorkspaceSelection && cwdFolderId ? { cwdFolderId } : {}),
        ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
      }),
    }));
    return result;
  }

  async inspectWorkspace(instanceId: string, cwd: { type: "runtime-path"; path: string }): Promise<RepositoryAiSessionWorkspace> {
    const instance = await this.options.requireInstance(instanceId);
    if (!instanceSupportsAiSessionWorkspaceSelection(instance)) {
      throw aiSessionWorkspaceSelectionUnsupported();
    }
    return parseResponse(RepositoryAiSessionWorkspaceSchema, await this.options.request(instance, "/repository/ai-session-workspace/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    }));
  }

  async fork(instanceId: string, aiSessionId: string, input: AiSessionForkInput): Promise<AiSessionForkResult> {
    return parseResponse(AiSessionForkResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "fork"), input));
  }

  async updateModelSelection(instanceId: string, aiSessionId: string, clientRequestId: string, selection: AiSessionModelSelection) {
    const instance = await this.options.requireInstance(instanceId);
    const session = instance.aiSessions.sessions.find((candidate) => candidate.id === aiSessionId);
    if (!session) throw Object.assign(new Error("AI Session was not found."), { statusCode: 404, code: "AI_SESSION_NOT_FOUND" });
    const capability = normalizeAiSessionModelSelectionCapabilities(aiSessionProviderCapability(instance.capabilities, session.agent));
    const changesProvider = Boolean(session.modelSelection && session.modelSelection.modelEntityId !== selection.modelEntityId);
    if (changesProvider ? !capability.switchProviderDuringSession : !capability.switchModelWithinProvider) {
      const code = changesProvider && session.agent === "codex"
        ? "AI_SESSION_PROVIDER_SWITCH_REQUIRES_NEW_SESSION"
        : "AI_SESSION_MODEL_SELECTION_UNSUPPORTED";
      throw Object.assign(new Error(changesProvider && session.agent === "codex"
        ? "Codex provider changes require a new session."
        : `${session.agent} does not support this model change.`), { statusCode: 409, code });
    }
    return parseResponse(AiSessionModelSelectionActionResponseSchema, await this.options.request(
      instance,
      sessionRoute(aiSessionId, "model-selection"),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId, modelSelection: selection }),
      },
    ));
  }

  async updateReasoningEffort(instanceId: string, aiSessionId: string, clientRequestId: string, effort: AiSessionReasoningEffort) {
    const instance = await this.options.requireInstance(instanceId);
    const session = instance.aiSessions.sessions.find((candidate) => candidate.id === aiSessionId);
    if (!session) throw Object.assign(new Error("AI Session was not found."), { statusCode: 404, code: "AI_SESSION_NOT_FOUND" });
    const capability = normalizeAiSessionReasoningEffortCapabilities(aiSessionProviderCapability(instance.capabilities, session.agent));
    if (!capability.updateDuringSession) {
      throw Object.assign(new Error(`${session.agent} does not support reasoning effort changes.`), {
        statusCode: 409,
        code: "AI_SESSION_REASONING_EFFORT_UNSUPPORTED",
      });
    }
    return parseResponse(AiSessionReasoningEffortActionResponseSchema, await this.options.request(
      instance,
      sessionRoute(aiSessionId, "reasoning-effort"),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId, reasoningEffort: effort }),
      },
    ));
  }

  async openApp(instanceId: string, aiSessionId: string, clientRequestId: string): Promise<AiSessionOpenAppResult> {
    const result = parseResponse(AiSessionOpenAppResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "open-app"), { clientRequestId }));
    return result;
  }

  async close(instanceId: string, aiSessionId: string, clientRequestId: string): Promise<AiSessionCloseResult> {
    const result = parseResponse(AiSessionCloseResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "close"), { clientRequestId }));
    return result;
  }

  diagnostics() {
    return {
      resumeSnapshotRefreshFailures: this.resumeSnapshotRefreshFailures,
      lastResumeSnapshotRefreshFailure: this.lastResumeSnapshotRefreshFailure,
    };
  }

  async sendMessage(
    instanceId: string,
    sessionId: string,
    message: string,
    mode?: AiSessionSendMode,
    attachments: Array<AiSessionMessageAttachment | AiSessionMessageAttachmentRef> = [],
    references: AiSessionReference[] = [],
    permissionMode?: AiSessionPermissionMode,
    diagnostics?: { traceId: string; onTiming?: (timing: RequestTimingDiagnostics) => void },
  ): Promise<AiSessionActionResponse> {
    const materializedAttachments = attachments.filter((attachment): attachment is AiSessionMessageAttachment => attachment.source.type !== "upload-ref");
    assertAiSessionAttachmentsWithinLimit(materializedAttachments);
    const instance = await this.options.requireInstance(instanceId);
    if (attachments.some((attachment) => attachment.source.type === "runtime-path")) {
      const runtime = await this.options.requireRuntime(instance.nodeId, instance.runtimeId);
      assertAiSessionRuntimePathSupport(materializedAttachments, runtime.type);
    }
    const session = instance.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
    const effectivePermissionMode = permissionMode
      || (session?.agent === "codex" ? instance.config.defaultCodexPermissionMode : undefined);
    return parseResponse(AiSessionActionCompatibleResponseSchema, await this.options.request(instance, sessionRoute(sessionId, "messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(diagnostics?.traceId ? { [TRACE_ID_HEADER]: diagnostics.traceId } : {}),
      },
      body: JSON.stringify({
        message,
        ...(mode ? { mode } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(references.length ? { references } : {}),
        ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
      }),
    }, diagnostics?.onTiming));
  }

  async mentionCatalog(instanceId: string, sessionId: string) {
    return parseResponse(AiSessionMentionCatalogSchema, await this.get(instanceId, sessionRoute(sessionId, "mentions")));
  }

  async searchMentionFiles(instanceId: string, sessionId: string, query: string) {
    return parseResponse(AiSessionMentionFileSearchSchema, await this.post(instanceId, sessionRoute(sessionId, "mentions/files"), { query }));
  }

  async executeCommand(instanceId: string, sessionId: string, input: AiSessionCommandInput): Promise<AiSessionCommandResult> {
    return parseResponse(AiSessionCommandResultSchema, await this.post(instanceId, sessionRoute(sessionId, "commands"), input));
  }

  async queue(instanceId: string, sessionId: string) {
    return parseResponse(AiSessionQueueSchema, await this.get(instanceId, sessionRoute(sessionId, "queue")));
  }

  async steerQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    return parseResponse(AiSessionActionCompatibleResponseSchema, await this.post(instanceId, queueRoute(sessionId, queueId, "steer"), {}));
  }

  async retryQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    return parseResponse(AiSessionQueueMutationResponseSchema, await this.post(instanceId, queueRoute(sessionId, queueId, "retry"), {}));
  }

  async removeQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    const instance = await this.options.requireInstance(instanceId);
    return parseResponse(AiSessionQueueMutationResponseSchema, await this.options.request(instance, queueRoute(sessionId, queueId), { method: "DELETE" }));
  }

  async editQueuedMessage(instanceId: string, sessionId: string, queueId: string, input: { expectedRevision: number; message: string }) {
    const body = AiSessionQueueEditInputSchema.parse(input);
    return parseResponse(AiSessionQueueMutationResponseSchema, await this.patch(instanceId, queueRoute(sessionId, queueId), body));
  }

  async reorderQueuedMessages(instanceId: string, sessionId: string, input: { expectedRevision: number; queueIds: string[] }) {
    const body = AiSessionQueueReorderInputSchema.parse(input);
    return parseResponse(AiSessionQueueMutationResponseSchema, await this.patch(instanceId, sessionRoute(sessionId, "queue/reorder"), body));
  }

  async interrupt(instanceId: string, sessionId: string): Promise<AiSessionActionResponse> {
    return parseResponse(AiSessionActionCompatibleResponseSchema, await this.post(instanceId, sessionRoute(sessionId, "interrupt"), {}));
  }

  private async get(instanceId: string, route: string) {
    return this.options.request(await this.options.requireInstance(instanceId), route);
  }

  private async post(instanceId: string, route: string, body: unknown) {
    return this.options.request(await this.options.requireInstance(instanceId), route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async patch(instanceId: string, route: string, body: unknown) {
    return this.options.request(await this.options.requireInstance(instanceId), route, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function instanceSupportsAiSessionWorkspaceSelection(instance: ControlledInstance) {
  return supportsAiSessionWorkspaceSelection(instance.capabilities);
}

function instanceSupportsAiSessionTimeline(instance: ControlledInstance) {
  return aiSessionTimelineCapabilityAgents(instance.capabilities, "session-read").length > 0;
}

function instanceSupportsAiSessionTurnTimeline(instance: ControlledInstance) {
  return aiSessionTimelineCapabilityAgents(instance.capabilities, "turn-read").length > 0;
}

function aiSessionTimelineUnsupported() {
  const error = new Error("The controlled instance does not support AI session Timeline reads.");
  Object.assign(error, { statusCode: 409, code: "AI_SESSION_TIMELINE_UNSUPPORTED" });
  return error;
}

function aiSessionTurnTimelineUnsupported() {
  const error = new Error("The controlled instance does not support per-turn AI session Timeline reads.");
  Object.assign(error, { statusCode: 409, code: "AI_SESSION_TURN_TIMELINE_UNSUPPORTED" });
  return error;
}

function aiSessionWorkspaceSelectionUnsupported() {
  const error = new Error("The controlled instance does not support AI session workspace selection.");
  Object.assign(error, { statusCode: 409, code: "AI_SESSION_WORKSPACE_SELECTION_UNSUPPORTED" });
  return error;
}

function sessionRoute(sessionId: string, suffix: string) {
  return `/ai-sessions/${encodeURIComponent(sessionId)}/${suffix}`;
}

function splitAiSessionReadUnavailable(error: unknown) {
  if (error instanceof z.ZodError) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as { statusCode?: unknown; status?: unknown; code?: unknown };
  const status = record.statusCode ?? record.status;
  return status === 404
    && record.code !== "AI_SESSION_NOT_FOUND"
    && record.code !== "AI_SESSION_TURN_NOT_FOUND";
}

function queueRoute(sessionId: string, queueId: string, suffix?: string) {
  return `${sessionRoute(sessionId, "queue")}/${encodeURIComponent(queueId)}${suffix ? `/${suffix}` : ""}`;
}

function assertAiSessionAttachmentsWithinLimit(attachments: AiSessionMessageAttachment[]) {
  const totalBytes = attachments.reduce(
    (total, attachment) => total + (attachment.source.type === "inline" ? attachment.size : 0),
    0,
  );
  if (totalBytes <= AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) return;
  const error = new Error(`Inline attachments must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`);
  Object.assign(error, { statusCode: 400, code: "AI_SESSION_ATTACHMENTS_TOO_LARGE" });
  throw error;
}

export function assertAiSessionRuntimePathSupport(
  attachments: AiSessionMessageAttachment[],
  runtimeType: "docker" | "kubernetes" | "local",
) {
  if (!attachments.some((attachment) => attachment.source.type === "runtime-path") || runtimeType === "local") return;
  const error = new Error("Runtime path attachments are currently available only for Local Runtime instances.");
  Object.assign(error, { statusCode: 400, code: "AI_SESSION_RUNTIME_PATH_UNSUPPORTED" });
  throw error;
}
