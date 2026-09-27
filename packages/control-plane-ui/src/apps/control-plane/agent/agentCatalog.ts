import type { AgentDefinition } from "@task-handoff/protocol/agent-definitions";
import type { AgentRun } from "@task-handoff/protocol/agent-runs";
import type { StoryAgentEntrySet } from "@task-handoff/protocol/story-agent-authorization";
import { controlPlaneAgentCapabilities, controlPlaneSupportsAgentExecutionPolicy } from "@task-handoff/control-plane-client";
import type { InstanceBoardItem, Node, NodeLocalFolder } from "../../../api/types";
import type { AgentCatalog, AgentCatalogAgent, AgentCatalogNode, AgentBlockedCode, AgentCatalogMember, AgentCatalogMemberRow, AgentEditorDraft } from "./agentCatalogTypes";

export type AgentCatalogDefinition = { nodeId: string; agent: AgentDefinition };
export type AgentCatalogRunSnapshot = { nodeId: string; run: AgentRun };
export type AgentCatalogStoryEntries = { nodeId: string; storyLabel: string; entrySet: StoryAgentEntrySet };

/** Agent/Run wire ids are Node-local; UI selection and keyed rendering use this aggregate identity. */
export function agentCatalogKey(nodeId: string, objectId: string) {
  return `node:${nodeId.length}:${nodeId}${objectId}`;
}

export type AgentCatalogInput = {
  nodes: Node[];
  definitions: AgentCatalogDefinition[];
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
      definitionIds: definitionIdsByNode.get(nodeId) ?? new Set(),
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
      callableAgentIds: [...agent.callableAgentIds],
      appendedPrompt: agent.appendedPrompt,
      entryStoryLabels: entryStoryLabels.get(agentCatalogKey(nodeId, agent.id)) ?? [],
      runsSupported: capability?.runs === true,
      manualRunsSupported: capability?.manualRuns === true,
      executable: !blockedCode,
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
  return { nodes, agents, runs };
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
  definitionIds: Set<string>;
}): AgentBlockedCode | undefined {
  if (!input.available) return "definitions-unsupported";
  if (!input.nodeOnline) return "node-offline";
  if (!input.instance) return "instance-missing";
  if (input.instance.runtime?.type === "local" || input.instance.runtime?.kind === "local") return "local-runtime";
  if (input.instance.connectionStatus === "offline") return "instance-offline";
  if (input.agent.callableAgentIds.some((id) => !input.definitionIds.has(id))) return "missing-reference";
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
    callableAgentIds: [],
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
    callableAgentIds: [...agent.callableAgentIds],
  };
}

export function callableAgentCandidates(agents: AgentCatalogAgent[], nodeId: string, excludeAgentId: string) {
  return agents.filter((agent) => agent.nodeId === nodeId && agent.id !== excludeAgentId);
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
