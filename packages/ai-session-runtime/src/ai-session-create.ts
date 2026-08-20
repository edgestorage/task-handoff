import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AiAgentKind,
  AiSessionCreateResult,
  AiSessionMessageAttachment,
  AiSessionPermissionMode,
  AiSessionReference,
} from "@task-handoff/protocol/ai-sessions";
import { AiSessionCreateResultSchema } from "@task-handoff/protocol/ai-sessions";
import { aiSessionControlError, type AiSessionController } from "./ai-session-control";
import type { AiSessionRegistry } from "./ai-session-registry";

export type AiSessionCreateCoordinatorInput = {
  agent: AiAgentKind;
  cwd: string;
  cwdFolderId?: string;
  message: string;
  attachments?: AiSessionMessageAttachment[];
  draftAttachmentIds?: string[];
  draftScopeType?: "session" | "create-request";
  draftScopeId?: string;
  references?: AiSessionReference[];
  permissionMode?: AiSessionPermissionMode;
  clientRequestId: string;
  idempotencyFingerprint?: string;
};

export type AiSessionCreateCoordinatorOptions = {
  registry: AiSessionRegistry;
  controller: AiSessionController;
  ensureProvider?: (agent: string) => void | Promise<void>;
  materializationTimeoutMs?: number;
  operationStorePath?: string;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
};

export class AiSessionCreateCoordinator {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<AiSessionCreateResult> }>();
  private readonly completed = new Map<string, { fingerprint?: string; result: AiSessionCreateResult }>();

  constructor(private readonly options: AiSessionCreateCoordinatorOptions) {
    this.restoreCompleted();
  }

  create(input: AiSessionCreateCoordinatorInput): Promise<AiSessionCreateResult> {
    const fingerprint = input.idempotencyFingerprint || aiSessionCreateRequestFingerprint(createFingerprintInput(input));
    const completed = this.completed.get(input.clientRequestId);
    if (completed) {
      assertAiSessionCreateRequestFingerprint(completed.fingerprint, fingerprint);
      return Promise.resolve({ ...completed.result, disposition: "already-created" });
    }
    const active = this.pending.get(input.clientRequestId);
    if (active) {
      assertAiSessionCreateRequestFingerprint(active.fingerprint, fingerprint);
      return active.promise;
    }
    const promise = this.perform(input).finally(() => {
      if (this.pending.get(input.clientRequestId)?.promise === promise) this.pending.delete(input.clientRequestId);
    });
    this.pending.set(input.clientRequestId, { fingerprint, promise });
    return promise;
  }

  completedResult(clientRequestId: string, fingerprint: string) {
    const completed = this.completed.get(clientRequestId);
    if (!completed) return undefined;
    assertAiSessionCreateRequestFingerprint(completed.fingerprint, fingerprint);
    return { ...completed.result, disposition: "already-created" as const };
  }

  private async perform(input: AiSessionCreateCoordinatorInput): Promise<AiSessionCreateResult> {
    await this.options.ensureProvider?.(input.agent);
    const provider = this.options.controller.provider(input.agent);
    if (!provider.createSession) {
      throw aiSessionControlError("AI_SESSION_CREATE_UNSUPPORTED", `${input.agent} does not support direct AI session creation.`, 400);
    }
    const created = await provider.createSession({ cwd: input.cwd, permissionMode: input.permissionMode });
    const providerSessionId = created.providerSessionId.trim();
    if (!providerSessionId || created.creationSource !== "ai-session") {
      throw aiSessionControlError("AI_SESSION_CREATE_INVALID_RESPONSE", "Provider returned an invalid Direct AI session identity.", 502);
    }
    let session = this.options.registry.getByProviderSessionId(input.agent, providerSessionId);
    if (!session) {
      session = this.options.registry.applyAdapterSnapshot({
        source: "control",
        agent: input.agent,
        creationSource: "ai-session",
        appId: input.agent === "codex" ? "codex-app-server" : input.agent,
        providerSessionId,
        cwd: created.cwd || input.cwd,
        cwdFolderId: input.cwdFolderId,
        status: "idle",
        phase: "unknown",
      });
    }
    if (!session || session.creationSource !== "ai-session") {
      await this.compensate(provider, providerSessionId, session?.id, "registry-projection-failed");
      throw aiSessionControlError("AI_SESSION_MATERIALIZATION_FAILED", "Direct AI session could not be projected.", 502);
    }
    if (input.cwdFolderId && session.cwdFolderId !== input.cwdFolderId) {
      session = this.options.registry.put({ ...session, cwdFolderId: input.cwdFolderId });
    }
    try {
      await withTimeout(
        this.options.controller.startMessage(session.id, {
          message: input.message,
          attachments: input.attachments || [],
          draftAttachmentIds: input.draftAttachmentIds,
          draftScopeType: input.draftScopeType,
          draftScopeId: input.draftScopeId,
          references: input.references || [],
          permissionMode: input.permissionMode,
        }),
        this.options.materializationTimeoutMs ?? 15_000,
      );
    } catch (error: unknown) {
      await this.compensate(provider, providerSessionId, session.id, "first-turn-failed", error);
      throw aiSessionControlError(
        "AI_SESSION_MATERIALIZATION_FAILED",
        error instanceof Error ? error.message : "The first provider turn could not be materialized.",
        502,
      );
    }
    const result = AiSessionCreateResultSchema.parse({
      disposition: "created",
      aiSessionId: session.id,
      providerSessionId,
      creationSource: "ai-session",
    });
    const fingerprint = input.idempotencyFingerprint || aiSessionCreateRequestFingerprint(createFingerprintInput(input));
    this.completed.set(input.clientRequestId, { fingerprint, result });
    this.persistCompleted();
    return result;
  }

  private restoreCompleted() {
    const storePath = this.options.operationStorePath;
    if (!storePath || !fs.existsSync(storePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const records = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.completed)
        ? parsed.completed
        : [];
      for (const record of records) {
        if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.clientRequestId !== "string") continue;
        const result = AiSessionCreateResultSchema.safeParse(record.result);
        if (result.success) this.completed.set(record.clientRequestId, {
          fingerprint: typeof record.fingerprint === "string" && /^[a-f0-9]{64}$/.test(record.fingerprint) ? record.fingerprint : undefined,
          result: result.data,
        });
      }
    } catch (error: unknown) {
      this.options.onDiagnostic?.({
        code: "AI_SESSION_CREATE_STORE_INVALID",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistCompleted() {
    const storePath = this.options.operationStorePath;
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const temporaryPath = `${storePath}.${process.pid}.tmp`;
      const completed = [...this.completed.entries()].map(([clientRequestId, record]) => ({ clientRequestId, ...record }));
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: 2, completed }, null, 2));
      fs.renameSync(temporaryPath, storePath);
    } catch (error: unknown) {
      this.options.onDiagnostic?.({
        code: "AI_SESSION_CREATE_STORE_WRITE_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async compensate(
    provider: ReturnType<AiSessionController["provider"]>,
    providerSessionId: string,
    aiSessionId: string | undefined,
    reason: string,
    error?: unknown,
  ) {
    if (aiSessionId) this.options.registry.discard(aiSessionId);
    const failures: string[] = [];
    try {
      if (provider.deleteSession) await provider.deleteSession(providerSessionId);
      else await provider.archiveSession?.(providerSessionId);
    } catch (cleanupError: unknown) {
      failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    try {
      await provider.unsubscribeSession?.(providerSessionId);
    } catch (cleanupError: unknown) {
      failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    this.options.onDiagnostic?.({
      code: "AI_SESSION_CREATE_COMPENSATED",
      reason,
      aiSessionId,
      providerSessionId,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      cleanupFailures: failures,
    });
  }
}

export function aiSessionCreateRequestFingerprint(value: unknown) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertAiSessionCreateRequestFingerprint(expected: string | undefined, actual: string) {
  // Compatibility for v0.0.21: restored operation records did not persist fingerprints.
  if (!expected || expected === actual) return;
  throw aiSessionControlError("AI_SESSION_CREATE_REQUEST_CONFLICT", "The client request ID was already used with different session creation input.", 409);
}

function createFingerprintInput(input: AiSessionCreateCoordinatorInput) {
  const { clientRequestId: _clientRequestId, idempotencyFingerprint: _idempotencyFingerprint, ...value } = input;
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Provider materialization timed out after ${timeoutMs}ms.`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
