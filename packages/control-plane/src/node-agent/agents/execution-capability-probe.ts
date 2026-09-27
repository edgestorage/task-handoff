import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { aiSessionProviderCapability, type ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { AgentRunMemberExecutionSnapshot } from "@task-handoff/protocol/agent-runs";
import type { NodeAgentState } from "../state.ts";
import {
  DOCKER_AGENT_RUN_SHARED_ROOT,
} from "../runtimes/docker.ts";
import type { DockerAgentRunStorage, PreparedDockerAgentRunWorkspace } from "./docker-agent-run-storage.ts";
import type { AgentRunMemberSessionClient } from "./member-session-client.ts";

const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 2 * 60 * 1_000;

type ProbeResult = {
  identity: string;
  status: "passed" | "failed";
  checkedAt: string;
  retryAt?: number;
  error?: string;
};

export type AgentRunExecutionProbeSupport = {
  targetInstanceId: string;
  runtimeType: string;
  providerId: string;
  permissionMode?: string;
  executionPolicy: { workspaceMaterializer: string; processSandbox: string };
};

/**
 * Publishes a combination only after the same controlled instance completes the real filesystem,
 * provider-thread, ordinary-session and cleanup behavior probe. Results are bound to container identity.
 */
export class AgentRunExecutionCapabilityProbe {
  private readonly results = new Map<string, ProbeResult>();
  private readonly active = new Map<string, Promise<void>>();
  private publishedCombinations: ReturnType<AgentRunExecutionCapabilityProbe["combinations"]> = [];
  private readonly options: {
    state: NodeAgentState;
    storage: DockerAgentRunStorage;
    sessions: AgentRunMemberSessionClient;
    candidateInstanceIds: () => Iterable<string>;
    pollIntervalMs?: number;
    onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
    onCapabilitiesChanged?: () => void;
  };

  constructor(options: {
    state: NodeAgentState;
    storage: DockerAgentRunStorage;
    sessions: AgentRunMemberSessionClient;
    candidateInstanceIds: () => Iterable<string>;
    pollIntervalMs?: number;
    onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
    onCapabilitiesChanged?: () => void;
  }) {
    this.options = options;
  }

  supports(input: AgentRunExecutionProbeSupport) {
    if (input.runtimeType !== "docker" || input.providerId !== "codex"
      || input.executionPolicy.workspaceMaterializer !== "overlay-copy-on-write"
      || input.executionPolicy.processSandbox !== "instance"
      || input.permissionMode === "full-access") return false;
    const instance = this.options.state.controlledInstances.get(input.targetInstanceId);
    if (!instance) return false;
    const result = this.results.get(instance.id);
    return result?.status === "passed" && result.identity === probeIdentity(instance);
  }

  combinations() {
    const published = [...this.results.entries()].some(([instanceId, result]) => {
      if (result.status !== "passed") return false;
      const instance = this.options.state.controlledInstances.get(instanceId);
      return Boolean(instance && result.identity === probeIdentity(instance));
    });
    return published ? [{
      runtime: "docker" as const,
      workspaceMaterializer: "overlay-copy-on-write" as const,
      processSandbox: "instance" as const,
      providerId: "codex",
    }] : [];
  }

  async reconcile() {
    this.publishCapabilitiesChange();
    const candidates = new Set(this.options.candidateInstanceIds());
    await Promise.allSettled([...candidates].map(async (instanceId) => {
      const instance = this.options.state.controlledInstances.get(instanceId);
      if (!instance || !eligible(instance, this.options.state)) return;
      const identity = probeIdentity(instance);
      const current = this.results.get(instance.id);
      if (current?.identity === identity && (current.status === "passed" || (current.retryAt ?? 0) > Date.now())) return;
      const running = this.active.get(instance.id);
      if (running) return running;
      const probe = this.run(instance, identity).finally(() => this.active.delete(instance.id));
      this.active.set(instance.id, probe);
      return probe;
    }));
    this.publishCapabilitiesChange();
  }

  private publishCapabilitiesChange() {
    const combinations = this.combinations();
    if (isDeepStrictEqual(combinations, this.publishedCombinations)) return;
    this.publishedCombinations = combinations;
    this.options.onCapabilitiesChanged?.();
  }

  private async run(instance: ControlledInstance, identity: string) {
    try {
      await runBehaviorProbe(this.options, instance);
      this.results.set(instance.id, { identity, status: "passed", checkedAt: new Date().toISOString() });
      this.options.onDiagnostic?.({ code: "AGENT_RUN_BEHAVIOR_PROBE_PASSED", instanceId: instance.id, identity });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.results.set(instance.id, {
        identity,
        status: "failed",
        checkedAt: new Date().toISOString(),
        retryAt: Date.now() + RETRY_AFTER_FAILURE_MS,
        error,
      });
      this.options.onDiagnostic?.({ code: "AGENT_RUN_BEHAVIOR_PROBE_FAILED", instanceId: instance.id, identity, error });
    }
  }
}

async function runBehaviorProbe(
  options: ConstructorParameters<typeof AgentRunExecutionCapabilityProbe>[0],
  instance: ControlledInstance,
) {
  const suffix = crypto.randomBytes(10).toString("hex");
  const runId = `probe_${suffix}`;
  const otherRunId = `probe_other_${suffix}`;
  const memberId = `member_${suffix}`;
  const generationId = `generation_${suffix}`;
  const runtimeId = instance.runtimeId;
  const sourceRuntimePath = path.posix.resolve(instance.runtime.workspacePath || instance.workspace.path || "/workspace");
  const sharedPath = path.posix.join(DOCKER_AGENT_RUN_SHARED_ROOT, runId);
  const otherSharedPath = path.posix.join(DOCKER_AGENT_RUN_SHARED_ROOT, otherRunId);
  const markerName = `.task-handoff-agent-run-probe-${generationId}`;
  let workspace: PreparedDockerAgentRunWorkspace | undefined;
  let sessionCreated = false;
  let primarySharedCreated = false;
  let otherSharedCreated = false;
  let failure: unknown;
  const before = await options.sessions.probeState(instance);
  try {
    await options.storage.ensureRunDirectory({ runId, generationId, runtimeId, instanceId: instance.id, runtimePath: sharedPath });
    primarySharedCreated = true;
    await options.storage.ensureRunDirectory({ runId: otherRunId, generationId, runtimeId, instanceId: instance.id, runtimePath: otherSharedPath });
    otherSharedCreated = true;
    const executionSnapshot: AgentRunMemberExecutionSnapshot = {
      agentRevision: "0".repeat(64),
      targetInstanceId: instance.id,
      cwdFolderId: "behavior-probe",
      appendedPrompt: "",
      providerId: "codex",
      permissionMode: "auto-review",
      executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
    };
    workspace = await options.storage.prepareProbe({
      runId, memberId, generationId, runtimeId, instanceId: instance.id, sourceRuntimePath, executionSnapshot,
    });
    await options.sessions.create(instance, {
      runId,
      memberId,
      clientRequestId: `agent_probe_${suffix}`,
      providerId: "codex",
      cwd: { type: "runtime-path", path: workspace.layout.cwd },
      writableRoots: {
        workspace: { type: "runtime-path", path: workspace.layout.cwd },
        shared: { type: "runtime-path", path: sharedPath },
      },
      prompt: probePrompt({ markerName, workspacePath: workspace.layout.cwd, sharedPath, sourceRuntimePath, otherSharedPath }),
      appendedPrompt: "",
      permissionMode: "auto-review",
      enabledTools: [],
    });
    sessionCreated = true;
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let completed = false;
    while (Date.now() < deadline) {
      const status = await options.sessions.status(instance, runId, memberId);
      if (status.status === "failed") throw Object.assign(new Error(status.error?.message || "The provider probe thread failed."), { code: status.error?.code });
      if (status.status === "completed") { completed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 500));
    }
    if (!completed) throw new Error("The Agent Run provider behavior probe timed out.");
    await options.storage.verifyProbe(workspace, sourceRuntimePath, otherSharedPath);
  } catch (cause) {
    failure = cause;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (sessionCreated) await options.sessions.close(instance, runId, memberId).catch((cause) => cleanupErrors.push(cause));
    if (workspace) {
      await options.storage.disposeProbe(workspace).catch((cause) => cleanupErrors.push(cause));
      const ownership = await options.storage.inspectOwnership(workspace, workspace.marker);
      if (ownership !== "absent") cleanupErrors.push(new Error(`Probe overlay remained ${ownership} after disposal.`));
    }
    if (otherSharedCreated) await options.storage.removeRunDirectory({ runId: otherRunId, generationId, runtimeId, instanceId: instance.id, runtimePath: otherSharedPath }).catch((cause) => cleanupErrors.push(cause));
    if (primarySharedCreated) await options.storage.removeRunDirectory({ runId, generationId, runtimeId, instanceId: instance.id, runtimePath: sharedPath }).catch((cause) => cleanupErrors.push(cause));
    const after = await options.sessions.probeState(instance).catch((cause) => {
      cleanupErrors.push(cause);
      return undefined;
    });
    if (after && !isDeepStrictEqual(before.ordinaryAiSessionIds, after.ordinaryAiSessionIds)) {
      cleanupErrors.push(new Error("The behavior probe changed the ordinary AI Session set."));
    }
    if (failure) throw failure;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "The Agent Run behavior probe did not cleanly converge.");
  }
}

function probePrompt(input: { markerName: string; workspacePath: string; sharedPath: string; sourceRuntimePath: string; otherSharedPath: string }) {
  return [
    "Run the following shell commands exactly once. Do not request expanded permissions and do not use any other tool.",
    `printf workspace-ok > ${shellQuote(path.posix.join(input.workspacePath, input.markerName))}`,
    `printf shared-ok > ${shellQuote(path.posix.join(input.sharedPath, input.markerName))}`,
    `(printf forbidden > ${shellQuote(path.posix.join(input.sourceRuntimePath, input.markerName))}) || true`,
    `ln -sfn ${shellQuote(input.sourceRuntimePath)} ${shellQuote(path.posix.join(input.workspacePath, `.probe-link-${input.markerName}`))}`,
    `(printf forbidden > ${shellQuote(path.posix.join(input.workspacePath, `.probe-link-${input.markerName}`, input.markerName))}) || true`,
    `(printf forbidden > ${shellQuote(path.posix.join(input.otherSharedPath, input.markerName))}) || true`,
    "Then reply with only: probe complete",
  ].join("\n");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function eligible(instance: ControlledInstance, state: NodeAgentState) {
  return state.requireRuntime(instance.runtimeId).type === "docker"
    && instance.ready === true
    && instance.status === "running"
    && instance.connectionStatus === "online"
    && instance.agentStatus === "online"
    && instance.targetStatus === "reachable"
    && Boolean(instance.runtime.containerId)
    && aiSessionProviderCapability(instance.capabilities, "codex");
}

function probeIdentity(instance: ControlledInstance) {
  return [
    instance.runtimeId,
    instance.runtime.containerId || "missing-container",
    instance.build?.packageVersion || instance.instanceVersion || "unknown-version",
  ].join(":");
}
