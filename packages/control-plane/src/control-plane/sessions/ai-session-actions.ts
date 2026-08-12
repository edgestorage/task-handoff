import {
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AiSessionActionResultSchema,
  AiSessionCreateResultSchema,
  AiSessionForkResultSchema,
  AiSessionCloseResultSchema,
  AiSessionOpenAppResultSchema,
  AiSessionCommandResultSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryListSchema,
  AiSessionMentionCatalogSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionQueueSchema,
  AiSessionQueueEditInputSchema,
  AiSessionQueueReorderInputSchema,
  AiSessionResumeResultSchema,
  AiSessionStatusSchema,
  type AiSessionActionResult,
  type AiSessionCommandInput,
  type AiSessionCommandResult,
  type AiSessionCreateResult,
  type AiSessionForkInput,
  type AiSessionForkResult,
  type AiSessionCloseResult,
  type AiSessionOpenAppResult,
  type AiSessionHistoryDetail,
  type AiSessionHistoryList,
  type AiSessionMessageAttachment,
  type AiSessionPermissionMode,
  type AiSessionReference,
  type AiSessionResumeResult,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlledInstance, NodeRuntime } from "@task-handoff/protocol/control-plane";
import { parseResponse } from "@task-handoff/protocol/response-validation";
import {
  RepositoryAiSessionWorkspaceSchema,
  type RepositoryAiSessionGitSelection,
  type RepositoryAiSessionWorkspace,
} from "@task-handoff/protocol/repository";

type AiSessionActionServiceOptions = {
  requireInstance: (instanceId: string) => Promise<ControlledInstance>;
  request: (instance: ControlledInstance, route: string, init?: RequestInit) => Promise<unknown>;
  requireRuntime: (nodeId: string, runtimeId: string) => Promise<NodeRuntime>;
  refreshSnapshots: () => Promise<unknown>;
  warn?: (data: Record<string, unknown>, message: string) => void;
};

export class AiSessionActionService {
  private readonly options: AiSessionActionServiceOptions;
  private resumeSnapshotRefreshFailures = 0;
  private lastResumeSnapshotRefreshFailure: { instanceId: string; aiSessionId: string; code: string; message: string; occurredAt: string } | undefined;

  constructor(options: AiSessionActionServiceOptions) {
    this.options = options;
  }

  async resolveApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip"): Promise<AiSessionActionResult> {
    return parseResponse(AiSessionActionResultSchema, await this.post(instanceId, sessionRoute(sessionId, "approval"), { decision }));
  }

  async listHistory(instanceId: string): Promise<AiSessionHistoryList> {
    return parseResponse(AiSessionHistoryListSchema, await this.get(instanceId, "/ai-sessions/history"));
  }

  async historyDetail(instanceId: string, aiSessionId: string): Promise<AiSessionHistoryDetail> {
    return parseResponse(AiSessionHistoryDetailSchema, await this.get(instanceId, `/ai-sessions/history/${encodeURIComponent(aiSessionId)}`));
  }

  async resume(instanceId: string, aiSessionId: string): Promise<AiSessionResumeResult> {
    const result = parseResponse(AiSessionResumeResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "resume"), {}));
    await this.refreshAfterCommittedResume(instanceId, aiSessionId);
    return result;
  }

  async create(
    instanceId: string,
    input: {
      agent: string;
      cwd: { type: "runtime-path"; path: string };
      cwdFolderId?: string;
      gitSelection?: RepositoryAiSessionGitSelection;
      message: string;
      attachments?: AiSessionMessageAttachment[];
      references?: AiSessionReference[];
      permissionMode?: AiSessionPermissionMode;
      clientRequestId: string;
    },
  ): Promise<AiSessionCreateResult> {
    assertAiSessionAttachmentsWithinLimit(input.attachments || []);
    const instance = await this.options.requireInstance(instanceId);
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
    const result = parseResponse(AiSessionForkResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "fork"), input));
    try {
      await this.options.refreshSnapshots();
    } catch (error) {
      try {
        this.options.warn?.({ instanceId, aiSessionId, providerSessionId: result.providerSessionId, code: errorCode(error), message: errorMessage(error) }, "AI session Fork committed but snapshot refresh failed");
      } catch {
        // Diagnostics cannot turn a committed remote Fork into an API failure.
      }
    }
    return result;
  }

  async openApp(instanceId: string, aiSessionId: string, clientRequestId: string): Promise<AiSessionOpenAppResult> {
    const result = parseResponse(AiSessionOpenAppResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "open-app"), { clientRequestId }));
    return result;
  }

  async close(instanceId: string, aiSessionId: string, clientRequestId: string): Promise<AiSessionCloseResult> {
    const result = parseResponse(AiSessionCloseResultSchema, await this.post(instanceId, sessionRoute(aiSessionId, "close"), { clientRequestId }));
    return result;
  }

  private async refreshAfterCommittedResume(instanceId: string, aiSessionId: string) {
    try {
      await this.options.refreshSnapshots();
    } catch (error) {
      const failure = {
        instanceId,
        aiSessionId,
        code: errorCode(error),
        message: errorMessage(error),
        occurredAt: new Date().toISOString(),
      };
      this.resumeSnapshotRefreshFailures += 1;
      this.lastResumeSnapshotRefreshFailure = failure;
      try {
        this.options.warn?.(failure, "AI session resumed but snapshot refresh failed");
      } catch {
        // Diagnostics must never turn an already committed remote resume into an API failure.
      }
    }
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
    attachments: AiSessionMessageAttachment[] = [],
    references: AiSessionReference[] = [],
    permissionMode?: AiSessionPermissionMode,
  ): Promise<AiSessionActionResult> {
    assertAiSessionAttachmentsWithinLimit(attachments);
    const instance = await this.options.requireInstance(instanceId);
    if (attachments.some((attachment) => attachment.source.type === "runtime-path")) {
      const runtime = await this.options.requireRuntime(instance.nodeId, instance.runtimeId);
      assertAiSessionRuntimePathSupport(attachments, runtime.type);
    }
    const session = instance.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
    const effectivePermissionMode = permissionMode
      || (session?.agent === "codex" ? instance.config.defaultCodexPermissionMode : undefined);
    return parseResponse(AiSessionActionResultSchema, await this.options.request(instance, sessionRoute(sessionId, "messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        ...(mode ? { mode } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(references.length ? { references } : {}),
        ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
      }),
    }));
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
    return parseResponse(AiSessionActionResultSchema, await this.post(instanceId, queueRoute(sessionId, queueId, "steer"), {}));
  }

  async retryQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    return parseResponse(AiSessionStatusSchema, await this.post(instanceId, queueRoute(sessionId, queueId, "retry"), {}));
  }

  async removeQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    const instance = await this.options.requireInstance(instanceId);
    return parseResponse(AiSessionStatusSchema, await this.options.request(instance, queueRoute(sessionId, queueId), { method: "DELETE" }));
  }

  async editQueuedMessage(instanceId: string, sessionId: string, queueId: string, input: { expectedRevision: number; message: string }) {
    const body = AiSessionQueueEditInputSchema.parse(input);
    return parseResponse(AiSessionStatusSchema, await this.patch(instanceId, queueRoute(sessionId, queueId), body));
  }

  async reorderQueuedMessages(instanceId: string, sessionId: string, input: { expectedRevision: number; queueIds: string[] }) {
    const body = AiSessionQueueReorderInputSchema.parse(input);
    return parseResponse(AiSessionStatusSchema, await this.patch(instanceId, sessionRoute(sessionId, "queue/reorder"), body));
  }

  async interrupt(instanceId: string, sessionId: string): Promise<AiSessionActionResult> {
    return parseResponse(AiSessionActionResultSchema, await this.post(instanceId, sessionRoute(sessionId, "interrupt"), {}));
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
  const features = instance.capabilities?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).aiSessionWorkspaceSelection === true);
}

function aiSessionWorkspaceSelectionUnsupported() {
  const error = new Error("The controlled instance does not support AI session workspace selection.");
  Object.assign(error, { statusCode: 409, code: "AI_SESSION_WORKSPACE_SELECTION_UNSUPPORTED" });
  return error;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "AI_SESSION_SNAPSHOT_REFRESH_FAILED";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sessionRoute(sessionId: string, suffix: string) {
  return `/ai-sessions/${encodeURIComponent(sessionId)}/${suffix}`;
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
