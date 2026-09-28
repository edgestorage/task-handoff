import type { AgentDefinition } from "@task-handoff/protocol/agent-definitions";
import type { AgentOrchestration } from "@task-handoff/protocol/agent-orchestrations";
import { agentOrchestrationEntryAgentIds, defaultAgentOrchestrationOwnerAgentId } from "@task-handoff/protocol/agent-orchestrations";
import type { AgentRun } from "@task-handoff/protocol/agent-runs";
import type { StoryAgentEntrySet } from "@task-handoff/protocol/story-agent-authorization";
import { controlPlaneAgentCapabilities, controlPlaneSupportsAgentExecutionPolicy } from "@task-handoff/control-plane-client";
import type { InstanceBoardItem, Node, NodeLocalFolder } from "../../../api/types";
import type { AgentCatalog, AgentCatalogAgent, AgentCatalogNode, AgentCatalogOrchestration, AgentBlockedCode, AgentCatalogMember, AgentCatalogMemberRow, AgentEditorDraft } from "./agentCatalogTypes";

export type AgentCatalogDefinition = { nodeId: string; agent: AgentDefinition };
export type AgentCatalogRunSnapshot = { nodeId: string; run: AgentRun };
export type AgentCatalogOrchestrationSnapshot = { nodeId: string; orchestration: AgentOrchestration };
export type AgentCatalogStoryEntries = { nodeId: string; storyLabel: string; entrySet: StoryAgentEntrySet };

/** Agent/Run wire ids are Node-local; UI selection and keyed rendering use this aggregate identity. */
export function agentCatalogKey(nodeId: string, objectId: string) {
  return `node:${nodeId.length}:${nodeId}${objectId}`;
}

export type AgentCatalogInput = {
  nodes: Node[];
  definitions: AgentCatalogDefinition[];
  orchestrations?: AgentCatalogOrchestrationSnapshot[];
  runs?: AgentCatalogRunSnapshot[];
  storyEntries?: AgentCatalogStoryEntries[];
  instances: InstanceBoardItem[];
  foldersByNode: Map<string, NodeLocalFolder[]>;
  /** 由调用方注入的 provider 展示名解析，让投影保持与 i18n 无关的纯函数。 */
  providerLabel?: (instance: InstanceBoardItem | undefined, providerId: string) => string;
};

/**
 * 把权威数据投影成只读展示模型：定义来自 Node Agent（Node 身份只出现在聚合信封上），
 * 标签与运行能力来自 Node 能力文档与实例目录，文件夹路径来自该 Node 的本地文件夹列表。
 * 展示模型不保存可写副本，也不替服务端做校验；阻塞只表达权威状态，不做兜底推断。
 */
export function buildAgentCatalog(input: AgentCatalogInput): AgentCatalog {
  const capabilities = new Map(input.nodes.map((node) => [node.id, controlPlaneAgentCapabilities(node.capabilities)]));
  const labels = new Map(input.nodes.map((node) => [node.id, node.name || node.id]));
  const instances = new Map(input.instances.map((instance) => [instance.id, instance]));
  const definitionIdsByNode = new Map<string, Set<string>>();
  for (const { nodeId, agent } of input.definitions) {
    const ids = definitionIdsByNode.get(nodeId) ?? new Set<string>();
    ids.add(agent.id);
    definitionIdsByNode.set(nodeId, ids);
  }
  const entryStoryLabels = new Map<string, string[]>();
  for (const story of input.storyEntries ?? []) {
    for (const entry of story.entrySet.entries) {
      const key = agentCatalogKey(story.nodeId, entry.agentId);
      entryStoryLabels.set(key, [...(entryStoryLabels.get(key) ?? []), story.storyLabel]);
    }
  }

  const nodes: AgentCatalogNode[] = input.nodes
    .filter((node) => capabilities.get(node.id)?.definitions)
    .map((node) => ({ id: node.id, label: node.name || node.id }));

  const agents = input.definitions.map<AgentCatalogAgent>(({ nodeId, agent }) => {
    const capability = capabilities.get(nodeId);
    const node = input.nodes.find((candidate) => candidate.id === nodeId);
    const instance = instances.get(agent.targetInstanceId);
    const blockedCode = agentBlockedCode({
      capability,
      available: capability?.definitions === true,
      nodeOnline: node?.status === "online",
      instance,
      agent,
    });
    return {
      key: agentCatalogKey(nodeId, agent.id),
      id: agent.id,
      revision: agent.revision,
      name: agent.name,
      description: agent.description,
      nodeId,
      nodeLabel: labels.get(nodeId) || nodeId,
      nodeOnline: node?.status === "online",
      instanceId: agent.targetInstanceId,
      instanceLabel: instance ? `${instance.name} · ${instance.node?.name || nodeId}` : agent.targetInstanceId,
      cwdFolderId: agent.cwdFolderId,
      folderPath: (input.foldersByNode.get(nodeId) || []).find((folder) => folder.id === agent.cwdFolderId)?.path || "",
      providerId: agent.providerId,
      provider: input.providerLabel?.(instance, agent.providerId) || agent.providerId,
      model: agent.modelName || "",
      permissionMode: agent.permissionMode || "",
      reasoning: agent.reasoningEffort || "",
      executionPolicy: agent.executionPolicy,
      appendedPrompt: agent.appendedPrompt,
      entryStoryLabels: entryStoryLabels.get(agentCatalogKey(nodeId, agent.id)) ?? [],
      runsSupported: capability?.runs === true,
      manualRunsSupported: capability?.manualRuns === true,
      executable: !blockedCode,
      blockedCode,
    };
  });

  const orchestrations = (input.orchestrations ?? []).map<AgentCatalogOrchestration>(({ nodeId, orchestration }) => {
    const capability = capabilities.get(nodeId);
    const node = input.nodes.find((candidate) => candidate.id === nodeId);
    const definitionIds = definitionIdsByNode.get(nodeId) ?? new Set<string>();
    const missingAgentIds = orchestration.agentIds.filter((agentId) => !definitionIds.has(agentId));
    const ownerAgentId = defaultAgentOrchestrationOwnerAgentId(orchestration.id);
    const editable = capability?.orchestrations === true && node?.status === "online";
    const blockedCode: AgentBlockedCode | undefined = missingAgentIds.length ? "missing-reference" : undefined;
    return {
      key: agentCatalogKey(nodeId, orchestration.id),
      id: orchestration.id,
      name: orchestration.name,
      nodeId,
      nodeLabel: labels.get(nodeId) || nodeId,
      revision: orchestration.revision,
      isDefault: Boolean(ownerAgentId),
      ownerAgentId,
      agentIds: [...orchestration.agentIds],
      edges: [...orchestration.edges],
      entryAgentIds: agentOrchestrationEntryAgentIds(orchestration),
      missingAgentIds,
      editable,
      runsSupported: capability?.runs === true,
      manualRunsSupported: capability?.manualRuns === true,
      executable: editable && !blockedCode,
      blockedCode,
    };
  });

  const agentLabels = new Map(input.definitions.map(({ nodeId, agent }) => [agentCatalogKey(nodeId, agent.id), agent.name]));
  const runs = (input.runs ?? []).map(({ nodeId, run }) => ({
    key: agentCatalogKey(nodeId, run.runId),
    nodeId,
    runId: run.runId,
    status: run.status,
    startedLabel: run.createdAt,
    durationLabel: durationLabel(run.createdAt, run.completedAt ?? run.updatedAt),
    initiatorSessionLabel: run.provenance.source === "control-plane"
      ? run.provenance.authorizationSubject?.subjectId ?? ""
      : run.provenance.initiatingAiSessionId,
    initiatorKind: (run.provenance.source === "control-plane" ? "control-plane" : "story-session") as "control-plane" | "story-session",
    orchestrationId: run.orchestrationId,
    revision: run.revision,
    resultDeliveryStatus: run.resultDelivery?.status,
    resultDeliveryError: run.resultDelivery?.error?.message,
    workspaceDestroyed: run.cleanup?.status === "completed" && ["completed", "failed", "cancelled"].includes(run.status),
    sharedExpiresLabel: run.sharedSpace?.expiresAt,
    sharedState: run.sharedSpace?.state,
    sharedUsageBytes: run.sharedSpace?.usageBytes,
    sharedQuotaBytes: run.sharedSpace?.quotaBytes,
    members: (run.members ?? []).map((member) => ({
      memberId: member.memberId,
      agentId: member.agentId,
      agentLabel: agentLabels.get(agentCatalogKey(nodeId, member.agentId)) ?? member.agentId,
      instanceLabel: instances.get(member.instanceId)?.name ?? member.instanceId,
      parentMemberId: member.parentMemberId,
      status: member.status,
      durationLabel: durationLabel(member.createdAt, member.completedAt ?? member.updatedAt),
      resultSummary: member.result?.text ?? member.error?.message ?? "",
    })),
  }));
  return { nodes, agents, orchestrations, runs };
}

function durationLabel(startedAt: string, endedAt: string) {
  const milliseconds = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  if (!Number.isFinite(milliseconds)) return "";
  return `${Math.round(milliseconds / 1_000)}s`;
}

/**
 * 可执行性只由权威能力与目标状态决定：任一条不成立就阻塞，且不替换为更弱的运行方式。
 * 运行能力尚未发布时定义仍然可以维护，只是不能发起运行。
 */
function agentBlockedCode(input: {
  capability: ReturnType<typeof controlPlaneAgentCapabilities> | undefined;
  available: boolean;
  nodeOnline: boolean;
  instance: InstanceBoardItem | undefined;
  agent: AgentDefinition;
}): AgentBlockedCode | undefined {
  if (!input.available) return "definitions-unsupported";
  if (!input.nodeOnline) return "node-offline";
  if (!input.instance) return "instance-missing";
  if (input.instance.runtime?.type === "local" || input.instance.runtime?.kind === "local") return "local-runtime";
  if (input.instance.connectionStatus === "offline") return "instance-offline";
  if (!controlPlaneSupportsAgentExecutionPolicy(input.capability?.execution, input.agent.executionPolicy, {
    runtime: "docker",
    providerId: input.agent.providerId,
  })) return "policy-unsupported";
  return undefined;
}

export function agentCatalogGroups(catalog: AgentCatalog) {
  return catalog.nodes
    .map((node) => ({ nodeId: node.id, nodeLabel: node.label, agents: catalog.agents.filter((agent) => agent.nodeId === node.id) }))
    .filter((group) => group.agents.length > 0);
}

/**
 * 手动运行是否可用：节点在线、定义未被阻塞，且该 Node 同时发布运行与手动运行能力。
 * 列表行、画布节点与详情页按钮共用这一个判定，避免各视图各自推导门控条件。
 */
export function agentManualRunAvailable(agent?: AgentCatalogAgent, runnableOrchestrations: AgentCatalogOrchestration[] = []) {
  return Boolean(agent?.nodeOnline && agent.executable && agent.runsSupported && agent.manualRunsSupported)
    && runnableOrchestrations.length > 0;
}

export function emptyAgentDraft(): AgentEditorDraft {
  return {
    id: "",
    revision: "",
    name: "",
    description: "",
    targetInstanceId: "",
    cwdFolderId: "",
    cwdFolderPath: "",
    providerId: "",
    modelEntityId: "",
    modelName: "",
    reasoningEffort: "",
    permissionMode: "",
    appendedPrompt: "",
  };
}

export function agentDraftFromDefinition(agent: AgentCatalogAgent): AgentEditorDraft {
  return {
    ...emptyAgentDraft(),
    id: agent.id,
    revision: agent.revision,
    name: agent.name,
    description: agent.description,
    targetInstanceId: agent.instanceId,
    cwdFolderId: agent.cwdFolderId,
    cwdFolderPath: agent.folderPath,
    providerId: agent.providerId,
    modelName: agent.model,
    reasoningEffort: agent.reasoning,
    permissionMode: agent.permissionMode,
    appendedPrompt: agent.appendedPrompt,
  };
}

/** 关系图的可选成员：默认只列同一 Node 上的 Agent，已验证的关系可以跨 Node 保留。 */
export function orchestrationAgentCandidates(agents: AgentCatalogAgent[], nodeId: string) {
  return agents.filter((agent) => agent.nodeId === nodeId);
}

/** 该 Agent 所在的编排：Run 可以把它作为入口成员，画布据此列出「参与的编排」。 */
export function agentParticipatingOrchestrations(orchestrations: AgentCatalogOrchestration[], agent: AgentCatalogAgent) {
  return orchestrations.filter((orchestration) => orchestration.nodeId === agent.nodeId && orchestration.agentIds.includes(agent.id));
}

/** 以该 Agent 为顶级节点的编排：新增编排默认从这里长出，入口换成其它 Agent 后自然移出。 */
export function agentEntryOrchestrations(orchestrations: AgentCatalogOrchestration[], agent: AgentCatalogAgent) {
  return orchestrations.filter((orchestration) => orchestration.nodeId === agent.nodeId && orchestration.entryAgentIds.includes(agent.id));
}

/** 该 Agent 可作为入口发起的编排：默认编排始终包含所属 Agent。 */
export function agentRunOrchestrations(orchestrations: AgentCatalogOrchestration[], agent: AgentCatalogAgent) {
  return agentParticipatingOrchestrations(orchestrations, agent)
    .filter((orchestration) => orchestration.manualRunsSupported && orchestration.executable);
}

/**
 * Flattens the authoritative parentMemberId tree for rendering. Orphans remain visible as roots, and
 * malformed cycles cannot recurse forever or hide every member in the cycle.
 */
export function agentCatalogMemberRows(members: AgentCatalogMember[]): AgentCatalogMemberRow[] {
  const membersById = new Map(members.map((member) => [member.memberId, member]));
  const childrenByParent = new Map<string, AgentCatalogMember[]>();
  for (const member of members) {
    if (!member.parentMemberId) continue;
    childrenByParent.set(member.parentMemberId, [...(childrenByParent.get(member.parentMemberId) ?? []), member]);
  }

  const rows: AgentCatalogMemberRow[] = [];
  const visited = new Set<string>();
  const visit = (member: AgentCatalogMember, depth: number) => {
    if (visited.has(member.memberId)) return;
    visited.add(member.memberId);
    rows.push({ member, depth, parent: member.parentMemberId ? membersById.get(member.parentMemberId) : undefined });
    for (const child of childrenByParent.get(member.memberId) ?? []) visit(child, depth + 1);
  };

  for (const member of members) {
    if (!member.parentMemberId || !membersById.has(member.parentMemberId)) visit(member, 0);
  }
  for (const member of members) visit(member, 0);
  return rows;
}
