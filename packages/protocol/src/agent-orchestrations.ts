import { z } from "zod";
import { AgentDefinitionIdSchema } from "./agent-definitions.ts";

/**
 * 编排（AgentOrchestration）是 Node 本地一级对象：它持有成员 Agent 的关系图，Agent Run 必须绑定一张编排。
 * 每个 Agent 恰好有一张默认编排，id 由 Agent 确定性派生（`default:<agentId>`），随 Agent 在同一事务里创建和删除；
 * 默认编排的内容（名称、节点、边）是可编辑的用户数据，因此编排本体是持久化对象，只有 id 和“默认”角色是派生的。
 *
 * 顶级节点（入度为 0 的节点）是派生的：编排归属哪个 Agent、出现在哪些 Agent 下，由顶级节点唯一决定，
 * 不保存 owner/entry 字段。入口节点不要求是顶级节点——顶级节点只表达归属与可见性。
 */
export const AGENT_ORCHESTRATION_NAME_MAX_LENGTH = 120;
export const AGENT_ORCHESTRATION_MAX_AGENTS = 50;
export const AGENT_ORCHESTRATION_MAX_EDGES = 200;
export const AGENT_ORCHESTRATION_DEFAULT_ID_PREFIX = "default:";

const StableIdSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const AgentOrchestrationIdSchema = StableIdSchema;
export const AgentOrchestrationRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

export function defaultAgentOrchestrationId(agentId: string): string {
  return `${AGENT_ORCHESTRATION_DEFAULT_ID_PREFIX}${AgentDefinitionIdSchema.parse(agentId)}`;
}

export function isDefaultAgentOrchestrationId(orchestrationId: string): boolean {
  return orchestrationId.startsWith(AGENT_ORCHESTRATION_DEFAULT_ID_PREFIX);
}

/** 默认编排所属的 Agent；非默认编排或非法 id 返回 undefined。 */
export function defaultAgentOrchestrationOwnerAgentId(orchestrationId: string): string | undefined {
  if (!isDefaultAgentOrchestrationId(orchestrationId)) return undefined;
  const ownerAgentId = orchestrationId.slice(AGENT_ORCHESTRATION_DEFAULT_ID_PREFIX.length);
  return AgentDefinitionIdSchema.safeParse(ownerAgentId).success ? ownerAgentId : undefined;
}

export const AgentOrchestrationEdgeSchema = z.object({
  fromAgentId: AgentDefinitionIdSchema,
  toAgentId: AgentDefinitionIdSchema,
}).strict();
export type AgentOrchestrationEdge = z.infer<typeof AgentOrchestrationEdgeSchema>;

export const AgentOrchestrationSchema = z.object({
  id: AgentOrchestrationIdSchema,
  revision: AgentOrchestrationRevisionSchema,
  name: z.string().trim().min(1).max(AGENT_ORCHESTRATION_NAME_MAX_LENGTH),
  /** 图内全部 Agent 节点，含引用了已删除定义的悬挂引用；边只允许出现在这里的节点之间。 */
  agentIds: z.array(AgentDefinitionIdSchema).min(1).max(AGENT_ORCHESTRATION_MAX_AGENTS),
  edges: z.array(AgentOrchestrationEdgeSchema).max(AGENT_ORCHESTRATION_MAX_EDGES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentOrchestration = z.infer<typeof AgentOrchestrationSchema>;

export const AgentOrchestrationCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(AGENT_ORCHESTRATION_NAME_MAX_LENGTH),
  agentIds: z.array(AgentDefinitionIdSchema).min(1).max(AGENT_ORCHESTRATION_MAX_AGENTS),
  edges: z.array(AgentOrchestrationEdgeSchema).max(AGENT_ORCHESTRATION_MAX_EDGES).default([]),
}).strict();
export type AgentOrchestrationCreateInput = z.infer<typeof AgentOrchestrationCreateInputSchema>;

/** 更新必须携带调用方读到的 revision；缺省字段保持当前值，显式给出则整体替换。 */
export const AgentOrchestrationUpdateInputSchema = z.object({
  expectedRevision: AgentOrchestrationRevisionSchema,
  name: z.string().trim().min(1).max(AGENT_ORCHESTRATION_NAME_MAX_LENGTH).optional(),
  agentIds: z.array(AgentDefinitionIdSchema).min(1).max(AGENT_ORCHESTRATION_MAX_AGENTS).optional(),
  edges: z.array(AgentOrchestrationEdgeSchema).max(AGENT_ORCHESTRATION_MAX_EDGES).optional(),
}).strict();
export type AgentOrchestrationUpdateInput = z.infer<typeof AgentOrchestrationUpdateInputSchema>;

export const AgentOrchestrationListSchema = z.object({ orchestrations: z.array(AgentOrchestrationSchema) }).strict();
export const AgentOrchestrationDeleteResultSchema = z.object({ id: AgentOrchestrationIdSchema, deleted: z.literal(true) }).strict();

/** Control Plane 聚合信封：Node 身份只出现在信封上，不进入编排本体。 */
export const AgentOrchestrationAggregateSchema = z.object({
  orchestrations: z.array(z.object({ nodeId: StableIdSchema, orchestration: AgentOrchestrationSchema }).strict()),
  unavailableNodeIds: z.array(StableIdSchema).default([]),
}).strict();
export type AgentOrchestrationAggregate = z.infer<typeof AgentOrchestrationAggregateSchema>;

export const AGENT_ORCHESTRATION_ERROR_CODES = [
  "AGENT_ORCHESTRATION_NOT_FOUND",
  "AGENT_ORCHESTRATION_REVISION_CONFLICT",
  "AGENT_ORCHESTRATION_INVALID_GRAPH",
  "AGENT_ORCHESTRATION_AGENT_UNKNOWN",
  "AGENT_ORCHESTRATION_CYCLE",
  "AGENT_ORCHESTRATION_DEFAULT_PROTECTED",
] as const;
export const AgentOrchestrationErrorCodeSchema = z.enum(AGENT_ORCHESTRATION_ERROR_CODES);
export type AgentOrchestrationErrorCode = z.infer<typeof AgentOrchestrationErrorCodeSchema>;

/** 环错误必须带可展示的环路，调用方据此指出具体引用链。 */
export const AgentOrchestrationCycleErrorDetailsSchema = z.object({
  code: z.literal("AGENT_ORCHESTRATION_CYCLE"),
  cycle: z.array(AgentDefinitionIdSchema).min(2),
}).strict();

export const AgentOrchestrationRevisionConflictErrorDetailsSchema = z.object({
  code: z.literal("AGENT_ORCHESTRATION_REVISION_CONFLICT"),
  expectedRevision: AgentOrchestrationRevisionSchema,
  actualRevision: AgentOrchestrationRevisionSchema,
}).strict();

export const AgentOrchestrationErrorDetailsSchema = z.union([
  AgentOrchestrationCycleErrorDetailsSchema,
  AgentOrchestrationRevisionConflictErrorDetailsSchema,
  z.object({ code: AgentOrchestrationErrorCodeSchema }).strict(),
]);
export type AgentOrchestrationErrorDetails = z.infer<typeof AgentOrchestrationErrorDetailsSchema>;

/**
 * 编排变更的权威事件：Node Agent 在每次持久状态转换后发布，Control Plane 聚合器按 Node 投影并转发。
 */
export const AGENT_ORCHESTRATION_CHANGED_EVENT_TYPE = "agent.orchestration.changed";
export const AgentOrchestrationChangedEventSchema = z.object({
  orchestrationId: AgentOrchestrationIdSchema,
  change: z.enum(["created", "updated", "deleted"]),
  revision: AgentOrchestrationRevisionSchema.optional(),
  orchestration: AgentOrchestrationSchema.optional(),
}).strict();
export type AgentOrchestrationChangedEvent = z.infer<typeof AgentOrchestrationChangedEventSchema>;

export const AgentOrchestrationAggregateEventSchema = z.object({
  nodeId: StableIdSchema,
  event: AgentOrchestrationChangedEventSchema,
}).strict();

export type AgentOrchestrationGraph = {
  agentIds: readonly string[];
  edges: readonly AgentOrchestrationEdge[];
};

/** 顶级节点（入口）= 图中入度为 0 的节点；非空 DAG 至少有一个。 */
export function agentOrchestrationEntryAgentIds(orchestration: AgentOrchestrationGraph): string[] {
  const called = new Set(orchestration.edges.map((edge) => edge.toAgentId));
  return orchestration.agentIds.filter((agentId) => !called.has(agentId));
}

export function agentOrchestrationContainsAgent(orchestration: AgentOrchestrationGraph, agentId: string): boolean {
  return orchestration.agentIds.includes(agentId);
}

export function agentOrchestrationHasEdge(orchestration: AgentOrchestrationGraph, fromAgentId: string, toAgentId: string): boolean {
  return orchestration.edges.some((edge) => edge.fromAgentId === fromAgentId && edge.toAgentId === toAgentId);
}

/** 去重并排序：写入边界用它归一图，读边界用它稳定投影。 */
export function normalizeAgentOrchestrationGraph(graph: AgentOrchestrationGraph): { agentIds: string[]; edges: AgentOrchestrationEdge[] } {
  const agentIds = [...new Set(graph.agentIds)].sort();
  const edges = [...new Map(graph.edges.map((edge) => [`${edge.fromAgentId}\u001f${edge.toAgentId}`, edge])).values()]
    .sort((left, right) => (left.fromAgentId === right.fromAgentId
      ? left.toAgentId.localeCompare(right.toAgentId)
      : left.fromAgentId.localeCompare(right.fromAgentId)));
  return { agentIds, edges };
}

/**
 * 返回一个环（首尾为同一节点）或 undefined。写入校验与 UI 预校验共用同一实现，
 * 避免客户端各自维护兼容表或本地判环逻辑。
 */
export function findAgentOrchestrationCycle(orchestration: AgentOrchestrationGraph): string[] | undefined {
  const adjacency = new Map<string, string[]>();
  for (const agentId of orchestration.agentIds) adjacency.set(agentId, []);
  for (const edge of orchestration.edges) adjacency.get(edge.fromAgentId)?.push(edge.toAgentId);
  const state = new Map<string, "visiting" | "visited">();
  const path: string[] = [];

  const walk = (agentId: string): string[] | undefined => {
    state.set(agentId, "visiting");
    path.push(agentId);
    for (const next of adjacency.get(agentId) ?? []) {
      if (state.get(next) === "visiting") return [...path.slice(path.indexOf(next)), next];
      if (state.get(next) === "visited") continue;
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(agentId, "visited");
    return undefined;
  };

  for (const agentId of orchestration.agentIds) {
    if (state.has(agentId)) continue;
    const cycle = walk(agentId);
    if (cycle) return cycle;
    path.length = 0;
  }
  return undefined;
}

const AgentOrchestrationConsumerSchema = AgentOrchestrationSchema.strip().extend({
  agentIds: z.array(AgentDefinitionIdSchema).max(AGENT_ORCHESTRATION_MAX_AGENTS).default([]),
  edges: z.array(AgentOrchestrationEdgeSchema).max(AGENT_ORCHESTRATION_MAX_EDGES).default([]),
});
const AgentOrchestrationListConsumerSchema = z.object({ orchestrations: z.array(AgentOrchestrationConsumerSchema) }).strip();
const AgentOrchestrationAggregateConsumerSchema = z.object({
  orchestrations: z.array(z.object({ nodeId: z.string().trim().min(1).max(160), orchestration: AgentOrchestrationConsumerSchema }).strip()),
  unavailableNodeIds: z.array(z.string().trim().min(1).max(160)).default([]),
}).strip();
const AgentOrchestrationChangedEventConsumerSchema = z.object({
  orchestrationId: AgentOrchestrationIdSchema,
  change: z.enum(["created", "updated", "deleted"]),
  revision: AgentOrchestrationRevisionSchema.optional(),
  orchestration: AgentOrchestrationConsumerSchema.optional(),
}).strip();
const AgentOrchestrationAggregateEventConsumerSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  event: AgentOrchestrationChangedEventConsumerSchema,
}).strip();

/**
 * 读取边界：历史记录或旧 Node 响应可能缺少新增字段、带有未知字段。先 sanitize 再按当前模型解析，
 * 缺失的可选字段归一为“未设置”，未知字段被丢弃而不是让整条记录失败。
 */
export function sanitizeAgentOrchestration(input: unknown): AgentOrchestration {
  return AgentOrchestrationConsumerSchema.parse(input);
}

export function sanitizeAgentOrchestrationList(input: unknown) {
  return AgentOrchestrationListConsumerSchema.parse(input);
}

export function sanitizeAgentOrchestrationAggregate(input: unknown): AgentOrchestrationAggregate {
  return AgentOrchestrationAggregateConsumerSchema.parse(input);
}

export function sanitizeAgentOrchestrationAggregateEvent(input: unknown) {
  return AgentOrchestrationAggregateEventConsumerSchema.parse(input);
}
