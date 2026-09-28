import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { registerAfterCommit, runInTransaction } from "./transaction-journal.ts";
import {
  normalizeAgentOrchestrationGraph,
  sanitizeAgentOrchestration,
  type AgentOrchestration,
  type AgentOrchestrationEdge,
} from "@task-handoff/protocol/agent-orchestrations";

type Row = Record<string, unknown>;

const AGENT_ORCHESTRATION_COLUMNS = new Set(["id", "name", "revision", "created_at", "updated_at"]);
const AGENT_ORCHESTRATION_REVISION_PATTERN = /^[a-f0-9]{64}$/;

export type AgentOrchestrationDiagnostic = (message: string, details: Record<string, unknown>) => void;

export type AgentOrchestrationContent = {
  name: string;
  agentIds: string[];
  edges: AgentOrchestrationEdge[];
};

export type AgentOrchestrationMutationResult =
  | { status: "updated"; orchestration: AgentOrchestration }
  | { status: "revision-conflict"; orchestration: AgentOrchestration }
  | { status: "missing" };

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

/**
 * 内容哈希即 revision：只有名称或图形变化才产生新 revision，调用方据此做乐观并发控制。
 * 图形的节点与边先归一（去重、排序），提交顺序不影响结果。
 */
export function agentOrchestrationRevision(content: AgentOrchestrationContent) {
  const graph = normalizeAgentOrchestrationGraph(content);
  return crypto.createHash("sha256").update(json([content.name, graph.agentIds, graph.edges])).digest("hex");
}

export class AgentOrchestrationRepository {
  private readonly client: DatabaseSync;
  private diagnostic?: AgentOrchestrationDiagnostic;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  setDiagnostic(sink: AgentOrchestrationDiagnostic) {
    this.diagnostic = sink;
  }

  transaction<T>(operation: () => T): T {
    return runInTransaction(this.client, operation);
  }

  /** 在事务内注册提交后副作用：外层事务回滚时不会发布未提交状态。 */
  afterCommit(callback: () => void) {
    registerAfterCommit(this.client, callback);
  }

  list(): AgentOrchestration[] {
    const rows = this.client
      .prepare("SELECT * FROM na_agent_orchestrations ORDER BY name COLLATE NOCASE ASC, id ASC")
      .all() as Row[];
    return rows.map((row) => this.orchestrationFromRow(row));
  }

  get(id: string): AgentOrchestration | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_orchestrations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.orchestrationFromRow(row) : undefined;
  }

  /** 引用该 Agent 的全部编排（含默认编排），用于删除 Agent 时的批量选项。 */
  idsReferencingAgent(agentId: string): string[] {
    const rows = this.client.prepare(
      "SELECT DISTINCT orchestration_id FROM na_agent_orchestration_agents WHERE agent_id = ? ORDER BY orchestration_id",
    ).all(agentId) as Row[];
    return rows.map((row) => String(row.orchestration_id));
  }

  insert(input: { id: string } & AgentOrchestrationContent, timestamp: string): AgentOrchestration {
    return runInTransaction(this.client, () => {
      const content = normalizeContent(input);
      this.client.prepare(`INSERT INTO na_agent_orchestrations (id, name, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(input.id, content.name, agentOrchestrationRevision(content), timestamp, timestamp);
      this.replaceGraph(input.id, content, timestamp);
      return this.requireOrchestration(input.id);
    });
  }

  update(id: string, expectedRevision: string, content: AgentOrchestrationContent, timestamp: string): AgentOrchestrationMutationResult {
    return runInTransaction(this.client, () => {
      const current = this.get(id);
      if (!current) return { status: "missing" };
      if (current.revision !== expectedRevision) return { status: "revision-conflict", orchestration: current };
      const normalized = normalizeContent(content);
      this.client.prepare("UPDATE na_agent_orchestrations SET name = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(normalized.name, agentOrchestrationRevision(normalized), timestamp, id);
      this.replaceGraph(id, normalized, timestamp);
      return { status: "updated", orchestration: this.requireOrchestration(id) };
    });
  }

  delete(id: string): boolean {
    return runInTransaction(this.client, () => (
      Number(this.client.prepare("DELETE FROM na_agent_orchestrations WHERE id = ?").run(id).changes) > 0
    ));
  }

  deleteMany(ids: readonly string[]): void {
    if (!ids.length) return;
    runInTransaction(this.client, () => {
      const remove = this.client.prepare("DELETE FROM na_agent_orchestrations WHERE id = ?");
      for (const id of [...new Set(ids)]) remove.run(id);
    });
  }

  private replaceGraph(orchestrationId: string, content: AgentOrchestrationContent, timestamp: string) {
    this.client.prepare("DELETE FROM na_agent_orchestration_agents WHERE orchestration_id = ?").run(orchestrationId);
    this.client.prepare("DELETE FROM na_agent_orchestration_edges WHERE orchestration_id = ?").run(orchestrationId);
    const insertAgent = this.client.prepare(
      "INSERT INTO na_agent_orchestration_agents (orchestration_id, agent_id, created_at) VALUES (?, ?, ?)",
    );
    for (const agentId of content.agentIds) insertAgent.run(orchestrationId, agentId, timestamp);
    const insertEdge = this.client.prepare(
      "INSERT INTO na_agent_orchestration_edges (orchestration_id, from_agent_id, to_agent_id, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const edge of content.edges) insertEdge.run(orchestrationId, edge.fromAgentId, edge.toAgentId, timestamp);
  }

  private requireOrchestration(id: string): AgentOrchestration {
    const orchestration = this.get(id);
    if (!orchestration) {
      throw Object.assign(new Error(`Agent orchestration ${id} was not found after the write.`), {
        code: "AGENT_ORCHESTRATION_NOT_FOUND",
        statusCode: 404,
      });
    }
    return orchestration;
  }

  private orchestrationFromRow(row: Row): AgentOrchestration {
    const id = String(row.id);
    const unknownColumns = Object.keys(row).filter((column) => !AGENT_ORCHESTRATION_COLUMNS.has(column));
    if (unknownColumns.length) {
      this.diagnostic?.("Agent orchestration row contains unknown columns; they are ignored on read.", {
        orchestrationId: id,
        columns: unknownColumns,
      });
    }
    const agentIds = (this.client.prepare(
      "SELECT agent_id FROM na_agent_orchestration_agents WHERE orchestration_id = ? ORDER BY agent_id",
    ).all(id) as Row[]).map((agentRow) => String(agentRow.agent_id));
    const edges = (this.client.prepare(
      "SELECT from_agent_id, to_agent_id FROM na_agent_orchestration_edges WHERE orchestration_id = ? ORDER BY from_agent_id, to_agent_id",
    ).all(id) as Row[]).map((edgeRow) => ({
      fromAgentId: String(edgeRow.from_agent_id),
      toAgentId: String(edgeRow.to_agent_id),
    }));
    const content = normalizeContent({ name: String(row.name), agentIds, edges });
    // 迁移回填的行没有内容哈希；按内容补算，保证乐观并发对所有行一致。
    const revision = AGENT_ORCHESTRATION_REVISION_PATTERN.test(String(row.revision))
      ? String(row.revision)
      : agentOrchestrationRevision(content);
    try {
      return sanitizeAgentOrchestration({
        id,
        revision,
        name: content.name,
        agentIds: content.agentIds,
        edges: content.edges,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch (cause) {
      throw Object.assign(new Error("Stored agent orchestration cannot be parsed with the current model.", { cause }), {
        code: "NODE_AGENT_AGENT_ORCHESTRATION_INVALID",
        statusCode: 500,
      });
    }
  }
}

function normalizeContent(content: AgentOrchestrationContent): AgentOrchestrationContent {
  const graph = normalizeAgentOrchestrationGraph(content);
  return { name: content.name, agentIds: graph.agentIds, edges: graph.edges };
}

export function createAgentOrchestrationRepository(client: DatabaseSync) {
  return new AgentOrchestrationRepository(client);
}
