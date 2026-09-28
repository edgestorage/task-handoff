import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "./transaction-journal.ts";
import { isDeepStrictEqual } from "node:util";
import {
  AGENT_RUN_TERMINAL_STATUSES,
  canTransitionAgentRunStatus,
  sanitizeAgentRun,
  sanitizeAgentRunMember,
  sanitizeAgentRunTimelineEntry,
  type AgentRun,
  type AgentRunBudget,
  type AgentRunCleanupDiagnostic,
  type AgentRunError,
  type AgentRunInput,
  type AgentRunMember,
  type AgentRunMemberExecutionSnapshot,
  type AgentRunProvenance,
  type AgentRunResult,
  type AgentRunResultDelivery,
  type AgentRunStatus,
  type AgentRunTimelineEntry,
} from "@task-handoff/protocol/agent-runs";
import { defaultAgentOrchestrationId } from "@task-handoff/protocol/agent-orchestrations";

type Row = Record<string, unknown>;

export type CreateAgentRunInput = {
  clientRequestId: string;
  orchestrationId: string;
  input: AgentRunInput;
  provenance: AgentRunProvenance;
  budget: AgentRunBudget;
  root: {
    agentId: string;
    instanceId: string;
    aiSessionId?: string;
    executionSnapshot: AgentRunMemberExecutionSnapshot;
    input?: AgentRunInput;
  };
  timestamp?: string;
};

export type AddAgentRunMemberInput = {
  runId: string;
  clientRequestId: string;
  parentMemberId: string;
  agentId: string;
  instanceId: string;
  aiSessionId?: string;
  executionSnapshot: AgentRunMemberExecutionSnapshot;
  input: AgentRunInput;
  timestamp?: string;
};

export type AgentRunTransition = {
  status: AgentRunStatus;
  result?: AgentRunResult | null;
  resultDelivery?: AgentRunResultDelivery | null;
  error?: AgentRunError | null;
  cleanup?: AgentRunCleanupDiagnostic | null;
  timestamp?: string;
};

export type AgentRunMemberTransition = {
  status: AgentRunStatus;
  result?: AgentRunResult | null;
  error?: AgentRunError | null;
  aiSessionId?: string | null;
  timestamp?: string;
};

export type AppendAgentRunTimelineInput = {
  runId: string;
  kind: string;
  memberId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
};

function now(timestamp?: string) {
  return timestamp ?? new Date().toISOString();
}

function id(prefix: "run" | "member") {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

function repositoryError(code: string, message: string, statusCode: number, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}

function assertSnapshotInstance(instanceId: string, snapshot: AgentRunMemberExecutionSnapshot) {
  if (snapshot.targetInstanceId !== instanceId) {
    throw repositoryError(
      "AGENT_RUN_SNAPSHOT_INSTANCE_MISMATCH",
      "The member instance does not match its immutable execution snapshot.",
      409,
      { instanceId, snapshotInstanceId: snapshot.targetInstanceId },
    );
  }
}

export class AgentRunRepository {
  private readonly client: DatabaseSync;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  transaction<T>(operation: () => T): T {
    return runInTransaction(this.client, operation);
  }

  create(input: CreateAgentRunInput): AgentRun {
    return runInTransaction(this.client, () => {
      const existing = this.getByClientRequestId(input.clientRequestId);
      if (existing) {
        const root = existing.members?.find((member) => member.memberId === existing.rootMemberId);
        const sameRequest = existing.orchestrationId === input.orchestrationId
          && root?.agentId === input.root.agentId
          && root.instanceId === input.root.instanceId
          && isDeepStrictEqual(root.executionSnapshot, input.root.executionSnapshot)
          && isDeepStrictEqual(existing.input, input.input)
          && isDeepStrictEqual(existing.provenance, input.provenance)
          && isDeepStrictEqual(existing.budget, input.budget);
        if (sameRequest) return existing;
        throw repositoryError(
          "AGENT_RUN_IDEMPOTENCY_CONFLICT",
          "The client request id is already associated with a different Agent Run request.",
          409,
          { clientRequestId: input.clientRequestId, runId: existing.runId },
        );
      }
      assertSnapshotInstance(input.root.instanceId, input.root.executionSnapshot);

      const runId = id("run");
      const rootMemberId = id("member");
      const timestamp = now(input.timestamp);
      this.client.prepare(`INSERT INTO na_agent_runs
        (run_id, client_request_id, revision, status, input_json, provenance_json, orchestration_id, root_member_id, budget_json,
         result_json, error_json, cleanup_json, created_at, updated_at, completed_at)
        VALUES (?, ?, 0, 'queued', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`)
        .run(runId, input.clientRequestId, json(input.input), json(input.provenance), input.orchestrationId, rootMemberId, json(input.budget), timestamp, timestamp);
      this.client.prepare(`INSERT INTO na_agent_run_members
        (member_id, run_id, client_request_id, agent_id, parent_member_id, instance_id, ai_session_id, role, depth, status,
         input_json, execution_snapshot_json, result_json, error_json, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, 'root', 0, 'queued', ?, ?, NULL, NULL, ?, ?, NULL)`)
        .run(rootMemberId, runId, input.clientRequestId, input.root.agentId, input.root.instanceId, input.root.aiSessionId ?? null,
          json(input.root.input ?? input.input), json(input.root.executionSnapshot), timestamp, timestamp);
      return this.require(runId);
    });
  }

  list(): AgentRun[] {
    const rows = this.client.prepare("SELECT run_id FROM na_agent_runs ORDER BY created_at DESC, run_id DESC").all() as Row[];
    return rows.map((row) => this.require(String(row.run_id)));
  }

  get(runId: string): AgentRun | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  getByClientRequestId(clientRequestId: string): AgentRun | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_runs WHERE client_request_id = ?").get(clientRequestId) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  addMember(input: AddAgentRunMemberInput): AgentRunMember {
    return runInTransaction(this.client, () => {
      const run = this.require(input.runId);
      if (AGENT_RUN_TERMINAL_STATUSES.has(run.status)) {
        throw repositoryError("AGENT_RUN_TERMINAL", "A terminal run cannot accept another member.", 409, { runId: input.runId, status: run.status });
      }
      const parent = this.getMember(input.runId, input.parentMemberId);
      if (!parent) {
        throw repositoryError("AGENT_RUN_PARENT_MEMBER_NOT_FOUND", "The parent member does not belong to this run.", 404, {
          runId: input.runId,
          parentMemberId: input.parentMemberId,
        });
      }
      const existingRow = this.client.prepare(
        "SELECT * FROM na_agent_run_members WHERE run_id = ? AND client_request_id = ?",
      ).get(input.runId, input.clientRequestId) as Row | undefined;
      if (existingRow) {
        const existing = this.memberFromRow(existingRow);
        if (existing.parentMemberId === input.parentMemberId
          && existing.agentId === input.agentId
          && existing.instanceId === input.instanceId
          && isDeepStrictEqual(existing.input, input.input)
          && isDeepStrictEqual(existing.executionSnapshot, input.executionSnapshot)) return existing;
        throw repositoryError("AGENT_RUN_MEMBER_IDEMPOTENCY_CONFLICT", "The member client request id is already associated with another invocation.", 409, {
          runId: input.runId, clientRequestId: input.clientRequestId, memberId: existing.memberId,
        });
      }
      const memberCount = Number((this.client.prepare("SELECT COUNT(*) AS count FROM na_agent_run_members WHERE run_id = ?").get(input.runId) as Row).count);
      if (memberCount >= run.budget.maxMembers) {
        throw repositoryError("AGENT_RUN_MEMBER_BUDGET_EXCEEDED", "The run member budget is exhausted.", 409, {
          runId: input.runId,
          maxMembers: run.budget.maxMembers,
        });
      }
      const depth = parent.depth + 1;
      if (depth > run.budget.maxDepth) {
        throw repositoryError("AGENT_RUN_DEPTH_BUDGET_EXCEEDED", "The run call depth budget is exhausted.", 409, {
          runId: input.runId,
          maxDepth: run.budget.maxDepth,
          requestedDepth: depth,
        });
      }
      assertSnapshotInstance(input.instanceId, input.executionSnapshot);

      const memberId = id("member");
      const timestamp = now(input.timestamp);
      this.client.prepare(`INSERT INTO na_agent_run_members
        (member_id, run_id, client_request_id, agent_id, parent_member_id, instance_id, ai_session_id, role, depth, status,
         input_json, execution_snapshot_json, result_json, error_json, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'callee', ?, 'queued', ?, ?, NULL, NULL, ?, ?, NULL)`)
        .run(memberId, input.runId, input.clientRequestId, input.agentId, input.parentMemberId, input.instanceId, input.aiSessionId ?? null,
          depth, json(input.input), json(input.executionSnapshot), timestamp, timestamp);
      this.bumpRevision(input.runId, timestamp);
      return this.requireMember(input.runId, memberId);
    });
  }

  getMember(runId: string, memberId: string): AgentRunMember | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_run_members WHERE run_id = ? AND member_id = ?").get(runId, memberId) as Row | undefined;
    return row ? this.memberFromRow(row) : undefined;
  }

  transitionRun(runId: string, transition: AgentRunTransition): AgentRun {
    return runInTransaction(this.client, () => {
      const current = this.require(runId);
      this.assertTransition(current.status, transition.status, { runId });
      const timestamp = now(transition.timestamp);
      const result = "result" in transition ? transition.result ?? undefined : current.result;
      const resultDelivery = "resultDelivery" in transition ? transition.resultDelivery ?? undefined : current.resultDelivery;
      const error = "error" in transition ? transition.error ?? undefined : current.error;
      const cleanup = "cleanup" in transition ? transition.cleanup ?? undefined : current.cleanup;
      const completedAt = AGENT_RUN_TERMINAL_STATUSES.has(transition.status) ? current.completedAt ?? timestamp : undefined;
      const changed = transition.status !== current.status
        || json(result ?? null) !== json(current.result ?? null)
        || json(resultDelivery ?? null) !== json(current.resultDelivery ?? null)
        || json(error ?? null) !== json(current.error ?? null)
        || json(cleanup ?? null) !== json(current.cleanup ?? null);
      if (!changed) return current;

      this.client.prepare(`UPDATE na_agent_runs SET status = ?, revision = revision + 1,
        result_json = ?, result_delivery_json = ?, error_json = ?, cleanup_json = ?, updated_at = ?, completed_at = ? WHERE run_id = ?`)
        .run(transition.status, result ? json(result) : null, resultDelivery ? json(resultDelivery) : null,
          error ? json(error) : null, cleanup ? json(cleanup) : null,
          timestamp, completedAt ?? null, runId);
      return this.require(runId);
    });
  }

  transitionMember(runId: string, memberId: string, transition: AgentRunMemberTransition): AgentRunMember {
    return runInTransaction(this.client, () => {
      const current = this.requireMember(runId, memberId);
      this.assertTransition(current.status, transition.status, { runId, memberId });
      const timestamp = now(transition.timestamp);
      const result = "result" in transition ? transition.result ?? undefined : current.result;
      const error = "error" in transition ? transition.error ?? undefined : current.error;
      const aiSessionId = "aiSessionId" in transition ? transition.aiSessionId ?? undefined : current.aiSessionId;
      const completedAt = AGENT_RUN_TERMINAL_STATUSES.has(transition.status) ? current.completedAt ?? timestamp : undefined;
      const changed = transition.status !== current.status
        || json(result ?? null) !== json(current.result ?? null)
        || json(error ?? null) !== json(current.error ?? null)
        || aiSessionId !== current.aiSessionId;
      if (!changed) return current;

      this.client.prepare(`UPDATE na_agent_run_members SET status = ?, result_json = ?, error_json = ?,
        ai_session_id = ?, updated_at = ?, completed_at = ? WHERE run_id = ? AND member_id = ?`)
        .run(transition.status, result ? json(result) : null, error ? json(error) : null, aiSessionId ?? null,
          timestamp, completedAt ?? null, runId, memberId);
      this.bumpRevision(runId, timestamp);
      return this.requireMember(runId, memberId);
    });
  }

  appendTimeline(input: AppendAgentRunTimelineInput): AgentRunTimelineEntry {
    return runInTransaction(this.client, () => {
      this.require(input.runId);
      if (input.memberId && !this.getMember(input.runId, input.memberId)) {
        throw repositoryError("AGENT_RUN_TIMELINE_MEMBER_NOT_FOUND", "The timeline member does not belong to this run.", 404, {
          runId: input.runId,
          memberId: input.memberId,
        });
      }
      const sequence = Number((this.client.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM na_agent_run_timeline WHERE run_id = ?",
      ).get(input.runId) as Row).sequence);
      const timestamp = now(input.timestamp);
      this.client.prepare(`INSERT INTO na_agent_run_timeline
        (run_id, sequence, timestamp, kind, member_id, data_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.runId, sequence, timestamp, input.kind, input.memberId ?? null, json(input.data ?? {}));
      this.bumpRevision(input.runId, timestamp);
      const row = this.client.prepare("SELECT * FROM na_agent_run_timeline WHERE run_id = ? AND sequence = ?")
        .get(input.runId, sequence) as Row;
      return this.timelineFromRow(row);
    });
  }

  private bumpRevision(runId: string, timestamp: string) {
    this.client.prepare("UPDATE na_agent_runs SET revision = revision + 1, updated_at = ? WHERE run_id = ?").run(timestamp, runId);
  }

  private assertTransition(from: AgentRunStatus, to: AgentRunStatus, details: Record<string, unknown>) {
    if (!canTransitionAgentRunStatus(from, to)) {
      throw repositoryError("AGENT_RUN_STATUS_TRANSITION_INVALID", `Cannot transition Agent Run status from ${from} to ${to}.`, 409, {
        ...details,
        from,
        to,
      });
    }
  }

  private require(runId: string): AgentRun {
    const run = this.get(runId);
    if (!run) throw repositoryError("AGENT_RUN_NOT_FOUND", "Agent Run was not found.", 404, { runId });
    return run;
  }

  private requireMember(runId: string, memberId: string): AgentRunMember {
    const member = this.getMember(runId, memberId);
    if (!member) throw repositoryError("AGENT_RUN_MEMBER_NOT_FOUND", "Agent Run member was not found.", 404, { runId, memberId });
    return member;
  }

  private runFromRow(row: Row): AgentRun {
    const runId = String(row.run_id);
    const members = (this.client.prepare("SELECT * FROM na_agent_run_members WHERE run_id = ? ORDER BY created_at, member_id").all(runId) as Row[])
      .map((member) => this.memberFromRow(member));
    const timeline = (this.client.prepare("SELECT * FROM na_agent_run_timeline WHERE run_id = ? ORDER BY sequence").all(runId) as Row[])
      .map((entry) => this.timelineFromRow(entry));
    // 迁移会为既有运行回填编排绑定；未回填的历史行按根成员的默认编排归一，与迁移前的行为一致。
    const orchestrationId = row.orchestration_id == null || String(row.orchestration_id).length === 0
      ? (() => {
        const root = members.find((member) => member.memberId === String(row.root_member_id));
        return root ? defaultAgentOrchestrationId(root.agentId) : undefined;
      })()
      : String(row.orchestration_id);
    try {
      return sanitizeAgentRun({
        runId,
        clientRequestId: row.client_request_id,
        revision: row.revision,
        status: row.status,
        input: row.input_json == null ? undefined : parseJson(row.input_json),
        provenance: parseJson(row.provenance_json),
        orchestrationId,
        rootMemberId: row.root_member_id,
        budget: parseJson(row.budget_json),
        result: row.result_json == null ? undefined : parseJson(row.result_json),
        resultDelivery: row.result_delivery_json == null ? undefined : parseJson(row.result_delivery_json),
        error: row.error_json == null ? undefined : parseJson(row.error_json),
        cleanup: row.cleanup_json == null ? undefined : parseJson(row.cleanup_json),
        members,
        timeline,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at ?? undefined,
      });
    } catch (cause) {
      throw repositoryError("NODE_AGENT_AGENT_RUN_INVALID", "Stored Agent Run cannot be parsed with the current model.", 500, {
        runId,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private memberFromRow(row: Row): AgentRunMember {
    try {
      return sanitizeAgentRunMember({
        memberId: row.member_id,
        runId: row.run_id,
        agentId: row.agent_id,
        parentMemberId: row.parent_member_id ?? undefined,
        instanceId: row.instance_id,
        aiSessionId: row.ai_session_id ?? undefined,
        role: row.role,
        depth: row.depth,
        status: row.status,
        input: row.input_json == null ? undefined : parseJson(row.input_json),
        executionSnapshot: parseJson(row.execution_snapshot_json),
        result: row.result_json == null ? undefined : parseJson(row.result_json),
        error: row.error_json == null ? undefined : parseJson(row.error_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at ?? undefined,
      });
    } catch (cause) {
      throw repositoryError("NODE_AGENT_AGENT_RUN_MEMBER_INVALID", "Stored Agent Run member cannot be parsed with the current model.", 500, {
        runId: row.run_id,
        memberId: row.member_id,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private timelineFromRow(row: Row): AgentRunTimelineEntry {
    try {
      return sanitizeAgentRunTimelineEntry({
        runId: row.run_id,
        sequence: row.sequence,
        timestamp: row.timestamp,
        kind: row.kind,
        memberId: row.member_id ?? undefined,
        data: parseJson(row.data_json),
      });
    } catch (cause) {
      throw repositoryError("NODE_AGENT_AGENT_RUN_TIMELINE_INVALID", "Stored Agent Run timeline entry cannot be parsed with the current model.", 500, {
        runId: row.run_id,
        sequence: row.sequence,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
