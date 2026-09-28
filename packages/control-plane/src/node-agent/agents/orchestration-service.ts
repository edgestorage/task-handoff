import {
  AgentOrchestrationCreateInputSchema,
  AgentOrchestrationUpdateInputSchema,
  defaultAgentOrchestrationId,
  defaultAgentOrchestrationOwnerAgentId,
  findAgentOrchestrationCycle,
  normalizeAgentOrchestrationGraph,
  agentOrchestrationContainsAgent,
  type AgentOrchestration,
  type AgentOrchestrationCreateInput,
  type AgentOrchestrationUpdateInput,
} from "@task-handoff/protocol/agent-orchestrations";
import { AgentOrchestrationRevisionConflictErrorDetailsSchema } from "@task-handoff/protocol/agent-orchestrations";
import { createId } from "../../shared/persistence/store.ts";
import type { AgentDefinitionRepository } from "../persistence/agent-repository.ts";
import type { AgentOrchestrationContent, AgentOrchestrationRepository } from "../persistence/agent-orchestration-repository.ts";
import type { AgentDefinitionChangePublisher } from "./service.ts";

/**
 * AgentOrchestration 服务：Node Agent 是编排的唯一权威来源。
 *
 * 每个 Agent 恰好有一张默认编排，id 由 Agent 确定性派生（`default:<agentId>`），与 Agent 在同一事务里创建和删除；
 * 默认编排不可删除、必须保留所属 Agent 作为节点，其余（名称、节点、边）与自定义编排一样可编辑。
 * 编排不保存 owner/entry 字段：顶级节点（入度为 0）派生决定它出现在哪些 Agent 下。
 */
export class AgentOrchestrationService {
  private readonly orchestrations: AgentOrchestrationRepository;
  private readonly definitions: AgentDefinitionRepository;
  private readonly publish?: AgentDefinitionChangePublisher;

  constructor(
    orchestrations: AgentOrchestrationRepository,
    definitions: AgentDefinitionRepository,
    publish?: AgentDefinitionChangePublisher,
  ) {
    this.orchestrations = orchestrations;
    this.definitions = definitions;
    this.publish = publish;
  }

  list(): AgentOrchestration[] {
    return this.orchestrations.list();
  }

  get(id: string): AgentOrchestration {
    const orchestration = this.orchestrations.get(id);
    if (!orchestration) throw agentOrchestrationError("AGENT_ORCHESTRATION_NOT_FOUND", `Agent orchestration ${id} was not found.`, 404);
    return orchestration;
  }

  has(id: string): boolean {
    return Boolean(this.orchestrations.get(id));
  }

  find(id: string): AgentOrchestration | undefined {
    return this.orchestrations.get(id);
  }

  containsAgent(orchestrationId: string, agentId: string): boolean {
    const orchestration = this.orchestrations.get(orchestrationId);
    return orchestration ? agentOrchestrationContainsAgent(orchestration, agentId) : false;
  }

  create(input: AgentOrchestrationCreateInput): AgentOrchestration {
    const parsed = AgentOrchestrationCreateInputSchema.parse(input);
    const id = createId("orchestration");
    const timestamp = new Date().toISOString();
    const orchestration = this.orchestrations.transaction(() => {
      this.validateGraph(parsed, id);
      return this.orchestrations.insert({ id, ...parsed }, timestamp);
    });
    // 事件只在最外层事务提交后发布：外层回滚不会泄露未提交的编排。
    this.orchestrations.afterCommit(() => this.publishChange("created", orchestration));
    return orchestration;
  }

  update(id: string, input: AgentOrchestrationUpdateInput): AgentOrchestration {
    const parsed = AgentOrchestrationUpdateInputSchema.parse(input);
    const timestamp = new Date().toISOString();
    const result = this.orchestrations.transaction(() => {
      const current = this.orchestrations.get(id);
      if (!current) return { status: "missing" } as const;
      const content: AgentOrchestrationContent = {
        name: parsed.name ?? current.name,
        agentIds: parsed.agentIds ?? current.agentIds,
        edges: parsed.edges ?? current.edges,
      };
      this.validateGraph(content, id, current);
      return this.orchestrations.update(id, parsed.expectedRevision, content, timestamp);
    });
    if (result.status === "missing") {
      throw agentOrchestrationError("AGENT_ORCHESTRATION_NOT_FOUND", `Agent orchestration ${id} was not found.`, 404);
    }
    if (result.status === "revision-conflict") {
      throw Object.assign(
        agentOrchestrationError("AGENT_ORCHESTRATION_REVISION_CONFLICT", "Agent orchestration changed since it was read.", 409),
        {
          details: AgentOrchestrationRevisionConflictErrorDetailsSchema.parse({
            code: "AGENT_ORCHESTRATION_REVISION_CONFLICT",
            expectedRevision: parsed.expectedRevision,
            actualRevision: result.orchestration.revision,
          }),
        },
      );
    }
    this.orchestrations.afterCommit(() => this.publishChange("updated", result.orchestration));
    return result.orchestration;
  }

  /** 默认编排只能随所属 Agent 删除。 */
  delete(id: string): boolean {
    const existing = this.get(id);
    if (defaultAgentOrchestrationOwnerAgentId(id)) {
      throw agentOrchestrationError(
        "AGENT_ORCHESTRATION_DEFAULT_PROTECTED",
        "The default orchestration of an Agent cannot be deleted directly; delete the Agent instead.",
        409,
      );
    }
    if (!this.orchestrations.delete(id)) return false;
    this.orchestrations.afterCommit(() => this.publishChange("deleted", existing));
    return true;
  }

  /**
   * Agent 创建事务的一部分：写入默认编排。调用方负责在提交后发布返回对象的事件。
   */
  insertDefaultForAgent(agentId: string, name: string, timestamp: string): AgentOrchestration {
    return this.orchestrations.insert({
      id: defaultAgentOrchestrationId(agentId),
      name,
      agentIds: [agentId],
      edges: [],
    }, timestamp);
  }

  /**
   * Agent 删除事务的一部分：默认编排必然删除；`referencing === "delete"` 时把引用该 Agent 的其它编排一并删除。
   * 返回被删除的编排，供调用方在提交后发布事件。
   */
  deleteForAgent(agentId: string, referencing: "keep" | "delete"): AgentOrchestration[] {
    const defaultId = defaultAgentOrchestrationId(agentId);
    const referencingIds = this.orchestrations.idsReferencingAgent(agentId);
    // 其它 Agent 的默认编排不参与批量删除：默认编排只能随其所属 Agent 删除，这里只保留悬挂引用。
    const deletable = referencing === "delete"
      ? referencingIds.filter((id) => id === defaultId || !defaultAgentOrchestrationOwnerAgentId(id))
      : [];
    const deletedIds = [...new Set([defaultId, ...deletable])];
    const deleted = deletedIds.flatMap((id) => {
      const orchestration = this.orchestrations.get(id);
      return orchestration ? [orchestration] : [];
    });
    this.orchestrations.deleteMany(deleted.map((orchestration) => orchestration.id));
    return deleted;
  }

  publishChange(change: "created" | "updated" | "deleted", orchestration: AgentOrchestration) {
    this.publish?.("agent.orchestration.changed", {
      orchestrationId: orchestration.id,
      change,
      revision: orchestration.revision,
      orchestration,
    }, {});
  }

  private validateGraph(content: AgentOrchestrationContent, orchestrationId: string, existing?: AgentOrchestration) {
    const graph = normalizeAgentOrchestrationGraph(content);
    const knownIds = new Set(graph.agentIds);
    for (const edge of graph.edges) {
      if (edge.fromAgentId === edge.toAgentId) {
        throw agentOrchestrationError("AGENT_ORCHESTRATION_INVALID_GRAPH", "An Agent cannot call itself.", 409, { agentId: edge.fromAgentId });
      }
      if (!knownIds.has(edge.fromAgentId) || !knownIds.has(edge.toAgentId)) {
        throw agentOrchestrationError(
          "AGENT_ORCHESTRATION_INVALID_GRAPH",
          "Every edge must connect Agents inside the orchestration graph.",
          409,
          { fromAgentId: edge.fromAgentId, toAgentId: edge.toAgentId },
        );
      }
    }
    const existingIds = new Set(existing?.agentIds ?? []);
    for (const agentId of graph.agentIds) {
      if (this.definitions.get(agentId)) continue;
      // 悬挂引用只允许保留既有节点，用户显式移除或替换后消失；新增未知 Agent 一律拒绝。
      if (existingIds.has(agentId)) continue;
      throw agentOrchestrationError(
        "AGENT_ORCHESTRATION_AGENT_UNKNOWN",
        `Agent definition ${agentId} was not found on this Node Agent.`,
        409,
        { agentId },
      );
    }
    const cycle = findAgentOrchestrationCycle(graph);
    if (cycle) {
      throw Object.assign(
        agentOrchestrationError("AGENT_ORCHESTRATION_CYCLE", `The orchestration graph would form a cycle: ${cycle.join(" -> ")}.`, 409),
        { details: { code: "AGENT_ORCHESTRATION_CYCLE", cycle } },
      );
    }
    const ownerAgentId = defaultAgentOrchestrationOwnerAgentId(orchestrationId);
    if (ownerAgentId) {
      if (!this.definitions.get(ownerAgentId)) {
        throw agentOrchestrationError(
          "AGENT_ORCHESTRATION_DEFAULT_PROTECTED",
          `The owning Agent ${ownerAgentId} of this default orchestration was not found.`,
          409,
          { agentId: ownerAgentId },
        );
      }
      if (!knownIds.has(ownerAgentId)) {
        throw agentOrchestrationError(
          "AGENT_ORCHESTRATION_DEFAULT_PROTECTED",
          "A default orchestration must keep its owning Agent in the graph.",
          409,
          { agentId: ownerAgentId },
        );
      }
    }
  }
}

function agentOrchestrationError(code: string, message: string, statusCode: number, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}
