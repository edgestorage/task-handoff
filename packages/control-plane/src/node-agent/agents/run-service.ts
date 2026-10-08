import {
  AGENT_RUN_DEFAULT_BUDGET,
  AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS,
  AGENT_RUN_SERVICE_ERROR_CODES,
  AGENT_RUN_TERMINAL_STATUSES,
  AgentRunCancelInputSchema,
  AgentRunCreateInputSchema,
  type AgentRun,
  type AgentRunBudget,
  type AgentRunCreateInput,
  type AgentRunMember,
  type AgentRunInput,
  type AgentRunStatus,
  type AgentRunResult,
  type AgentRunError,
  type AgentRunCleanupDiagnostic,
  type AgentRunServiceErrorCode,
  AgentRunToolResultSchema,
  AgentRunInputSchema,
  type AgentRunToolResult,
} from "@task-handoff/protocol/agent-runs";
import { isDeepStrictEqual } from "node:util";
import {
  agentOrchestrationContainsAgent,
  agentOrchestrationEntryAgentIds,
  agentOrchestrationHasEdge,
  type AgentOrchestration,
} from "@task-handoff/protocol/agent-orchestrations";
import { resolveAgentInvocationToolGrant, type AgentInvocationToolGrant } from "@task-handoff/protocol/agent-invocation-tools";
import type { AgentRunRepository } from "../persistence/agent-run-repository.ts";
import type { AgentRunResourceRepository } from "../persistence/agent-run-resource-repository.ts";
import type { AgentRunMemberTransition } from "../persistence/agent-run-repository.ts";
import type { NodeAgentState } from "../state.ts";
import type { AgentDefinitionService, AgentDefinitionChangePublisher } from "./service.ts";
import type { AgentOrchestrationService } from "./orchestration-service.ts";

export type AgentRunExecutionSupport = (input: {
  targetInstanceId: string;
  runtimeType: string;
  providerId: string;
  permissionMode?: string;
  executionPolicy: { workspaceMaterializer: string; processSandbox: string };
}) => boolean;

export type AgentRunExecutionCoordinator = {
  accept(runId: string, memberId: string): void;
  cancel?(runId: string): void;
};

/**
 * Accepts and snapshots Agent Runs. Process scheduling is intentionally a later boundary: a run is
 * persisted only after the current definition target and a registered execution combination resolve.
 */
export class AgentRunService {
  private readonly state: NodeAgentState;
  private readonly definitions: AgentDefinitionService;
  private readonly orchestrations: AgentOrchestrationService;
  private readonly runs: AgentRunRepository;
  private readonly supportsExecution: AgentRunExecutionSupport;
  private readonly publish?: AgentDefinitionChangePublisher;
  private readonly resources?: AgentRunResourceRepository;
  private coordinator?: AgentRunExecutionCoordinator;

  constructor(
    state: NodeAgentState,
    definitions: AgentDefinitionService,
    orchestrations: AgentOrchestrationService,
    runs: AgentRunRepository,
    supportsExecution: AgentRunExecutionSupport,
    publish?: AgentDefinitionChangePublisher,
    resources?: AgentRunResourceRepository,
  ) {
    this.state = state;
    this.definitions = definitions;
    this.orchestrations = orchestrations;
    this.runs = runs;
    this.supportsExecution = supportsExecution;
    this.publish = publish;
    this.resources = resources;
  }

  setCoordinator(coordinator: AgentRunExecutionCoordinator) {
    this.coordinator = coordinator;
  }

  list(): AgentRun[] {
    return this.runs.list().map((run) => this.withSharedSpace(run));
  }

  get(runId: string): AgentRun {
    const run = this.runs.get(runId);
    if (!run) throw agentRunServiceError("AGENT_RUN_NOT_FOUND", `Agent Run ${runId} was not found.`, 404, { runId });
    return this.withSharedSpace(run);
  }

  private withSharedSpace(run: AgentRun): AgentRun {
    const shared = this.resources?.getSharedSpace(run.runId);
    if (!shared) return run;
    return {
      ...run,
      sharedSpace: {
        runtimeId: shared.runtimeId,
        state: shared.state,
        usageBytes: shared.usageBytes,
        quotaBytes: shared.quotaBytes,
        ...(shared.expiresAt ? { expiresAt: shared.expiresAt } : {}),
      },
    };
  }

  getMember(runId: string, memberId: string): AgentRunMember {
    // Resolve the run first so an unknown run cannot be distinguished through member lookup behavior.
    this.get(runId);
    const member = this.runs.getMember(runId, memberId);
    if (!member) {
      throw agentRunServiceError("AGENT_RUN_MEMBER_NOT_FOUND", `Agent Run member ${memberId} was not found.`, 404, { runId, memberId });
    }
    return member;
  }

  transitionMember(runId: string, memberId: string, transition: AgentRunMemberTransition): AgentRunMember {
    const before = this.get(runId);
    const member = this.runs.transitionMember(runId, memberId, transition);
    const run = this.get(runId);
    if (run.revision !== before.revision) this.publishMember(run, member);
    return member;
  }

  /**
   * 成员会话的调用工具授权：只来自 Run 绑定编排中该成员的出边，且目标定义仍然存在。
   * 这只是会话侧的工具面投影；每次调用仍按同一编排图重新校验。
   */
  resolveMemberInvocationTools(runId: string, memberAgentId: string): AgentInvocationToolGrant {
    const run = this.get(runId);
    const orchestration = this.requireOrchestrationForRun(run.orchestrationId);
    const targets = orchestration.edges
      .filter((edge) => edge.fromAgentId === memberAgentId)
      .flatMap((edge) => (this.definitions.has(edge.toAgentId) ? [{ agentId: edge.toAgentId, orchestrationId: orchestration.id }] : []));
    return resolveAgentInvocationToolGrant(targets);
  }

  private requireOrchestrationForRun(orchestrationId: string): AgentOrchestration {
    const orchestration = this.orchestrations.find(orchestrationId);
    if (!orchestration) {
      throw agentRunServiceError(
        "AGENT_RUN_ORCHESTRATION_UNKNOWN",
        `Agent orchestration ${orchestrationId} was not found on this Node Agent.`,
        409,
        { orchestrationId },
      );
    }
    return orchestration;
  }

  create(input: AgentRunCreateInput): AgentRun {
    const parsed = AgentRunCreateInputSchema.parse(input);
    const existing = this.runs.getByClientRequestId(parsed.clientRequestId);
    if (existing) {
      const root = existing.members?.find((member) => member.memberId === existing.rootMemberId);
      const sameRequest = existing.orchestrationId === parsed.orchestrationId
        && (parsed.entryAgentId === undefined || root?.agentId === parsed.entryAgentId)
        && isDeepStrictEqual(existing.input, parsed.input)
        && isDeepStrictEqual(existing.provenance, parsed.provenance)
        && isDeepStrictEqual(existing.budget, effectiveAgentRunBudget(parsed.budget));
      if (sameRequest) return this.withSharedSpace(existing);
      throw agentRunServiceError(
        "AGENT_RUN_IDEMPOTENCY_CONFLICT",
        "The client request id is already associated with a different Agent Run request.",
        409,
        { clientRequestId: parsed.clientRequestId, runId: existing.runId },
      );
    }

    if (parsed.provenance.source !== "control-plane" && !this.state.controlledInstances.get(parsed.provenance.initiatingInstanceId)) {
      throw agentRunServiceError(
        "AGENT_RUN_INITIATING_INSTANCE_UNKNOWN",
        `Initiating instance ${parsed.provenance.initiatingInstanceId} does not belong to this Node Agent.`,
        404,
        { initiatingInstanceId: parsed.provenance.initiatingInstanceId },
      );
    }

    const orchestration = this.requireOrchestrationForRun(parsed.orchestrationId);
    const entryAgentId = resolveAgentRunEntry(orchestration, parsed.entryAgentId);
    const { definition, runtimeType } = this.definitions.resolveExecution(entryAgentId);
    if (!this.supportsExecution({
      targetInstanceId: definition.targetInstanceId,
      runtimeType,
      providerId: definition.providerId,
      permissionMode: definition.permissionMode,
      executionPolicy: definition.executionPolicy,
    })) {
      throw agentRunServiceError(
        "AGENT_RUN_EXECUTION_UNSUPPORTED",
        "The target runtime, workspace materializer, process sandbox, and provider combination is not supported.",
        409,
        {
          agentId: definition.id,
          runtimeType,
          providerId: definition.providerId,
          executionPolicy: definition.executionPolicy,
        },
      );
    }

    const run = this.runs.create({
      clientRequestId: parsed.clientRequestId,
      orchestrationId: orchestration.id,
      input: parsed.input,
      provenance: parsed.provenance,
      budget: effectiveAgentRunBudget(parsed.budget),
      root: {
        agentId: definition.id,
        instanceId: definition.targetInstanceId,
        executionSnapshot: {
          agentRevision: definition.revision,
          targetInstanceId: definition.targetInstanceId,
          cwdFolderId: definition.cwdFolderId,
          appendedPrompt: definition.appendedPrompt,
          providerId: definition.providerId,
          modelEntityId: definition.modelEntityId,
          modelName: definition.modelName,
          modelUpstreamName: definition.modelUpstreamName,
          reasoningEffort: definition.reasoningEffort,
          permissionMode: definition.permissionMode,
          executionPolicy: definition.executionPolicy,
        },
        input: parsed.input,
      },
    });
    this.publishRun(run);
    const rootMember = run.members?.find((member) => member.memberId === run.rootMemberId);
    if (rootMember) this.publishMember(run, rootMember);
    if (rootMember) this.coordinator?.accept(run.runId, rootMember.memberId);
    return this.withSharedSpace(run);
  }

  addMember(input: {
    runId: string;
    parentMemberId: string;
    clientRequestId: string;
    agentId: string;
    input: AgentRunInput;
  }): AgentRunMember {
    // Keep this boundary strict even for internal callers: invocation input is only a prompt.
    // Paths, execution policies, and credentials are definition-owned and never caller-owned.
    const memberInput = AgentRunInputSchema.parse(input.input);
    const run = this.get(input.runId);
    if (run.status !== "running") {
      throw agentRunServiceError("AGENT_RUN_ALREADY_TERMINAL", "Only a running Agent Run can accept another member.", 409, {
        runId: input.runId, status: run.status,
      });
    }
    const parent = this.getMember(input.runId, input.parentMemberId);
    if (parent.status !== "running") {
      throw agentRunServiceError("AGENT_RUN_ALREADY_TERMINAL", "Only a running Agent Run member can invoke another Agent.", 409, {
        runId: input.runId, memberId: input.parentMemberId, status: parent.status,
      });
    }
    // 授权来源是 Run 绑定编排的当前图：撤边、删节点或删除编排立即拒绝后续调用。
    const orchestration = this.requireOrchestrationForRun(run.orchestrationId);
    if (!agentOrchestrationHasEdge(orchestration, parent.agentId, input.agentId)) {
      throw agentRunServiceError("AGENT_RUN_INVOCATION_FORBIDDEN", "The caller Agent is not authorized to invoke the target Agent in this orchestration.", 403, {
        runId: input.runId, memberId: input.parentMemberId, agentId: input.agentId, orchestrationId: orchestration.id,
      });
    }
    const { definition, runtimeType } = this.definitions.resolveExecution(input.agentId);
    if (!this.supportsExecution({
      targetInstanceId: definition.targetInstanceId,
      runtimeType,
      providerId: definition.providerId,
      permissionMode: definition.permissionMode,
      executionPolicy: definition.executionPolicy,
    })) {
      throw agentRunServiceError("AGENT_RUN_EXECUTION_UNSUPPORTED", "The callee execution combination has not passed behavior probing.", 409, {
        agentId: definition.id, runtimeType, providerId: definition.providerId, executionPolicy: definition.executionPolicy,
      });
    }
    const member = this.runs.addMember({
      runId: run.runId,
      parentMemberId: parent.memberId,
      clientRequestId: input.clientRequestId,
      agentId: definition.id,
      instanceId: definition.targetInstanceId,
      input: memberInput,
      executionSnapshot: {
        agentRevision: definition.revision,
        targetInstanceId: definition.targetInstanceId,
        cwdFolderId: definition.cwdFolderId,
        appendedPrompt: definition.appendedPrompt,
        providerId: definition.providerId,
        modelEntityId: definition.modelEntityId,
        modelName: definition.modelName,
        modelUpstreamName: definition.modelUpstreamName,
        reasoningEffort: definition.reasoningEffort,
        permissionMode: definition.permissionMode,
        executionPolicy: definition.executionPolicy,
      },
    });
    const updatedRun = this.get(run.runId);
    const policyDifference = {
      permissionModeChanged: parent.executionSnapshot.permissionMode !== definition.permissionMode,
      workspaceMaterializerChanged: parent.executionSnapshot.executionPolicy.workspaceMaterializer !== definition.executionPolicy.workspaceMaterializer,
      processSandboxChanged: parent.executionSnapshot.executionPolicy.processSandbox !== definition.executionPolicy.processSandbox,
      providerChanged: parent.executionSnapshot.providerId !== definition.providerId,
    };
    if (Object.values(policyDifference).some(Boolean)) {
      this.appendTimeline(run.runId, "member.policy-difference", {
        memberId: member.memberId,
        data: { parentMemberId: parent.memberId, ...policyDifference },
      });
    }
    this.publishMember(updatedRun, member);
    if (member.status === "queued") this.coordinator?.accept(run.runId, member.memberId);
    return member;
  }

  transitionRun(runId: string, transition: {
    status: AgentRunStatus;
    result?: AgentRunResult | null;
    error?: AgentRunError | null;
    cleanup?: AgentRunCleanupDiagnostic | null;
  }) {
    const run = this.runs.transitionRun(runId, transition);
    this.publishRun(run);
    return this.withSharedSpace(run);
  }

  appendTimeline(runId: string, kind: string, input: { memberId?: string; data?: Record<string, unknown> } = {}) {
    const entry = this.runs.appendTimeline({ runId, kind, ...input });
    this.publishRun(this.get(runId));
    return entry;
  }

  toolResult(runId: string): AgentRunToolResult | undefined {
    const run = this.get(runId);
    if (!AGENT_RUN_TERMINAL_STATUSES.has(run.status)) return undefined;
    if (run.status === "completed") {
      const text = run.result?.text ?? "";
      const bounded = text.slice(0, AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS);
      return AgentRunToolResultSchema.parse({
        runId,
        status: "completed",
        result: {
          text: bounded,
          truncated: Boolean(run.result?.truncated) || bounded.length < text.length,
        },
      });
    }
    return AgentRunToolResultSchema.parse({
      runId,
      status: run.status,
      error: run.error ?? {
        code: run.status === "cancelled" ? "AGENT_RUN_CANCELLED" : "AGENT_RUN_FAILED",
        message: run.status === "cancelled" ? "The Agent Run was cancelled." : "The Agent Run failed.",
        retryable: false,
      },
    });
  }

  async waitForToolResult(runId: string, signal?: AbortSignal, timeoutMs = 30 * 60 * 1_000): Promise<AgentRunToolResult> {
    const startedAt = Date.now();
    while (true) {
      const result = this.toolResult(runId);
      if (result) return result;
      if (signal?.aborted) throw agentRunServiceError("AGENT_RUN_ALREADY_TERMINAL", "Waiting for the Agent Run result was aborted.", 499, { runId });
      if (Date.now() - startedAt >= timeoutMs) {
        return AgentRunToolResultSchema.parse({
          runId,
          status: "failed",
          error: { code: "AGENT_RUN_RESULT_TIMEOUT", message: "The Agent Run did not reach a terminal state before the tool timeout.", retryable: true },
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  async waitForMemberToolResult(runId: string, memberId: string, signal?: AbortSignal, timeoutMs = 30 * 60 * 1_000): Promise<AgentRunToolResult> {
    const startedAt = Date.now();
    while (true) {
      const member = this.getMember(runId, memberId);
      if (AGENT_RUN_TERMINAL_STATUSES.has(member.status)) {
        if (member.status === "completed") {
          const text = member.result?.text ?? "";
          const bounded = text.slice(0, AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS);
          return AgentRunToolResultSchema.parse({
            runId,
            status: "completed",
            result: { text: bounded, truncated: Boolean(member.result?.truncated) || bounded.length < text.length },
          });
        }
        return AgentRunToolResultSchema.parse({
          runId,
          status: member.status,
          error: member.error ?? {
            code: member.status === "cancelled" ? "AGENT_RUN_MEMBER_CANCELLED" : "AGENT_RUN_MEMBER_FAILED",
            message: member.status === "cancelled" ? "The Agent Run member was cancelled." : "The Agent Run member failed.",
            retryable: false,
          },
        });
      }
      if (signal?.aborted) throw agentRunServiceError("AGENT_RUN_ALREADY_TERMINAL", "Waiting for the Agent Run member was aborted.", 499, { runId, memberId });
      if (Date.now() - startedAt >= timeoutMs) {
        return AgentRunToolResultSchema.parse({
          runId,
          status: "failed",
          error: { code: "AGENT_RUN_MEMBER_RESULT_TIMEOUT", message: "The Agent Run member did not finish before the tool timeout.", retryable: true },
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  cancel(runId: string, input: unknown): AgentRun {
    const parsed = AgentRunCancelInputSchema.parse(input);
    const current = this.get(runId);
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== current.revision) {
      throw agentRunServiceError("AGENT_RUN_REVISION_CONFLICT", "Agent Run changed since it was read.", 409, {
        runId,
        expectedRevision: parsed.expectedRevision,
        actualRevision: current.revision,
      });
    }
    if (current.status === "finalizing") return current;
    if (AGENT_RUN_TERMINAL_STATUSES.has(current.status)) {
      throw agentRunServiceError("AGENT_RUN_ALREADY_TERMINAL", "A terminal Agent Run cannot be cancelled.", 409, {
        runId,
        status: current.status,
      });
    }
    const run = this.runs.transitionRun(runId, { status: "finalizing" });
    this.coordinator?.cancel?.(runId);
    this.publishRun(run);
    return this.withSharedSpace(run);
  }

  private publishRun(run: AgentRun) {
    run = this.withSharedSpace(run);
    this.publish?.("agent.run.changed", { runId: run.runId, revision: run.revision, run }, {});
  }

  private publishMember(run: AgentRun, member: AgentRunMember) {
    this.publish?.(
      "agent.run.member.changed",
      { runId: run.runId, memberId: member.memberId, revision: run.revision, member },
      { instanceId: member.instanceId },
    );
  }
}

/** Client requests may lower a run budget, but the Node policy is the authoritative upper bound. */
export function effectiveAgentRunBudget(requested?: AgentRunBudget): AgentRunBudget {
  if (!requested) return { ...AGENT_RUN_DEFAULT_BUDGET };
  return {
    maxMembers: Math.min(requested.maxMembers, AGENT_RUN_DEFAULT_BUDGET.maxMembers),
    maxDepth: Math.min(requested.maxDepth, AGENT_RUN_DEFAULT_BUDGET.maxDepth),
    maxConcurrency: Math.min(requested.maxConcurrency, AGENT_RUN_DEFAULT_BUDGET.maxConcurrency),
  };
}

/**
 * 运行入口是编排内的任意节点：顶级节点只是缺省入口。只有一个顶级节点时可以省略 entryAgentId，
 * 多顶级节点必须显式指定，避免用不确定的默认值启动运行。
 */
export function resolveAgentRunEntry(orchestration: AgentOrchestration, entryAgentId?: string): string {
  if (entryAgentId) {
    if (!agentOrchestrationContainsAgent(orchestration, entryAgentId)) {
      throw agentRunServiceError(
        "AGENT_RUN_ENTRY_INVALID",
        `Agent ${entryAgentId} is not part of orchestration ${orchestration.id}.`,
        409,
        { orchestrationId: orchestration.id, entryAgentId },
      );
    }
    return entryAgentId;
  }
  const entries = agentOrchestrationEntryAgentIds(orchestration);
  if (entries.length !== 1) {
    throw agentRunServiceError(
      "AGENT_RUN_ENTRY_REQUIRED",
      "The orchestration has multiple entry Agents; the request must name one.",
      409,
      { orchestrationId: orchestration.id, entryAgentIds: entries },
    );
  }
  return entries[0]!;
}

export function agentRunServiceError(
  code: AgentRunServiceErrorCode,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>,
) {
  if (!AGENT_RUN_SERVICE_ERROR_CODES.includes(code)) throw new Error(`Unknown Agent Run service error code ${code}.`);
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}
