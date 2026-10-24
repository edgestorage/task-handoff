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
  NodeAgentModelRelaySchema,
  UpdateNodeAgentModelRelaySchema,
  NodeAgentInstanceProxyRawResponseSchema,
  NodeAgentInstanceLifecycleResultSchema,
  NodeAgentPairingInviteResponseSchema,
  NodeAgentCloudRelayBindRequestSchema,
  NodeAgentCloudRelayStatusSchema,
  NodeAgentControlPlaneConnectionCreateResultSchema,
  NodeAgentControlPlanePairingSchema,
  NodeAgentControlPlaneConnectionSchema,
  NodeFolderTreeEntrySchema,
  NodeFolderPlaceSchema,
  NodeLocalFolderSchema,
  NodeModelAssignmentSchema,
  NodeModelMergeResultSchema,
  NodeModelPublicRecordSchema,
  NodeRuntimeConsumerListSchema,
  NodeRuntimeSchema,
  UpdateCheckResultSchema,
  UpdateJobSchema,
  supportsNodeModelRelayImagePruning,
  supportsNodeModelRelay,
  supportsNodeModelRelayUnknownModelPolicy,
  nodeAgentCapabilitiesFromPublicNode,
  safeParseStoredControlledInstance,
  type ControlledInstance,
  type InstanceLifecycleHeartbeat,
  type InstanceLifecycleSnapshot,
  type Node,
  type NodeLocalFolder,
  type NodeModelPublicRecord,
  type NodeRuntime,
  type UpdateCheckRequest,
  type ApplyUpdateRequest,
  type UpdateNodeAgentModelRelay,
} from "@task-handoff/protocol/control-plane";
import type { AiSessionsSnapshot } from "@task-handoff/protocol/ai-sessions";
import { ControlPlaneNodeAgentClient, nodeAgentScopedError, type NodeAgentScopedError } from "./client.ts";
import type {
  ControlPlaneFleetResource,
  ControlPlaneFleetResourcePhase,
  ControlPlaneNodeFleetState,
  ControlPlaneNodeFleetUpdatedEvent,
} from "@task-handoff/protocol/control-plane-directory";
import {
  GitCredentialPublicSchema,
  NodeGitCredentialAuthorizationSetSchema,
  type NodeGitCredentialAuthorizationSet,
  type NodeGitCredentialPayload,
} from "@task-handoff/protocol/managed-git-credentials";
import {
  INSTANCE_DIRECTORY_PROJECTION,
  INSTANCE_PROJECTION_HEADER,
  projectInstancesForFleetComparison,
} from "../../shared/instances/fleet-projection.ts";

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
  onFleetStateChanged?: (state: ControlPlaneNodeFleetUpdatedEvent) => void;
};

export type NodeFleetResource = ControlPlaneFleetResource;
export type NodeFleetResourcePhase = ControlPlaneFleetResourcePhase;
export type NodeFleetResourceState = ControlPlaneNodeFleetState;

export type InstanceLifecycleApplyResult = "applied" | "ignored" | "missing";

type NodeAgentListResult<T> = {
  items: T[];
  nodeErrors: NodeAgentScopedError[];
  notModified?: boolean;
  etag?: string;
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

// Remote transports (notably the trusted control-plane proxy) forward complete
// instance projections that can exceed 100 KB. A two-second deadline marked
// healthy but slower nodes as stale even though the response arrived shortly
// afterwards. Keep enough headroom for those links while still bounding a
// genuinely unavailable node.
const DEFAULT_FLEET_REQUEST_TIMEOUT_MS = 5_000;
// Directory consumers (notably the desktop tray) poll every 15 seconds. A
// 15-second freshness window therefore misses on nearly every poll and turns
// an unchanged snapshot into a full request/revalidation across the node
// transport. Lifecycle and mutation paths update or invalidate snapshots
// directly, so the periodic read only needs to reconcile less volatile
// directory fields.
const DEFAULT_FLEET_SNAPSHOT_FRESH_MS = 30_000;
const DEFAULT_FLEET_RETRY_BASE_MS = 1_000;
const DEFAULT_FLEET_RETRY_MAX_MS = 30_000;

function describeProjectionDiff(left: unknown, right: unknown, path = "", out: string[] = [], limit = 6): string[] {
  if (out.length >= limit || left === right) return out;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push(`${path}.length ${left.length} -> ${right.length}`);
    for (let index = 0; index < Math.min(left.length, right.length) && out.length < limit; index += 1) {
      describeProjectionDiff(left[index], right[index], `${path}[${index}]`, out, limit);
    }
    return out;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
    for (const key of keys) {
      describeProjectionDiff(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`,
        out,
        limit,
      );
      if (out.length >= limit) break;
    }
    return out;
  }
  out.push(`${path} ${JSON.stringify(left)} -> ${JSON.stringify(right)}`);
  return out;
}

export class ControlPlaneNodeAgentGateway {
  private readonly client: ControlPlaneNodeAgentClient;
  private readonly fleetRequestTimeoutMs: number;
  private readonly fleetSnapshotFreshMs: number;
  private readonly fleetRetryBaseMs: number;
  private readonly fleetRetryMaxMs: number;
  private readonly onFleetStateChanged: ((state: ControlPlaneNodeFleetUpdatedEvent) => void) | undefined;
  private readonly runtimeSnapshots = new Map<string, NodeAgentFleetSnapshot<NodeRuntime>>();
  private readonly instanceSnapshots = new Map<string, NodeAgentFleetSnapshot<ControlledInstance>>();
  private readonly modelSnapshots = new Map<string, NodeAgentFleetSnapshot<NodeModelPublicRecord>>();
  private readonly fleetEtags = new Map<string, string>();
  private readonly fleetRefreshes = new Map<string, Promise<void>>();
  private readonly fleetRevisions = new Map<string, number>();
  private readonly fleetRetryAttempts = new Map<string, number>();
  private readonly fleetRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private aiSessionSnapshots: ((instanceId: string) => AiSessionsSnapshot | undefined) | undefined;
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

  /**
   * Instance directory snapshots intentionally omit Session detail. The
   * Control Plane's revisioned Session aggregator is the authority for that
   * detail, so every instance read is enriched at this single boundary.
   */
  setAiSessionSnapshotProvider(provider: (instanceId: string) => AiSessionsSnapshot | undefined) {
    this.aiSessionSnapshots = provider;
  }

  forgetNode(nodeId: string) {
    this.runtimeSnapshots.delete(nodeId);
    this.instanceSnapshots.delete(nodeId);
    this.modelSnapshots.delete(nodeId);
    for (const resource of ["runtimes", "instances", "models"] as const) {
      this.fleetEtags.delete(this.fleetEtagKey(nodeId, resource));
    }
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

  async applyUpdate(node: Node, input: ApplyUpdateRequest) {
    return this.projectNodeResource(node, await this.client.requestSchema(node, "/updates/apply", UpdateJobSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  }

  async listUpdateJobs(node: Node) {
    const jobs = await this.client.requestSchema(node, "/updates/jobs", z.array(UpdateJobSchema));
    return jobs.map((job) => this.projectNodeResource(node, job));
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

  getModelRelay(node: Node) {
    this.requireModelRelayCapability(node);
    return this.client.requestSchema(node, "/settings/model-relay", NodeAgentModelRelaySchema);
  }

  updateModelRelay(node: Node, input: unknown) {
    this.requireModelRelayCapability(node);
    const parsed = UpdateNodeAgentModelRelaySchema.parse(input);
    return this.client.requestSchema(node, "/settings/model-relay", NodeAgentModelRelaySchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.modelRelayWriteBody(node, parsed)),
    });
  }

  /**
   * Compatibility for nodes without the unknown-model policy capability: their
   * strict settings schema rejects the additive field, so it is stripped. An
   * explicit passthrough request cannot be honored there and fails closed
   * instead of silently leaving the node on its fail-closed behavior.
   */
  private modelRelayWriteBody(node: Node, parsed: UpdateNodeAgentModelRelay) {
    const capabilities = nodeAgentCapabilitiesFromPublicNode(node.capabilities);
    const body: UpdateNodeAgentModelRelay = { enabled: parsed.enabled };
    if (parsed.unknownModelPolicy !== undefined) {
      if (supportsNodeModelRelayUnknownModelPolicy(capabilities)) {
        body.unknownModelPolicy = parsed.unknownModelPolicy;
      } else if (parsed.unknownModelPolicy === "passthrough") {
        throw Object.assign(new Error(`Node ${node.id} must be updated before the model relay can forward unknown model names.`), {
          statusCode: 409,
          code: "NODE_MODEL_RELAY_UNKNOWN_MODEL_POLICY_UNSUPPORTED",
          details: { nodeId: node.id },
        });
      }
      // An old node is already fail closed, so an explicit reject can be
      // represented by omitting the unsupported field.
    }
    if (parsed.imagePruning !== undefined) {
      if (supportsNodeModelRelayImagePruning(capabilities)) {
        body.imagePruning = parsed.imagePruning;
      } else if (parsed.imagePruning.enabled) {
        throw Object.assign(new Error(`Node ${node.id} must be updated before model relay image pruning can be enabled.`), {
          statusCode: 409,
          code: "NODE_MODEL_RELAY_IMAGE_PRUNING_UNSUPPORTED",
          details: { nodeId: node.id },
        });
      }
    }
    return body;
  }

  /**
   * Capability gate for both relay settings routes. A node that predates the
   * relay producer capability must keep working over its legacy settings
   * surface, so the gateway returns a structured downgrade error instead of
   * forwarding a request its strict schema cannot parse.
   */
  private requireModelRelayCapability(node: Node) {
    if (supportsNodeModelRelay(nodeAgentCapabilitiesFromPublicNode(node.capabilities))) return;
    throw Object.assign(new Error(`Node ${node.id} does not support the model relay settings.`), {
      statusCode: 409,
      code: "NODE_MODEL_RELAY_UNSUPPORTED",
    });
  }

  deployGitCredential(node: Node, payload: NodeGitCredentialPayload) {
    return this.client.requestSchema(node, `/git-credentials/${encodeURIComponent(payload.credential.id)}`, GitCredentialPublicSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  removeGitCredential(node: Node, credentialId: string) {
    return this.client.requestSchema(node, `/git-credentials/${encodeURIComponent(credentialId)}`, z.object({ deleted: z.boolean() }).strip(), {
      method: "DELETE",
    });
  }

  replaceGitCredentialAuthorizations(node: Node, desired: NodeGitCredentialAuthorizationSet) {
    return this.client.requestSchema(
      node,
      `/instances/${encodeURIComponent(desired.instanceId)}/git-credential-authorizations`,
      NodeGitCredentialAuthorizationSetSchema,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(desired) },
    );
  }

  createPairingInvite(node: Node, input: unknown = {}) {
    return this.client.requestSchema(node, "/pairing/invites", NodeAgentPairingInviteResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input && typeof input === "object" ? input : {}),
    });
  }

  /**
   * Guided account binding (path one): the Control Plane delivers a one-time
   * binding token to a node it already manages, over the existing tunnel. The
   * node redeems it cloud-side; this Control Plane stays a courier.
   */
  bindNodeCloudRelay(node: Node, input: unknown) {
    const parsed = NodeAgentCloudRelayBindRequestSchema.parse(input);
    return this.client.requestSchema(node, "/cloud-relay/bind", NodeAgentCloudRelayStatusSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed),
    });
  }

  cloudRelayStatus(node: Node) {
    return this.client.requestSchema(node, "/cloud-relay", NodeAgentCloudRelayStatusSchema);
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

  async listLocalFolders(node: Node, init: RequestInit = {}) {
    const folders = await this.client.requestSchema(node, "/local-folders", z.array(NodeLocalFolderSchema), init);
    return folders.map((folder) => this.projectNodeResource(node, folder));
  }

  async createLocalFolder(node: Node, input: unknown) {
    return this.projectNodeResource(node, await this.client.requestSchema(node, "/local-folders", NodeLocalFolderSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  }

  async updateLocalFolder(node: Node, folderId: string, input: unknown) {
    return this.projectNodeResource(node, await this.client.requestSchema(node, `/local-folders/${encodeURIComponent(folderId)}`, NodeLocalFolderSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
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

  async listRuntimes(node: Node, init: RequestInit = {}) {
    // add-wsl-runtime D11: 未知 runtime 类型只被忽略，不能让旧端整表解析失败。
    const runtimes = await this.client.requestSchema(node, "/runtimes", NodeRuntimeConsumerListSchema, init);
    return runtimes.map((runtime) => this.projectNodeResource(node, runtime));
  }

  async createRuntime(node: Node, input: unknown) {
    const result = this.projectNodeResource(node, await this.client.requestSchema(node, "/runtimes", NodeRuntimeSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    this.upsertRuntimeSnapshot(node, result);
    return result;
  }

  async updateRuntime(node: Node, runtimeId: string, input: unknown) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}`;
    const result = this.projectNodeResource(node, await this.client.requestSchema(node, route, NodeRuntimeSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    this.upsertRuntimeSnapshot(node, result);
    return result;
  }

  async checkRuntime(node: Node, runtimeId: string) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}/check`;
    const result = this.projectNodeResource(node, await this.client.requestSchema(node, route, NodeRuntimeSchema, { method: "POST" }));
    this.upsertRuntimeSnapshot(node, result);
    return result;
  }

  async deleteRuntime(node: Node, runtimeId: string) {
    const result = await this.client.requestSchema(node, `/runtimes/${encodeURIComponent(runtimeId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
    this.removeRuntimeSnapshot(node, runtimeId);
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

  async mergeModel(node: Node, modelId: string, targetModelId: string) {
    const result = await this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}/merge`, NodeModelMergeResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetModelId }),
    });
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
    const instance = this.projectInstanceNodeId(node, result.instance);
    this.upsertInstanceSnapshot(node, instance);
    return { ...result, instance };
  }

  async syncInstanceModels(node: Node, instanceId: string) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/sync-models`, z.object({
      synced: z.boolean(),
    }).strict(), { method: "POST" });
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
    return { ...result, items: result.items.map(({ item }) => this.withAiSessionSnapshot(item)) };
  }

  refreshFleetModels(nodes: Node[], init: RequestInit = {}, force = false) {
    return this.refreshFleetSnapshots(nodes, "models", "/models", init, this.modelSnapshots, (node, requestInit, options) => (
      this.loadModelsWithDiagnostics(node, requestInit, options)
    ), force);
  }

  refreshFleetRuntimes(nodes: Node[], init: RequestInit = {}, force = false) {
    return this.refreshFleetSnapshots(nodes, "runtimes", "/runtimes", init, this.runtimeSnapshots, (node, requestInit, options) => (
      this.loadRuntimesWithDiagnostics(node, requestInit, options)
    ), force);
  }

  refreshFleetInstances(nodes: Node[], init: RequestInit = {}, force = false) {
    return this.refreshFleetSnapshots(nodes, "instances", "/instances", init, this.instanceSnapshots, (node, requestInit, requestOptions) => (
      this.loadInstancesWithDiagnostics(node, requestInit, requestOptions)
    ), force);
  }

  listInstances(node: Node, init: RequestInit = {}) {
    return this.listInstancesWithDiagnostics(node, init).then((result) => result.items);
  }

  async listInstancesWithAiSessions(node: Node, init: RequestInit = {}) {
    const result = await this.listInstancesWithDiagnostics(node, init, { fullAiSessions: true });
    return result.items;
  }

  async listInstancesWithDiagnostics(
    node: Node,
    init: RequestInit = {},
    options: { fullAiSessions?: boolean } = {},
  ): Promise<NodeAgentListResult<ControlledInstance>> {
    const previous = this.instanceSnapshots.get(node.id);
    // Direct list calls (for example ownership checks) must not become more
    // expensive than the background fleet refresh. Revalidate any usable
    // snapshot against the same validator the fleet path already recorded.
    const ifNoneMatch = !options.fullAiSessions && previous?.connectionKey === this.fleetConnectionKey(node) && previous.phase === "ready"
      ? this.fleetEtags.get(this.fleetEtagKey(node.id, "instances"))
      : undefined;
    const result = await this.loadInstancesWithDiagnostics(node, init, { ifNoneMatch, fullAiSessions: options.fullAiSessions });
    if (result.notModified) {
      const current = this.instanceSnapshots.get(node.id);
      if (!current || current.connectionKey !== this.fleetConnectionKey(node)) {
        throw Object.assign(new Error(`Node agent ${node.id} returned an unrequested not-modified response for /instances.`), {
          statusCode: 502,
          code: "NODE_AGENT_UNEXPECTED_NOT_MODIFIED",
          nodeId: node.id,
          route: "/instances",
        });
      }
      return { items: current.items.map((item) => this.withAiSessionSnapshot(item)), nodeErrors: current.error ? [current.error] : [] };
    }
    this.setTargetedSnapshot(node, "instances", this.instanceSnapshots, result);
    return { ...result, items: result.items.map((item) => this.withAiSessionSnapshot(item)) };
  }

  private async loadInstancesWithDiagnostics(
    node: Node,
    init: RequestInit = {},
    options: { ifNoneMatch?: string; fullAiSessions?: boolean } = {},
  ): Promise<NodeAgentListResult<ControlledInstance>> {
    const headers = new Headers(init.headers);
    if (!options.fullAiSessions) headers.set(INSTANCE_PROJECTION_HEADER, INSTANCE_DIRECTORY_PROJECTION);
    const response = await this.client.requestSchemaConditional(node, "/instances", z.array(z.unknown()), { ...init, headers }, {
      ifNoneMatch: options.fullAiSessions ? undefined : options.ifNoneMatch,
    });
    if (!options.fullAiSessions) this.recordFleetEtag(node.id, "instances", response.etag);
    if (response.notModified) return { items: [], nodeErrors: [], notModified: true, ...(response.etag ? { etag: response.etag } : {}) };
    return (response.data || []).reduce<NodeAgentListResult<ControlledInstance>>((current, item) => {
        const result = this.normalizeInstance(node, item);
        if (result.instance) {
          current.items.push(result.instance);
        }
        if (result.error) {
          current.nodeErrors.push(result.error);
        }
        return current;
      }, { items: [], nodeErrors: [], ...(response.etag ? { etag: response.etag } : {}) });
  }

  private async loadModelsWithDiagnostics(
    node: Node,
    init: RequestInit = {},
    options: { ifNoneMatch?: string } = {},
  ): Promise<NodeAgentListResult<NodeModelPublicRecord>> {
    const response = await this.client.requestSchemaConditional(node, "/models", z.array(NodeModelPublicRecordSchema), init, options);
    this.recordFleetEtag(node.id, "models", response.etag);
    if (response.notModified) return { items: [], nodeErrors: [], notModified: true, ...(response.etag ? { etag: response.etag } : {}) };
    return { items: response.data || [], nodeErrors: [], ...(response.etag ? { etag: response.etag } : {}) };
  }

  private async loadRuntimesWithDiagnostics(
    node: Node,
    init: RequestInit = {},
    options: { ifNoneMatch?: string } = {},
  ): Promise<NodeAgentListResult<NodeRuntime>> {
    const response = await this.client.requestSchemaConditional(node, "/runtimes", NodeRuntimeConsumerListSchema, init, options);
    this.recordFleetEtag(node.id, "runtimes", response.etag);
    if (response.notModified) return { items: [], nodeErrors: [], notModified: true, ...(response.etag ? { etag: response.etag } : {}) };
    return {
      items: (response.data || []).map((runtime) => this.projectNodeResource(node, runtime)),
      nodeErrors: [],
      ...(response.etag ? { etag: response.etag } : {}),
    };
  }

  instanceFromSnapshot(nodes: Node[], instanceId: string) {
    for (const node of nodes) {
      const snapshot = this.instanceSnapshots.get(node.id);
      if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) continue;
      const instance = snapshot.items.find((item) => item.id === instanceId);
      if (instance) return this.withAiSessionSnapshot(instance);
    }
    return undefined;
  }

  applyInstanceLifecycle(node: Node, lifecycle: InstanceLifecycleSnapshot): InstanceLifecycleApplyResult {
    const snapshot = this.instanceSnapshots.get(node.id);
    if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) return "missing";
    const index = snapshot.items.findIndex((instance) => instance.id === lifecycle.instanceId);
    if (index < 0) return "missing";
    const current = snapshot.items[index];
    if (current.nodeId !== node.id) return "missing";
    // Only a strictly older observation is stale. Replaying the revision the gateway already
    // holds is the authoritative current state: a consumer that has not seen this instance yet
    // only learns about it from this event, and it costs nothing for one that has.
    if (current.stateRevision > lifecycle.revision) return "ignored";

    const next = ControlledInstanceSchema.parse({
      ...current,
      stateRevision: lifecycle.revision,
      updatedAt: lifecycle.updatedAt,
      status: lifecycle.status,
      health: lifecycle.health,
      connectionStatus: lifecycle.connectionStatus,
      uiAccessStatus: lifecycle.accessStatus,
      imageProvisioning: lifecycle.imageProvisioning,
      workspace: lifecycle.workspace,
      runtime: lifecycle.runtime,
      runtimeVersion: lifecycle.runtimeVersion,
      ready: lifecycle.ready,
      lastHeartbeatAt: lifecycle.lastHeartbeatAt,
    });
    snapshot.items = snapshot.items.map((instance, itemIndex) => itemIndex === index ? next : instance);
    return "applied";
  }

  /**
   * Applies a liveness-only observation. The gateway snapshot must keep the newest
   * `lastHeartbeatAt` because the authoritative board derives heartbeat age and the
   * offline projection from it.
   */
  applyInstanceLifecycleHeartbeat(node: Node, heartbeat: InstanceLifecycleHeartbeat): InstanceLifecycleApplyResult {
    const snapshot = this.instanceSnapshots.get(node.id);
    if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) return "missing";
    const index = snapshot.items.findIndex((instance) => instance.id === heartbeat.instanceId);
    if (index < 0) return "missing";
    const current = snapshot.items[index];
    if (current.nodeId !== node.id) return "missing";
    // As with a snapshot replay, an observation at the revision the gateway already holds still
    // carries the newest liveness clock and stays publishable; only a strictly older one is stale.
    if (current.stateRevision > heartbeat.revision) return "ignored";

    const next = ControlledInstanceSchema.parse({
      ...current,
      stateRevision: heartbeat.revision,
      updatedAt: heartbeat.updatedAt,
      ...(heartbeat.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: heartbeat.lastHeartbeatAt }),
    });
    snapshot.items = snapshot.items.map((instance, itemIndex) => itemIndex === index ? next : instance);
    return "applied";
  }

  async createInstance(node: Node, input: unknown) {
    const instance = this.projectInstanceNodeId(node, await this.client.requestSchema(node, "/instances", ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async updateInstance(node: Node, instanceId: string, input: unknown) {
    const instance = this.projectInstanceNodeId(node, await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}`, ControlledInstanceSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
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

  async listEnvironmentTemplates(node: Node, init: RequestInit = {}) {
    const templates = await this.client.requestSchema(node, "/environment-templates", z.array(EnvironmentTemplateSchema), init);
    return templates.map((template) => this.projectNodeResource(node, template));
  }

  async getEnvironmentTemplate(node: Node, templateId: string, init: RequestInit = {}) {
    return this.projectNodeResource(node, await this.client.requestSchema(node, `/environment-templates/${encodeURIComponent(templateId)}`, EnvironmentTemplateSchema, init));
  }

  async createEnvironmentTemplate(node: Node, instanceId: string, input: unknown) {
    return this.projectNodeResource(node, await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/environment-templates`, EnvironmentTemplateSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  }

  deleteEnvironmentTemplate(node: Node, templateId: string) {
    return this.client.requestSchema(node, `/environment-templates/${encodeURIComponent(templateId)}`, z.object({
      deleted: z.boolean(),
      templateId: EnvironmentTemplateSchema.shape.id,
    }).strict(), { method: "DELETE" });
  }

  async startInstance(node: Node, instanceId: string, input: unknown = {}) {
    const result = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/start`, NodeAgentInstanceLifecycleResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const instance = this.projectInstanceNodeId(node, result.instance);
    this.upsertInstanceSnapshot(node, instance);
    return { ...result, instance };
  }

  async retryInstanceImageProvisioning(node: Node, instanceId: string) {
    const instance = this.projectInstanceNodeId(node, await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/image-provisioning/retry`, ControlledInstanceSchema, {
      method: "POST",
    }));
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async retryInstanceGitProvisioning(node: Node, instanceId: string) {
    const instance = this.projectInstanceNodeId(node, await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/git-provisioning/retry`, ControlledInstanceSchema, {
      method: "POST",
    }));
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async stopInstance(node: Node, instanceId: string) {
    const instance = this.projectInstanceNodeId(node, await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/stop`, ControlledInstanceSchema, {
      method: "POST",
    }));
    this.upsertInstanceSnapshot(node, instance);
    return instance;
  }

  async restartInstance(node: Node, instanceId: string, input: unknown = {}) {
    const result = await this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/restart`, NodeAgentInstanceLifecycleResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const instance = this.projectInstanceNodeId(node, result.instance);
    this.upsertInstanceSnapshot(node, instance);
    return { ...result, instance };
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
    load: (node: Node, init: RequestInit, options: { ifNoneMatch?: string }) => Promise<NodeAgentListResult<T>>,
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
    load: (node: Node, init: RequestInit, options: { ifNoneMatch?: string }) => Promise<NodeAgentListResult<T>>,
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
    const previous = current?.connectionKey === connectionKey ? current : undefined;
    const fresh = previous?.phase === "ready"
      && previous.updatedAt !== undefined
      && Date.now() - Date.parse(previous.updatedAt) < this.fleetSnapshotFreshMs;
    if (!force && fresh) return Promise.resolve();

    const retryingFailure = current?.connectionKey === connectionKey && Boolean(current.error)
      && (current.phase === "error" || current.phase === "stale");
    const revision = this.nextFleetRevision(node.id, resource);
    // A usable snapshot remains authoritative while it is revalidated. Publishing
    // observation-only ready -> stale -> ready transitions would make every client
    // refetch the same fleet projection and amplify one refresh across all windows.
    const loading: NodeAgentFleetSnapshot<T> = {
      connectionKey,
      items: current?.connectionKey === connectionKey ? [...current.items] : [],
      phase: retryingFailure
        ? current.phase
        : previous?.phase === "ready" ? "ready"
          : previous?.updatedAt ? "stale" : "loading",
      revision,
      updatedAt: current?.connectionKey === connectionKey ? current.updatedAt : undefined,
      error: retryingFailure ? current.error : undefined,
    };
    snapshots.set(node.id, loading);
    if (!retryingFailure && (!previous || !this.sameFleetState(resource, previous, loading))) {
      this.emitFleetState(node.id, resource, loading, { contentChanged: false });
    }

    const refresh = (async () => {
      try {
        this.requireFleetNodeReady(node, route);
        // `force` bypasses the freshness cache, not conditional revalidation. A
        // validator still proves that the authoritative directory is unchanged.
        const ifNoneMatch = previous?.phase !== "ready" ? undefined : this.fleetEtags.get(this.fleetEtagKey(node.id, resource));
        const loaded = await this.withFleetDeadline(node, route, init, (requestInit) => load(node, requestInit, { ifNoneMatch }));
        if (snapshots.get(node.id)?.revision !== revision) return;
        if (loaded.notModified) {
          if (!previous) {
            throw Object.assign(new Error(`Node agent ${node.id} returned an unrequested not-modified response for ${route}.`), {
              statusCode: 502,
              code: "NODE_AGENT_UNEXPECTED_NOT_MODIFIED",
              nodeId: node.id,
              route,
            });
          }
          const unchanged: NodeAgentFleetSnapshot<T> = {
            connectionKey,
            items: [...previous.items],
            phase: "ready",
            revision,
            updatedAt: new Date().toISOString(),
          };
          snapshots.set(node.id, unchanged);
          this.resetFleetRetry(key);
          if (!this.sameFleetState(resource, previous, unchanged)) {
            this.emitFleetState(node.id, resource, unchanged, { contentChanged: false });
          }
          return;
        }
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
        const contentChanged = !previous || !this.sameFleetItems(resource, previous, ready);
        if (contentChanged) {
          this.client.logger?.warn?.({
            nodeId: node.id,
            resource,
            reason: !previous ? "no-previous-snapshot" : "projection-changed",
            diff: previous
              ? describeProjectionDiff(
                this.fleetItemsForComparison(resource, previous.items),
                this.fleetItemsForComparison(resource, ready.items),
              )
              : undefined,
            previousPhase: previous?.phase,
          }, "node fleet content changed");
        }
        if (invalidPayloadError) {
          if (!this.sameFleetState(resource, loading, ready)) this.emitFleetState(node.id, resource, ready, { contentChanged });
          this.scheduleFleetRetry(key, () => this.refreshFleetNode(node, resource, route, {}, snapshots, load, true));
          return;
        }
        this.resetFleetRetry(key);
        if (!previous || !this.sameFleetState(resource, previous, ready)) {
          this.emitFleetState(node.id, resource, ready, { contentChanged });
        }
      } catch (error) {
        if (snapshots.get(node.id)?.revision !== revision) return;
        const scopedError = nodeAgentScopedError(node, route, "GET", error);
        const failed: NodeAgentFleetSnapshot<T> = {
          ...loading,
          phase: loading.updatedAt ? "stale" : "error",
          error: scopedError,
        };
        snapshots.set(node.id, failed);
        if (!this.sameFleetState(resource, loading, failed)) this.emitFleetState(node.id, resource, failed, { contentChanged: false });
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
        this.fleetEtags.delete(this.fleetEtagKey(node.id, resource));
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
    this.fleetEtags.delete(this.fleetEtagKey(node.id, resource));
    this.onFleetStateChanged?.({
      nodeId: node.id,
      resource,
      phase: "uninitialized",
      revision: this.nextFleetRevision(node.id, resource),
      contentChanged: true,
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

  private emitFleetState<T>(
    nodeId: string,
    resource: NodeFleetResource,
    snapshot: NodeAgentFleetSnapshot<T>,
    options: { contentChanged?: boolean } = {},
  ) {
    this.onFleetStateChanged?.({
      ...this.publicFleetState(nodeId, resource, snapshot),
      ...(options.contentChanged === undefined ? {} : { contentChanged: options.contentChanged }),
    });
  }

  private sameFleetItems<T>(resource: NodeFleetResource, left: NodeAgentFleetSnapshot<T>, right: NodeAgentFleetSnapshot<T>) {
    return JSON.stringify(this.fleetItemsForComparison(resource, left.items))
      === JSON.stringify(this.fleetItemsForComparison(resource, right.items));
  }

  private fleetItemsForComparison<T>(resource: NodeFleetResource, items: T[]) {
    if (resource !== "instances") return items;
    return projectInstancesForFleetComparison(items) as T[];
  }

  private sameFleetState<T>(resource: NodeFleetResource, left: NodeAgentFleetSnapshot<T>, right: NodeAgentFleetSnapshot<T>) {
    const comparable = (snapshot: NodeAgentFleetSnapshot<T>) => ({
      phase: snapshot.phase,
      // `updatedAt` records the observation time and advances on every
      // malformed response. It is not a semantic state change and must not
      // keep invalidating progressive consumers while the failure is stable.
      items: this.fleetItemsForComparison(resource, snapshot.items),
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
    const previous = snapshots.get(node.id);
    const snapshot: NodeAgentFleetSnapshot<T> = {
      connectionKey: this.fleetConnectionKey(node),
      items: [...result.items],
      phase: result.nodeErrors.length ? "stale" : "ready",
      revision: this.nextFleetRevision(node.id, resource),
      updatedAt: new Date().toISOString(),
      error: result.nodeErrors[0],
    };
    snapshots.set(node.id, snapshot);
    const targetedContentChanged = !previous
      || previous.connectionKey !== snapshot.connectionKey
      || !this.sameFleetItems(resource, previous, snapshot);
    if (targetedContentChanged) {
      this.client.logger?.warn?.({
        nodeId: node.id,
        resource,
        source: "targeted",
        reason: !previous
          ? "no-previous-snapshot"
          : previous.connectionKey !== snapshot.connectionKey ? "connection-changed" : "projection-changed",
        diff: previous && previous.connectionKey === snapshot.connectionKey
          ? describeProjectionDiff(
            this.fleetItemsForComparison(resource, previous.items),
            this.fleetItemsForComparison(resource, snapshot.items),
          )
          : undefined,
      }, "node fleet content changed");
    }
    this.emitFleetState(node.id, resource, snapshot, {
      contentChanged: targetedContentChanged,
    });
  }

  private upsertRuntimeSnapshot(node: Node, runtime: NodeRuntime) {
    const snapshot = this.runtimeSnapshots.get(node.id);
    if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) return;
    const previous = { ...snapshot, items: [...snapshot.items] };
    const index = snapshot.items.findIndex((item) => item.id === runtime.id);
    snapshot.items = index < 0
      ? [...snapshot.items, runtime]
      : snapshot.items.map((item, itemIndex) => itemIndex === index ? runtime : item);
    snapshot.phase = "ready";
    snapshot.revision = this.nextFleetRevision(node.id, "runtimes");
    snapshot.updatedAt = new Date().toISOString();
    snapshot.error = undefined;
    this.emitFleetState(node.id, "runtimes", snapshot, {
      contentChanged: !this.sameFleetItems("runtimes", previous, snapshot),
    });
  }

  private removeRuntimeSnapshot(node: Node, runtimeId: string) {
    const snapshot = this.runtimeSnapshots.get(node.id);
    if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) return;
    const previous = { ...snapshot, items: [...snapshot.items] };
    snapshot.items = snapshot.items.filter((item) => item.id !== runtimeId);
    snapshot.phase = "ready";
    snapshot.revision = this.nextFleetRevision(node.id, "runtimes");
    snapshot.updatedAt = new Date().toISOString();
    snapshot.error = undefined;
    this.emitFleetState(node.id, "runtimes", snapshot, {
      contentChanged: !this.sameFleetItems("runtimes", previous, snapshot),
    });
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

  private fleetEtagKey(nodeId: string, resource: NodeFleetResource) {
    return `${resource}:${nodeId}`;
  }

  private withAiSessionSnapshot(instance: ControlledInstance) {
    const snapshot = this.aiSessionSnapshots?.(instance.id);
    return snapshot ? { ...instance, aiSessions: snapshot } : instance;
  }

  private recordFleetEtag(nodeId: string, resource: NodeFleetResource, etag: string | undefined) {
    const key = this.fleetEtagKey(nodeId, resource);
    if (etag) this.fleetEtags.set(key, etag);
    else this.fleetEtags.delete(key);
  }

  private upsertInstanceSnapshot(node: Node, instance: ControlledInstance) {
    const snapshot = this.instanceSnapshots.get(node.id);
    const connectionKey = this.fleetConnectionKey(node);
    // A mutation response is not a complete fleet snapshot. Only update an
    // already-established snapshot so a cold cache cannot hide sibling instances.
    if (!snapshot || snapshot.connectionKey !== connectionKey) return;
    const previousItems = snapshot.items;
    snapshot.items = [...snapshot.items.filter((item) => item.id !== instance.id), instance];
    snapshot.phase = "ready";
    snapshot.revision = this.nextFleetRevision(node.id, "instances");
    snapshot.updatedAt = new Date().toISOString();
    snapshot.error = undefined;
    this.emitFleetState(node.id, "instances", snapshot, {
      contentChanged: !this.sameFleetItems(
        "instances",
        { ...snapshot, items: previousItems },
        snapshot,
      ),
    });
  }

  private removeInstanceSnapshot(node: Node, instanceId: string) {
    const snapshot = this.instanceSnapshots.get(node.id);
    if (!snapshot || snapshot.connectionKey !== this.fleetConnectionKey(node)) return;
    const previousItems = snapshot.items;
    snapshot.items = snapshot.items.filter((item) => item.id !== instanceId);
    snapshot.phase = "ready";
    snapshot.revision = this.nextFleetRevision(node.id, "instances");
    snapshot.updatedAt = new Date().toISOString();
    snapshot.error = undefined;
    this.emitFleetState(node.id, "instances", snapshot, {
      contentChanged: JSON.stringify(previousItems) !== JSON.stringify(snapshot.items),
    });
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
        return { instance: this.projectInstanceNodeId(node, parsed.data) };
      }
      return { instance: this.projectInstanceNodeId(node, parsed.data) };
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

  private projectInstanceNodeId(node: Node, instance: ControlledInstance) {
    if (node.connectionPath?.kind !== "cloud-relay" || instance.nodeId === node.id) return instance;
    // Instances are owned by the machine, but a cloud-relay node's local record
    // is keyed by its account handle. Project that local record ID at the CP
    // boundary so routing and ownership checks never fall back to another
    // connection for the same machine.
    return ControlledInstanceSchema.parse({
      ...instance,
      nodeId: node.id,
      ...(instance.source.type === "local-folder" && instance.source.ownerNodeId && instance.source.ownerNodeId !== node.id
        ? { source: { ...instance.source, ownerNodeId: node.id } }
        : {}),
      ...(instance.environmentTemplateOrigin && instance.environmentTemplateOrigin.nodeId !== node.id
        ? { environmentTemplateOrigin: { ...instance.environmentTemplateOrigin, nodeId: node.id } }
        : {}),
    });
  }

  private projectNodeResource<T extends { nodeId: string }>(node: Node, resource: T): T {
    if (node.connectionPath?.kind !== "cloud-relay" || resource.nodeId === node.id) return resource;
    return { ...resource, nodeId: node.id };
  }
}

export type { NodeLocalFolder, NodeRuntime };
