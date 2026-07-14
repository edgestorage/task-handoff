import {
  BuildInfoSchema,
  ModelConfigSchema,
  ProjectSchema,
  type ControlledInstance,
  type ModelConfig,
  type Node,
  type Project,
} from "@task-handoff/protocol/control-plane";

export function publicNodeAgentCapabilities(data: unknown) {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const build = BuildInfoSchema.safeParse(record.build);
  return {
    ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.nodeId === "string" ? { nodeId: record.nodeId } : {}),
    ...(typeof record.protocolVersion === "string" ? { protocolVersion: record.protocolVersion } : {}),
    ...(build.success ? { build: build.data } : {}),
    ...(typeof record.serverTime === "string" ? { serverTime: record.serverTime } : {}),
  };
}

export function publicNode(node: Node) {
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
    const record = { ...(project as Record<string, unknown>) };
    if (!("defaultRuntimeId" in record)) {
      record.defaultRuntimeId = "runtime_local_docker";
    }
    return ProjectSchema.parse(record);
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

export function normalizeModelSelection(record: Record<string, unknown>) {
  if (record.modelSelection && typeof record.modelSelection === "object" && !Array.isArray(record.modelSelection)) {
    return record.modelSelection;
  }
  return {};
}
