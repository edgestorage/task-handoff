import {
  BuildInfoSchema,
  CONTROL_PLANE_PROTOCOL_VERSION,
  FinalComputerPlatformSchema,
  FinalComputerArchSchema,
  NodeAgentCapabilitiesSchema,
  ModelConfigSchema,
  ProjectSchema,
  sanitizeStoredProject,
  type ControlledInstance,
  type ModelConfig,
  type Node,
  type Project,
} from "@task-handoff/protocol/control-plane";
import {
  ControlPlaneInstanceDirectoryEntrySchema,
  ControlPlaneNodeDirectoryEntrySchema,
} from "@task-handoff/protocol/control-plane-directory";
import type { InstanceBoardResult } from "./instances/board-reader.ts";

export function publicNodeAgentCapabilities(data: unknown) {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const build = BuildInfoSchema.safeParse(record.build);
  const platform = FinalComputerPlatformSchema.safeParse(record.platform);
  const arch = FinalComputerArchSchema.safeParse(record.arch);
  const capabilities = NodeAgentCapabilitiesSchema.safeParse(record.capabilities);
  return {
    ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.nodeId === "string" ? { nodeId: record.nodeId } : {}),
    ...(typeof record.protocolVersion === "string" ? { protocolVersion: record.protocolVersion } : {}),
    ...(platform.success ? { platform: platform.data } : {}),
    ...(arch.success ? { arch: arch.data } : {}),
    ...(capabilities.success ? { capabilities: capabilities.data } : {}),
    ...(build.success ? { build: build.data } : {}),
    ...(typeof record.serverTime === "string" ? { serverTime: record.serverTime } : {}),
  };
}

export function publicNode<T extends Node>(node: T) {
  const { agent, ...capabilities } = node.capabilities;
  const { secret: _secret, ...auth } = node.auth;
  const pairing = auth.pairing ? { ...auth.pairing, joinToken: undefined } : undefined;
  const publicAgent = publicNodeAgentCapabilities(agent);
  return {
    ...node,
    auth: pairing ? { ...auth, pairing } : auth,
    capabilities: publicAgent ? { ...capabilities, agent: publicAgent } : capabilities,
  };
}

export function publicNodeDirectory(node: Node & { connectionPhase?: "connecting" | "handshaking" | "healthy" | "reconnecting" | "suspect" | "offline" }) {
  const proxyError = node.proxyState?.lastError;
  return ControlPlaneNodeDirectoryEntrySchema.parse({
    id: node.id,
    name: node.name,
    status: node.status,
    health: node.health,
    connectionMode: node.connectionMode,
    connectionPhase: node.connectionPhase,
    lastSeenAt: node.lastSeenAt,
    observedAt: node.updatedAt,
    capabilities: Object.keys(node.capabilities).sort(),
    error: proxyError ? { code: proxyError.code, message: "Node connection failed. Use the desktop Control Plane for diagnostics." } : undefined,
  });
}

export function publicInstanceDirectory(item: InstanceBoardResult["items"][number]) {
  const runtimeError = item.runtimeVersion?.error;
  const imageError = item.imageProvisioning?.error;
  const workspaceError = item.workspace.error;
  const error = runtimeError
    ? { code: runtimeError.code, message: "Instance runtime convergence failed. Use the desktop Control Plane for diagnostics." }
    : imageError
      ? { code: "IMAGE_PROVISIONING_FAILED", message: "Instance image provisioning failed. Use the desktop Control Plane for diagnostics." }
      : workspaceError
        ? { code: "WORKSPACE_FAILED", message: "Instance workspace preparation failed. Use the desktop Control Plane for diagnostics." }
        : undefined;
  const nodeAgent = item.node?.capabilities.agent;
  const nodeAgentRecord = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? nodeAgent as Record<string, unknown>
    : undefined;
  const nodeProtocolVersion = typeof nodeAgentRecord?.protocolVersion === "string"
    ? nodeAgentRecord.protocolVersion
    : undefined;
  const nodeProtocolCompatible = !nodeProtocolVersion || nodeProtocolVersion === CONTROL_PLANE_PROTOCOL_VERSION;
  const protocolWarnings = [
    item.protocolCompatible ? undefined : `Instance protocol ${item.protocolVersion || "unknown"} differs from this Control Plane.`,
    nodeProtocolCompatible ? undefined : `Node protocol ${nodeProtocolVersion} differs from this Control Plane.`,
  ].filter((warning): warning is string => Boolean(warning));
  const running = item.status === "running" || item.connectionStatus === "online" || item.access.status === "reachable";
  const connecting = !["failed", "stopped", "stopping", "unhealthy"].includes(item.status)
    && item.connectionStatus !== "online"
    && ["provisioning", "starting", "registering", "registered"].includes(item.status);
  const availableActions = [
    !running && !["provisioning", "starting", "registering", "registered", "stopping"].includes(item.status) ? "start" as const : undefined,
    !["failed", "stopped", "stopping", "unhealthy"].includes(item.status) && (running || connecting) ? "stop" as const : undefined,
    running ? "restart" as const : undefined,
    item.status === "failed" && item.imageProvisioning?.phase === "failed" ? "retry-image" as const : undefined,
  ].filter((action): action is "start" | "stop" | "restart" | "retry-image" => Boolean(action));
  return ControlPlaneInstanceDirectoryEntrySchema.parse({
    id: item.id,
    name: item.name,
    nodeId: item.nodeId,
    status: item.status,
    health: item.health,
    connectionStatus: item.connectionStatus,
    ready: item.ready,
    capabilities: {
      aiSessionTimeline: item.capabilities.features.aiSessionTimeline,
      aiSessionConversationAttachments: item.capabilities.features.aiSessionConversationAttachments,
      aiSessionProviders: item.capabilities.features.aiSessionProviders,
    },
    config: {
      defaultCodexPermissionMode: item.config.defaultCodexPermissionMode,
      aiSessionMaxFileAttachmentBytes: item.config.aiSessionMaxFileAttachmentBytes,
    },
    lastHeartbeatAt: item.lastHeartbeatAt,
    heartbeatAgeMs: item.heartbeatAgeMs,
    observedAt: item.updatedAt,
    runtime: { id: item.runtimeId, name: item.runtime?.name, type: item.runtime?.type },
    workspace: { status: item.workspace.status, path: item.workspace.path },
    protocol: {
      version: item.protocolVersion,
      compatible: item.protocolCompatible && nodeProtocolCompatible,
      warning: protocolWarnings.length ? protocolWarnings.join(" ") : undefined,
    },
    aiSessions: item.aiSessions,
    availableActions,
    availableApps: (item.appInventory?.items || [])
      .filter((app) => app.availability === "available")
      .map((app) => ({
        id: app.id,
        name: app.name,
        kind: app.kind,
        supportsCwdSelection: app.capabilities.supportsCwdSelection,
      })),
    availableAgents: (item.appInventory?.items || [])
      .filter((app) => app.availability === "available" && item.capabilities.features.aiSessionProviders.some((provider) => provider.agent === app.id && provider.actions.create))
      .map((app) => ({
        id: app.id,
        name: app.name,
        kind: app.kind,
        supportsCwdSelection: app.capabilities.supportsCwdSelection,
      })),
    error,
  });
}

export function workspacePolicyForSource(source: Project["source"]) {
  if (source.type === "local-folder") {
    return { mode: "local-bind" as const, path: "/workspace", readOnly: false };
  }
  return { mode: "git-clone" as const, path: "/workspace", readOnly: false };
}

export function publicInstance(instance: ControlledInstance) {
  const {
    registrationToken: _registrationToken,
    target: _target,
    agentStatus: _agentStatus,
    targetStatus: _targetStatus,
    uiAccessStatus: _uiAccessStatus,
    ...publicRecord
  } = instance;
  return publicRecord;
}

export function publicInstanceWithAccess(instance: ControlledInstance) {
  return publicInstance(withControlPlaneAccess(instance));
}

export function publicProject(project: Project) {
  return project;
}

export function normalizeProject(project: unknown) {
  if (project && typeof project === "object" && !Array.isArray(project)) {
    return ProjectSchema.parse(sanitizeStoredProject(project));
  }
  return ProjectSchema.parse(project);
}

export function publicModel(model: ModelConfig) {
  const { key: _key, ...publicRecord } = model;
  return {
    ...publicRecord,
    keyPreview: keyPreview(model.key),
    keySet: true,
  };
}

export function normalizeModel(model: unknown) {
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const record = { ...(model as Record<string, unknown>) };
    if (!("app" in record)) {
      const apps = Array.isArray(record.apps) ? record.apps : [];
      record.app = apps.includes("claude") && !apps.includes("codex") ? "claude" : "codex";
    }
    delete record.apps;
    return ModelConfigSchema.parse(record);
  }
  return ModelConfigSchema.parse(model);
}

function withControlPlaneAccess<T extends ControlledInstance>(instance: T): T {
  const proxyBase = `/instances/${encodeURIComponent(instance.id)}`;
  const accessStatus: "reachable" | "endpoint-unreachable" = instance.connectionStatus === "online" || instance.agentStatus === "online" ? "reachable" : "endpoint-unreachable";
  const access = {
    strategy: "control-plane-proxy" as const,
    web: `${proxyBase}/`,
    api: `${proxyBase}/api`,
    ws: `${proxyBase}/api`,
    status: accessStatus,
  };
  return {
    ...instance,
    access,
  };
}

function keyPreview(key: string) {
  if (key.length <= 8) {
    return "set";
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
