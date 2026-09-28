import { z } from "zod";

/**
 * AgentDefinition 跑在既有的 Node Agent ↔ Control Plane 通信边界上，因此不新增第二个协议版本：
 * 该边界的权威版本仍然是 `CONTROL_PLANE_PROTOCOL_VERSION`，能力协商只由 capability document 的
 * `agentExecution` 子模型承担。N-1 Node 缺失该子模型时只关闭 Agent 功能域，不阻断注册、心跳或代理。
 */

export const AGENT_DEFINITION_NAME_MAX_LENGTH = 120;
export const AGENT_DEFINITION_DESCRIPTION_MAX_LENGTH = 2000;
export const AGENT_DEFINITION_APPENDED_PROMPT_MAX_LENGTH = 32_000;

const StableIdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const AgentDefinitionIdSchema = StableIdSchema;
export const AgentDefinitionRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * 执行策略分两层：materializer 决定运行工作区如何从源文件夹派生，sandbox 决定成员进程的边界。
 * 取值是增量可扩展的；可用性由 capability 中完整的 runtime/materializer/sandbox/provider 组合决定。
 */
export const AgentWorkspaceMaterializerSchema = z.enum(["overlay-copy-on-write", "worktree"]);
export const AgentProcessSandboxSchema = z.enum(["instance", "container", "local-runtime"]);
export type AgentWorkspaceMaterializer = z.infer<typeof AgentWorkspaceMaterializerSchema>;
export type AgentProcessSandbox = z.infer<typeof AgentProcessSandboxSchema>;

/** 当前定义模型允许保存的执行策略；运行可用性仍以 Node 的实测 capability 组合为准。 */
export const AGENT_PUBLISHED_EXECUTION_POLICIES: readonly { workspaceMaterializer: AgentWorkspaceMaterializer; processSandbox: AgentProcessSandbox }[] = Object.freeze([
  { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
]);

export const AgentExecutionPolicySchema = z.object({
  workspaceMaterializer: AgentWorkspaceMaterializerSchema.default("overlay-copy-on-write"),
  processSandbox: AgentProcessSandboxSchema.default("instance"),
}).strict();
export type AgentExecutionPolicy = z.infer<typeof AgentExecutionPolicySchema>;

export function isPublishedAgentExecutionPolicy(policy: AgentExecutionPolicy) {
  return AGENT_PUBLISHED_EXECUTION_POLICIES.some((candidate) =>
    candidate.workspaceMaterializer === policy.workspaceMaterializer && candidate.processSandbox === policy.processSandbox);
}

/**
 * AgentDefinition 是 Node 本地一级对象，只保存最小执行意图：不包含 `ownerNodeId`、
 * 绝对路径、密钥、Story 引用或调用拓扑；拓扑由 AgentOrchestration 持有，Story 入口关联由 Story 侧持有。
 */
export const AgentDefinitionSchema = z.object({
  id: AgentDefinitionIdSchema,
  revision: AgentDefinitionRevisionSchema,
  name: z.string().trim().min(1).max(AGENT_DEFINITION_NAME_MAX_LENGTH),
  description: z.string().trim().max(AGENT_DEFINITION_DESCRIPTION_MAX_LENGTH).default(""),
  appendedPrompt: z.string().max(AGENT_DEFINITION_APPENDED_PROMPT_MAX_LENGTH).default(""),
  targetInstanceId: StableIdSchema,
  cwdFolderId: StableIdSchema,
  providerId: StableIdSchema,
  modelEntityId: StableIdSchema.optional(),
  modelName: z.string().trim().min(1).max(120).optional(),
  reasoningEffort: z.string().trim().min(1).max(120).optional(),
  permissionMode: z.string().trim().min(1).max(120).optional(),
  executionPolicy: AgentExecutionPolicySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

const definitionInputShape = {
  name: z.string().trim().min(1).max(AGENT_DEFINITION_NAME_MAX_LENGTH),
  description: z.string().trim().max(AGENT_DEFINITION_DESCRIPTION_MAX_LENGTH).default(""),
  appendedPrompt: z.string().max(AGENT_DEFINITION_APPENDED_PROMPT_MAX_LENGTH).default(""),
  targetInstanceId: StableIdSchema,
  cwdFolderId: StableIdSchema,
  providerId: StableIdSchema,
  modelEntityId: StableIdSchema.optional(),
  modelName: z.string().trim().min(1).max(120).optional(),
  reasoningEffort: z.string().trim().min(1).max(120).optional(),
  permissionMode: z.string().trim().min(1).max(120).optional(),
  executionPolicy: AgentExecutionPolicySchema.optional(),
} as const;

export const AgentDefinitionCreateInputSchema = z.object(definitionInputShape).strict();
export type AgentDefinitionCreateInput = z.infer<typeof AgentDefinitionCreateInputSchema>;

/**
 * 更新必须携带调用方读到的 revision，避免覆盖并发写入。
 * 可选预设字段显式传 `null` 表示清空，缺失表示保持当前值。
 */
export const AgentDefinitionUpdateInputSchema = z.object({
  expectedRevision: AgentDefinitionRevisionSchema,
  name: definitionInputShape.name.optional(),
  description: z.string().trim().max(AGENT_DEFINITION_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  appendedPrompt: z.string().max(AGENT_DEFINITION_APPENDED_PROMPT_MAX_LENGTH).nullable().optional(),
  targetInstanceId: definitionInputShape.targetInstanceId.optional(),
  cwdFolderId: definitionInputShape.cwdFolderId.optional(),
  providerId: definitionInputShape.providerId.optional(),
  modelEntityId: StableIdSchema.nullable().optional(),
  modelName: z.string().trim().min(1).max(120).nullable().optional(),
  reasoningEffort: z.string().trim().min(1).max(120).nullable().optional(),
  permissionMode: z.string().trim().min(1).max(120).nullable().optional(),
  executionPolicy: definitionInputShape.executionPolicy,
}).strict();
export type AgentDefinitionUpdateInput = z.infer<typeof AgentDefinitionUpdateInputSchema>;

export const AgentDefinitionListSchema = z.object({ agents: z.array(AgentDefinitionSchema) }).strict();
/** 删除结果带上被一并删除的编排：UI 用它提示"同时删除了哪些编排"并精确失效缓存。 */
export const AgentDefinitionDeleteResultSchema = z.object({
  id: AgentDefinitionIdSchema,
  deleted: z.literal(true),
  deletedOrchestrationIds: z.array(z.string().trim().min(1).max(160)).default([]),
}).strict();

/** Control Plane 聚合信封：Node 身份只出现在信封上，不进入定义本体。 */
export const AgentDefinitionAggregateSchema = z.object({
  agents: z.array(z.object({ nodeId: StableIdSchema, agent: AgentDefinitionSchema }).strict()),
  unavailableNodeIds: z.array(StableIdSchema).default([]),
}).strict();
export type AgentDefinitionAggregate = z.infer<typeof AgentDefinitionAggregateSchema>;

export const AGENT_DEFINITION_ERROR_CODES = [
  "AGENT_DEFINITION_INVALID_INPUT",
  "AGENT_DEFINITION_NOT_FOUND",
  "AGENT_DEFINITION_REVISION_CONFLICT",
  "AGENT_DEFINITION_TARGET_INSTANCE_UNKNOWN",
  "AGENT_DEFINITION_FOLDER_UNKNOWN",
  "AGENT_DEFINITION_PROVIDER_UNSUPPORTED",
  "AGENT_DEFINITION_POLICY_UNSUPPORTED",
] as const;
export const AgentDefinitionErrorCodeSchema = z.enum(AGENT_DEFINITION_ERROR_CODES);
export type AgentDefinitionErrorCode = z.infer<typeof AgentDefinitionErrorCodeSchema>;

/** 修订冲突必须带调用方读到的与当前权威的 revision，调用方可直接重读并重试。 */
export const AgentDefinitionRevisionConflictErrorDetailsSchema = z.object({
  code: z.literal("AGENT_DEFINITION_REVISION_CONFLICT"),
  expectedRevision: AgentDefinitionRevisionSchema,
  actualRevision: AgentDefinitionRevisionSchema,
}).strict();

export const AgentDefinitionErrorDetailsSchema = z.union([
  AgentDefinitionRevisionConflictErrorDetailsSchema,
  z.object({ code: AgentDefinitionErrorCodeSchema }).strict(),
]);
export type AgentDefinitionErrorDetails = z.infer<typeof AgentDefinitionErrorDetailsSchema>;

/**
 * AgentDefinition 变更的权威事件：Node Agent 在每次持久状态转换后发布，
 * Control Plane 聚合器维护每个 Node 的最后投影并转发。HTTP 只用于初始快照与显式校验。
 */
export const AGENT_DEFINITION_CHANGED_EVENT_TYPE = "agent.definition.changed";
export const AgentDefinitionChangedEventSchema = z.object({
  agentId: AgentDefinitionIdSchema,
  change: z.enum(["created", "updated", "deleted"]),
  revision: AgentDefinitionRevisionSchema.optional(),
  definition: AgentDefinitionSchema.optional(),
}).strict();
export type AgentDefinitionChangedEvent = z.infer<typeof AgentDefinitionChangedEventSchema>;

/** Control Plane adds the transport-derived Node identity outside the Node-owned event. */
export const AgentDefinitionAggregateEventSchema = z.object({
  nodeId: StableIdSchema,
  event: AgentDefinitionChangedEventSchema,
}).strict();

const AgentDefinitionConsumerSchema = AgentDefinitionSchema.strip().extend({
  executionPolicy: AgentExecutionPolicySchema.strip(),
});
const AgentDefinitionListConsumerSchema = z.object({ agents: z.array(AgentDefinitionConsumerSchema) }).strip();
const AgentDefinitionAggregateConsumerSchema = z.object({
  agents: z.array(z.object({ nodeId: StableIdSchema, agent: AgentDefinitionConsumerSchema }).strip()),
  unavailableNodeIds: z.array(z.string().trim().min(1).max(120)).default([]),
}).strip();
const AgentDefinitionChangedEventConsumerSchema = z.object({
  agentId: AgentDefinitionIdSchema,
  change: z.enum(["created", "updated", "deleted"]),
  revision: AgentDefinitionRevisionSchema.optional(),
  definition: AgentDefinitionConsumerSchema.optional(),
}).strip();
const AgentDefinitionAggregateEventConsumerSchema = z.object({
  nodeId: StableIdSchema,
  event: AgentDefinitionChangedEventConsumerSchema,
}).strip();

/**
 * 读取边界：历史记录或旧 Node 响应可能缺少新增字段、带有未知字段。先 sanitize 再按当前
 * 模型解析，缺失的可选字段归一为“未设置”，未知字段被丢弃而不是让整条记录失败。
 */
export function sanitizeAgentExecutionPolicy(input: unknown): AgentExecutionPolicy {
  return AgentExecutionPolicySchema.strip().parse(input ?? {});
}

export function sanitizeAgentDefinition(input: unknown): AgentDefinition {
  return AgentDefinitionConsumerSchema.parse(input);
}

export function sanitizeAgentDefinitionList(input: unknown) {
  return AgentDefinitionListConsumerSchema.parse(input);
}

export function sanitizeAgentDefinitionAggregate(input: unknown): AgentDefinitionAggregate {
  return AgentDefinitionAggregateConsumerSchema.parse(input);
}

export function sanitizeAgentDefinitionAggregateEvent(input: unknown) {
  return AgentDefinitionAggregateEventConsumerSchema.parse(input);
}
