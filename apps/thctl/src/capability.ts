import {
  supportsNodeFolderPlaces,
  supportsNodeLocalFolderNameUpdate,
  supportsNodeGitCredentialRuntimeBroker,
  supportsNodeManagedGitCredentialRegistry,
  supportsNodeModelRelay,
  supportsNodeModelRequestMappings,
  supportsNodePrivateModelCatalog,
  supportsNodeStableModelIdentity,
} from "@task-handoff/protocol/control-plane";
import {
  supportsControlPlaneCustomRoles,
  supportsControlPlaneExternalIdentityLogin,
  supportsControlPlaneUserManagement,
} from "@task-handoff/protocol/control-plane-access";
import type { ControlPlaneClient } from "@task-handoff/control-plane-client";
import type { VerifiedControlPlaneIdentity } from "./control-plane.ts";
import { capabilityMissingError } from "./errors.ts";

/**
 * 统一 capability 查询：节点侧结构化能力文档与面板 `nodeCapabilities.ts` 同源，
 * 都从 `/api/nodes/:id` 的 `capabilities.agent.capabilities` 读取后调用节点协议查询函数。
 */
export type CapabilityCheck = {
  /** 面向用户的稳定能力名，用于错误信息与诊断。 */
  name: string;
  check: (capabilities: unknown) => boolean;
};

export const NODE_CAPABILITIES = {
  modelRelay: { name: "modelRelay", check: supportsNodeModelRelay },
  modelRequestMappings: { name: "modelRequestMappings", check: supportsNodeModelRequestMappings },
  privateModelCatalog: { name: "privateModelCatalog", check: supportsNodePrivateModelCatalog },
  stableModelIdentity: { name: "stableModelIdentity", check: supportsNodeStableModelIdentity },
  managedGitCredentials: { name: "managedGitCredentials", check: supportsNodeManagedGitCredentialRegistry },
  gitCredentialRuntimeBroker: { name: "gitCredentialRuntimeBroker", check: supportsNodeGitCredentialRuntimeBroker },
  localFolderPlaces: { name: "localFolderPlaces", check: supportsNodeFolderPlaces },
  localFolderNameUpdate: { name: "localFolderNameUpdate", check: supportsNodeLocalFolderNameUpdate },
} as const satisfies Record<string, CapabilityCheck>;

/** 从公开节点记录取出结构化能力文档；缺失或形状异常时返回 undefined，由查询函数归一为“不支持”。 */
export function nodeAgentCapabilityDocument(node: { capabilities?: Record<string, unknown> } | undefined): unknown {
  const agent = node?.capabilities?.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  return (agent as { capabilities?: unknown }).capabilities;
}

export type NodeCapabilitySnapshot = { nodeId: string; capabilities: unknown };

/**
 * 读取节点能力快照。能力门控只对“服务端明确声明不支持”关闭命令；
 * 无法读取节点记录（例如节点已被移除）交给后续业务请求返回权威错误。
 */
export async function fetchNodeCapabilitySnapshot(
  client: ControlPlaneClient,
  nodeId: string,
  signal?: AbortSignal,
): Promise<NodeCapabilitySnapshot | undefined> {
  const node = await client.resources.node(nodeId, signal);
  return { nodeId, capabilities: nodeAgentCapabilityDocument(node) };
}

export function requireNodeCapability(
  commandId: string,
  snapshot: NodeCapabilitySnapshot | undefined,
  capability: CapabilityCheck,
) {
  if (!snapshot) return;
  if (capability.check(snapshot.capabilities)) return;
  throw capabilityMissingError(commandId, capability.name, { nodeId: snapshot.nodeId, scope: "node" });
}

/** 实例级命令按实例所属节点做能力门控；实例不可见时交给权威请求返回 404。 */
export async function requireInstanceNodeCapability(
  client: ControlPlaneClient,
  instanceId: string,
  commandId: string,
  capability: CapabilityCheck,
  signal?: AbortSignal,
) {
  const instances = await client.resources.instanceBoard(signal);
  const instance = instances.find((candidate) => candidate.id === instanceId);
  if (!instance) return;
  const snapshot = await fetchNodeCapabilitySnapshot(client, instance.nodeId, signal);
  requireNodeCapability(commandId, snapshot, capability);
}

export const CONTROL_PLANE_CAPABILITIES = {
  userManagement: { name: "userManagement", check: supportsControlPlaneUserManagement },
  customRoles: { name: "customRoles", check: supportsControlPlaneCustomRoles },
  externalIdentityLogin: { name: "externalIdentityLogin", check: supportsControlPlaneExternalIdentityLogin },
} as const satisfies Record<string, CapabilityCheck>;

export function requireControlPlaneCapability(
  commandId: string,
  identity: VerifiedControlPlaneIdentity,
  capability: CapabilityCheck,
) {
  if (capability.check(identity.payload.capabilities)) return;
  throw capabilityMissingError(commandId, capability.name, {
    origin: identity.origin,
    protocolVersion: identity.payload.protocolVersion,
    scope: "control-plane",
  });
}
