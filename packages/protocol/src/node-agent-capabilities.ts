import { z } from "zod";
import { ModelProtocolSchema, type ModelProtocol } from "./model-protocol.ts";

// Compatibility for v0.0.32: older control planes ignore this additive event and
// retain their connection; current consumers re-read the authoritative health document.
export const NODE_AGENT_CAPABILITIES_CHANGED_EVENT_TYPE = "node-agent.capabilities.changed";
export const NodeAgentCapabilitiesChangedEventSchema = z.object({}).strict();
export type NodeAgentCapabilitiesChangedEvent = z.infer<typeof NodeAgentCapabilitiesChangedEventSchema>;

/**
 * Runtime values a Node Agent may report for shared agent execution space.
 * `wsl` is additive (add-wsl-runtime D1/D11); readers filter by known values so an
 * unknown future runtime never resets the whole `agentExecution` capability group.
 */
export const NODE_AGENT_SHARED_SPACE_RUNTIMES = ["docker", "local", "wsl"] as const;

export const NodeAgentSharedSpaceRuntimeSchema = z.enum(NODE_AGENT_SHARED_SPACE_RUNTIMES);

export type NodeAgentSharedSpaceRuntime = z.infer<typeof NodeAgentSharedSpaceRuntimeSchema>;

export const NodeAgentManagedGitWorkspaceProvisioningSchema = z.object({
  docker: z.boolean().default(false),
  kubernetes: z.boolean().default(false),
  local: z.boolean().default(false),
  // Compatibility for add-wsl-runtime: older node agents strip this key, so an old
  // control plane keeps reading exactly the three legacy keys.
  wsl: z.boolean().default(false),
}).strip();

export const NodeAgentManagedGitCapabilitiesSchema = z.object({
  registry: z.boolean().default(false),
  runtimeBroker: z.boolean().default(false),
  workspaceProvisioning: NodeAgentManagedGitWorkspaceProvisioningSchema.default({ docker: false, kubernetes: false, local: false, wsl: false }),
}).strip();

export const NodeAgentManagedModelCapabilitiesSchema = z.object({
  multiEntityAssignment: z.boolean().default(false),
  privateModelCatalog: z.boolean().default(false),
  // Additive capability: the node keeps a model entity id stable across edits
  // and applies content updates in place. Older nodes derive the id from the
  // content hash and reject in-place edits, so writers must fall back to the
  // legacy deploy shape for them.
  stableModelIdentity: z.boolean().default(false),
  // Additive capability: the node persists per-entity request name mappings
  // and applies them when resolving relay requests. Absence (v0.0.34 and
  // earlier) keeps mapping edits disabled and makes writers strip the field
  // from node payloads so the legacy strict request schema keeps working.
  requestMappings: z.boolean().default(false),
  // Additive capability: the node can relay model traffic for assigned
  // entities over the declared protocols. Absence (v0.0.34 and earlier) keeps
  // mapping deployment disabled; the relay switch is node configuration and
  // is deliberately not part of the capability document.
  modelRelay: z.object({
    protocols: z.array(ModelProtocolSchema).max(3).default([]),
    streaming: z.boolean().default(false),
    // Additive capability: the node persists and honors the relay
    // unknown-model policy. Absence (v0.0.34 and earlier) means the node
    // always fails closed and its strict settings schema rejects the field.
    unknownModelPolicy: z.boolean().default(false),
  }).strip().default(() => ({ protocols: [], streaming: false, unknownModelPolicy: false })),
}).strip();

export const NodeAgentStoryAgentToolCapabilitiesSchema = z.object({
  policy: z.boolean().default(false),
  actions: z.boolean().default(false),
  automations: z.boolean().default(false),
  aiSessionRead: z.boolean().default(false),
  // Compatibility for v0.0.33: 缺失即不支持 decision 功能域，只关闭该域。
  decisions: z.boolean().default(false),
}).strip();

export const NodeAgentStoryCapabilitiesSchema = z.object({
  enabled: z.boolean().default(false),
  // Compatibility for v0.0.32: this only advertises the original Content tools.
  agentTools: z.boolean().default(false),
  agentToolCapabilities: NodeAgentStoryAgentToolCapabilitiesSchema.optional(),
  sessionRetention: z.boolean().default(false),
  maxFileBytes: z.number().int().positive().default(32 * 1024 * 1024),
  maxBatchPaths: z.number().int().min(1).max(100).default(20),
}).strip();

const NodeAgentExecutionCombinationSchema = z.object({
  runtime: z.enum(["docker", "local"]),
  workspaceMaterializer: z.enum(["overlay-copy-on-write", "worktree"]),
  processSandbox: z.enum(["instance", "container", "local-runtime"]),
  providerId: z.string().trim().min(1).max(120),
}).strip();

export const NodeAgentAgentExecutionCapabilitiesSchema = z.object({
  definitions: z.boolean().default(false),
  runs: z.boolean().default(false),
  orchestration: z.object({
    storyEntryAuthorization: z.boolean().default(false),
    // 编排对象与其关系图；缺失该字段的节点不支持编排管理，只保留不可编辑的默认编排语义。
    orchestrations: z.boolean().default(false),
    runMembers: z.boolean().default(false),
    // Compatibility for v0.0.32: existing Story runs stay readable, while direct UI launch fails closed.
    manualRuns: z.boolean().default(false),
  }).strip().default({ storyEntryAuthorization: false, orchestrations: false, runMembers: false, manualRuns: false }),
  sharedSpace: z.object({
    enabled: z.boolean().default(false),
    runtimes: z.array(NodeAgentSharedSpaceRuntimeSchema).default([]),
  }).strip().default({ enabled: false, runtimes: [] }),
  // 每个条目是 Node Agent 已注册并实现的完整组合；不能从各维度独立布尔值推导可用性。
  combinations: z.array(NodeAgentExecutionCombinationSchema).default([]),
}).strip();

// 消费侧把共享空间的 runtime 读成字符串数组再按已知值过滤（add-wsl-runtime D11）：
// 出现未知 runtime 时只丢弃该值，MUST NOT 让整组 agentExecution 能力退回默认值。
const NodeAgentSharedSpaceConsumerSchema = z.object({
  enabled: z.boolean().default(false),
  runtimes: z.array(z.string().trim().min(1).max(64)).default([]),
}).strip().default({ enabled: false, runtimes: [] });

const NodeAgentAgentExecutionCapabilitiesConsumerSchema = NodeAgentAgentExecutionCapabilitiesSchema
  .omit({ combinations: true, sharedSpace: true })
  .extend({
    combinations: z.array(z.unknown()).default([]),
    sharedSpace: NodeAgentSharedSpaceConsumerSchema,
  })
  .strip();

export const NodeAgentCapabilitiesSchema = z.object({
  modelEndpointProbe: z.boolean().optional(),
  aiSessionHistoryLimit: z.boolean().optional(),
  aiSessionAttachmentRetention: z.boolean().optional(),
  aiSessionFileAttachmentLimit: z.boolean().optional(),
  folderPlaces: z.boolean().optional(),
  localFolderNameUpdate: z.boolean().optional(),
  // Additive capability: absent on v0.0.21 node-agents.
  managedGitCredentials: NodeAgentManagedGitCapabilitiesSchema.optional(),
  // Compatibility for v0.0.23: absence keeps the legacy single-model projection.
  managedModels: NodeAgentManagedModelCapabilitiesSchema.optional(),
  stories: NodeAgentStoryCapabilitiesSchema.optional(),
  // Compatibility for v0.0.28: absent node-agents reject codexSettings in instance patches.
  codexManagedSettings: z.boolean().optional(),
  // Compatibility for v0.0.32: 缺失该字段只关闭 Agent 功能域，不影响其它 Node 能力。
  agentExecution: NodeAgentAgentExecutionCapabilitiesSchema.optional(),
}).strip();

export type NodeAgentCapabilities = z.infer<typeof NodeAgentCapabilitiesSchema>;

export function normalizeNodeAgentCapabilities(capabilities: unknown): NodeAgentCapabilities & {
  managedGitCredentials: z.infer<typeof NodeAgentManagedGitCapabilitiesSchema>;
  managedModels: z.infer<typeof NodeAgentManagedModelCapabilitiesSchema>;
  agentExecution: z.infer<typeof NodeAgentAgentExecutionCapabilitiesSchema>;
  stories: z.infer<typeof NodeAgentStoryCapabilitiesSchema> & {
    agentToolCapabilities: z.infer<typeof NodeAgentStoryAgentToolCapabilitiesSchema>;
  };
} {
  const source = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? capabilities as Record<string, unknown>
    : {};
  const parsed = NodeAgentCapabilitiesSchema.safeParse({ ...source, agentExecution: undefined });
  const current = parsed.success ? parsed.data : {};
  const agentExecution = NodeAgentAgentExecutionCapabilitiesConsumerSchema.safeParse(source.agentExecution);
  const normalizedAgentExecution = agentExecution.success
    ? NodeAgentAgentExecutionCapabilitiesSchema.parse({
      ...agentExecution.data,
      sharedSpace: {
        enabled: agentExecution.data.sharedSpace.enabled,
        runtimes: agentExecution.data.sharedSpace.runtimes.filter(
          (runtime): runtime is NodeAgentSharedSpaceRuntime => (NODE_AGENT_SHARED_SPACE_RUNTIMES as readonly string[]).includes(runtime),
        ),
      },
      combinations: agentExecution.data.combinations.flatMap((combination) => {
        const parsedCombination = NodeAgentExecutionCombinationSchema.safeParse(combination);
        return parsedCombination.success ? [parsedCombination.data] : [];
      }),
    })
    : NodeAgentAgentExecutionCapabilitiesSchema.parse({});
  return {
    ...current,
    managedGitCredentials: NodeAgentManagedGitCapabilitiesSchema.parse(current.managedGitCredentials || {}),
    managedModels: NodeAgentManagedModelCapabilitiesSchema.parse(current.managedModels || {}),
    agentExecution: normalizedAgentExecution,
    stories: {
      ...NodeAgentStoryCapabilitiesSchema.parse(current.stories || {}),
      agentToolCapabilities: NodeAgentStoryAgentToolCapabilitiesSchema.parse(current.stories?.agentToolCapabilities || {}),
    },
  };
}

export function supportsNodeMultiEntityModelAssignment(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.multiEntityAssignment;
}

export function supportsNodePrivateModelCatalog(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.privateModelCatalog;
}

export function supportsNodeStableModelIdentity(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.stableModelIdentity;
}

/** Single query for the relay request mapping producer capability. */
export function supportsNodeModelRequestMappings(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.requestMappings;
}

/** Single query for the relay producer capability declared by this boundary. */
export function nodeAgentModelRelayCapabilities(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.modelRelay;
}

export function supportsNodeModelRelay(capabilities: unknown) {
  return nodeAgentModelRelayCapabilities(capabilities).protocols.length > 0;
}

export function supportsNodeModelRelayProtocol(capabilities: unknown, protocol: ModelProtocol) {
  return nodeAgentModelRelayCapabilities(capabilities).protocols.includes(protocol);
}

export function supportsNodeModelRelayStreaming(capabilities: unknown) {
  return nodeAgentModelRelayCapabilities(capabilities).streaming;
}

/** Single query for the relay unknown-model policy producer capability. */
export function supportsNodeModelRelayUnknownModelPolicy(capabilities: unknown) {
  return nodeAgentModelRelayCapabilities(capabilities).unknownModelPolicy;
}

export function supportsNodeCodexManagedSettings(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).codexManagedSettings === true;
}

export function supportsNodeStories(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).stories.enabled;
}

export function nodeAgentExecutionCapabilities(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution;
}

export function supportsNodeAgentDefinitions(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution.definitions;
}

export function supportsNodeAgentRuns(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution.runs;
}

export function supportsNodeAgentStoryEntryAuthorization(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution.orchestration.storyEntryAuthorization;
}

export function supportsNodeAgentOrchestrations(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution.orchestration.orchestrations;
}

export function supportsNodeAgentRunMembers(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution.orchestration.runMembers;
}

export function supportsNodeAgentManualRuns(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).agentExecution.orchestration.manualRuns;
}

/** `runtime` 是窄 union 的替代：未知 runtime 归为不支持，而不是类型错误（add-wsl-runtime 2.3）。 */
export function supportsNodeAgentSharedSpace(capabilities: unknown, runtime: string) {
  const sharedSpace = normalizeNodeAgentCapabilities(capabilities).agentExecution.sharedSpace;
  return sharedSpace.enabled && sharedSpace.runtimes.some((value) => value === runtime);
}

/** 执行组合必须由同一个 Node Agent 的真实探测结果显式发布，缺失即不支持。 */
export function supportsNodeAgentExecutionPolicy(
  capabilities: unknown,
  policy: { workspaceMaterializer: string; processSandbox: string },
  target: { runtime: string; providerId: string },
) {
  const execution = normalizeNodeAgentCapabilities(capabilities).agentExecution;
  return execution.combinations.some((combination) => combination.runtime === target.runtime
    && combination.providerId === target.providerId
    && combination.workspaceMaterializer === policy.workspaceMaterializer
    && combination.processSandbox === policy.processSandbox);
}

export function nodeStoryAgentToolCapabilities(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).stories.agentToolCapabilities;
}

/** 缺失即不支持 decision 功能域；只关闭该域，不影响 Story 与 AI Session。 */
export function supportsNodeStoryDecisionTools(capabilities: unknown) {
  return nodeStoryAgentToolCapabilities(capabilities).decisions;
}

export function nodeAgentCapabilitiesFromPublicNode(capabilities: unknown) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const agent = (capabilities as Record<string, unknown>).agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  return (agent as Record<string, unknown>).capabilities;
}

export function supportsNodeManagedGitCredentialRegistry(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedGitCredentials.registry;
}

export function supportsNodeGitCredentialRuntimeBroker(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedGitCredentials.runtimeBroker;
}

/** 未知 runtime（含未来新增类型）归为不支持，调用点不再需要 runtime 字面量 union（add-wsl-runtime 2.3）。 */
export function supportsNodeGitWorkspaceProvisioning(capabilities: unknown, runtime: string) {
  const provisioning = normalizeNodeAgentCapabilities(capabilities).managedGitCredentials.workspaceProvisioning as Record<string, boolean>;
  return provisioning[runtime] === true;
}

export function supportsNodeFolderPlaces(capabilities: unknown) {
  return NodeAgentCapabilitiesSchema.safeParse(capabilities).data?.folderPlaces === true;
}

export function supportsNodeLocalFolderNameUpdate(capabilities: unknown) {
  return NodeAgentCapabilitiesSchema.safeParse(capabilities).data?.localFolderNameUpdate === true;
}

export function supportsNodeAiSessionFileAttachmentLimit(capabilities: unknown) {
  return NodeAgentCapabilitiesSchema.safeParse(capabilities).data?.aiSessionFileAttachmentLimit === true;
}
