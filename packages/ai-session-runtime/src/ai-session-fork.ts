import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AiSessionForkInput, AiSessionForkResult, AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { AiSessionForkInputSchema, AiSessionForkResultSchema } from "@task-handoff/protocol/ai-sessions";
import { aiSessionControlError, type AiSessionController } from "./ai-session-control";
import type { AiSessionRegistry } from "./ai-session-registry";

type ForkStage = "validated" | "workspace-prepared" | "provider-created" | "materialized" | "completed";

type ForkOperation = {
  clientRequestId: string;
  fingerprint: string;
  sourceSessionId: string;
  input: AiSessionForkInput;
  stage: ForkStage;
  cwd?: string;
  worktreeId?: string;
  providerSessionId?: string;
  aiSessionId?: string;
  result?: AiSessionForkResult;
};

export type AiSessionForkWorkspacePreparation = { cwd: string; worktreeId: string };

export type AiSessionForkCoordinatorOptions = {
  registry: AiSessionRegistry;
  controller: AiSessionController;
  ensureProvider?: (agent: string) => void | Promise<void>;
  prepareManagedWorktree?: (source: AiSessionStatus, clientRequestId: string) => Promise<AiSessionForkWorkspacePreparation>;
  validateManagedWorktree?: (source: AiSessionStatus, worktreeId: string, cwd: string) => Promise<boolean>;
  removeManagedWorktree?: (source: AiSessionStatus, worktreeId: string) => Promise<boolean>;
  materializationTimeoutMs?: number;
  operationStorePath?: string;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
};

export class AiSessionForkCoordinator {
  private readonly operations = new Map<string, ForkOperation>();
  private readonly pending = new Map<string, Promise<AiSessionForkResult>>();

  constructor(private readonly options: AiSessionForkCoordinatorOptions) {
    this.restore();
  }

  fork(sourceSessionId: string, input: AiSessionForkInput): Promise<AiSessionForkResult> {
    const normalized = { ...input, workspace: input.workspace || { mode: "current" as const } };
    const fingerprint = forkFingerprint({ sourceSessionId, ...normalized });
    const restored = this.operations.get(input.clientRequestId);
    if (restored) {
      if (restored.fingerprint !== fingerprint) {
        throw aiSessionControlError("AI_SESSION_FORK_IDEMPOTENCY_CONFLICT", "The client request ID was already used with different Fork input.", 409);
      }
      if (restored.result) return Promise.resolve({ ...restored.result, disposition: "already-created" });
    }
    const active = this.pending.get(input.clientRequestId);
    if (active) return active;
    const operation = restored || {
      clientRequestId: input.clientRequestId,
      fingerprint,
      sourceSessionId,
      input: normalized,
      stage: "validated" as const,
    };
    this.operations.set(input.clientRequestId, operation);
    this.persist();
    const promise = this.perform(operation).finally(() => {
      if (this.pending.get(input.clientRequestId) === promise) this.pending.delete(input.clientRequestId);
    });
    this.pending.set(input.clientRequestId, promise);
    return promise;
  }

  private async perform(operation: ForkOperation) {
    const source = this.options.registry.get(operation.sourceSessionId);
    if (!source) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "Fork source AI session was not found.", 404);
    if (!source.providerSessionId || source.actions?.fork !== true) {
      throw aiSessionControlError("AI_SESSION_FORK_UNSUPPORTED", "Fork source does not expose a verified provider capability.", 409);
    }
    if (!source.cwd) throw aiSessionControlError("AI_SESSION_FORK_SOURCE_INVALID", "Fork source has no working directory.", 409);
    if (operation.input.workspace.mode === "managed-worktree" && operation.input.throughTurnId) {
      throw aiSessionControlError("AI_SESSION_FORK_WORKTREE_UNAVAILABLE", "A historical-turn Fork cannot prepare a managed worktree.", 409);
    }
    await this.options.ensureProvider?.(source.agent);

    try {
      if (!operation.cwd) {
        if (operation.input.workspace.mode === "managed-worktree") {
          if (!this.options.prepareManagedWorktree) {
            throw aiSessionControlError("AI_SESSION_FORK_WORKTREE_UNAVAILABLE", "Managed worktree Fork is unavailable.", 409);
          }
          const prepared = await this.options.prepareManagedWorktree(source, operation.clientRequestId);
          operation.cwd = prepared.cwd;
          operation.worktreeId = prepared.worktreeId;
        } else {
          operation.cwd = source.cwd;
        }
        operation.stage = "workspace-prepared";
        this.persist();
      }

      if (operation.input.workspace.mode === "managed-worktree") {
        if (!operation.worktreeId || !this.options.validateManagedWorktree) {
          throw aiSessionControlError("AI_SESSION_FORK_WORKTREE_UNAVAILABLE", "Managed Fork worktree validation is unavailable.", 409);
        }
        if (!await this.options.validateManagedWorktree(source, operation.worktreeId, operation.cwd)) {
          throw aiSessionControlError("AI_SESSION_FORK_WORKTREE_UNAVAILABLE", "Managed Fork worktree changed before the provider session was created.", 409);
        }
      }

      if (!operation.providerSessionId) {
        const created = await this.options.controller.forkSession(source.id, {
          throughTurnId: operation.input.throughTurnId,
          ...(operation.input.workspace.mode === "managed-worktree" ? { cwd: operation.cwd } : {}),
        });
        operation.providerSessionId = created.providerSessionId;
        operation.stage = "provider-created";
        this.persist();
      }

      let session = this.options.registry.getByProviderSessionId(source.agent, operation.providerSessionId);
      if (!session) {
        await this.options.controller.provider(source.agent).readSession?.(operation.providerSessionId);
        session = await this.waitForSession(source.agent, operation.providerSessionId);
      }
      if (!session) {
        throw aiSessionControlError("AI_SESSION_FORK_PROJECTION_FAILED", "Forked provider session was not projected.", 502);
      }
      if (session.creationSource !== "ai-session" || session.appSessionId || session.providerSessionId === source.providerSessionId) {
        throw aiSessionControlError("AI_SESSION_FORK_INVALID_RESPONSE", "Fork did not materialize as an independent Direct AI Session.", 502);
      }
      if (source.cwdFolderId && session.cwdFolderId !== source.cwdFolderId) {
        session = this.options.registry.patch(session.id, { cwdFolderId: source.cwdFolderId });
      }
      if (source.storyId && session.storyId !== source.storyId) {
        session = this.options.registry.patch(session.id, { storyId: source.storyId });
      }
      operation.aiSessionId = session.id;
      operation.stage = "materialized";
      this.persist();

      const result = AiSessionForkResultSchema.parse({
        disposition: "created",
        aiSessionId: session.id,
        providerSessionId: operation.providerSessionId,
        creationSource: "ai-session",
      });
      operation.result = result;
      operation.stage = "completed";
      this.persist();
      return result;
    } catch (error) {
      await this.compensate(operation, source, error);
      throw error;
    }
  }

  private async waitForSession(agent: string, providerSessionId: string) {
    const deadline = Date.now() + (this.options.materializationTimeoutMs ?? 5_000);
    do {
      const session = this.options.registry.getByProviderSessionId(agent, providerSessionId);
      if (session) return session;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return undefined;
  }

  private async compensate(operation: ForkOperation, source: AiSessionStatus, error: unknown) {
    const failures: string[] = [];
    if (operation.providerSessionId) {
      const provider = this.options.controller.provider(source.agent);
      try {
        if (provider.deleteSession) await provider.deleteSession(operation.providerSessionId);
        else await provider.archiveSession?.(operation.providerSessionId);
      } catch (cleanupError) { failures.push(String(cleanupError)); }
      const projected = this.options.registry.getByProviderSessionId(source.agent, operation.providerSessionId);
      if (projected) this.options.registry.discard(projected.id);
    }
    if (operation.worktreeId && this.options.removeManagedWorktree) {
      try {
        if (!await this.options.removeManagedWorktree(source, operation.worktreeId)) failures.push("managed worktree retained");
      } catch (cleanupError) { failures.push(String(cleanupError)); }
    }
    this.operations.delete(operation.clientRequestId);
    this.persist();
    this.options.onDiagnostic?.({
      code: "AI_SESSION_FORK_COMPENSATED",
      clientRequestId: operation.clientRequestId,
      providerSessionId: operation.providerSessionId,
      worktreeId: operation.worktreeId,
      error: error instanceof Error ? error.message : String(error),
      cleanupFailures: failures,
    });
  }

  private restore() {
    const storePath = this.options.operationStorePath;
    if (!storePath || !fs.existsSync(storePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.operations)) {
        throw new Error("Unsupported AI Session Fork operation store schema.");
      }
      for (const value of parsed.operations) {
        const operation = sanitizeForkOperation(value);
        if (!operation) {
          this.options.onDiagnostic?.({ code: "AI_SESSION_FORK_STORE_RECORD_INVALID" });
          continue;
        }
        this.operations.set(operation.clientRequestId, operation);
      }
    } catch (error) {
      this.options.onDiagnostic?.({ code: "AI_SESSION_FORK_STORE_INVALID", error: String(error) });
    }
  }

  private persist() {
    const storePath = this.options.operationStorePath;
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const temporaryPath = `${storePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, operations: [...this.operations.values()] }, null, 2));
      fs.renameSync(temporaryPath, storePath);
    } catch (error) {
      this.options.onDiagnostic?.({ code: "AI_SESSION_FORK_STORE_WRITE_FAILED", error: String(error) });
    }
  }
}

function forkFingerprint(value: unknown) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sanitizeForkOperation(value: unknown): ForkOperation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const clientRequestId = boundedString(record.clientRequestId, 160);
  const sourceSessionId = boundedString(record.sourceSessionId, 120);
  const fingerprint = typeof record.fingerprint === "string" && /^[a-f0-9]{64}$/.test(record.fingerprint)
    ? record.fingerprint
    : undefined;
  const input = AiSessionForkInputSchema.safeParse(record.input);
  if (!clientRequestId || !sourceSessionId || !fingerprint || !input.success || clientRequestId !== input.data.clientRequestId) return undefined;
  if (fingerprint !== forkFingerprint({ sourceSessionId, ...input.data })) return undefined;

  const stage = isForkStage(record.stage) ? record.stage : undefined;
  const cwd = boundedString(record.cwd, 4096);
  const worktreeId = boundedString(record.worktreeId, 240);
  const providerSessionId = boundedString(record.providerSessionId, 240);
  const aiSessionId = boundedString(record.aiSessionId, 120);
  const result = record.result === undefined ? undefined : AiSessionForkResultSchema.safeParse(record.result);
  if (!stage || result && !result.success) return undefined;
  if (stage === "validated" && (cwd || worktreeId || providerSessionId || aiSessionId || result?.success)) return undefined;
  if (stage !== "validated" && (!cwd || !path.isAbsolute(cwd))) return undefined;
  if (input.data.workspace.mode === "managed-worktree" && stage !== "validated" && !worktreeId) return undefined;
  if (input.data.workspace.mode === "current" && worktreeId) return undefined;
  if (["provider-created", "materialized", "completed"].includes(stage) && !providerSessionId) return undefined;
  if (["workspace-prepared"].includes(stage) && (providerSessionId || aiSessionId || result?.success)) return undefined;
  if (["materialized", "completed"].includes(stage) && !aiSessionId) return undefined;
  if (stage === "provider-created" && (aiSessionId || result?.success)) return undefined;
  if (stage === "completed") {
    if (!result?.success || result.data.aiSessionId !== aiSessionId || result.data.providerSessionId !== providerSessionId) return undefined;
  } else if (result?.success) {
    return undefined;
  }

  return {
    clientRequestId: input.data.clientRequestId,
    fingerprint,
    sourceSessionId,
    input: input.data,
    stage,
    ...(cwd ? { cwd } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(aiSessionId ? { aiSessionId } : {}),
    ...(result?.success ? { result: result.data } : {}),
  };
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function isForkStage(value: unknown): value is ForkStage {
  return ["validated", "workspace-prepared", "provider-created", "materialized", "completed"].includes(String(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
