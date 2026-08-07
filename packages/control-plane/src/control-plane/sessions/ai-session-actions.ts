import {
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AiSessionActionResultSchema,
  AiSessionCreateResultSchema,
  AiSessionCloseResultSchema,
  AiSessionOpenAppResultSchema,
  AiSessionCommandResultSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryListSchema,
  AiSessionMentionCatalogSchema,
  AiSessionMentionFileSearchSchema,
  AiSessionQueueSchema,
  AiSessionResumeResultSchema,
  AiSessionStatusSchema,
  type AiSessionActionResult,
  type AiSessionCommandInput,
  type AiSessionCommandResult,
  type AiSessionCreateResult,
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
      message: string;
      attachments?: AiSessionMessageAttachment[];
      references?: AiSessionReference[];
      permissionMode?: AiSessionPermissionMode;
      clientRequestId: string;
    },
  ): Promise<AiSessionCreateResult> {
    assertAiSessionAttachmentsWithinLimit(input.attachments || []);
    const instance = await this.options.requireInstance(instanceId);
    const effectivePermissionMode = input.permissionMode
      || (input.agent === "codex" ? instance.config.defaultCodexPermissionMode : undefined);
    const result = parseResponse(AiSessionCreateResultSchema, await this.options.request(instance, "/ai-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}) }),
    }));
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
