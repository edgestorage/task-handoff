import {
  ControlledInstanceSchema,
  GitProvisioningTerminalEventType,
  type ControlledInstance,
} from "@task-handoff/protocol/control-plane";
import type { ExecutorContext } from "../runtimes/docker.ts";
import { gitWorkspaceProvisioningErrorCode } from "../runtimes/docker.ts";
import { GitProvisioningTerminalParser, redactGitUrlCredentials, type GitProvisioningStage } from "@task-handoff/protocol/workspace-git";
import { nowIso as now } from "@task-handoff/core/core/time";

type Diagnostic = (data: Record<string, unknown>, message: string) => void;

export type GitProvisioningRunOptions = {
  onOutput: (data: string) => void;
  signal?: AbortSignal;
};

type GitProvisioningState = {
  get(id: string): ControlledInstance | undefined;
  put(instance: ControlledInstance): ControlledInstance;
};

type Options = {
  context(instance: ControlledInstance): ExecutorContext;
  run(context: ExecutorContext, options: GitProvisioningRunOptions): Promise<unknown>;
  sync(): void;
  diagnostic: Diagnostic;
  warn: Diagnostic;
  publish(type: string, payload: Record<string, unknown>, instanceId: string): void;
  runInstanceOperation?<T>(instanceId: string, operation: () => Promise<T>): Promise<T>;
};

const MAX_TERMINAL_CHUNK = 60_000;
const MAX_REASON_CHARS = 500;

const GIT_PROVISIONING_FAILURE_LABELS: Record<string, string> = {
  GIT_WORKSPACE_PROVISIONING_TIMEOUT: "Git workspace provisioning timed out",
  GIT_WORKSPACE_PROVISIONING_CANCELLED: "Git workspace provisioning was cancelled",
  GIT_WORKSPACE_PROVISIONING_CLONE_FAILED: "Git clone failed",
  GIT_WORKSPACE_PROVISIONING_AUTHENTICATION_REJECTED: "Git authentication rejected",
  GIT_WORKSPACE_PROVISIONING_CREDENTIAL_AMBIGUOUS: "Git credential is ambiguous",
  GIT_WORKSPACE_PROVISIONING_CREDENTIAL_MISSING: "Git credential is missing",
  GIT_WORKSPACE_PROVISIONING_HOST_KEY_REQUIRED: "Git host key is not pinned",
  GIT_WORKSPACE_PROVISIONING_LFS_FAILED: "Git LFS pull failed",
  GIT_WORKSPACE_PROVISIONING_REF_NOT_FOUND: "Git ref was not found",
  GIT_WORKSPACE_PROVISIONING_REMOTE_UNSUPPORTED: "Git remote is not supported",
  GIT_WORKSPACE_PROVISIONING_SSH_AGENT_UNAVAILABLE: "Git SSH agent is unavailable",
  GIT_WORKSPACE_PROVISIONING_SUBDIRECTORY_NOT_FOUND: "Git subdirectory was not found",
  GIT_WORKSPACE_PROVISIONING_WORKSPACE_NOT_EMPTY: "Workspace is not empty",
  GIT_WORKSPACE_PROVISIONING_WORKSPACE_OWNERSHIP_MISMATCH: "Workspace belongs to another instance",
  GIT_CREDENTIAL_MISSING: "Git credential is missing",
  GIT_CREDENTIAL_AMBIGUOUS: "Git credential is ambiguous",
  GIT_CREDENTIAL_MISSING_HOST_KEY: "Git host key is not pinned",
};

function errorCodeOf(error: unknown) {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * The Docker executor already resolves clone/credential failures into protocol
 * codes, and its message deliberately omits the provisioning marker. Trust that
 * code and only fall back to re-deriving it from raw runner output.
 */
function gitProvisioningErrorCode(error: unknown) {
  const code = errorCodeOf(error);
  if (code?.startsWith("GIT_WORKSPACE_PROVISIONING_") || code?.startsWith("GIT_CREDENTIAL_")) return code;
  return gitWorkspaceProvisioningErrorCode(error);
}

export function gitProvisioningFailureMessage(code: string, detail?: string) {
  const label = GIT_PROVISIONING_FAILURE_LABELS[code] || "Git workspace provisioning failed";
  const reason = detail ? redactGitUrlCredentials(detail).slice(0, MAX_REASON_CHARS) : undefined;
  return reason ? `${label}: ${reason}` : label;
}

/**
 * Materializes Git workspace volumes outside the instance start request so the
 * create/start API returns immediately while the clone keeps reporting progress
 * and failures exactly like image provisioning does.
 */
export class InstanceGitWorkspaceProvisioningController {
  private readonly state: GitProvisioningState;
  private readonly options: Options;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortController = new AbortController();
  private stopped = false;

  constructor(state: GitProvisioningState, options: Options) {
    this.state = state;
    this.options = options;
  }

  provision(instance: ControlledInstance, onReadyToStart?: () => Promise<void>) {
    if (this.stopped) return Promise.resolve();
    const generation = instance.workspace.gitProvisioning?.generation;
    if (generation === undefined) return Promise.resolve();
    const key = `${instance.id}:${generation}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.provisionGeneration(instance, generation, onReadyToStart).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  retry(id: string) {
    const current = this.state.get(id);
    if (!current) {
      throw Object.assign(new Error(`Instance ${id} was not found.`), { statusCode: 404, code: "NODE_INSTANCE_NOT_FOUND" });
    }
    const provisioning = current.workspace.gitProvisioning;
    if (!provisioning || provisioning.phase !== "failed") {
      throw Object.assign(new Error(`Instance ${id} does not have failed Git provisioning to retry.`), {
        statusCode: 409,
        code: "INSTANCE_GIT_PROVISIONING_NOT_FAILED",
      });
    }
    const timestamp = now();
    return this.state.put(ControlledInstanceSchema.parse({
      ...current,
      status: "starting",
      health: "unknown",
      ready: false,
      workspace: {
        ...current.workspace,
        status: "pending",
        error: undefined,
        gitProvisioning: { ...provisioning, phase: "pending", error: undefined, generation: provisioning.generation + 1, updatedAt: timestamp },
      },
      updatedAt: timestamp,
    }));
  }

  async stop() {
    this.stopped = true;
    this.abortController.abort();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private async provisionGeneration(instance: ControlledInstance, generation: number, onReadyToStart?: () => Promise<void>) {
    const initial = this.currentGeneration(instance.id, generation);
    if (!initial) return;
    const parser = new GitProvisioningTerminalParser();
    let sequence = 0;
    let resolvedCommit: string | undefined;
    let phaseUpdates = Promise.resolve();
    const recordStage = (stage: GitProvisioningStage) => {
      phaseUpdates = phaseUpdates.then(() => this.updatePhase(initial.id, generation, stage));
    };
    const publishOutput = (data: string) => {
      if (!data) return;
      for (const [index, chunk] of splitTerminalChunks(data).entries()) {
        this.options.publish(GitProvisioningTerminalEventType.Output, {
          ...this.eventBase(initial, generation),
          sequence: (sequence += 1) * 1000 + index,
          data: chunk,
        }, initial.id);
      }
    };
    try {
      await this.updatePhase(initial.id, generation, "cloning");
      const context = this.options.context(initial);
      await this.options.run(context, {
        signal: this.abortController.signal,
        onOutput: (data) => {
          const parsed = parser.push(data);
          if (parsed.stage) recordStage(parsed.stage);
          if (parsed.commit) resolvedCommit = parsed.commit;
          // The raw stream is the wire contract: the control plane strips the
          // marker lines with the same shared parser before displaying them.
          publishOutput(data);
        },
      });
      await phaseUpdates;
      if (this.stopped) return;
      this.publishFinished(initial, generation, ++sequence, "succeeded");
      await this.commitReady(initial, generation, resolvedCommit, onReadyToStart);
    } catch (error) {
      parser.flush();
      await phaseUpdates;
      if (this.stopped) return;
      // Credential resolution failures happen before the provisioning container
      // starts and already carry their own protocol error code.
      const code = gitProvisioningErrorCode(error);
      // Failures that happen before any clone output (credentials, managed
      // volumes) only exist on the error itself, so keep their reason visible.
      const message = gitProvisioningFailureMessage(code, parser.failureDetail() ?? (error instanceof Error ? error.message : undefined));
      this.publishFinished(initial, generation, ++sequence, "failed");
      await this.commitFailure(initial.id, generation, message, code);
    }
  }

  private currentGeneration(id: string, generation: number) {
    const current = this.state.get(id);
    if (!current || current.workspace.gitProvisioning?.generation !== generation) return undefined;
    return current;
  }

  private async updatePhase(id: string, generation: number, phase: GitProvisioningStage) {
    if (this.stopped) return;
    await this.runOperation(id, async () => {
      if (this.stopped) return;
      const current = this.currentGeneration(id, generation);
      if (!current || !["provisioning", "starting"].includes(current.status)) return;
      const provisioning = current.workspace.gitProvisioning!;
      if (provisioning.phase === phase) return;
      this.state.put(ControlledInstanceSchema.parse({
        ...current,
        workspace: { ...current.workspace, gitProvisioning: { ...provisioning, phase, updatedAt: now() } },
        updatedAt: now(),
      }));
      this.options.sync();
    });
  }

  private async commitReady(
    instance: ControlledInstance,
    generation: number,
    resolvedCommit: string | undefined,
    onReadyToStart?: () => Promise<void>,
  ) {
    const ready = await this.runOperation(instance.id, async () => {
      if (this.stopped) return undefined;
      const current = this.currentGeneration(instance.id, generation);
      if (!current) return undefined;
      const provisioning = current.workspace.gitProvisioning!;
      return this.state.put(ControlledInstanceSchema.parse({
        ...current,
        workspace: {
          ...current.workspace,
          mode: "git-clone",
          status: "ready",
          error: undefined,
          resolvedCommit: resolvedCommit || current.workspace.resolvedCommit,
          gitProvisioning: { ...provisioning, phase: "ready", error: undefined, updatedAt: now() },
        },
        updatedAt: now(),
      }));
    });
    if (!ready) return;
    this.options.sync();
    this.options.diagnostic({
      instanceId: instance.id,
      action: "git.provision",
      remoteUrl: ready.workspace.gitProvisioning?.remoteUrl,
      resolvedCommit: ready.workspace.resolvedCommit,
    }, "node instance git workspace provisioning completed");
    if (ready.status === "starting") await onReadyToStart?.();
  }

  private async commitFailure(id: string, generation: number, message: string, code: string) {
    await this.runOperation(id, async () => {
      if (this.stopped) return;
      const current = this.currentGeneration(id, generation);
      if (!current || !["provisioning", "starting"].includes(current.status)) return;
      const provisioning = current.workspace.gitProvisioning!;
      this.state.put(ControlledInstanceSchema.parse({
        ...current,
        status: "failed",
        health: "failed",
        ready: false,
        workspace: {
          ...current.workspace,
          status: "failed",
          error: message,
          gitProvisioning: { ...provisioning, phase: "failed", error: message, updatedAt: now() },
        },
        updatedAt: now(),
      }));
      this.options.sync();
      this.options.warn({
        instanceId: id,
        action: "git.provision",
        remoteUrl: provisioning.remoteUrl,
        error: message,
        code,
      }, "node instance git workspace provisioning failed");
    });
  }

  private runOperation<T>(instanceId: string, operation: () => Promise<T>) {
    return this.options.runInstanceOperation?.(instanceId, operation) ?? operation();
  }

  private eventBase(instance: ControlledInstance, generation: number) {
    return {
      instanceId: instance.id,
      generation,
      // The controller only governs instances that carry Git provisioning state.
      remoteUrl: instance.workspace.gitProvisioning!.remoteUrl,
      observedAt: now(),
    };
  }

  private publishFinished(instance: ControlledInstance, generation: number, sequence: number, outcome: "succeeded" | "failed") {
    this.options.publish(GitProvisioningTerminalEventType.Finished, {
      ...this.eventBase(instance, generation),
      sequence: sequence * 1000,
      outcome,
    }, instance.id);
  }
}

function splitTerminalChunks(data: string, maxLength = MAX_TERMINAL_CHUNK) {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += maxLength) chunks.push(data.slice(offset, offset + maxLength));
  return chunks;
}
