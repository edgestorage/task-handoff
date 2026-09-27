import crypto from "node:crypto";
import { SchedulerExecutionRuntime, type SchedulerSkipReason } from "@task-handoff/core/core/scheduler-runtime";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import { AGENT_RUN_TERMINAL_STATUSES, type AgentRun, type AgentRunError, type AgentRunMember } from "@task-handoff/protocol/agent-runs";
import type { NodeAgentState } from "../state.ts";
import type { AgentRunResourceRepository } from "../persistence/agent-run-resource-repository.ts";
import { resolveInstanceFolder } from "../instances/instance-folder.ts";
import type { AgentDefinitionService } from "./service.ts";
import type { AgentRunExecutionCoordinator, AgentRunService } from "./run-service.ts";
import type { AgentRunMemberSessionClient } from "./member-session-client.ts";
import type { AgentRunSharedSpaceService } from "./agent-run-shared-space.ts";
import {
  WorkspaceMaterializerRegistry,
  createAgentRunWorkspaceMarker,
  type PreparedAgentRunWorkspace,
  type WorkspaceMaterializer,
} from "./workspace-materializer.ts";

type ScheduledMember = { runId: string; memberId: string; root: boolean; initiatorKey: string; maxConcurrency: number };

function runError(error: unknown, fallback = "AGENT_RUN_EXECUTION_FAILED"): AgentRunError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    code: typeof record.code === "string" ? record.code : fallback,
    message: error instanceof Error ? error.message : String(error),
    retryable: record.retryable === true,
  };
}

export class AgentRunCoordinator implements AgentRunExecutionCoordinator {
  private readonly runScheduler: SchedulerExecutionRuntime<ScheduledMember>;
  private readonly memberScheduler: SchedulerExecutionRuntime<ScheduledMember>;
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private readonly completionWaiters = new Map<string, () => void>();
  private readonly cleanupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Run ids accepted by this coordinator process; startup recovery must only claim persisted orphans. */
  private readonly managedRunIds = new Set<string>();
  private readonly options: {
    state: NodeAgentState;
    definitions: AgentDefinitionService;
    runs: AgentRunService;
    materializers: WorkspaceMaterializerRegistry;
    sharedSpaces: AgentRunSharedSpaceService;
    resources: AgentRunResourceRepository;
    sessions: AgentRunMemberSessionClient;
    reconcileInstanceResources?: (instanceId: string) => Promise<unknown>;
    pollIntervalMs?: number;
    cleanupRetryBaseMs?: number;
  };
  private accepting = true;

  constructor(options: {
    state: NodeAgentState;
    definitions: AgentDefinitionService;
    runs: AgentRunService;
    materializers: WorkspaceMaterializerRegistry;
    sharedSpaces: AgentRunSharedSpaceService;
    resources: AgentRunResourceRepository;
    sessions: AgentRunMemberSessionClient;
    reconcileInstanceResources?: (instanceId: string) => Promise<unknown>;
    pollIntervalMs?: number;
    cleanupRetryBaseMs?: number;
  }) {
    this.options = options;
    this.memberScheduler = new SchedulerExecutionRuntime({
      execute: (event) => this.trackMemberExecution(event),
      skipped: (event, reason) => this.failQueued(event, reason),
    });
    this.runScheduler = new SchedulerExecutionRuntime({
      execute: (event) => this.submitRootMember(event),
      skipped: (event, reason) => this.failQueued(event, reason),
    });
  }

  accept(runId: string, memberId: string) {
    if (!this.accepting) return this.failQueued(this.event(runId, memberId), "scheduler-stopped");
    const event = this.event(runId, memberId);
    if (event.root) {
      if (this.managedRunIds.has(runId)) return;
      this.managedRunIds.add(runId);
      this.runScheduler.submit(event.initiatorKey, event, { maxConcurrentRuns: 2, whenBusy: "queue" });
    } else {
      this.memberScheduler.submit(`run:${runId}`, event, { maxConcurrentRuns: event.maxConcurrency, whenBusy: "queue" });
    }
  }

  cancel(runId: string) {
    this.memberScheduler.clearQueued(`run:${runId}`, "job-disabled");
    for (const [key, controller] of this.controllers) if (key.startsWith(`${runId}:`)) controller.abort();
  }

  async stop() {
    this.accepting = false;
    this.runScheduler.stop();
    this.memberScheduler.stop();
    for (const timer of this.cleanupRetryTimers.values()) clearTimeout(timer);
    this.cleanupRetryTimers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.activeExecutions]);
  }

  async reconcile() {
    for (const run of this.options.runs.list()) {
      if (AGENT_RUN_TERMINAL_STATUSES.has(run.status)) {
        this.managedRunIds.delete(run.runId);
        continue;
      }
      if (this.managedRunIds.has(run.runId)) continue;
      const resources = this.options.resources.listForRun(run.runId);
      if (run.status === "queued" && resources.length === 0) {
        const root = run.members?.find((member) => member.memberId === run.rootMemberId);
        if (root?.status === "queued") this.accept(run.runId, root.memberId);
        continue;
      }
      await this.reconcileInterruptedRun(run.runId);
    }
  }

  private async reconcileInterruptedRun(runId: string) {
    const restartError: AgentRunError = {
      code: "AGENT_RUN_NODE_RESTARTED",
      message: "The Node Agent restarted after this Agent Run began; started members are not executed again.",
      retryable: false,
    };
    let run = this.options.runs.get(runId);
    if (run.status !== "finalizing") run = this.options.runs.transitionRun(runId, { status: "finalizing" });
    for (const member of run.members ?? []) {
      if (!AGENT_RUN_TERMINAL_STATUSES.has(member.status) && member.status !== "finalizing") {
        this.options.runs.transitionMember(runId, member.memberId, { status: "finalizing", error: restartError });
      }
    }

    const instanceIds = new Set<string>();
    for (const resource of this.options.resources.listForRun(runId)) {
      if (resource.instanceId) instanceIds.add(resource.instanceId);
      if (resource.kind !== "provider-thread" || resource.phase === "deleted" || resource.phase === "manual-intervention") continue;
      if (!resource.memberId || !resource.instanceId) {
        this.options.resources.transition(resource.resourceId, "manual-intervention", {
          metadata: { code: "AGENT_RUN_RESOURCE_OWNERSHIP_UNPROVEN", message: "Provider thread ownership is incomplete." },
        });
        continue;
      }
      try {
        this.options.resources.transition(resource.resourceId, "deleting");
        await this.options.sessions.close(this.options.state.requireInstance(resource.instanceId), runId, resource.memberId);
        this.options.resources.transition(resource.resourceId, "deleted");
      } catch (cause) {
        this.options.resources.transition(resource.resourceId, "delete-retrying", {
          incrementCleanupAttempts: true,
          metadata: { code: "AGENT_RUN_PROVIDER_THREAD_CLOSE_FAILED", message: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    }
    for (const instanceId of instanceIds) {
      await this.options.reconcileInstanceResources?.(instanceId).catch(() => undefined);
    }

    const cleanupResources = this.options.resources.listForRun(runId)
      .filter((resource) => resource.kind === "provider-thread" || resource.kind === "overlay-mount");
    const manual = cleanupResources.some((resource) => resource.phase === "manual-intervention");
    const pending = cleanupResources.some((resource) => resource.phase !== "deleted" && resource.phase !== "manual-intervention");
    const attempts = Math.max(1, ...cleanupResources.map((resource) => resource.cleanupAttempts));
    if (pending) {
      this.options.runs.transitionRun(runId, {
        status: "finalizing",
        error: restartError,
        cleanup: { status: "retrying", attempts, message: "Runtime cleanup will be retried.", updatedAt: new Date().toISOString() },
      });
      return;
    }
    for (const member of this.options.runs.get(runId).members ?? []) {
      if (!AGENT_RUN_TERMINAL_STATUSES.has(member.status)) {
        this.options.runs.transitionMember(runId, member.memberId, { status: "failed", error: restartError });
      }
    }
    this.options.runs.transitionRun(runId, {
      status: "failed",
      error: restartError,
      cleanup: {
        status: manual ? "manual-intervention" : "completed",
        attempts,
        ...(manual ? { message: "At least one runtime resource could not be proven to belong to this Agent Run." } : {}),
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private trackMemberExecution(event: ScheduledMember) {
    const execution = this.executeMember(event);
    this.activeExecutions.add(execution);
    void execution.finally(() => this.activeExecutions.delete(execution));
    return execution;
  }

  private event(runId: string, memberId: string): ScheduledMember {
    const run = this.options.runs.get(runId);
    const member = this.options.runs.getMember(runId, memberId);
    return {
      runId,
      memberId,
      root: run.rootMemberId === memberId,
      initiatorKey: run.provenance.source === "control-plane"
        ? `control-plane:${run.provenance.authorizationSubject?.subjectId ?? "system"}`
        : `story:${run.provenance.initiatingAiSessionId}`,
      maxConcurrency: run.budget.maxConcurrency,
    };
  }

  private async submitRootMember(event: ScheduledMember) {
    await new Promise<void>((resolve) => {
      this.completionWaiters.set(`${event.runId}:${event.memberId}`, resolve);
      // Root and callees share one run-keyed scheduler, so all consume the frozen member concurrency budget.
      this.memberScheduler.submit(`run:${event.runId}`, event, { maxConcurrentRuns: event.maxConcurrency, whenBusy: "queue" });
    });
  }

  private async executeMember(event: ScheduledMember) {
    const key = `${event.runId}:${event.memberId}`;
    if (this.controllers.has(key)) return;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    let workspace: PreparedAgentRunWorkspace | undefined;
    let materializer: WorkspaceMaterializer | undefined;
    let instance: ControlledInstance | undefined;
    let sessionCreated = false;
    let providerThreadResourceId: string | undefined;
    let terminalResult: AgentRunMember["result"];
    let terminalError: AgentRunError | undefined;
    try {
      let run = this.options.runs.get(event.runId);
      let member = this.options.runs.getMember(event.runId, event.memberId);
      if (run.status === "finalizing") throw Object.assign(new Error("The Agent Run was cancelled before the member started."), { code: "AGENT_RUN_CANCELLED" });
      if (event.root) this.options.runs.transitionRun(run.runId, { status: "preparing" });
      member = this.options.runs.transitionMember(run.runId, member.memberId, { status: "preparing" });
      this.options.runs.appendTimeline(run.runId, "member.preparing", { memberId: member.memberId });

      instance = this.options.state.requireInstance(member.instanceId);
      const runtime = this.options.state.requireRuntime(instance.runtimeId);
      if (runtime.type !== "docker") throw Object.assign(new Error("Phase 1 Agent Run execution requires a Docker Runtime."), { code: "AGENT_RUN_RUNTIME_UNSUPPORTED" });
      const folder = resolveInstanceFolder(this.options.state, instance, member.executionSnapshot.cwdFolderId);
      if (folder.status !== "resolved") throw Object.assign(new Error("The Agent working folder is no longer available in the target instance."), { code: "AGENT_RUN_FOLDER_UNAVAILABLE" });
      const generationId = `generation_${crypto.randomBytes(12).toString("hex")}`;
      if (event.root) {
        await this.options.sharedSpaces.ensure({ runId: run.runId, runtimeId: runtime.id, instanceId: instance.id, generationId });
      }
      // Validate the run's shared-runtime boundary before creating any member workspace resources.
      this.options.sharedSpaces.bindingForMember(run.runId, runtime.id);
      materializer = this.options.materializers.require({
        runtimeType: runtime.type,
        workspaceMaterializer: member.executionSnapshot.executionPolicy.workspaceMaterializer,
        processSandbox: member.executionSnapshot.executionPolicy.processSandbox,
      });
      workspace = await materializer.prepare({
        runId: run.runId,
        memberId: member.memberId,
        generationId,
        runtimeId: runtime.id,
        instanceId: instance.id,
        sourceRuntimePath: folder.runtimePath,
        executionSnapshot: member.executionSnapshot,
      });
      const pathPolicy = this.options.sharedSpaces.pathPolicyForMember(run.runId, runtime.id, workspace.layout.cwd);
      const invocation = this.options.definitions.resolveInvocationTools(member.agentId);
      const modelSelection = member.executionSnapshot.modelEntityId && member.executionSnapshot.modelName
        ? { modelEntityId: member.executionSnapshot.modelEntityId, modelName: member.executionSnapshot.modelName }
        : undefined;
      if (!member.input) throw Object.assign(new Error("The Agent Run member has no frozen input."), { code: "AGENT_RUN_MEMBER_INPUT_MISSING" });
      const created = await this.options.sessions.create(instance, {
        runId: run.runId,
        memberId: member.memberId,
        clientRequestId: `agent_member_${member.memberId}`,
        providerId: member.executionSnapshot.providerId,
        cwd: { type: "runtime-path", path: pathPolicy.cwd },
        writableRoots: {
          workspace: { type: "runtime-path", path: pathPolicy.writableRoots[0] },
          shared: { type: "runtime-path", path: pathPolicy.writableRoots[1] },
        },
        prompt: member.input.prompt,
        appendedPrompt: member.executionSnapshot.appendedPrompt,
        // An unspecified Agent preset still uses the registered workspace sandbox. Full access is
        // never accepted because it would invalidate write-root isolation.
        permissionMode: (member.executionSnapshot.permissionMode || "auto-review") as never,
        modelSelection,
        reasoningEffort: member.executionSnapshot.reasoningEffort as never,
        enabledTools: invocation.enabledTools,
      });
      sessionCreated = true;
      const thread = this.options.resources.register({
        runId: run.runId,
        memberId: member.memberId,
        instanceId: instance.id,
        runtimeId: runtime.id,
        kind: "provider-thread",
        generationId,
        backendIdentity: created.providerSessionId,
        metadata: { aiSessionId: created.aiSessionId, providerId: member.executionSnapshot.providerId },
      });
      providerThreadResourceId = thread.resourceId;
      this.options.resources.transition(thread.resourceId, "ready");
      this.options.runs.transitionMember(run.runId, member.memberId, { status: "running", aiSessionId: created.aiSessionId });
      if (event.root) this.options.runs.transitionRun(run.runId, { status: "running" });
      this.options.runs.appendTimeline(run.runId, "member.running", { memberId: member.memberId });

      while (!controller.signal.aborted) {
        run = this.options.runs.get(run.runId);
        if (run.status === "finalizing") break;
        const status = await this.options.sessions.status(instance, run.runId, member.memberId);
        await this.options.sharedSpaces.refreshUsage(run.runId, instance.id);
        if (status.status === "completed") { terminalResult = status.result; break; }
        if (status.status === "failed") { terminalError = status.error; break; }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 250));
      }
      if (!terminalResult && !terminalError) {
        terminalError = { code: "AGENT_RUN_CANCELLED", message: "The Agent Run member was cancelled.", retryable: false };
      }
    } catch (error) {
      terminalError = runError(error);
    } finally {
      await this.finalizeMember(event, instance, sessionCreated, providerThreadResourceId, materializer, workspace, terminalResult, terminalError);
      this.controllers.delete(key);
      this.complete(event);
    }
  }

  private async finalizeMember(
    event: ScheduledMember,
    instance: ControlledInstance | undefined,
    sessionCreated: boolean,
    providerThreadResourceId: string | undefined,
    materializer: WorkspaceMaterializer | undefined,
    workspace: PreparedAgentRunWorkspace | undefined,
    result: AgentRunMember["result"],
    error: AgentRunError | undefined,
  ) {
    const retryKey = `${event.runId}:${event.memberId}`;
    this.cleanupRetryTimers.delete(retryKey);
    let cleanupError: AgentRunError | undefined;
    const initialMember = this.options.runs.getMember(event.runId, event.memberId);
    const memberAlreadyTerminal = AGENT_RUN_TERMINAL_STATUSES.has(initialMember.status);
    try {
      if (!memberAlreadyTerminal && initialMember.status !== "finalizing") {
        this.options.runs.transitionMember(event.runId, event.memberId, { status: "finalizing" });
      }
      if (!memberAlreadyTerminal && sessionCreated && instance) {
        if (providerThreadResourceId) this.options.resources.transition(providerThreadResourceId, "deleting");
        try {
          await this.options.sessions.close(instance, event.runId, event.memberId);
          if (providerThreadResourceId) this.options.resources.transition(providerThreadResourceId, "deleted");
        } catch (cause) {
          if (providerThreadResourceId) {
            this.options.resources.transition(providerThreadResourceId, "delete-retrying", {
              incrementCleanupAttempts: true,
              metadata: { code: "AGENT_RUN_PROVIDER_THREAD_CLOSE_FAILED", message: cause instanceof Error ? cause.message : String(cause) },
            });
          }
          throw cause;
        }
      }
      if (!memberAlreadyTerminal && workspace && materializer) {
        await materializer.dispose(workspace, createAgentRunWorkspaceMarker({
          runId: event.runId, memberId: event.memberId, generationId: workspace.generationId,
        }));
      }
    } catch (cause) {
      cleanupError = runError(cause, "AGENT_RUN_CLEANUP_FAILED");
    }
    const cancelled = this.options.runs.get(event.runId).status === "finalizing" && error?.code === "AGENT_RUN_CANCELLED";
    if (cleanupError) {
      if (!memberAlreadyTerminal) {
        this.options.runs.transitionMember(event.runId, event.memberId, {
          status: "finalizing",
          ...(result ? { result } : {}),
          ...(error ? { error } : {}),
        });
      }
      if (event.root) {
        const current = this.options.runs.get(event.runId);
        if (current.status !== "finalizing") this.options.runs.transitionRun(event.runId, { status: "finalizing" });
        const attempts = (current.cleanup?.attempts ?? 0) + 1;
        this.options.runs.transitionRun(event.runId, {
          status: "finalizing",
          cleanup: { status: "retrying", attempts, message: cleanupError.message, updatedAt: new Date().toISOString() },
        });
        this.options.runs.appendTimeline(event.runId, "run.cleanup-retrying", {
          memberId: event.memberId,
          data: { code: cleanupError.code, attempts },
        });
      }
      this.scheduleCleanupRetry(
        event,
        instance,
        sessionCreated,
        providerThreadResourceId,
        materializer,
        workspace,
        result,
        error,
      );
      return;
    }
    const memberStatus = error ? cancelled ? "cancelled" : "failed" : "completed";
    if (!memberAlreadyTerminal) {
      this.options.runs.transitionMember(event.runId, event.memberId, {
        status: memberStatus,
        ...(memberStatus === "completed" ? { result } : { error }),
      });
      this.options.runs.appendTimeline(event.runId, `member.${memberStatus}`, { memberId: event.memberId });
    }
    if (!event.root) return;
    const current = this.options.runs.get(event.runId);
    if (current.status !== "finalizing") this.options.runs.transitionRun(event.runId, { status: "finalizing" });
    try {
      this.options.sharedSpaces.retain(event.runId);
    } catch (cause) {
      cleanupError = runError(cause, "AGENT_RUN_SHARED_SPACE_RETAIN_FAILED");
      const attempts = (current.cleanup?.attempts ?? 0) + 1;
      this.options.runs.transitionRun(event.runId, {
        status: "finalizing",
        cleanup: { status: "retrying", attempts, message: cleanupError.message, updatedAt: new Date().toISOString() },
      });
      this.scheduleCleanupRetry(event, instance, false, undefined, undefined, undefined, result, error);
      return;
    }
    const cleanup = {
      status: "completed" as const,
      attempts: (current.cleanup?.attempts ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const runStatus = error ? cancelled ? "cancelled" : "failed" : "completed";
    this.options.runs.transitionRun(event.runId, {
      status: runStatus,
      ...(runStatus === "completed" ? { result } : { error }),
      cleanup,
    });
    this.managedRunIds.delete(event.runId);
  }

  private scheduleCleanupRetry(
    event: ScheduledMember,
    instance: ControlledInstance | undefined,
    sessionCreated: boolean,
    providerThreadResourceId: string | undefined,
    materializer: WorkspaceMaterializer | undefined,
    workspace: PreparedAgentRunWorkspace | undefined,
    result: AgentRunMember["result"],
    error: AgentRunError | undefined,
  ) {
    if (!this.accepting) return;
    const key = `${event.runId}:${event.memberId}`;
    if (this.cleanupRetryTimers.has(key)) return;
    const attempts = this.options.runs.get(event.runId).cleanup?.attempts ?? 1;
    const delay = Math.min((this.options.cleanupRetryBaseMs ?? 1_000) * (2 ** Math.min(attempts - 1, 6)), 60_000);
    const timer = setTimeout(() => {
      this.cleanupRetryTimers.delete(key);
      const retry = this.finalizeMember(
        event,
        instance,
        sessionCreated,
        providerThreadResourceId,
        materializer,
        workspace,
        result,
        error,
      );
      this.activeExecutions.add(retry);
      void retry.finally(() => this.activeExecutions.delete(retry));
    }, delay);
    timer.unref?.();
    this.cleanupRetryTimers.set(key, timer);
  }

  private failQueued(event: ScheduledMember, reason: SchedulerSkipReason) {
    try {
      const member = this.options.runs.getMember(event.runId, event.memberId);
      if (member.status !== "queued") return;
      this.options.runs.transitionMember(event.runId, event.memberId, { status: "finalizing" });
      const error = { code: "AGENT_RUN_SCHEDULER_STOPPED", message: `Agent Run scheduling stopped: ${reason}.`, retryable: reason === "scheduler-stopped" };
      this.options.runs.transitionMember(event.runId, event.memberId, { status: "failed", error });
      if (event.root) {
        const run = this.options.runs.get(event.runId);
        if (run.status !== "finalizing") this.options.runs.transitionRun(event.runId, { status: "finalizing" });
        this.options.runs.transitionRun(event.runId, { status: "failed", error, cleanup: { status: "completed", attempts: 0, updatedAt: new Date().toISOString() } });
        this.managedRunIds.delete(event.runId);
      }
    } catch {} finally { this.complete(event); }
  }

  private complete(event: ScheduledMember) {
    const key = `${event.runId}:${event.memberId}`;
    const resolve = this.completionWaiters.get(key);
    if (!resolve) return;
    this.completionWaiters.delete(key);
    resolve();
  }
}
