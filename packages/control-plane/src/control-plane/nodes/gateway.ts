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
  NodeFolderPlaceSchema,
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
import type {
  ControlPlaneFleetResource,
  ControlPlaneFleetResourcePhase,
  ControlPlaneNodeFleetState,
} from "@task-handoff/protocol/control-plane-directory";

export type NodeAgentFleetResult<T> = {
  items: T[];
  nodeErrors: NodeAgentScopedError[];
  nodeStates: NodeFleetResourceState[];
};

export type ControlPlaneNodeAgentGatewayOptions = {
  fleetRequestTimeoutMs?: number;
  fleetSnapshotFreshMs?: number;
  fleetRetryBaseMs?: number;
  fleetRetryMaxMs?: number;
  onFleetStateChanged?: (state: NodeFleetResourceState) => void;
};

export type NodeFleetResource = ControlPlaneFleetResource;
export type NodeFleetResourcePhase = ControlPlaneFleetResourcePhase;
export type NodeFleetResourceState = ControlPlaneNodeFleetState;

type NodeAgentListResult<T> = {
  items: T[];
  nodeErrors: NodeAgentScopedError[];
};

type NodeAgentInstanceParseResult = {
  instance?: ControlledInstance;
  error?: NodeAgentScopedError;
};

type NodeAgentFleetSnapshot<T> = {
  connectionKey: string;
  items: T[];
  phase: NodeFleetResourcePhase;
  revision: number;
  updatedAt?: string;
  error?: NodeAgentScopedError;
};

const DEFAULT_FLEET_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_FLEET_SNAPSHOT_FRESH_MS = 15_000;
const DEFAULT_FLEET_RETRY_BASE_MS = 1_000;
const DEFAULT_FLEET_RETRY_MAX_MS = 30_000;

export class ControlPlaneNodeAgentGateway {
  private readonly client: ControlPlaneNodeAgentClient;
  private readonly fleetRequestTimeoutMs: number;
  private readonly fleetSnapshotFreshMs: number;
  private readonly fleetRetryBaseMs: number;
  private readonly fleetRetryMaxMs: number;
  private readonly onFleetStateChanged: ((state: NodeFleetResourceState) => void) | undefined;
  private readonly runtimeSnapshots = new Map<string, NodeAgentFleetSnapshot<NodeRuntime>>();
  private readonly instanceSnapshots = new Map<string, NodeAgentFleetSnapshot<ControlledInstance>>();
  private readonly modelSnapshots = new Map<string, NodeAgentFleetSnapshot<NodeModelPublicRecord>>();
  private readonly fleetRefreshes = new Map<string, Promise<void>>();
  private readonly fleetRevisions = new Map<string, number>();
  private readonly fleetRetryAttempts = new Map<string, number>();
  private readonly fleetRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(client: ControlPlaneNodeAgentClient, options: ControlPlaneNodeAgentGatewayOptions = {}) {
    this.client = client;
    this.fleetRequestTimeoutMs = Number.isFinite(options.fleetRequestTimeoutMs) && Number(options.fleetRequestTimeoutMs) > 0
      ? Number(options.fleetRequestTimeoutMs)
      : DEFAULT_FLEET_REQUEST_TIMEOUT_MS;
    this.fleetSnapshotFreshMs = Number.isFinite(options.fleetSnapshotFreshMs) && Number(options.fleetSnapshotFreshMs) >= 0
      ? Number(options.fleetSnapshotFreshMs)
      : DEFAULT_FLEET_SNAPSHOT_FRESH_MS;
    this.fleetRetryBaseMs = Number.isFinite(options.fleetRetryBaseMs) && Number(options.fleetRetryBaseMs) > 0
      ? Number(options.fleetRetryBaseMs)
      : DEFAULT_FLEET_RETRY_BASE_MS;
    this.fleetRetryMaxMs = Number.isFinite(options.fleetRetryMaxMs) && Number(options.fleetRetryMaxMs) >= this.fleetRetryBaseMs
      ? Number(options.fleetRetryMaxMs)
      : Math.max(DEFAULT_FLEET_RETRY_MAX_MS, this.fleetRetryBaseMs);
    this.onFleetStateChanged = options.onFleetStateChanged;
  }

  request(node: Node, route: string, init: RequestInit = {}) {
    return this.client.request(node, route, init);
  }

  forgetNode(nodeId: string) {
    this.runtimeSnapshots.delete(nodeId);
    this.instanceSnapshots.delete(nodeId);
    this.modelSnapshots.delete(nodeId);
    for (const resource of ["runtimes", "instances", "models"] as const) {
      this.resetFleetRetry(`${resource}:${nodeId}`);
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.fleetRetryTimers.values()) clearTimeout(timer);
    this.fleetRetryTimers.clear();
    this.fleetRetryAttempts.clear();
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

  listFolderPlaces(node: Node) {
    return this.client.requestSchema(node, "/folders/places", z.array(NodeFolderPlaceSchema));
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

  updateLocalFolder(node: Node, folderId: string, input: unknown) {
    return this.client.requestSchema(node, `/local-folders/${encodeURIComponent(folderId)}`, NodeLocalFolderSchema, {
      method: "PATCH",
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

  async createRuntime(node: Node, input: unknown) {
    const result = await this.client.requestSchema(node, "/runtimes", NodeRuntimeSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.invalidateFleetResource(node, "runtimes");
    return result;
  }

  async updateRuntime(node: Node, runtimeId: string, input: unknown) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}`;
    const result = await this.client.requestSchema(node, route, NodeRuntimeSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.invalidateFleetResource(node, "runtimes");
    return result;
  }

  async checkRuntime(node: Node, runtimeId: string) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}/check`;
    const result = await this.client.requestSchema(node, route, NodeRuntimeSchema, { method: "POST" });
    this.invalidateFleetResource(node, "runtimes");
    return result;
  }

  async deleteRuntime(node: Node, runtimeId: string) {
    const result = await this.client.requestSchema(node, `/runtimes/${encodeURIComponent(runtimeId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
    this.invalidateFleetResource(node, "runtimes");
    return result;
  }

  deleteLocalFolder(node: Node, folderId: string) {
    return this.client.requestSchema(node, `/local-folders/${encodeURIComponent(folderId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  listModels(node: Node, init: RequestInit = {}) {
    return this.client.requestSchema(node, "/models", z.array(NodeModelPublicRecordSchema), init);
  }

  async createModel(node: Node, input: unknown) {
    const result = await this.client.requestSchema(node, "/models", NodeModelPublicRecordSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.invalidateFleetResource(node, "models");
    return result;
  }

  async deployModel(node: Node, modelId: string, input: unknown) {
    const result = await this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}/deploy`, NodeModelPublicRecordSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.invalidateFleetResource(node, "models");
    return result;
  }

  async updateModel(node: Node, modelId: string, input: unknown) {
    const result = await this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}`, NodeModelPublicRecordSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.invalidateFleetResource(node, "models");
    return result;
  }

  async deleteModel(node: Node, modelId: string) {
    const result = await this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}`, NodeAgentDeleteResponseSchema, { method: "DELETE" });
    this.invalidateFleetResource(node, "models");
    return result;
  }

  discoverModels(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/models/discover", z.object({
      models: z.array(z.object({ id: z.string(), ownedBy: z.string().optional() }).strict()),
      latencyMs: z.number().nonnegative(),
    }).strict(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  testModel(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/models/test", z.object({ success: z.literal(true), latencyMs: z.number().nonnegative() }).strict(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async assignInstanceModels(node: Node, instanceId: string, input: unknown) {
    const result = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/model-assignment`, z.object({
      assignment: NodeModelAssignmentSchema,
      instance: ControlledInstanceSchema,
    }).strict(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.upsertInstanceSnapshot(node, result.instance);
    return result;
  }

  async listFleetModels(nodes: Node[], init: RequestInit = {}): Promise<NodeAgentFleetResult<{ nodeId: string; model: NodeModelPublicRecord }>> {
    await this.refreshFleetModels(nodes, init, true);
    return this.readFleetModels(nodes);
  }

  async listFleetRuntimes(nodes: Node[], init: RequestInit = {}): Promise<NodeAgentFleetResult<NodeRuntime>> {
    await this.refreshFleetRuntimes(nodes, init, true);
    return this.readFleetRuntimes(nodes);
  }

  readFleetModels(nodes: Node[]): NodeAgentFleetResult<{ nodeId: string; model: NodeModelPublicRecord }> {
    const result = this.readFleetSnapshots(nodes, "models", this.modelSnapshots);
    return { ...result, items: result.items.map(({ nodeId, item: model }) => ({ nodeId, model })) };
  }

  readFleetRuntimes(nodes: Node[]): NodeAgentFleetResult<NodeRuntime> {
    const result = this.readFleetSnapshots(nodes, "runtimes", this.runtimeSnapshots);
    return { ...result, items: result.items.map(({ item }) => item) };
  }

  readFleetInstances(nodes: Node[]): NodeAgentFleetResult<ControlledInstance> {
    const result = this.readFleetSnapshots(nodes, "instances", this.instanceSnapshots);
    return { ...result, items: result.items.map(({ item }) => item) };
  }

  refreshFleetModels(nodes: Node[], init: RequestInit = {}, force = false) {
    return this.refreshFleetSnapshots(nodes, "models", "/models", init, this.modelSnapshots, async (node, requestInit) => ({
      items: await this.listModels(node, requestInit),
      nodeErrors: [],
    }), force);
  }

  refreshFleetRuntimes(nodes: Node[], init: RequestInit = {}, force = false) {
    return this.refreshFleetSnapshots(nodes, "runtimes", "/runtimes", init, this.runtimeSnapshots, async (node, requestInit) => ({
      items: await this.listRuntimes(node, requestInit),
      nodeErrors: [],
    }), force);
  }

  refreshFleetInstances(nodes: Node[], init: RequestInit = {}, force = false) {
    return this.refreshFleetSnapshots(nodes, "instances", "/instances", init, this.instanceSnapshots, (node, requestInit) => (
      this.loadInstancesWithDiagnostics(node, requestInit)
    ), force);
  }

  listInstances(node: Node, init: RequestInit = {}) {
    return this.listInstancesWithDiagnostics(node, init).then((result) => result.items);
  }

  async listInstancesWithDiagnostics(node: Node, init: RequestInit = {}): Promise<NodeAgentListResult<ControlledInstance>> {
    const result = await this.loadInstancesWithDiagnostics(node, init);
    this.setTargetedSnapshot(node, "instances", this.instanceSnapshots, result);
    return result;
  }

  private async loadInstancesWithDiagnostics(node: Node, init: RequestInit = {}): Promise<NodeAgentListResult<ControlledInstance>> {
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

  instanceFromSnapshot(nodes: Node[], instanceId: string) {
    for (const node of nodes) {
      const snapshot = this.instanceSnapshots.get(node.id);
      if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) continue;
      const instance = snapshot.items.find((item) => item.id === instanceId);
      if (instance) return instance;
    }
    return undefined;
  }

  async createInstance(node: Node, input: unknown) {
    const instance = await this.client.requestSchema(node, "/instances", ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async updateInstance(node: Node, instanceId: string, input: unknown) {
    const instance = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}`, ControlledInstanceSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async deleteInstance(node: Node, instanceId: string, input: unknown) {
    const result = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/delete`, InstanceDeleteResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.removeInstanceSnapshot(node, instanceId);
    return result;
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

  async startInstance(node: Node, instanceId: string, input: unknown = {}) {
    const instance = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/start`, ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async retryInstanceImageProvisioning(node: Node, instanceId: string) {
    const instance = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/image-provisioning/retry`, ControlledInstanceSchema, {
      method: "POST",
    });
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async stopInstance(node: Node, instanceId: string) {
    const instance = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/stop`, ControlledInstanceSchema, {
      method: "POST",
    });
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async restartInstance(node: Node, instanceId: string, input: unknown = {}) {
    const instance = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/restart`, ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    this.upsertInstanceSnapshot(node, instance);
    return instance;
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
    await this.refreshFleetInstances(nodes, init, true);
    return this.readFleetInstances(nodes);
  }

  private readFleetSnapshots<T>(
    nodes: Node[],
    resource: NodeFleetResource,
    snapshots: Map<string, NodeAgentFleetSnapshot<T>>,
  ): { items: Array<{ nodeId: string; item: T }>; nodeErrors: NodeAgentScopedError[]; nodeStates: NodeFleetResourceState[] } {
    this.reconcileFleetConnections(nodes, resource, snapshots);
    const result = { items: [] as Array<{ nodeId: string; item: T }>, nodeErrors: [] as NodeAgentScopedError[], nodeStates: [] as NodeFleetResourceState[] };
    for (const node of nodes) {
      const snapshot = snapshots.get(node.id);
      if (!snapshot) {
        result.nodeStates.push({
          nodeId: node.id,
          resource,
          phase: "uninitialized",
          revision: this.fleetRevisions.get(`${resource}:${node.id}`),
        });
        continue;
      }
      result.items.push(...snapshot.items.map((item) => ({ nodeId: node.id, item })));
      const state = this.publicFleetState(node.id, resource, snapshot);
      result.nodeStates.push(state);
      if (snapshot.error) result.nodeErrors.push(snapshot.error);
    }
    return result;
  }

  private async refreshFleetSnapshots<T>(
    nodes: Node[],
    resource: NodeFleetResource,
    route: string,
    init: RequestInit,
    snapshots: Map<string, NodeAgentFleetSnapshot<T>>,
    load: (node: Node, init: RequestInit) => Promise<NodeAgentListResult<T>>,
    force: boolean,
  ) {
    this.reconcileFleetConnections(nodes, resource, snapshots);
    await Promise.all(nodes.map((node) => this.refreshFleetNode(node, resource, route, init, snapshots, load, force)));
  }

  private refreshFleetNode<T>(
    node: Node,
    resource: NodeFleetResource,
    route: string,
    init: RequestInit,
    snapshots: Map<string, NodeAgentFleetSnapshot<T>>,
    load: (node: Node, init: RequestInit) => Promise<NodeAgentListResult<T>>,
    force: boolean,
  ) {
    if (this.disposed) return Promise.resolve();
    const key = `${resource}:${node.id}`;
    const existingRefresh = this.fleetRefreshes.get(key);
    if (existingRefresh) return existingRefresh;
    if (!force && this.fleetRetryTimers.has(key)) return Promise.resolve();
    if (force) this.clearFleetRetry(key);
    const connectionKey = this.fleetConnectionKey(node);
    const current = snapshots.get(node.id);
    const fresh = current?.connectionKey === connectionKey
      && current.phase === "ready"
      && current.updatedAt !== undefined
      && Date.now() - Date.parse(current.updatedAt) < this.fleetSnapshotFreshMs;
    if (!force && fresh) return Promise.resolve();

    const retryingFailure = current?.connectionKey === connectionKey && Boolean(current.error)
      && (current.phase === "error" || current.phase === "stale");
    const revision = this.nextFleetRevision(node.id, resource);
    const loading: NodeAgentFleetSnapshot<T> = {
      connectionKey,
      items: current?.connectionKey === connectionKey ? [...current.items] : [],
      phase: retryingFailure
        ? current.phase
        : current?.connectionKey === connectionKey && current.updatedAt ? "stale" : "loading",
      revision,
      updatedAt: current?.connectionKey === connectionKey ? current.updatedAt : undefined,
      error: retryingFailure ? current.error : undefined,
    };
    snapshots.set(node.id, loading);
    if (!retryingFailure) this.emitFleetState(node.id, resource, loading);

    const refresh = (async () => {
      try {
        this.requireFleetNodeReady(node, route);
        const loaded = await this.withFleetDeadline(node, route, init, (requestInit) => load(node, requestInit));
        if (snapshots.get(node.id)?.revision !== revision) return;
        const invalidPayloadError = loaded.nodeErrors[0];
        const ready: NodeAgentFleetSnapshot<T> = {
          connectionKey,
          items: [...loaded.items],
          phase: invalidPayloadError ? "stale" : "ready",
          revision,
          updatedAt: new Date().toISOString(),
          error: invalidPayloadError,
        };
        snapshots.set(node.id, ready);
        if (invalidPayloadError) {
          if (!this.sameFleetState(loading, ready)) this.emitFleetState(node.id, resource, ready);
          this.scheduleFleetRetry(key, () => this.refreshFleetNode(node, resource, route, {}, snapshots, load, true));
          return;
        }
        this.resetFleetRetry(key);
        this.emitFleetState(node.id, resource, ready);
      } catch (error) {
        if (snapshots.get(node.id)?.revision !== revision) return;
        const scopedError = nodeAgentScopedError(node, route, "GET", error);
        const failed: NodeAgentFleetSnapshot<T> = {
          ...loading,
          phase: loading.updatedAt ? "stale" : "error",
          error: scopedError,
        };
        snapshots.set(node.id, failed);
        if (!this.sameFleetState(loading, failed)) this.emitFleetState(node.id, resource, failed);
        this.scheduleFleetRetry(key, () => this.refreshFleetNode(node, resource, route, {}, snapshots, load, true));
      }
    })().finally(() => {
      if (this.fleetRefreshes.get(key) === refresh) this.fleetRefreshes.delete(key);
    });
    this.fleetRefreshes.set(key, refresh);
    return refresh;
  }

  private reconcileFleetConnections<T>(nodes: Node[], resource: NodeFleetResource, snapshots: Map<string, NodeAgentFleetSnapshot<T>>) {
    // Reads and refreshes may intentionally target a single node (for example,
    // tunnel scope validation). The supplied nodes are therefore a scope, not
    // an authoritative fleet membership snapshot. Actual node removal calls
    // forgetNode(), while this pass only invalidates changed connections in the
    // requested scope.
    for (const node of nodes) {
      const snapshot = snapshots.get(node.id);
      if (snapshot && snapshot.connectionKey !== this.fleetConnectionKey(node)) {
        snapshots.delete(node.id);
        this.resetFleetRetry(`${resource}:${node.id}`);
      }
    }
  }

  private invalidateFleetResource(node: Node, resource: NodeFleetResource) {
    const snapshots = resource === "instances" ? this.instanceSnapshots
      : resource === "runtimes" ? this.runtimeSnapshots
        : this.modelSnapshots;
    const current = snapshots.get(node.id);
    if (!current) return;
    this.resetFleetRetry(`${resource}:${node.id}`);
    snapshots.delete(node.id);
    this.onFleetStateChanged?.({
      nodeId: node.id,
      resource,
      phase: "uninitialized",
      revision: this.nextFleetRevision(node.id, resource),
    });
  }

  private publicFleetState<T>(nodeId: string, resource: NodeFleetResource, snapshot: NodeAgentFleetSnapshot<T>): NodeFleetResourceState {
    const error = snapshot.error ? {
      nodeId: snapshot.error.nodeId,
      route: snapshot.error.route,
      method: snapshot.error.method,
      code: snapshot.error.code,
      message: snapshot.error.message,
      ...(snapshot.error.statusCode !== undefined ? { statusCode: snapshot.error.statusCode } : {}),
      ...(snapshot.error.issues ? {
        issues: snapshot.error.issues.map((issue) => ({
          path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
          message: issue.message,
        })),
      } : {}),
    } : undefined;
    return {
      nodeId,
      resource,
      phase: snapshot.phase,
      revision: snapshot.revision,
      ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
      ...(error ? { error } : {}),
    };
  }

  private emitFleetState<T>(nodeId: string, resource: NodeFleetResource, snapshot: NodeAgentFleetSnapshot<T>) {
    this.onFleetStateChanged?.(this.publicFleetState(nodeId, resource, snapshot));
  }

  private sameFleetState<T>(left: NodeAgentFleetSnapshot<T>, right: NodeAgentFleetSnapshot<T>) {
    const comparable = (snapshot: NodeAgentFleetSnapshot<T>) => ({
      phase: snapshot.phase,
      // `updatedAt` records the observation time and advances on every
      // malformed response. It is not a semantic state change and must not
      // keep invalidating progressive consumers while the failure is stable.
      items: snapshot.items,
      error: snapshot.error && {
        code: snapshot.error.code,
        message: snapshot.error.message,
        statusCode: snapshot.error.statusCode,
        route: snapshot.error.route,
        method: snapshot.error.method,
        issues: snapshot.error.issues,
      },
    });
    return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
  }

  private scheduleFleetRetry(key: string, retry: () => Promise<void>) {
    if (this.disposed || this.fleetRetryTimers.has(key)) return;
    const attempt = (this.fleetRetryAttempts.get(key) || 0) + 1;
    this.fleetRetryAttempts.set(key, attempt);
    const delay = Math.min(this.fleetRetryMaxMs, this.fleetRetryBaseMs * (2 ** Math.min(attempt - 1, 10)));
    const timer = setTimeout(() => {
      this.fleetRetryTimers.delete(key);
      if (!this.disposed) void retry();
    }, delay);
    timer.unref?.();
    this.fleetRetryTimers.set(key, timer);
  }

  private clearFleetRetry(key: string) {
    const timer = this.fleetRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.fleetRetryTimers.delete(key);
  }

  private resetFleetRetry(key: string) {
    this.clearFleetRetry(key);
    this.fleetRetryAttempts.delete(key);
  }

  private setTargetedSnapshot<T>(
    node: Node,
    resource: NodeFleetResource,
    snapshots: Map<string, NodeAgentFleetSnapshot<T>>,
    result: NodeAgentListResult<T>,
  ) {
    const snapshot: NodeAgentFleetSnapshot<T> = {
      connectionKey: this.fleetConnectionKey(node),
      items: [...result.items],
      phase: result.nodeErrors.length ? "stale" : "ready",
      revision: this.nextFleetRevision(node.id, resource),
      updatedAt: new Date().toISOString(),
      error: result.nodeErrors[0],
    };
    snapshots.set(node.id, snapshot);
    this.emitFleetState(node.id, resource, snapshot);
  }

  private nextFleetRevision(nodeId: string, resource: NodeFleetResource) {
    const key = `${resource}:${nodeId}`;
    const revision = (this.fleetRevisions.get(key) || 0) + 1;
    this.fleetRevisions.set(key, revision);
    return revision;
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

  private upsertInstanceSnapshot(node: Node, instance: ControlledInstance) {
    const snapshot = this.instanceSnapshots.get(node.id);
    const connectionKey = this.fleetConnectionKey(node);
    // A mutation response is not a complete fleet snapshot. Only update an
    // already-established snapshot so a cold cache cannot hide sibling instances.
    if (!snapshot || snapshot.connectionKey !== connectionKey) return;
    snapshot.items = [...snapshot.items.filter((item) => item.id !== instance.id), instance];
    snapshot.phase = "ready";
    snapshot.revision = this.nextFleetRevision(node.id, "instances");
    snapshot.updatedAt = new Date().toISOString();
    snapshot.error = undefined;
    this.emitFleetState(node.id, "instances", snapshot);
  }

  private removeInstanceSnapshot(node: Node, instanceId: string) {
    const snapshot = this.instanceSnapshots.get(node.id);
    if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) return;
    snapshot.items = snapshot.items.filter((item) => item.id !== instanceId);
    snapshot.phase = "ready";
    snapshot.revision = this.nextFleetRevision(node.id, "instances");
    snapshot.updatedAt = new Date().toISOString();
    snapshot.error = undefined;
    this.emitFleetState(node.id, "instances", snapshot);
  }

  private requireFleetNodeReady(node: Node, route: string) {
    const phase = (node as Node & { connectionPhase?: string }).connectionPhase;
    const directControlApiCanBeProbed = node.connectionMode !== "reverse-wss"
      && node.connectionMode !== "control-plane-proxy";
    if (!phase || phase === "healthy" || directControlApiCanBeProbed) return;
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
