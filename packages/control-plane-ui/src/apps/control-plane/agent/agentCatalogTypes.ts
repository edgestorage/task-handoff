import type { AgentExecutionPolicy } from "@task-handoff/protocol/agent-definitions";

export type AgentRunStatus = "queued" | "preparing" | "running" | "finalizing" | "completed" | "failed" | "cancelled";

export type AgentCatalogNode = {
  id: string;
  label: string;
};

/**
 * Agent 视图的只读展示模型。它由权威数据派生：定义来自 Node Agent，标签与运行能力来自
 * Node/实例目录，文件夹路径来自该 Node 的本地文件夹列表。这里不放任何本地可写副本。
 */
export type AgentCatalogAgent = {
  /** Control Plane 展示身份；AgentDefinition.id 只在所属 Node 内唯一。 */
  key: string;
  id: string;
  /** 定义内容的修订号，编辑提交时必须原样带回做乐观并发控制。 */
  revision: string;
  name: string;
  description: string;
  nodeId: string;
  nodeLabel: string;
  nodeOnline: boolean;
  instanceId: string;
  instanceLabel: string;
  /** 权威的工作目录标识；路径只是在该 Node 文件夹列表里解析出来的只读投影。 */
  cwdFolderId: string;
  folderPath: string;
  providerId: string;
  provider: string;
  model: string;
  permissionMode: string;
  reasoning: string;
  executionPolicy: AgentExecutionPolicy;
  callableAgentIds: string[];
  /** 附加提示词：叠加在该 Agent 的运行提示上，不是运行开始时发送的用户消息。 */
  appendedPrompt: string;
  /** Story 入口引用是从 Story 侧派生的只读投影，不属于 AgentDefinition 本体。 */
  entryStoryLabels?: string[];
  /** 该 Node 是否发布运行能力；定义可用不代表可以发起运行。 */
  runsSupported: boolean;
  manualRunsSupported: boolean;
  executable: boolean;
  /** 阻塞原因用结构化代码表达，展示文案由视图本地化，避免投影层依赖消息目录。 */
  blockedCode?: AgentBlockedCode;
};

export type AgentBlockedCode =
  | "definitions-unsupported"
  | "node-offline"
  | "instance-missing"
  | "instance-offline"
  | "local-runtime"
  | "missing-reference"
  | "policy-unsupported";

/**
 * 编辑器草稿。字段与 AgentDefinition 的「最小执行意图」保持一致：只保存稳定身份、
 * 目标实例、文件夹、provider 与预设，以及附加提示词和可调用引用；Node 身份与解析后的
 * 绝对路径由目标实例权威数据推导，不进入草稿。
 */
export type AgentEditorDraft = {
  id: string;
  revision: string;
  name: string;
  description: string;
  targetInstanceId: string;
  cwdFolderId: string;
  cwdFolderPath: string;
  providerId: string;
  modelEntityId: string;
  modelName: string;
  reasoningEffort: string;
  permissionMode: string;
  /**
   * 附加提示词：叠加在该 Agent 的运行提示上，不替换触发运行的用户消息。
   * Codex adapter 以 `developer_instructions` 承载这段附加提示词。
   */
  appendedPrompt: string;
  callableAgentIds: string[];
};

export type AgentCatalogMember = {
  memberId: string;
  agentId: string;
  agentLabel: string;
  instanceLabel: string;
  parentMemberId?: string;
  status: AgentRunStatus;
  durationLabel: string;
  resultSummary: string;
};

export type AgentCatalogMemberRow = {
  member: AgentCatalogMember;
  depth: number;
  parent?: AgentCatalogMember;
};

export type AgentCatalogRun = {
  key: string;
  nodeId: string;
  runId: string;
  status: AgentRunStatus;
  startedLabel: string;
  durationLabel: string;
  initiatorSessionLabel: string;
  initiatorKind: "story-session" | "control-plane";
  revision: number;
  resultDeliveryStatus?: "pending" | "delivered" | "failed";
  resultDeliveryError?: string;
  workspaceDestroyed: boolean;
  sharedRootPath?: string;
  sharedExpiresLabel?: string;
  sharedState?: "preparing" | "active" | "retained" | "expiring" | "delete-retrying" | "expired" | "manual-intervention";
  sharedUsageBytes?: number;
  sharedQuotaBytes?: number;
  members: AgentCatalogMember[];
};

export type AgentCatalog = {
  nodes: AgentCatalogNode[];
  agents: AgentCatalogAgent[];
  /** 运行对象由 Node Agent 发布；执行链路尚未启用时为空集合。 */
  runs: AgentCatalogRun[];
};
