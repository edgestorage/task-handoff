import path from "node:path";
import { AgentRunIdSchema } from "@task-handoff/protocol/agent-runs";
import type { AgentRunResourceRepository, AgentRunSharedSpaceRecord } from "../persistence/agent-run-resource-repository.ts";

export const AGENT_RUN_SHARED_SPACE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const AGENT_RUN_SHARED_SPACE_DEFAULT_RUN_QUOTA_BYTES = 1024 * 1024 * 1024;
export const AGENT_RUN_SHARED_SPACE_DEFAULT_RUNTIME_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export type AgentRunSharedSpaceBinding = {
  runId: string;
  runtimeId: string;
  runtimePath: string;
};

export type AgentRunMemberPathPolicy = {
  cwd: string;
  writableRoots: readonly [string, string];
};

export type AgentRunSharedSpaceBackend = {
  ensureRunDirectory(input: { runId: string; generationId: string; runtimeId: string; instanceId: string; runtimePath: string }): Promise<Record<string, unknown>>;
  removeRunDirectory?(input: { runId: string; generationId: string; runtimeId: string; instanceId: string; runtimePath: string }): Promise<Record<string, unknown>>;
  inspectRunDirectory?(input: { runId: string; generationId: string; runtimeId: string; instanceId: string; runtimePath: string }): Promise<{ usageBytes: number }>;
};

export function agentRunSharedSpaceBinding(runId: string, runtimeId: string, root: string): AgentRunSharedSpaceBinding {
  const id = AgentRunIdSchema.parse(runId);
  const normalizedRoot = path.posix.resolve("/", root);
  return { runId: id, runtimeId, runtimePath: path.posix.join(normalizedRoot, id) };
}

export function assertAgentRunSharedSpacePath(binding: AgentRunSharedSpaceBinding, candidate: string) {
  if (!path.posix.isAbsolute(candidate)) {
    throw Object.assign(new Error("Agent Run shared-space paths must be absolute runtime paths."), {
      code: "AGENT_RUN_SHARED_PATH_INVALID", statusCode: 400,
    });
  }
  const normalized = path.posix.resolve(candidate);
  if (normalized === binding.runtimePath || normalized.startsWith(`${binding.runtimePath}/`)) return normalized;
  throw Object.assign(new Error("The requested path is outside this Agent Run shared space."), {
    code: "AGENT_RUN_SHARED_PATH_OUTSIDE_RUN", statusCode: 403,
    details: { runId: binding.runId },
  });
}

/** Every member receives the same run-level artifact root; no member-specific subdirectory is introduced. */
export function agentRunMemberPathPolicy(binding: AgentRunSharedSpaceBinding, workspaceCwd: string): AgentRunMemberPathPolicy {
  if (!path.posix.isAbsolute(workspaceCwd)) {
    throw Object.assign(new Error("The Agent Run workspace cwd must be an absolute runtime path."), {
      code: "AGENT_RUN_WORKSPACE_PATH_INVALID", statusCode: 400,
    });
  }
  return {
    cwd: path.posix.resolve(workspaceCwd),
    writableRoots: [path.posix.resolve(workspaceCwd), binding.runtimePath],
  };
}

export function assertAgentRunSharedRuntime(space: AgentRunSharedSpaceRecord, runtimeId: string) {
  if (space.runtimeId === runtimeId) return;
  throw Object.assign(new Error("The member runtime cannot access this Agent Run shared space."), {
    code: "AGENT_RUN_SHARED_RUNTIME_MISMATCH", statusCode: 409,
    details: { runId: space.runId, sharedRuntimeId: space.runtimeId, memberRuntimeId: runtimeId },
  });
}

export class AgentRunSharedSpaceService {
  private readonly repository: AgentRunResourceRepository;
  private readonly backend: AgentRunSharedSpaceBackend;
  private readonly root: string;

  constructor(
    repository: AgentRunResourceRepository,
    backend: AgentRunSharedSpaceBackend,
    root: string,
  ) {
    this.repository = repository;
    this.backend = backend;
    this.root = root;
  }

  async ensure(input: { runId: string; runtimeId: string; instanceId: string; generationId: string; timestamp?: string }) {
    const runtimeUsage = this.repository.runtimeSharedSpaceUsage(input.runtimeId, input.runId);
    if (runtimeUsage >= AGENT_RUN_SHARED_SPACE_DEFAULT_RUNTIME_QUOTA_BYTES) {
      throw Object.assign(new Error("The Agent Run runtime shared-space quota is exhausted."), {
        code: "AGENT_RUN_SHARED_RUNTIME_QUOTA_EXCEEDED",
        statusCode: 409,
        details: { runtimeId: input.runtimeId, usageBytes: runtimeUsage, quotaBytes: AGENT_RUN_SHARED_SPACE_DEFAULT_RUNTIME_QUOTA_BYTES },
      });
    }
    const space = this.repository.ensureSharedSpace({
      ...input,
      quotaBytes: AGENT_RUN_SHARED_SPACE_DEFAULT_RUN_QUOTA_BYTES,
    });
    const binding = agentRunSharedSpaceBinding(input.runId, input.runtimeId, this.root);
    try {
      const diagnostics = await this.backend.ensureRunDirectory({ ...input, runtimePath: binding.runtimePath });
      const active = this.repository.updateSharedSpace(input.runId, { state: "active", diagnostics, timestamp: input.timestamp });
      this.repository.register({
        runId: input.runId,
        instanceId: input.instanceId,
        runtimeId: input.runtimeId,
        kind: "shared-space-directory",
        generationId: input.generationId,
        backendIdentity: binding.runtimePath,
        metadata: { runtimePath: binding.runtimePath },
        timestamp: input.timestamp,
      });
      return { space: active, binding };
    } catch (cause) {
      this.repository.updateSharedSpace(input.runId, {
        state: "delete-retrying",
        diagnostics: { code: "AGENT_RUN_SHARED_SPACE_PREPARE_FAILED", message: cause instanceof Error ? cause.message : String(cause) },
        timestamp: input.timestamp,
      });
      throw Object.assign(new Error("Could not prepare the Agent Run shared space.", { cause }), {
        code: "AGENT_RUN_SHARED_SPACE_PREPARE_FAILED", statusCode: 409,
      });
    }
  }

  bindingForMember(runId: string, memberRuntimeId: string) {
    const space = this.repository.getSharedSpace(runId);
    if (!space) throw Object.assign(new Error("The Agent Run shared space was not found."), { code: "AGENT_RUN_SHARED_SPACE_NOT_FOUND", statusCode: 404 });
    assertAgentRunSharedRuntime(space, memberRuntimeId);
    return agentRunSharedSpaceBinding(runId, memberRuntimeId, this.root);
  }

  pathPolicyForMember(runId: string, memberRuntimeId: string, workspaceCwd: string) {
    return agentRunMemberPathPolicy(this.bindingForMember(runId, memberRuntimeId), workspaceCwd);
  }

  retain(runId: string, timestamp = new Date()) {
    const expiresAt = new Date(timestamp.getTime() + AGENT_RUN_SHARED_SPACE_TTL_MS).toISOString();
    return this.repository.updateSharedSpace(runId, {
      state: "retained",
      expiresAt,
      timestamp: timestamp.toISOString(),
    });
  }

  async refreshUsage(runId: string, instanceId: string, timestamp = new Date()) {
    const space = this.repository.getSharedSpace(runId);
    if (!space) throw Object.assign(new Error("The Agent Run shared space was not found."), { code: "AGENT_RUN_SHARED_SPACE_NOT_FOUND", statusCode: 404 });
    if (!this.backend.inspectRunDirectory) {
      throw Object.assign(new Error("The shared-space backend cannot report usage."), { code: "AGENT_RUN_SHARED_USAGE_UNAVAILABLE", statusCode: 409 });
    }
    const binding = agentRunSharedSpaceBinding(runId, space.runtimeId, this.root);
    const measured = await this.backend.inspectRunDirectory({
      runId,
      generationId: space.generationId,
      runtimeId: space.runtimeId,
      instanceId,
      runtimePath: binding.runtimePath,
    });
    const runtimeUsage = this.repository.runtimeSharedSpaceUsage(space.runtimeId, runId) + measured.usageBytes;
    const diagnostics = {
      ...space.diagnostics,
      usageBytes: measured.usageBytes,
      runQuotaBytes: space.quotaBytes,
      runtimeUsageBytes: runtimeUsage,
      runtimeQuotaBytes: AGENT_RUN_SHARED_SPACE_DEFAULT_RUNTIME_QUOTA_BYTES,
      measuredAt: timestamp.toISOString(),
    };
    this.repository.updateSharedSpace(runId, { usageBytes: measured.usageBytes, diagnostics, timestamp: timestamp.toISOString() });
    if (measured.usageBytes > space.quotaBytes) {
      throw Object.assign(new Error("The Agent Run shared-space quota is exhausted."), {
        code: "AGENT_RUN_SHARED_RUN_QUOTA_EXCEEDED", statusCode: 409,
        details: { runId, usageBytes: measured.usageBytes, quotaBytes: space.quotaBytes },
      });
    }
    if (runtimeUsage > AGENT_RUN_SHARED_SPACE_DEFAULT_RUNTIME_QUOTA_BYTES) {
      throw Object.assign(new Error("The Agent Run runtime shared-space quota is exhausted."), {
        code: "AGENT_RUN_SHARED_RUNTIME_QUOTA_EXCEEDED", statusCode: 409,
        details: { runtimeId: space.runtimeId, usageBytes: runtimeUsage, quotaBytes: AGENT_RUN_SHARED_SPACE_DEFAULT_RUNTIME_QUOTA_BYTES },
      });
    }
    return this.repository.getSharedSpace(runId)!;
  }

  async reconcileExpired(now = new Date()) {
    const expired = this.repository.listSharedSpaces({ expiredBefore: now.toISOString() });
    const results: Array<{ runId: string; status: "expired" | "retrying" | "manual-intervention" }> = [];
    for (const space of expired) {
      if (space.state !== "retained" && space.state !== "delete-retrying") continue;
      const resource = this.repository.listForRun(space.runId).find((item) => item.kind === "shared-space-directory");
      if (!resource || !resource.instanceId) {
        this.repository.updateSharedSpace(space.runId, { state: "manual-intervention", diagnostics: { code: "AGENT_RUN_SHARED_SPACE_OWNERSHIP_UNPROVEN" }, timestamp: now.toISOString() });
        results.push({ runId: space.runId, status: "manual-intervention" });
        continue;
      }
      this.repository.updateSharedSpace(space.runId, { state: "expiring", timestamp: now.toISOString() });
      try {
        if (!this.backend.removeRunDirectory) throw Object.assign(new Error("Shared-space backend does not support expiry cleanup."), { code: "AGENT_RUN_SHARED_SPACE_CLEANUP_UNSUPPORTED" });
        await this.backend.removeRunDirectory({ runId: space.runId, generationId: resource.generationId, runtimeId: space.runtimeId, instanceId: resource.instanceId, runtimePath: String(resource.metadata.runtimePath ?? resource.backendIdentity) });
        this.repository.updateSharedSpace(space.runId, { state: "expired", usageBytes: 0, timestamp: now.toISOString() });
        this.repository.transition(resource.resourceId, "deleted", { timestamp: now.toISOString() });
        results.push({ runId: space.runId, status: "expired" });
      } catch (cause) {
        this.repository.updateSharedSpace(space.runId, { state: "delete-retrying", diagnostics: { code: "AGENT_RUN_SHARED_SPACE_CLEANUP_FAILED", message: cause instanceof Error ? cause.message : String(cause) }, timestamp: now.toISOString() });
        this.repository.transition(resource.resourceId, "delete-retrying", { incrementCleanupAttempts: true, timestamp: now.toISOString() });
        results.push({ runId: space.runId, status: "retrying" });
      }
    }
    return results;
  }
}
