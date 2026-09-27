import path from "node:path";
import type { CommandRunner } from "../runtimes/docker.ts";
import {
  DOCKER_AGENT_RUN_OVERLAY_ROOT,
  DOCKER_AGENT_RUN_ROOT,
  DOCKER_AGENT_RUN_SHARED_ROOT,
  agentRunRuntimeVolume,
} from "../runtimes/docker.ts";
import type { AgentRunResourceRepository, AgentRunResourceRecord } from "../persistence/agent-run-resource-repository.ts";
import {
  agentRunWorkspaceLayout,
  assertAgentRunWorkspacePath,
  createAgentRunWorkspaceMarker,
  workspaceMarkerMatches,
  type AgentRunWorkspaceMarker,
  type PreparedAgentRunWorkspace,
  type WorkspaceMaterializer,
  type WorkspaceMaterializerPrepareInput,
  type WorkspaceOwnership,
} from "./workspace-materializer.ts";

export const AGENT_RUN_OVERLAY_HELPER_IMAGE = "ghcr.io/edgestorage/task-handoff-agent-run-overlay-helper:1";
const HelperCapabilities = ["SYS_ADMIN", "SYS_PTRACE", "SYS_CHROOT", "DAC_OVERRIDE", "CHOWN"] as const;

type DockerMount = { Type?: unknown; Name?: unknown; Destination?: unknown };
type DockerContainerInspection = {
  Id?: unknown;
  State?: { Running?: unknown };
  Config?: { User?: unknown; Labels?: unknown };
  Mounts?: DockerMount[];
};

export type DockerAgentRunTarget = {
  nodeId: string;
  runtimeId: string;
  instanceId: string;
  containerName: string;
  expectedContainerId?: string;
  providerReady: boolean;
};

export type PreparedDockerAgentRunWorkspace = PreparedAgentRunWorkspace & {
  target: DockerAgentRunTarget;
  resourceId: string;
  upperPath: string;
  workPath: string;
  sharedPath: string;
  marker: AgentRunWorkspaceMarker;
};

function storageError(code: string, message: string, cause?: unknown, details?: Record<string, unknown>) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, statusCode: 409, ...(details ? { details } : {}) });
}

export class DockerAgentRunStorage implements WorkspaceMaterializer<PreparedDockerAgentRunWorkspace> {
  readonly kind = "overlay-copy-on-write" as const;
  private readonly runCommand: CommandRunner;
  private readonly resources: AgentRunResourceRepository;
  private readonly targetForInstance: (instanceId: string) => DockerAgentRunTarget;
  private readonly terminateMemberThread: (runId: string, memberId: string) => Promise<void>;
  private readonly helperImage: string;

  constructor(
    runCommand: CommandRunner,
    resources: AgentRunResourceRepository,
    targetForInstance: (instanceId: string) => DockerAgentRunTarget,
    terminateMemberThread: (runId: string, memberId: string) => Promise<void> = async () => {},
    helperImage = AGENT_RUN_OVERLAY_HELPER_IMAGE,
  ) {
    this.runCommand = runCommand;
    this.resources = resources;
    this.targetForInstance = targetForInstance;
    this.terminateMemberThread = terminateMemberThread;
    this.helperImage = helperImage;
  }

  async prepare(input: WorkspaceMaterializerPrepareInput): Promise<PreparedDockerAgentRunWorkspace> {
    if (input.executionSnapshot.executionPolicy.workspaceMaterializer !== "overlay-copy-on-write"
      || input.executionSnapshot.executionPolicy.processSandbox !== "instance") {
      throw storageError("AGENT_RUN_MATERIALIZER_UNAVAILABLE", "The requested execution policy has no Docker instance materializer.");
    }
    const target = this.targetForInstance(input.instanceId);
    if (target.runtimeId !== input.runtimeId) {
      throw storageError("AGENT_RUN_RUNTIME_MISMATCH", "The target instance no longer belongs to the frozen runtime.");
    }
    const container = await this.requireReadyContainer(target);
    const layout = agentRunWorkspaceLayout(input.runId, input.memberId);
    const overlayRunRoot = path.posix.join(DOCKER_AGENT_RUN_OVERLAY_ROOT, input.runId, input.memberId);
    const upperPath = path.posix.join(overlayRunRoot, "upper");
    const workPath = path.posix.join(overlayRunRoot, "work");
    const sharedPath = path.posix.join(DOCKER_AGENT_RUN_SHARED_ROOT, input.runId);
    this.assertStorageBoundaries(input.sourceRuntimePath, { upperPath, workPath, sharedPath, mergedPath: layout.cwd });
    const marker = createAgentRunWorkspaceMarker(input);
    const backendIdentity = `${String(container.Id)}:${layout.cwd}`;
    const resource = this.resources.register({
      runId: input.runId,
      memberId: input.memberId,
      instanceId: input.instanceId,
      runtimeId: input.runtimeId,
      kind: "overlay-mount",
      generationId: input.generationId,
      backendIdentity,
      metadata: { containerId: container.Id, mergedPath: layout.cwd, upperPath, workPath, sourceRuntimePath: input.sourceRuntimePath },
    });
    const prepared: PreparedDockerAgentRunWorkspace = {
      materializer: this.kind,
      generationId: input.generationId,
      layout,
      backendIdentity,
      diagnostics: {
        isolation: "instance",
        sharesContainerUserNetworkAndCredentials: true,
        sourceWritesDeniedBy: "provider-thread-write-roots",
        crossRunWritesDeniedBy: "provider-thread-write-roots-and-node-path-validation",
      },
      target,
      resourceId: resource.resourceId,
      upperPath,
      workPath,
      sharedPath,
      marker,
    };
    try {
      this.appendInjectionAudit(resource.resourceId, {
        requestedAt: new Date().toISOString(),
        result: "pending",
        helperImage: this.helperImage,
        capabilities: [...HelperCapabilities],
        targetContainerId: String(container.Id),
      });
      await this.runHelper(target, input.runId, input.memberId, input.generationId, [
        "inject", "--lower", input.sourceRuntimePath, "--upper", upperPath, "--work", workPath,
        "--merged", layout.cwd, "--shared", sharedPath, "--marker", JSON.stringify(marker),
      ]);
      this.finishInjectionAudit(resource.resourceId, "completed");
      this.resources.transition(resource.resourceId, "ready");
      return prepared;
    } catch (cause) {
      this.finishInjectionAudit(resource.resourceId, "failed", cause);
      await this.rollbackInjection(prepared, cause);
      throw storageError("AGENT_RUN_OVERLAY_INJECTION_FAILED", "Could not inject the Agent Run overlay workspace.", cause, {
        runId: input.runId, memberId: input.memberId,
      });
    }
  }

  async ensureRunDirectory(input: { runId: string; generationId: string; runtimeId: string; instanceId: string; runtimePath: string }) {
    const target = this.targetForInstance(input.instanceId);
    if (target.runtimeId !== input.runtimeId) throw storageError("AGENT_RUN_SHARED_RUNTIME_MISMATCH", "The target instance is outside the run runtime.");
    await this.requireReadyContainer(target);
    await this.runHelper(target, input.runId, "shared_space", input.generationId, [
      "shared-ensure", "--path", input.runtimePath, "--generation", input.generationId,
    ]);
    return { runtimePath: input.runtimePath, runtimeId: input.runtimeId, volumeRole: "agent-run" };
  }

  /** Probe resources are intentionally not persisted as Run resources; they are synchronously owned and cleaned here. */
  async prepareProbe(input: WorkspaceMaterializerPrepareInput): Promise<PreparedDockerAgentRunWorkspace> {
    const target = this.targetForInstance(input.instanceId);
    if (target.runtimeId !== input.runtimeId) throw storageError("AGENT_RUN_RUNTIME_MISMATCH", "The probe target no longer belongs to the frozen runtime.");
    const container = await this.requireReadyContainer(target);
    const layout = agentRunWorkspaceLayout(input.runId, input.memberId);
    const overlayRunRoot = path.posix.join(DOCKER_AGENT_RUN_OVERLAY_ROOT, input.runId, input.memberId);
    const upperPath = path.posix.join(overlayRunRoot, "upper");
    const workPath = path.posix.join(overlayRunRoot, "work");
    const sharedPath = path.posix.join(DOCKER_AGENT_RUN_SHARED_ROOT, input.runId);
    this.assertStorageBoundaries(input.sourceRuntimePath, { upperPath, workPath, sharedPath, mergedPath: layout.cwd });
    const marker = createAgentRunWorkspaceMarker(input);
    const workspace: PreparedDockerAgentRunWorkspace = {
      materializer: this.kind,
      generationId: input.generationId,
      layout,
      backendIdentity: `${String(container.Id)}:${layout.cwd}`,
      diagnostics: { probe: true },
      target,
      resourceId: `probe:${input.generationId}`,
      upperPath,
      workPath,
      sharedPath,
      marker,
    };
    await this.runHelper(target, input.runId, input.memberId, input.generationId, [
      "inject", "--lower", input.sourceRuntimePath, "--upper", upperPath, "--work", workPath,
      "--merged", layout.cwd, "--shared", sharedPath, "--marker", JSON.stringify(marker),
    ]);
    return workspace;
  }

  async verifyProbe(workspace: PreparedDockerAgentRunWorkspace, sourceRuntimePath: string, otherSharedPath: string) {
    const result = await this.runHelper(
      workspace.target,
      workspace.marker.runId,
      workspace.marker.memberId,
      workspace.marker.generationId,
      [
        "probe-verify", "--lower", sourceRuntimePath, "--merged", workspace.layout.cwd,
        "--shared", workspace.sharedPath, "--other-shared", otherSharedPath,
        "--generation", workspace.marker.generationId,
      ],
    );
    const parsed = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
    if (parsed.workspaceWritable !== true || parsed.sharedWritable !== true
      || parsed.sourceWriteRejected !== true || parsed.otherRunWriteRejected !== true) {
      throw storageError("AGENT_RUN_BEHAVIOR_PROBE_FAILED", "The Agent Run filesystem behavior probe did not prove every write boundary.", undefined, parsed);
    }
    return parsed;
  }

  async disposeProbe(workspace: PreparedDockerAgentRunWorkspace) {
    await this.runHelper(workspace.target, workspace.marker.runId, workspace.marker.memberId, workspace.marker.generationId, [
      "dispose", "--merged", workspace.layout.cwd, "--upper", workspace.upperPath, "--work", workspace.workPath,
    ]);
  }

  async removeRunDirectory(input: { runId: string; generationId: string; runtimeId: string; instanceId: string; runtimePath: string }) {
    const target = this.targetForInstance(input.instanceId);
    if (target.runtimeId !== input.runtimeId) throw storageError("AGENT_RUN_SHARED_RUNTIME_MISMATCH", "The target instance is outside the run runtime.");
    await this.requireReadyContainer(target);
    await this.runHelper(target, input.runId, "shared_space", input.generationId, [
      "shared-expire", "--path", input.runtimePath, "--generation", input.generationId,
    ]);
    return { runtimePath: input.runtimePath, runtimeId: input.runtimeId, volumeRole: "agent-run" };
  }

  async inspectRunDirectory(input: { runId: string; generationId: string; runtimeId: string; instanceId: string; runtimePath: string }) {
    const target = this.targetForInstance(input.instanceId);
    if (target.runtimeId !== input.runtimeId) throw storageError("AGENT_RUN_SHARED_RUNTIME_MISMATCH", "The target instance is outside the run runtime.");
    await this.requireReadyContainer(target);
    const result = await this.runHelper(target, input.runId, "shared_space", input.generationId, [
      "shared-inspect", "--path", input.runtimePath, "--generation", input.generationId,
    ]);
    const parsed = JSON.parse(result.stdout || "{}") as { usageBytes?: unknown };
    if (!Number.isSafeInteger(parsed.usageBytes) || Number(parsed.usageBytes) < 0) {
      throw storageError("AGENT_RUN_SHARED_USAGE_INVALID", "The shared-space helper returned an invalid usage measurement.");
    }
    return { usageBytes: Number(parsed.usageBytes) };
  }

  async inspectOwnership(workspace: PreparedDockerAgentRunWorkspace, expected: AgentRunWorkspaceMarker): Promise<WorkspaceOwnership> {
    try {
      const inspection = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", workspace.target.containerName]);
      const container = JSON.parse(inspection.stdout || "{}") as DockerContainerInspection;
      // A stopped or replaced container no longer has the injected mount namespace. The backing
      // directories remain registered and are cleaned when the authoritative container is ready.
      if (container.State?.Running !== true
        || (workspace.target.expectedContainerId && container.Id !== workspace.target.expectedContainerId)) return "absent";
      const result = await this.runHelper(workspace.target, expected.runId, expected.memberId, expected.generationId, [
        "inspect", "--merged", workspace.layout.cwd,
      ]);
      const parsed = JSON.parse(result.stdout || "{}") as { mounted?: unknown; marker?: AgentRunWorkspaceMarker };
      if (parsed.mounted !== true) return "absent";
      return parsed.marker && workspaceMarkerMatches(parsed.marker, expected) ? "owned" : "foreign";
    } catch {
      return "foreign";
    }
  }

  async dispose(workspace: PreparedDockerAgentRunWorkspace, expected: AgentRunWorkspaceMarker): Promise<void> {
    const ownership = await this.inspectOwnership(workspace, expected);
    if (ownership === "foreign") {
      this.resources.transition(workspace.resourceId, "manual-intervention", {
        metadata: { ownership: "foreign", mergedPath: workspace.layout.cwd },
      });
      throw storageError("AGENT_RUN_RESOURCE_OWNERSHIP_UNPROVEN", "Refusing to remove an Agent Run workspace with a foreign generation marker.");
    }
    await this.terminateMemberThread(expected.runId, expected.memberId);
    this.resources.transition(workspace.resourceId, "deleting");
    try {
      await this.runHelper(workspace.target, expected.runId, expected.memberId, expected.generationId, [
        "dispose", "--merged", workspace.layout.cwd, "--upper", workspace.upperPath, "--work", workspace.workPath,
      ]);
      this.resources.transition(workspace.resourceId, "deleted");
    } catch (cause) {
      this.resources.transition(workspace.resourceId, "delete-retrying", {
        incrementCleanupAttempts: true,
        metadata: { code: "AGENT_RUN_OVERLAY_DISPOSE_FAILED", message: cause instanceof Error ? cause.message : String(cause) },
      });
      throw storageError("AGENT_RUN_OVERLAY_DISPOSE_FAILED", "Could not dispose the Agent Run overlay workspace.", cause);
    }
  }

  async reconcileInstance(instanceId: string) {
    const results: Array<{ resourceId: string; status: "deleted" | "retrying" | "manual-intervention" }> = [];
    for (const resource of this.resources.listActiveForInstance(instanceId)) {
      if (resource.kind !== "overlay-mount" || !resource.memberId) continue;
      const workspace = this.workspaceFromResource(resource);
      const marker = createAgentRunWorkspaceMarker({
        runId: resource.runId,
        memberId: resource.memberId,
        generationId: resource.generationId,
        createdAt: resource.createdAt,
      });
      try {
        await this.dispose(workspace, marker);
        results.push({ resourceId: resource.resourceId, status: "deleted" });
      } catch {
        const current = this.resources.get(resource.resourceId);
        results.push({ resourceId: resource.resourceId, status: current?.phase === "manual-intervention" ? "manual-intervention" : "retrying" });
      }
    }
    return results;
  }

  private async requireReadyContainer(target: DockerAgentRunTarget) {
    let parsed: DockerContainerInspection;
    try {
      const result = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", target.containerName]);
      parsed = JSON.parse(result.stdout || "{}");
    } catch (cause) {
      throw storageError("AGENT_RUN_INSTANCE_NOT_READY", "The target Docker instance is not available.", cause);
    }
    if (typeof parsed.Id !== "string" || parsed.State?.Running !== true
      || (target.expectedContainerId && parsed.Id !== target.expectedContainerId)) {
      throw storageError("AGENT_RUN_INSTANCE_NOT_READY", "The target Docker instance identity or running state is not ready.");
    }
    if (!target.providerReady) {
      throw storageError("AGENT_RUN_PROVIDER_NOT_READY", "The target instance shared provider is not ready.");
    }
    const mounts = Array.isArray(parsed.Mounts) ? parsed.Mounts : [];
    const expected = agentRunRuntimeVolume(target.nodeId, target.runtimeId);
    const mount = mounts.find((item) => item.Destination === expected.mountPath);
    if (!mount) {
      throw storageError("AGENT_RUN_RUNTIME_VOLUME_MISSING", "The target instance does not have the Agent Run runtime volume.", undefined, {
        role: expected.role,
      });
    }
    if (mount.Type !== "volume" || mount.Name !== expected.name) {
      throw storageError("AGENT_RUN_RUNTIME_VOLUME_IDENTITY_MISMATCH", "The target instance has an unexpected Agent Run runtime volume.", undefined, {
        role: expected.role,
      });
    }
    return parsed;
  }

  private assertStorageBoundaries(sourceRuntimePath: string, paths: { upperPath: string; workPath: string; sharedPath: string; mergedPath: string }) {
    if (!path.posix.isAbsolute(sourceRuntimePath)) throw storageError("AGENT_RUN_SOURCE_PATH_INVALID", "The workspace source must be an absolute runtime path.");
    const source = path.posix.resolve(sourceRuntimePath);
    for (const candidate of [paths.upperPath, paths.workPath]) assertAgentRunWorkspacePath(DOCKER_AGENT_RUN_OVERLAY_ROOT, candidate);
    assertAgentRunWorkspacePath(DOCKER_AGENT_RUN_SHARED_ROOT, paths.sharedPath);
    assertAgentRunWorkspacePath(path.posix.dirname(paths.mergedPath), paths.mergedPath);
    if (source === DOCKER_AGENT_RUN_ROOT || source.startsWith(`${DOCKER_AGENT_RUN_ROOT}/`)
      || paths.upperPath === DOCKER_AGENT_RUN_SHARED_ROOT || paths.upperPath.startsWith(`${DOCKER_AGENT_RUN_SHARED_ROOT}/`)
      || paths.workPath === DOCKER_AGENT_RUN_SHARED_ROOT || paths.workPath.startsWith(`${DOCKER_AGENT_RUN_SHARED_ROOT}/`)
      || paths.sharedPath === DOCKER_AGENT_RUN_OVERLAY_ROOT || paths.sharedPath.startsWith(`${DOCKER_AGENT_RUN_OVERLAY_ROOT}/`)) {
      throw storageError("AGENT_RUN_OVERLAY_STORAGE_BOUNDARY_INVALID", "The source, overlay backing subtree, and shared artifact subtree must remain disjoint.");
    }
  }

  private helperArgs(target: DockerAgentRunTarget, runId: string, memberId: string, generationId: string, operation: string[]) {
    const helperName = `task-handoff-agent-helper-${runId}-${memberId}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
    const args = [
      "run", "--rm", "--name", helperName,
      "--pid", `container:${target.expectedContainerId || target.containerName}`,
      "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777",
      "--cap-drop", "ALL",
    ];
    for (const capability of HelperCapabilities) args.push("--cap-add", capability);
    args.push(
      "--label", "task-handoff.owner=task-handoff",
      "--label", "task-handoff.role=agent-run-overlay-helper",
      "--label", `task-handoff.run-id=${runId}`,
      "--label", `task-handoff.member-id=${memberId}`,
      "--label", `task-handoff.generation-id=${generationId}`,
      this.helperImage,
      ...operation,
    );
    return args;
  }

  private runHelper(target: DockerAgentRunTarget, runId: string, memberId: string, generationId: string, operation: string[]) {
    return this.runCommand("docker", this.helperArgs(target, runId, memberId, generationId, operation), { timeoutMs: 30_000 });
  }

  private async rollbackInjection(workspace: PreparedDockerAgentRunWorkspace, cause: unknown) {
    try {
      await this.runHelper(workspace.target, workspace.marker.runId, workspace.marker.memberId, workspace.marker.generationId, [
        "rollback", "--merged", workspace.layout.cwd, "--upper", workspace.upperPath, "--work", workspace.workPath,
      ]);
      const current = this.resources.get(workspace.resourceId);
      this.resources.transition(workspace.resourceId, "deleted", { metadata: { ...current?.metadata, rolledBack: true } });
    } catch (rollbackCause) {
      const current = this.resources.get(workspace.resourceId);
      this.resources.transition(workspace.resourceId, "delete-retrying", {
        incrementCleanupAttempts: true,
        metadata: {
          ...current?.metadata,
          code: "AGENT_RUN_OVERLAY_ROLLBACK_FAILED",
          prepareError: cause instanceof Error ? cause.message : String(cause),
          rollbackError: rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause),
        },
      });
    }
  }

  private appendInjectionAudit(resourceId: string, attempt: Record<string, unknown>) {
    const resource = this.resources.get(resourceId);
    if (!resource) return;
    const previous = Array.isArray(resource.metadata.injectionAttempts) ? resource.metadata.injectionAttempts : [];
    this.resources.transition(resourceId, resource.phase, {
      metadata: { ...resource.metadata, injectionAttempts: [...previous, attempt] },
    });
  }

  private finishInjectionAudit(resourceId: string, result: "completed" | "failed", cause?: unknown) {
    const resource = this.resources.get(resourceId);
    if (!resource) return;
    const attempts = Array.isArray(resource.metadata.injectionAttempts) ? [...resource.metadata.injectionAttempts] : [];
    const last = attempts.at(-1);
    if (last && typeof last === "object" && !Array.isArray(last)) {
      attempts[attempts.length - 1] = {
        ...last,
        result,
        finishedAt: new Date().toISOString(),
        ...(cause === undefined ? {} : { error: cause instanceof Error ? cause.message : String(cause) }),
      };
    }
    this.resources.transition(resourceId, resource.phase, { metadata: { ...resource.metadata, injectionAttempts: attempts } });
  }

  private workspaceFromResource(resource: AgentRunResourceRecord): PreparedDockerAgentRunWorkspace {
    if (!resource.instanceId || !resource.memberId) throw storageError("AGENT_RUN_RESOURCE_INVALID", "The overlay resource is missing instance or member ownership.");
    const layout = agentRunWorkspaceLayout(resource.runId, resource.memberId);
    const overlayRunRoot = path.posix.join(DOCKER_AGENT_RUN_OVERLAY_ROOT, resource.runId, resource.memberId);
    return {
      materializer: this.kind,
      generationId: resource.generationId,
      layout,
      backendIdentity: resource.backendIdentity,
      diagnostics: resource.metadata,
      target: this.targetForInstance(resource.instanceId),
      resourceId: resource.resourceId,
      upperPath: path.posix.join(overlayRunRoot, "upper"),
      workPath: path.posix.join(overlayRunRoot, "work"),
      sharedPath: path.posix.join(DOCKER_AGENT_RUN_SHARED_ROOT, resource.runId),
      marker: createAgentRunWorkspaceMarker({
        runId: resource.runId, memberId: resource.memberId, generationId: resource.generationId, createdAt: resource.createdAt,
      }),
    };
  }
}
