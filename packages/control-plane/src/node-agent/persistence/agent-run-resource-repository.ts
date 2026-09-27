import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export type AgentRunSharedSpaceState = "preparing" | "active" | "retained" | "expiring" | "delete-retrying" | "expired" | "manual-intervention";
export type AgentRunResourcePhase = "preparing" | "ready" | "deleting" | "delete-retrying" | "deleted" | "manual-intervention";
export type AgentRunResourceKind = "provider-thread" | "overlay-mount" | "overlay-run-directory" | "shared-space-directory" | "helper-container" | "sandbox-container";

export type AgentRunSharedSpaceRecord = {
  runId: string;
  runtimeId: string;
  generationId: string;
  state: AgentRunSharedSpaceState;
  quotaBytes: number;
  usageBytes: number;
  expiresAt?: string;
  diagnostics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunResourceRecord = {
  resourceId: string;
  runId: string;
  memberId?: string;
  instanceId?: string;
  runtimeId: string;
  kind: AgentRunResourceKind;
  generationId: string;
  backendIdentity: string;
  phase: AgentRunResourcePhase;
  cleanupAttempts: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function json(value: unknown) { return JSON.stringify(value ?? {}); }
function parsedObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function conflict(code: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode: 409, ...(details ? { details } : {}) });
}

export class AgentRunResourceRepository {
  private readonly client: DatabaseSync;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  ensureSharedSpace(input: {
    runId: string;
    runtimeId: string;
    generationId: string;
    quotaBytes: number;
    timestamp?: string;
  }): AgentRunSharedSpaceRecord {
    const existing = this.getSharedSpace(input.runId);
    if (existing) {
      if (existing.runtimeId !== input.runtimeId || existing.generationId !== input.generationId || existing.quotaBytes !== input.quotaBytes) {
        throw conflict("AGENT_RUN_SHARED_SPACE_IDENTITY_MISMATCH", "The existing shared space has different runtime ownership.", { runId: input.runId });
      }
      return existing;
    }
    const timestamp = input.timestamp ?? new Date().toISOString();
    this.client.prepare(`INSERT INTO na_agent_run_shared_spaces
      (run_id, runtime_id, generation_id, state, quota_bytes, usage_bytes, diagnostics_json, created_at, updated_at)
      VALUES (?, ?, ?, 'preparing', ?, 0, '{}', ?, ?)`).run(
      input.runId, input.runtimeId, input.generationId, input.quotaBytes, timestamp, timestamp,
    );
    return this.getSharedSpace(input.runId)!;
  }

  getSharedSpace(runId: string): AgentRunSharedSpaceRecord | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_run_shared_spaces WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? this.sharedSpaceFromRow(row) : undefined;
  }

  listSharedSpaces(input: { runtimeId?: string; expiredBefore?: string } = {}): AgentRunSharedSpaceRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.runtimeId) { clauses.push("runtime_id = ?"); values.push(input.runtimeId); }
    if (input.expiredBefore) { clauses.push("expires_at IS NOT NULL AND expires_at <= ?"); values.push(input.expiredBefore); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.client.prepare(`SELECT * FROM na_agent_run_shared_spaces${where} ORDER BY updated_at, run_id`).all(...values) as Row[])
      .map((row) => this.sharedSpaceFromRow(row));
  }

  runtimeSharedSpaceUsage(runtimeId: string, excludingRunId?: string): number {
    const row = excludingRunId
      ? this.client.prepare("SELECT COALESCE(SUM(usage_bytes), 0) AS usage FROM na_agent_run_shared_spaces WHERE runtime_id = ? AND run_id != ? AND state NOT IN ('expired','manual-intervention')").get(runtimeId, excludingRunId) as Row
      : this.client.prepare("SELECT COALESCE(SUM(usage_bytes), 0) AS usage FROM na_agent_run_shared_spaces WHERE runtime_id = ? AND state NOT IN ('expired','manual-intervention')").get(runtimeId) as Row;
    return Number(row?.usage ?? 0);
  }

  updateSharedSpace(runId: string, patch: {
    state?: AgentRunSharedSpaceState;
    usageBytes?: number;
    expiresAt?: string | null;
    diagnostics?: Record<string, unknown>;
    timestamp?: string;
  }): AgentRunSharedSpaceRecord {
    const current = this.getSharedSpace(runId);
    if (!current) throw conflict("AGENT_RUN_SHARED_SPACE_NOT_FOUND", "The Agent Run shared space was not found.", { runId });
    const timestamp = patch.timestamp ?? new Date().toISOString();
    this.client.prepare(`UPDATE na_agent_run_shared_spaces SET state = ?, usage_bytes = ?, expires_at = ?,
      diagnostics_json = ?, updated_at = ? WHERE run_id = ?`).run(
      patch.state ?? current.state,
      patch.usageBytes ?? current.usageBytes,
      patch.expiresAt === null ? null : patch.expiresAt ?? current.expiresAt ?? null,
      json(patch.diagnostics ?? current.diagnostics),
      timestamp,
      runId,
    );
    return this.getSharedSpace(runId)!;
  }

  register(input: {
    runId: string;
    memberId?: string;
    instanceId?: string;
    runtimeId: string;
    kind: AgentRunResourceKind;
    generationId: string;
    backendIdentity: string;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  }): AgentRunResourceRecord {
    const existing = this.client.prepare(
      "SELECT * FROM na_agent_run_resources WHERE run_id = ? AND kind = ? AND backend_identity = ?",
    ).get(input.runId, input.kind, input.backendIdentity) as Row | undefined;
    if (existing) {
      const record = this.resourceFromRow(existing);
      if (record.memberId !== input.memberId || record.instanceId !== input.instanceId
        || record.runtimeId !== input.runtimeId || record.generationId !== input.generationId) {
        throw conflict("AGENT_RUN_RESOURCE_IDENTITY_MISMATCH", "The existing runtime resource has different ownership.", { resourceId: record.resourceId });
      }
      return record;
    }
    const timestamp = input.timestamp ?? new Date().toISOString();
    const resourceId = `resource_${crypto.randomBytes(10).toString("hex")}`;
    this.client.prepare(`INSERT INTO na_agent_run_resources
      (resource_id, run_id, member_id, instance_id, runtime_id, kind, generation_id, backend_identity,
       phase, cleanup_attempts, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?)`).run(
      resourceId, input.runId, input.memberId ?? null, input.instanceId ?? null, input.runtimeId, input.kind,
      input.generationId, input.backendIdentity, json(input.metadata), timestamp, timestamp,
    );
    return this.get(resourceId)!;
  }

  get(resourceId: string): AgentRunResourceRecord | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_run_resources WHERE resource_id = ?").get(resourceId) as Row | undefined;
    return row ? this.resourceFromRow(row) : undefined;
  }

  listForRun(runId: string) {
    return (this.client.prepare("SELECT * FROM na_agent_run_resources WHERE run_id = ? ORDER BY created_at, resource_id").all(runId) as Row[])
      .map((row) => this.resourceFromRow(row));
  }

  listActiveForInstance(instanceId: string) {
    return (this.client.prepare(`SELECT * FROM na_agent_run_resources WHERE instance_id = ?
      AND phase NOT IN ('deleted','manual-intervention') ORDER BY created_at, resource_id`).all(instanceId) as Row[])
      .map((row) => this.resourceFromRow(row));
  }

  transition(resourceId: string, phase: AgentRunResourcePhase, input: {
    incrementCleanupAttempts?: boolean;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  } = {}): AgentRunResourceRecord {
    const current = this.get(resourceId);
    if (!current) throw conflict("AGENT_RUN_RESOURCE_NOT_FOUND", "The Agent Run resource was not found.", { resourceId });
    this.client.prepare(`UPDATE na_agent_run_resources SET phase = ?, cleanup_attempts = ?, metadata_json = ?,
      updated_at = ? WHERE resource_id = ?`).run(
      phase,
      current.cleanupAttempts + (input.incrementCleanupAttempts ? 1 : 0),
      json(input.metadata ?? current.metadata),
      input.timestamp ?? new Date().toISOString(),
      resourceId,
    );
    return this.get(resourceId)!;
  }

  private sharedSpaceFromRow(row: Row): AgentRunSharedSpaceRecord {
    return {
      runId: String(row.run_id), runtimeId: String(row.runtime_id), generationId: String(row.generation_id),
      state: row.state as AgentRunSharedSpaceState, quotaBytes: Number(row.quota_bytes), usageBytes: Number(row.usage_bytes),
      expiresAt: row.expires_at == null ? undefined : String(row.expires_at), diagnostics: parsedObject(row.diagnostics_json),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private resourceFromRow(row: Row): AgentRunResourceRecord {
    return {
      resourceId: String(row.resource_id), runId: String(row.run_id),
      memberId: row.member_id == null ? undefined : String(row.member_id),
      instanceId: row.instance_id == null ? undefined : String(row.instance_id), runtimeId: String(row.runtime_id),
      kind: row.kind as AgentRunResourceKind, generationId: String(row.generation_id), backendIdentity: String(row.backend_identity),
      phase: row.phase as AgentRunResourcePhase, cleanupAttempts: Number(row.cleanup_attempts), metadata: parsedObject(row.metadata_json),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
