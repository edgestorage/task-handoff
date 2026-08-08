import { z } from "zod";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceSchema,
  EnvironmentTemplateSchema,
  InstanceResourceMetricsSchema,
  InstanceDeleteResultSchema,
  LocalDockerImageSchema,
  NodeAgentDeleteResponseSchema,
  NodeAgentHealthSchema,
  NodeAgentExternalListenerSchema,
  NodeAgentInstanceProxyRawResponseSchema,
  NodeAgentPairingInviteResponseSchema,
  NodeAgentControlPlaneConnectionCreateResultSchema,
  NodeAgentControlPlanePairingSchema,
  NodeAgentControlPlaneConnectionSchema,
  NodeFolderTreeEntrySchema,
  NodeLocalFolderSchema,
  NodeModelAssignmentSchema,
  NodeModelPublicRecordSchema,
  NodeRuntimeSchema,
  UpdateCheckResultSchema,
  UpdateJobSchema,
  safeParseStoredControlledInstance,
  type ControlledInstance,
  type Node,
  type NodeLocalFolder,
  type NodeModelPublicRecord,
  type NodeRuntime,
  type UpdateCheckRequest,
  type ApplyUpdateRequest,
} from "@task-handoff/protocol/control-plane";
import { ControlPlaneNodeAgentClient, nodeAgentScopedError, type NodeAgentScopedError } from "./client.ts";

export type NodeAgentFleetResult<T> = {
  items: T[];
  nodeErrors: NodeAgentScopedError[];
};

export type ControlPlaneNodeAgentGatewayOptions = {
  fleetRequestTimeoutMs?: number;
};

type NodeAgentListResult<T> = NodeAgentFleetResult<T>;

type NodeAgentInstanceParseResult = {
  instance?: ControlledInstance;
  error?: NodeAgentScopedError;
};

type NodeAgentFleetSnapshot<T> = {
  connectionKey: string;
  items: T[];
};

const DEFAULT_FLEET_REQUEST_TIMEOUT_MS = 2_000;

export class ControlPlaneNodeAgentGateway {
  private readonly client: ControlPlaneNodeAgentClient;
  private readonly fleetRequestTimeoutMs: number;
  private readonly runtimeSnapshots = new Map<string, NodeAgentFleetSnapshot<NodeRuntime>>();
  private readonly instanceSnapshots = new Map<string, NodeAgentFleetSnapshot<ControlledInstance>>();

  constructor(client: ControlPlaneNodeAgentClient, options: ControlPlaneNodeAgentGatewayOptions = {}) {
    this.client = client;
    this.fleetRequestTimeoutMs = Number.isFinite(options.fleetRequestTimeoutMs) && Number(options.fleetRequestTimeoutMs) > 0
      ? Number(options.fleetRequestTimeoutMs)
      : DEFAULT_FLEET_REQUEST_TIMEOUT_MS;
  }

  request(node: Node, route: string, init: RequestInit = {}) {
    return this.client.request(node, route, init);
  }

  health(node: Node) {
    return this.client.requestSchema(node, "/health", NodeAgentHealthSchema);
  }

  checkUpdate(node: Node, input: UpdateCheckRequest) {
    return this.client.requestSchema(node, "/updates/check", UpdateCheckResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  applyUpdate(node: Node, input: ApplyUpdateRequest) {
    return this.client.requestSchema(node, "/updates/apply", UpdateJobSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listUpdateJobs(node: Node) {
    return this.client.requestSchema(node, "/updates/jobs", z.array(UpdateJobSchema));
  }

  getExternalListener(node: Node) {
    return this.client.requestSchema(node, "/settings/external-listener", NodeAgentExternalListenerSchema);
  }

  updateExternalListener(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/settings/external-listener", NodeAgentExternalListenerSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  createPairingInvite(node: Node, input: unknown = {}) {
    return this.client.requestSchema(node, "/pairing/invites", NodeAgentPairingInviteResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input && typeof input === "object" ? input : {}),
    });
  }

  createControlPlaneConnection(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/control-plane-connections", NodeAgentControlPlaneConnectionCreateResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listControlPlanePairings(node: Node) {
    return this.client.requestSchema(node, "/control-plane-pairings", z.array(NodeAgentControlPlanePairingSchema));
  }

  deleteControlPlanePairing(node: Node, keyId: string) {
    return this.client.requestSchema(node, `/control-plane-pairings/${encodeURIComponent(keyId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  listControlPlaneConnections(node: Node) {
    return this.client.requestSchema(node, "/control-plane-connections", z.array(NodeAgentControlPlaneConnectionSchema));
  }

  deleteControlPlaneConnection(node: Node, connectionId: string) {
    return this.client.requestSchema(node, `/control-plane-connections/${encodeURIComponent(connectionId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  listDockerImages(node: Node) {
    return this.client.requestSchema(node, "/docker/images", z.array(LocalDockerImageSchema));
  }

  listFolderTree(node: Node, input: { path?: string; depth?: number } = {}) {
    const params = new URLSearchParams();
    if (input.path) {
      params.set("path", input.path);
    }
    if (input.depth !== undefined) {
      params.set("depth", String(input.depth));
    }
    const query = params.toString();
    return this.client.requestSchema(node, `/folders/tree${query ? `?${query}` : ""}`, z.array(NodeFolderTreeEntrySchema));
  }

  listLocalFolders(node: Node, init: RequestInit = {}) {
    return this.client.requestSchema(node, "/local-folders", z.array(NodeLocalFolderSchema), init);
  }

  createLocalFolder(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/local-folders", NodeLocalFolderSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async requireLocalFolder(node: Node, folderId: string) {
    const folders = await this.listLocalFolders(node);
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) {
      const error = new Error(`Local folder ${folderId} was not found on node ${node.id}.`);
      Object.assign(error, { statusCode: 404, code: "NODE_LOCAL_FOLDER_NOT_FOUND", nodeId: node.id, route: "/local-folders" });
      throw error;
    }
    return folder;
  }

  listRuntimes(node: Node, init: RequestInit = {}) {
    return this.client.requestSchema(node, "/runtimes", z.array(NodeRuntimeSchema), init);
  }

  createRuntime(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/runtimes", NodeRuntimeSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateRuntime(node: Node, runtimeId: string, input: unknown) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}`;
    return this.client.requestSchema(node, route, NodeRuntimeSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  checkRuntime(node: Node, runtimeId: string) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}/check`;
    return this.client.requestSchema(node, route, NodeRuntimeSchema, { method: "POST" });
  }

  deleteRuntime(node: Node, runtimeId: string) {
    return this.client.requestSchema(node, `/runtimes/${encodeURIComponent(runtimeId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  deleteLocalFolder(node: Node, folderId: string) {
    return this.client.requestSchema(node, `/local-folders/${encodeURIComponent(folderId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  listModels(node: Node, init: RequestInit = {}) {
    return this.client.requestSchema(node, "/models", z.array(NodeModelPublicRecordSchema), init);
  }

  createModel(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/models", NodeModelPublicRecordSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deployModel(node: Node, modelId: string, input: unknown) {
    return this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}/deploy`, NodeModelPublicRecordSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateModel(node: Node, modelId: string, input: unknown) {
    return this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}`, NodeModelPublicRecordSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deleteModel(node: Node, modelId: string) {
    return this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}`, NodeAgentDeleteResponseSchema, { method: "DELETE" });
  }

  assignInstanceModels(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/model-assignment`, z.object({
      assignment: NodeModelAssignmentSchema,
      instance: ControlledInstanceSchema,
    }).strict(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async listFleetModels(nodes: Node[], init: RequestInit = {}): Promise<NodeAgentFleetResult<{ nodeId: string; model: NodeModelPublicRecord }>> {
    const route = "/models";
    const results = await Promise.allSettled(nodes.map(async (node) => ({ node, models: await this.listModels(node, init) })));
    return results.reduce<NodeAgentFleetResult<{ nodeId: string; model: NodeModelPublicRecord }>>((current, result, index) => {
      if (result.status === "fulfilled") {
        current.items.push(...result.value.models.map((model) => ({ nodeId: result.value.node.id, model })));
      } else {
        const node = nodes[index];
        if (node) current.nodeErrors.push(nodeAgentScopedError(node, route, "GET", result.reason));
      }
      return current;
    }, { items: [], nodeErrors: [] });
  }

  async listFleetRuntimes(nodes: Node[], init: RequestInit = {}): Promise<NodeAgentFleetResult<NodeRuntime>> {
    return this.listFleetFromSnapshots(nodes, "/runtimes", init, this.runtimeSnapshots, async (node, requestInit) => ({
      items: await this.listRuntimes(node, requestInit),
      nodeErrors: [],
    }));
  }

  listInstances(node: Node, init: RequestInit = {}) {
    return this.listInstancesWithDiagnostics(node, init).then((result) => result.items);
  }

  async listInstancesWithDiagnostics(node: Node, init: RequestInit = {}): Promise<NodeAgentListResult<ControlledInstance>> {
    return this.client.requestSchema(node, "/instances", z.array(z.unknown()), init)
      .then((items) => items.reduce<NodeAgentListResult<ControlledInstance>>((current, item) => {
        const result = this.normalizeInstance(node, item);
        if (result.instance) {
          current.items.push(result.instance);
        }
        if (result.error) {
          current.nodeErrors.push(result.error);
        }
        return current;
      }, { items: [], nodeErrors: [] }));
  }

  createInstance(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/instances", ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateInstance(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}`, ControlledInstanceSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deleteInstance(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/delete`, InstanceDeleteResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listEnvironmentTemplates(node: Node, init: RequestInit = {}) {
    return this.client.requestSchema(node, "/environment-templates", z.array(EnvironmentTemplateSchema), init);
  }

  getEnvironmentTemplate(node: Node, templateId: string, init: RequestInit = {}) {
    return this.client.requestSchema(node, `/environment-templates/${encodeURIComponent(templateId)}`, EnvironmentTemplateSchema, init);
  }

  createEnvironmentTemplate(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/environment-templates`, EnvironmentTemplateSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deleteEnvironmentTemplate(node: Node, templateId: string) {
    return this.client.requestSchema(node, `/environment-templates/${encodeURIComponent(templateId)}`, z.object({
      deleted: z.boolean(),
      templateId: EnvironmentTemplateSchema.shape.id,
    }).strict(), { method: "DELETE" });
  }

  startInstance(node: Node, instanceId: string, input: unknown = {}) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/start`, ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  retryInstanceImageProvisioning(node: Node, instanceId: string) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/image-provisioning/retry`, ControlledInstanceSchema, {
      method: "POST",
    });
  }

  stopInstance(node: Node, instanceId: string) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/stop`, ControlledInstanceSchema, {
      method: "POST",
    });
  }

  restartInstance(node: Node, instanceId: string, input: unknown = {}) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/restart`, ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  instanceResourceMetrics(node: Node, instanceId: string) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/metrics`, InstanceResourceMetricsSchema);
  }

  proxyRawInstance(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/proxy/raw`, NodeAgentInstanceProxyRawResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async listFleetInstances(nodes: Node[], init: RequestInit = {}): Promise<NodeAgentFleetResult<ControlledInstance>> {
    return this.listFleetFromSnapshots(
      nodes,
      "/instances",
      init,
      this.instanceSnapshots,
      (node, requestInit) => this.listInstancesWithDiagnostics(node, requestInit),
    );
  }

  private async listFleetFromSnapshots<T>(
    nodes: Node[],
    route: string,
    init: RequestInit,
    snapshots: Map<string, NodeAgentFleetSnapshot<T>>,
    load: (node: Node, init: RequestInit) => Promise<NodeAgentListResult<T>>,
  ): Promise<NodeAgentFleetResult<T>> {
    const activeNodeIds = new Set(nodes.map((node) => node.id));
    for (const nodeId of snapshots.keys()) {
      if (!activeNodeIds.has(nodeId)) snapshots.delete(nodeId);
    }
    const results = await Promise.all(nodes.map(async (node): Promise<NodeAgentFleetResult<T>> => {
      const connectionKey = this.fleetConnectionKey(node);
      try {
        this.requireFleetNodeReady(node, route);
        const result = await this.withFleetDeadline(node, route, init, (requestInit) => load(node, requestInit));
        snapshots.set(node.id, { connectionKey, items: [...result.items] });
        return result;
      } catch (error) {
        const snapshot = snapshots.get(node.id);
        return {
          items: snapshot?.connectionKey === connectionKey ? [...snapshot.items] : [],
          nodeErrors: [nodeAgentScopedError(node, route, "GET", error)],
        };
      }
    }));
    return results.reduce<NodeAgentFleetResult<T>>((fleet, result) => {
      fleet.items.push(...result.items);
      fleet.nodeErrors.push(...result.nodeErrors);
      return fleet;
    }, { items: [], nodeErrors: [] });
  }

  private fleetConnectionKey(node: Node) {
    return JSON.stringify([
      node.id,
      node.connectionMode,
      node.controlEndpoint,
      node.endpoint,
      node.auth.mode,
      node.auth.keyId,
    ]);
  }

  private requireFleetNodeReady(node: Node, route: string) {
    const phase = (node as Node & { connectionPhase?: string }).connectionPhase;
    const directControlApiIsOnline = node.status === "online"
      && node.connectionMode !== "reverse-wss"
      && node.connectionMode !== "control-plane-proxy";
    if (!phase || phase === "healthy" || directControlApiIsOnline) return;
    const error = new Error(`Node agent ${node.id} is ${phase}; serving its latest fleet snapshot.`);
    Object.assign(error, { code: "NODE_AGENT_CONNECTION_PENDING", nodeId: node.id, route });
    throw error;
  }

  private async withFleetDeadline<T>(
    node: Node,
    route: string,
    init: RequestInit,
    load: (init: RequestInit) => Promise<T>,
  ) {
    const controller = new AbortController();
    const timeoutError = Object.assign(
      new Error(`Node agent ${node.id} did not return ${route} before the fleet aggregation deadline.`),
      { code: "NODE_AGENT_FLEET_TIMEOUT", nodeId: node.id, route },
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectFromAbort = () => reject(controller.signal.reason || timeoutError);
      if (controller.signal.aborted) rejectFromAbort();
      else controller.signal.addEventListener("abort", rejectFromAbort, { once: true });
    });
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abortFromCaller();
    else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError), this.fleetRequestTimeoutMs);
    timer.unref?.();
    try {
      return await Promise.race([load({ ...init, signal: controller.signal }), aborted]);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private normalizeInstance(node: Node, value: unknown): NodeAgentInstanceParseResult {
    const route = "/instances";
    const method = "GET";
    const parsed = safeParseStoredControlledInstance(value);
    if (parsed.success) {
      if (parsed.data.protocolVersion && parsed.data.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
        this.client.logger?.warn?.({
          nodeId: node.id,
          instanceId: parsed.data.id,
          expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          actualProtocolVersion: parsed.data.protocolVersion,
          errorCode: "PROTOCOL_VERSION_MISMATCH",
        }, "node instance protocol version mismatch");
        return { instance: parsed.data };
      }
      return { instance: parsed.data };
    }
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const instanceId = typeof record.id === "string" ? record.id : undefined;
    this.client.logger?.warn?.({
      nodeId: node.id,
      instanceId,
      errorCode: "NODE_INSTANCE_PAYLOAD_INVALID",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    }, "node instance payload invalid");
    return {
      error: {
        nodeId: node.id,
        route,
        method,
        code: "NODE_INSTANCE_PAYLOAD_INVALID",
        message: instanceId ? `Node instance ${instanceId} payload is invalid.` : "Node instance payload is invalid.",
        statusCode: 502,
        issues: parsed.error.issues,
      },
    };
  }
}

export type { NodeLocalFolder, NodeRuntime };
