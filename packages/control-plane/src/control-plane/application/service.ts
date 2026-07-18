import {
  ChatBridgeConfigSchema,
  ChatSessionBindingSchema,
  CONTROL_PLANE_PROTOCOL_VERSION,
  BuildInfoSchema,
  AppManagementJobResponseSchema,
  AppManagementSnapshotSchema,
  ControlledInstanceSchema,
  ImageProfileSchema,
  NodeImageAvailabilitySchema,
  sanitizeStoredImageProfile,
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  modelConfigHash,
  NodeModelPublicRecordSchema,
  NodeSchema,
  PendingRouteSchema,
  ProjectSchema,
  type ChatGatewayMessage,
  type ChatBridgeConfig,
  type ChatSessionBinding,
  type ControlledInstance,
  type ControlledInstanceHeartbeat,
  type ImageProfile,
  type ModelConfig,
  type NodeModelPublicRecord,
  type Node,
  type NodeLocalFolder,
  type NodeRuntime,
  type PendingRoute,
  type Project,
  type UpdateCheckRequest,
  type AppManagementOperationRequest,
} from "@task-handoff/protocol/control-plane";
import {
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AiSessionActionResultSchema,
  AiSessionDeltaResponseSchema,
  AiSessionQueueSchema,
  AiSessionStatusSchema,
  AiSessionsStateSchema,
  type AiSessionActionResult,
  type AiSessionDeltaResponse,
  type AiSessionMessageAttachment,
  type AiSessionSendMode,
  type AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import { AppSessionDeltaResponseSchema, AppSessionsStateSchema, emptyAppSessionsSnapshot, type AppSessionDeltaResponse, type AppSessionsSnapshot } from "@task-handoff/protocol/app-sessions";
import {
  TriggerIndexSchema,
} from "@task-handoff/protocol/triggers";
import crypto from "node:crypto";
import path from "node:path";
import { WebSocket as WsClient } from "ws";
import { z } from "zod";
import type { CommandRunner } from "../../shared/process/command-runner.ts";
import { ControlPlaneNodeAgentClient, type NodeAgentTransport, type NodeAgentWebSocket } from "../nodes/client.ts";
import { ControlPlaneNodeAgentGateway } from "../nodes/gateway.ts";
import { ControlledInstanceGateway } from "../instances/gateway.ts";
import { InstanceBoardReader } from "../instances/board-reader.ts";
import { ControlPlaneTriggerService } from "../triggers/service.ts";
import { ControlPlaneCatalogService } from "../catalog/service.ts";
import { AppAccessService, type AppAccessMode } from "../instances/app-access-service.ts";
import { ChatActionTokenService, type ChatActionToken } from "../chat/action-token-service.ts";
import { ChatBridgeService } from "../chat/bridges/service.ts";
import { ChatSessionService } from "../chat/sessions/service.ts";
import { ControlPlaneChatSessionRuntime } from "../chat/sessions/runtime.ts";
import { configSyncPresets, type ConfigSyncPreset } from "../instances/config-sync.ts";
import { relativeNodePathSegments, resolveNodePath } from "../nodes/path.ts";
import { normalizeModel, publicInstance, publicInstanceWithAccess, publicModel, publicNode, publicNodeAgentCapabilities, publicProject, workspacePolicyForSource } from "../public-records.ts";
import { controlPlaneDiagnosticLogsEnabled, errorMessage, now, protocolMismatchError, throwNotFound } from "./helpers.ts";
import {
  ConnectNodeRemoteInputSchema,
  ControlPlaneTriggerRecordSchema,
  ControlPlaneSettingsSchema,
  CreateInstanceInputSchema,
  CreateModelInputSchema,
  CreateNodeJoinInviteInputSchema,
  CreateNodeInputSchema,
  UpdateInstanceInputSchema,
  UpdateModelInputSchema,
  UpdateNodeInputSchema,
  type ControlPlaneSettings,
  type ControlPlaneTriggerRecord,
  type CreateInstanceInput,
  type CreateModelInput,
  type CreateNodeInput,
  type UpdateInstanceInput,
  type UpdateModelInput,
  type UpdateNodeInput,
} from "./inputs.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import { createId, createSecret, JsonCollection, JsonFile, type StoredRecord } from "../../shared/persistence/store.ts";
import { controlledInstanceTriggerSnapshot } from "../triggers/records.ts";
import { createNodeAgentHmacHeaders } from "../../shared/security/node-agent-auth.ts";
import { assertLocalIpcSocketOwnedByCurrentUser, createNodeAgentIpcWebSocket, fetchNodeAgentIpc, parseNodeAgentIpcEndpoint } from "../../shared/transport/node-agent-ipc.ts";

export function parseInstanceAppManagementSnapshot(value: unknown) {
  try {
    return AppManagementSnapshotSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const unsupported = new Error("This controlled instance does not support managed app operations.");
      Object.assign(unsupported, { statusCode: 409, code: "INSTANCE_APP_MANAGEMENT_UNSUPPORTED" });
      throw unsupported;
    }
    throw error;
  }
}

type FetchImpl = typeof fetch;
type ServiceLogger = {
  info?: (data: unknown, message?: string) => void;
  warn?: (data: unknown, message?: string) => void;
  error?: (data: unknown, message?: string) => void;
};
const NODE_JOIN_INVITE_TTL_MS = 10 * 60 * 1000;
type NodeJoinInvite = StoredRecord & {
  tokenHash: string;
  expiresAt: string;
  nodeName?: string;
};
const NodeJoinInviteSchema = z.object({
  id: z.string().trim().min(1),
  tokenHash: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  nodeName: z.string().trim().min(1).max(160).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const CONTROL_PLANE_LOCAL_NODE_LABEL = "task-handoff.control-plane.local";
const CONTROL_PLANE_BUILTIN_NODE_LABEL = "task-handoff.control-plane.builtin";

export type ControlPlaneServiceOptions = {
  fetchImpl?: FetchImpl;
  dockerCommandRunner?: CommandRunner;
  nodeAgentTransport?: NodeAgentTransport;
  logger?: ServiceLogger;
};

function isControlPlaneLocalNode(node: Node) {
  return node.labels[CONTROL_PLANE_LOCAL_NODE_LABEL] === "true";
}

function isControlPlaneBuiltinNode(node: Node) {
  return node.labels[CONTROL_PLANE_BUILTIN_NODE_LABEL] === "true";
}

function nodeAgentRemoteSecret(node: Pick<Node, "auth">) {
  return node.auth.mode === "paired-hmac" ? node.auth.secret : undefined;
}

function nodeAgentRemoteKeyId(node: Pick<Node, "auth">) {
  return node.auth.mode === "paired-hmac" ? node.auth.keyId : undefined;
}

function requireNodeAgentRemoteKeyId(node: Pick<Node, "id" | "auth">) {
  const keyId = nodeAgentRemoteKeyId(node);
  if (!keyId) {
    const error = new Error(`Node ${node.id} paired-HMAC auth is missing keyId.`);
    Object.assign(error, { statusCode: 500, code: "NODE_AGENT_REMOTE_KEY_ID_MISSING" });
    throw error;
  }
  return keyId;
}

type NodeAgentAuthContext = Pick<Node, "id" | "auth" | "labels" | "connectionMode">;

function nodeAgentLocalStaticToken(node: NodeAgentAuthContext) {
  if (node.connectionMode !== "local-ipc" && node.connectionMode !== "local-loopback") {
    return undefined;
  }
  return node.auth.mode === "local-static-key" ? node.auth.secret : undefined;
}

function createDirectNodeAgentAuthHeaders(node: NodeAgentAuthContext, input: { method: string; pathWithQuery: string; body?: string | Buffer }) {
  const remoteSecret = nodeAgentRemoteSecret(node);
  if (remoteSecret) {
    return createNodeAgentHmacHeaders({
      nodeId: node.id,
      keyId: requireNodeAgentRemoteKeyId(node),
      secret: remoteSecret,
      method: input.method,
      pathWithQuery: input.pathWithQuery,
      body: input.body,
    });
  }
  const token = nodeAgentLocalStaticToken(node);
  return token ? { authorization: `Bearer ${token}` } : {};
}

function defaultLocalNodeEndpoint() {
  return process.env.TASK_HANDOFF_NODE_AGENT_CONTROL_ENDPOINT || process.env.TASK_HANDOFF_NODE_AGENT_ENDPOINT || "http://127.0.0.1:8091";
}

function localConnectionModeForEndpoint(endpoint: string): Node["connectionMode"] {
  return parseNodeAgentIpcEndpoint(endpoint) ? "local-ipc" : "local-loopback";
}

export class ControlPlaneService {
  private readonly projects: JsonCollection<Project>;
  readonly models: JsonCollection<ModelConfig>;
  private readonly images: JsonCollection<ImageProfile>;
  readonly nodes: JsonCollection<Node>;
  readonly chatSessions: JsonCollection<ChatSessionBinding>;
  readonly chatBridges: JsonCollection<ChatBridgeConfig>;
  readonly triggers: JsonCollection<ControlPlaneTriggerRecord>;
  readonly nodeJoinInvites: JsonCollection<NodeJoinInvite>;
  private readonly settings: JsonFile<ControlPlaneSettings>;
  readonly paths: ControlPlaneStorePaths;
  private readonly fetchImpl: FetchImpl;
  private readonly dockerCommandRunner: CommandRunner | undefined;
  private readonly logger: ServiceLogger | undefined;
  private readonly appAccessService: AppAccessService;
  private readonly chatActionTokenService = new ChatActionTokenService();
  private nodeAgentTransport: NodeAgentTransport | undefined;
  private readonly nodeAgentGateway: ControlPlaneNodeAgentGateway;
  private readonly controlledInstanceGateway: ControlledInstanceGateway;
  private readonly instanceBoardReader = new InstanceBoardReader();
  private readonly controlPlaneTriggerService: ControlPlaneTriggerService;
  private readonly catalogService: ControlPlaneCatalogService;
  private readonly chatBridgeService: ChatBridgeService;
  private readonly chatSessionService: ChatSessionService;
  private readonly chatSessionRuntime: ControlPlaneChatSessionRuntime;
  private aiSessionSnapshotProvider: ((options?: { refresh?: boolean }) => Promise<{ updatedAt: string; instances: Array<{ instanceId: string; streamId: string; aiSessions: AiSessionsSnapshot; revision: number; lastEventAt: string }> }>) | undefined;
  private appSessionSnapshotProvider: ((options?: { refresh?: boolean }) => Promise<{ updatedAt: string; instances: Array<{ instanceId: string; streamId: string; appSessions: AppSessionsSnapshot; revision: number; lastEventAt: string }> }>) | undefined;

  constructor(paths: ControlPlaneStorePaths, options: ControlPlaneServiceOptions = {}) {
    this.paths = paths;
    this.fetchImpl = options.fetchImpl || fetch;
    this.dockerCommandRunner = options.dockerCommandRunner;
    this.nodeAgentTransport = options.nodeAgentTransport;
    this.logger = controlPlaneDiagnosticLogsEnabled() ? options.logger : undefined;
    const nodeAgentClient = new ControlPlaneNodeAgentClient({
      request: (node, route, init) => this.nodeAgentFetch(node, route, init),
      logger: this.logger,
    });
    this.nodeAgentGateway = new ControlPlaneNodeAgentGateway(nodeAgentClient);
    this.controlledInstanceGateway = new ControlledInstanceGateway({
      requireNode: (nodeId) => this.requireNode(nodeId),
      nodeAgentRequest: (node, route, init) => this.nodeAgentFetch(node, route, init),
      nodeAgentStreamRequest: (node, route, init) => this.nodeAgentTransportFor(node).requestStream(node, route, init),
      fetchImpl: this.fetchImpl,
    });
    const storeOptions = <T,>(schema: z.ZodType<T>) => ({
      schema,
      logger: (message: string, details: Record<string, unknown>) => this.logWarn(details, message),
    });
    this.projects = new JsonCollection(paths.projectsDir, storeOptions(ProjectSchema));
    this.models = new JsonCollection(paths.modelsDir, storeOptions(ModelConfigSchema));
    this.images = new JsonCollection(paths.imagesDir, {
      ...storeOptions(ImageProfileSchema),
      sanitize: (value) => sanitizeStoredImageProfile(value, (warning) => this.logWarn(warning, "legacy image profile field was migrated")),
    });
    this.nodes = new JsonCollection(paths.nodesDir, storeOptions(NodeSchema));
    this.chatSessions = new JsonCollection(paths.chatSessionsDir, storeOptions(ChatSessionBindingSchema));
    this.chatBridges = new JsonCollection(paths.chatBridgesDir, storeOptions(ChatBridgeConfigSchema));
    this.triggers = new JsonCollection(paths.triggersDir, storeOptions(ControlPlaneTriggerRecordSchema));
    this.nodeJoinInvites = new JsonCollection(paths.nodeJoinInvitesDir, storeOptions(NodeJoinInviteSchema));
    this.settings = new JsonFile(paths.settingsPath, () => ControlPlaneSettingsSchema.parse({}), storeOptions(ControlPlaneSettingsSchema));
    this.catalogService = new ControlPlaneCatalogService({
      projects: this.projects,
      images: this.images,
      settings: this.settings,
      defaultNodeId: () => this.defaultNodeId(),
    });
    this.controlPlaneTriggerService = new ControlPlaneTriggerService({
      triggers: this.triggers,
      listInstances: () => this.listNodeInstances(),
      requireInstance: async (instanceId) => this.requireControlledInstance(instanceId, true) as Promise<ControlledInstance>,
      instanceRequest: (instance, route, init) => this.instanceRequest(instance, route, init),
    });
    this.appAccessService = new AppAccessService({
      requireInstance: async (instanceId) => this.requireControlledInstance(instanceId, true) as Promise<ControlledInstance>,
      listAppSessions: () => this.listAppSessions(),
    });
    this.chatBridgeService = new ChatBridgeService({
      chatBridges: this.chatBridges,
      chatSessions: this.chatSessions,
    });
    this.chatSessionService = new ChatSessionService({
      chatSessions: this.chatSessions,
    });
    this.chatSessionRuntime = new ControlPlaneChatSessionRuntime({
      upsertChatSession: (input) => this.upsertChatSession(input),
      boardAsync: () => this.boardAsync(),
      listAiSessions: (options) => this.listAiSessions(options),
      listAppSessions: (options) => this.listAppSessions(options),
      listNodeInstances: () => this.listNodeInstances(),
      listPendingRoutes: () => this.listPendingRoutes(),
      pendingDecisionCallbackData: (routeId, decision) => this.pendingDecisionCallbackData(routeId, decision),
      createChatActionToken: (input) => this.createChatActionToken(input),
      createAppAccessToken: (input) => this.createAppAccessToken(input),
      controlPlanePublicBaseUrl: () => this.getSettings().publicBaseUrl || process.env.TASK_HANDOFF_CONTROL_PLANE_URL || process.env.TASK_HANDOFF_PUBLIC_BASE || process.env.TASK_HANDOFF_CONTROL_PLANE_PUBLIC_URL,
      requireControlledInstance: (id, includeSecret) => this.requireControlledInstance(id, includeSecret),
      requireProject: (id) => this.requireProject(id),
      getProject: (id) => this.catalogService.getProject(id),
      listProjects: () => this.catalogService.listProjects(),
      resolveAiSessionApproval: (instanceId, sessionId, decision) => this.resolveAiSessionApproval(instanceId, sessionId, decision),
      sendAiSessionMessage: (instanceId, sessionId, message, mode, attachments) => this.sendAiSessionMessage(instanceId, sessionId, message, mode, attachments),
      interruptAiSession: (instanceId, sessionId) => this.interruptAiSession(instanceId, sessionId),
      launchAppSession: (instanceId, appId, options) => this.launchAppSession(instanceId, appId, options),
    });
  }

  private logInfo(data: Record<string, unknown>, message: string) {
    this.logger?.info?.(data, message);
  }

  private logWarn(data: Record<string, unknown>, message: string) {
    this.logger?.warn?.(data, message);
  }

  private logError(data: Record<string, unknown>, message: string) {
    this.logger?.error?.(data, message);
  }

  setNodeAgentTransport(transport: NodeAgentTransport) {
    this.nodeAgentTransport = transport;
  }

  setAiSessionSnapshotProvider(provider: (options?: { refresh?: boolean }) => Promise<{ updatedAt: string; instances: Array<{ instanceId: string; streamId: string; aiSessions: AiSessionsSnapshot; revision: number; lastEventAt: string }> }>) {
    this.aiSessionSnapshotProvider = provider;
  }

  async listAiSessions(options: { refresh?: boolean } = {}) {
    return this.aiSessionSnapshotProvider ? this.aiSessionSnapshotProvider(options) : this.bootstrapAiSessionsFromInstances();
  }

  setAppSessionSnapshotProvider(provider: (options?: { refresh?: boolean }) => Promise<{ updatedAt: string; instances: Array<{ instanceId: string; streamId: string; appSessions: AppSessionsSnapshot; revision: number; lastEventAt: string }> }>) {
    this.appSessionSnapshotProvider = provider;
  }

  async listAppSessions(options: { refresh?: boolean } = {}) {
    return this.appSessionSnapshotProvider ? this.appSessionSnapshotProvider(options) : this.bootstrapAppSessionsFromInstances();
  }

  init() {
    this.projects.init();
    this.models.init();
    this.images.init();
    this.nodes.init();
    this.chatSessions.init();
    this.chatBridges.init();
    this.triggers.init();
    this.nodeJoinInvites.init();
    this.settings.init();
    this.seedDefaults();
  }

  getSettings() {
    return this.catalogService.getSettings();
  }

  updateSettings(input: unknown) {
    return this.catalogService.updateSettings(input);
  }

  seedDefaults() {
    return this.catalogService.seedDefaults();
  }

  listProjects() {
    return this.catalogService.listProjects();
  }

  private defaultNodeId() {
    return this.nodes.list().find(isControlPlaneLocalNode)?.id || this.nodes.list()[0]?.id;
  }

  private async inspectNodeAgent(endpoint: string, node?: NodeAgentAuthContext) {
    const route = "/health";
    const headers = node
      ? createDirectNodeAgentAuthHeaders(node, {
          method: "GET",
          pathWithQuery: `/api/node-agent${route}`,
        })
      : {};
    const response = await this.fetchNodeAgentEndpoint(endpoint, route, { headers });
    const payload = (await response.json().catch(() => ({}))) as { data?: { nodeId?: unknown; protocolVersion?: unknown; build?: unknown }; error?: { message?: string } };
    if (!response.ok) {
      const error = new Error(payload.error?.message || `Node agent health check failed with HTTP ${response.status}`);
      Object.assign(error, { statusCode: response.status, code: "NODE_AGENT_HEALTH_FAILED" });
      this.logWarn({ nodeEndpoint: endpoint, statusCode: response.status, errorCode: "NODE_AGENT_HEALTH_FAILED" }, "node agent health check failed");
      throw error;
    }
    const nodeId = typeof payload.data?.nodeId === "string" && payload.data.nodeId.trim() ? payload.data.nodeId.trim() : undefined;
    if (!nodeId) {
      const error = new Error("Node agent health response did not include nodeId.");
      Object.assign(error, { statusCode: 502, code: "NODE_AGENT_ID_MISSING" });
      this.logWarn({ nodeEndpoint: endpoint, payload: payload.data, errorCode: "NODE_AGENT_ID_MISSING" }, "node agent health response missing node id");
      throw error;
    }
    if (payload.data?.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
      const error = protocolMismatchError(`Node agent ${nodeId}`, payload.data?.protocolVersion);
      this.logWarn({ nodeId, nodeEndpoint: endpoint, expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, actualProtocolVersion: payload.data?.protocolVersion, build: payload.data?.build, errorCode: "PROTOCOL_VERSION_MISMATCH" }, "node agent protocol version mismatch");
      throw error;
    }
    const build = BuildInfoSchema.safeParse(payload.data?.build);
    this.logInfo({ nodeId, nodeEndpoint: endpoint, protocolVersion: payload.data.protocolVersion, build: build.success ? build.data : payload.data?.build }, "node agent health check ok");
    return {
      nodeId,
      data: payload.data || {},
    };
  }

  private async fetchNodeAgentEndpoint(endpoint: string, route: string, init: RequestInit = {}) {
    const ipcPath = parseNodeAgentIpcEndpoint(endpoint);
    if (ipcPath) {
      assertLocalIpcSocketOwnedByCurrentUser(ipcPath);
      return fetchNodeAgentIpc(ipcPath, route, init);
    }
    return this.fetchImpl(`${endpoint.replace(/\/$/, "")}/api/node-agent${route}`, init);
  }

  private async completeNodeAgentPairing(endpoint: string, input: { joinToken: string; controlPlaneName?: string; controlPlaneUrl?: string }) {
    const response = await this.fetchImpl(`${endpoint.replace(/\/$/, "")}/api/node-agent/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        joinToken: input.joinToken,
        controlPlaneName: input.controlPlaneName || "Control Plane",
        controlPlaneUrl: input.controlPlaneUrl,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: { nodeId?: unknown; keyId?: unknown; secret?: unknown; pairedAt?: unknown };
      error?: { message?: string };
    };
    if (!response.ok) {
      const error = new Error(payload.error?.message || `Node agent pairing failed with status ${response.status}.`);
      Object.assign(error, { statusCode: response.status, code: "NODE_AGENT_PAIRING_FAILED" });
      throw error;
    }
    if (typeof payload.data?.nodeId !== "string" || !payload.data.nodeId.trim() || typeof payload.data?.keyId !== "string" || !payload.data.keyId.trim() || typeof payload.data?.secret !== "string" || !payload.data.secret.trim()) {
      const error = new Error("Node agent pairing response did not include nodeId, keyId, and secret.");
      Object.assign(error, { statusCode: 502, code: "NODE_AGENT_PAIRING_RESPONSE_INVALID" });
      throw error;
    }
    return {
      nodeId: payload.data.nodeId.trim(),
      keyId: payload.data.keyId.trim(),
      secret: payload.data.secret.trim(),
      pairedAt: typeof payload.data.pairedAt === "string" ? payload.data.pairedAt : now(),
    };
  }

  async syncLocalNodeConnection() {
    const labels = {
      [CONTROL_PLANE_LOCAL_NODE_LABEL]: "true",
      [CONTROL_PLANE_BUILTIN_NODE_LABEL]: "true",
    };
    const localStaticSecret = process.env.TASK_HANDOFF_NODE_AGENT_TOKEN?.trim() || undefined;
    const endpoint = defaultLocalNodeEndpoint();
    const connectionMode = localConnectionModeForEndpoint(endpoint);
    const localProbeNode = NodeSchema.parse({
      id: "node_local_probe",
      name: "Local Node Probe",
      connectionMode,
      auth: { mode: "local-static-key", secret: localStaticSecret },
      labels,
      createdAt: now(),
      updatedAt: now(),
    });
    const inspected = await this.inspectNodeAgent(endpoint, localProbeNode);
    const timestamp = now();
    const current = this.nodes.get(inspected.nodeId);
    const previousLocal = this.nodes.list().filter((node) => isControlPlaneLocalNode(node) && node.id !== inspected.nodeId);
    for (const node of previousLocal) {
      this.nodes.delete(node.id);
    }
    const node = NodeSchema.parse({
      ...(current || {}),
      id: inspected.nodeId,
      name: current?.name || "Local Node",
      connectionMode,
      auth: { mode: "local-static-key", secret: localStaticSecret },
      endpoint,
      controlEndpoint: endpoint,
      containerEndpoint: process.env.TASK_HANDOFF_NODE_AGENT_CONTAINER_URL,
      publicWebBase: process.env.TASK_HANDOFF_INSTANCE_PUBLIC_WEB_BASE,
      status: "online",
      health: "ok",
      capabilities: { ...(current?.capabilities || {}), agent: publicNodeAgentCapabilities(inspected.data) },
      labels: {
        ...(current?.labels || {}),
        ...labels,
      },
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return this.nodes.put(node);
  }

  listModels() {
    return this.listAllModels().map(publicModel);
  }

  async listFederatedModels() {
    const nodes = this.listNodes();
    const fleet = await this.nodeAgentGateway.listFleetModels(nodes);
    const groups = new Map<string, {
      id: string;
      model: ReturnType<typeof publicModel> | NodeModelPublicRecord;
      locations: Array<
        | { type: "control-plane"; name: string; enabled: boolean; order: number }
        | { type: "node"; nodeId: string; name: string; enabled: boolean; order: number; referenceCount: number }
      >;
      referenceCount: number;
    }>();
    for (const model of this.listAllModels()) {
      groups.set(model.id, {
        id: model.id,
        model: publicModel(model),
        locations: [{ type: "control-plane", name: model.name, enabled: model.enabled, order: model.order }],
        referenceCount: 0,
      });
    }
    for (const { nodeId, model } of fleet.items) {
      const { referenceCount: _referenceCount, ...publicModelRecord } = model;
      const group = groups.get(model.id);
      if (group) {
        group.locations.push({ type: "node", nodeId, name: model.name, enabled: model.enabled, order: model.order, referenceCount: model.referenceCount });
        group.referenceCount += model.referenceCount;
      } else {
        groups.set(model.id, {
          id: model.id,
          model: publicModelRecord,
          locations: [{ type: "node", nodeId, name: model.name, enabled: model.enabled, order: model.order, referenceCount: model.referenceCount }],
          referenceCount: model.referenceCount,
        });
      }
    }
    return FederatedModelRegistrySchema.parse({
      models: [...groups.values()].sort((a, b) => a.model.order - b.model.order || a.model.name.localeCompare(b.model.name)),
      nodeDiagnostics: fleet.nodeErrors.map((error) => ({ nodeId: error.nodeId, code: error.code, message: error.message })),
      updatedAt: now(),
    });
  }

  private listAllModels() {
    return this.models.list().map((model) => this.normalizeModelRecord(model)).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async createModel(input: unknown) {
    const parsedInput = CreateModelInputSchema.parse(input);
    const timestamp = now();
    const nextOrder = this.nextModelOrder();
    const id = modelConfigHash(parsedInput);
    const existing = this.models.get(id);
    const model = ModelConfigSchema.parse({
      ...parsedInput,
      id,
      enabled: parsedInput.enabled ?? true,
      order: parsedInput.order ?? nextOrder,
      labels: parsedInput.labels || {},
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return publicModel(this.models.put(model));
  }

  async updateModel(id: string, input: unknown) {
    const parsedInput: UpdateModelInput = UpdateModelInputSchema.parse(input);
    const current = this.requireModelSecret(id);
    const candidate = ModelConfigSchema.parse({
      ...current,
      ...parsedInput,
      key: parsedInput.key?.trim() ? parsedInput.key : current.key,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    const nextId = modelConfigHash(candidate);
    const stored = this.models.put(ModelConfigSchema.parse({ ...candidate, id: nextId }));
    return publicModel(stored);
  }

  async deleteModel(id: string) {
    this.requireModelSecret(id);
    return this.models.delete(id);
  }

  async reorderModels(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const byId = new Map(this.models.list().map((model) => [model.id, model]));
    for (const id of uniqueIds) {
      if (!byId.has(id)) {
        throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
      }
    }
    uniqueIds.forEach((id, index) => {
      const current = byId.get(id)!;
      this.models.put(ModelConfigSchema.parse({ ...current, order: (index + 1) * 100, updatedAt: now() }));
    });
    return this.listModels();
  }

  createNodeModel(nodeId: string, input: unknown) {
    return this.nodeAgentGateway.createModel(this.requireNode(nodeId), input);
  }

  updateNodeModel(nodeId: string, modelId: string, input: unknown) {
    return this.nodeAgentGateway.updateModel(this.requireNode(nodeId), modelId, input);
  }

  deleteNodeModel(nodeId: string, modelId: string) {
    return this.nodeAgentGateway.deleteModel(this.requireNode(nodeId), modelId);
  }

  createProject(input: unknown) {
    return this.catalogService.createProject(input);
  }

  updateProject(id: string, input: unknown) {
    return this.catalogService.updateProject(id, input);
  }

  deleteProject(id: string) {
    return this.catalogService.deleteProject(id);
  }

  listImages() {
    return this.catalogService.listImages();
  }

  createImage(input: unknown) {
    return this.catalogService.createImage(input);
  }

  async listNodeDockerImages(nodeId: string) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.listDockerImages(node);
  }

  async listNodeImageAvailability(nodeId: string) {
    const node = this.requireNode(nodeId);
    const images = this.listImages();
    try {
      const localImages = await this.nodeAgentGateway.listDockerImages(node);
      return images.map((image) => {
        const localImage = localImages.find((local) => local.reference === image.reference || local.repoDigests.includes(image.reference!));
        return NodeImageAvailabilitySchema.parse({ image, status: localImage ? "available" : "pull-required", localImage });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return images.map((image) => NodeImageAvailabilitySchema.parse({ image, status: "unknown", error: message }));
    }
  }

  async listNodeLocalFolders(nodeId: string) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.listLocalFolders(node);
  }

  async listNodeFolderTree(nodeId: string, input: { path?: string; depth?: number } = {}) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.listFolderTree(node, input);
  }

  async createNodeLocalFolder(nodeId: string, input: unknown) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.createLocalFolder(node, input);
  }

  async deleteNodeLocalFolder(nodeId: string, folderId: string) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.deleteLocalFolder(node, folderId);
  }

  async checkNode(id: string) {
    const node = this.requireNode(id);
    try {
      const data = await this.nodeAgentGateway.health(node);
      const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const agentNodeId = typeof record.nodeId === "string" && record.nodeId.trim() ? record.nodeId.trim() : node.id;
      const updated = NodeSchema.parse({
        ...node,
        id: agentNodeId,
        status: "online",
        health: "ok",
        capabilities: typeof data === "object" && data ? { ...node.capabilities, agent: publicNodeAgentCapabilities(data) } : node.capabilities,
        lastSeenAt: now(),
        updatedAt: now(),
      });
      if (agentNodeId !== node.id) {
        this.nodes.delete(node.id);
      }
      this.nodes.put(updated);
      return {
        id: updated.id,
        status: "online",
        checkedAt: now(),
        agent: data,
      };
    } catch (error) {
      const updated = NodeSchema.parse({
        ...node,
        status: "offline",
        health: "failed",
        updatedAt: now(),
      });
      this.nodes.put(updated);
      return {
        id: node.id,
        status: "offline",
        checkedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkNodeUpdate(id: string, input: UpdateCheckRequest) {
    return this.nodeAgentGateway.checkUpdate(this.requireNode(id), input);
  }

  async applyNodeUpdate(id: string, input: UpdateCheckRequest) {
    const node = this.requireNode(id);
    if (input.target.component === "controlled-instance") {
      const instance = await this.requireNodeInstance(input.target.instanceId);
      if (instance.nodeId !== node.id) {
        const error = new Error(`Instance ${instance.id} does not belong to node ${node.id}.`);
        Object.assign(error, { statusCode: 400, code: "UPDATE_TARGET_NODE_MISMATCH" });
        throw error;
      }
      await this.ensureInstanceModelAssignment(instance);
      return this.nodeAgentGateway.applyUpdate(node, input);
    }
    return this.nodeAgentGateway.applyUpdate(node, input);
  }

  async listNodeUpdateJobs(id: string) {
    return this.nodeAgentGateway.listUpdateJobs(this.requireNode(id));
  }

  async getLocalNodeExternalListener(id: string) {
    return this.nodeAgentGateway.getExternalListener(this.requireLocalListenerNode(id));
  }

  async updateLocalNodeExternalListener(id: string, input: unknown) {
    return this.nodeAgentGateway.updateExternalListener(this.requireLocalListenerNode(id), input);
  }

  async createNodePairingInvite(id: string, input: unknown = {}) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.createPairingInvite(node, input);
  }

  private requireLocalListenerNode(id: string) {
    const node = this.requireNode(id);
    if (!isControlPlaneBuiltinNode(node) || !isControlPlaneLocalNode(node)) {
      const error = new Error("Node agent TCP listener settings are available only for the built-in local node.");
      Object.assign(error, { statusCode: 403, code: "LOCAL_NODE_LISTENER_ONLY" });
      throw error;
    }
    return node;
  }

  private pruneNodeJoinInvites() {
    const timestamp = Date.now();
    for (const invite of this.nodeJoinInvites.list()) {
      if (Date.parse(invite.expiresAt) <= timestamp) {
        this.nodeJoinInvites.delete(invite.id);
      }
    }
  }

  createNodeJoinInvite(input: unknown = {}) {
    this.pruneNodeJoinInvites();
    const parsedInput = CreateNodeJoinInviteInputSchema.parse(input && typeof input === "object" ? input : {});
    const timestamp = now();
    const token = createSecret();
    const invite = {
      id: createId("node_join"),
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + (parsedInput.expiresInMs || NODE_JOIN_INVITE_TTL_MS)).toISOString(),
      ...(parsedInput.nodeName ? { nodeName: parsedInput.nodeName } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.nodeJoinInvites.put(invite);
    return {
      id: invite.id,
      joinToken: token,
      expiresAt: invite.expiresAt,
    };
  }

  completeNodeJoin(input: unknown) {
    this.pruneNodeJoinInvites();
    const parsedInput = z.object({
      joinToken: z.string().trim().min(1).max(4096),
      nodeId: NodeSchema.shape.id,
      nodeName: NodeSchema.shape.name.optional(),
      keyId: z.string().trim().min(1).max(160),
      secret: z.string().trim().min(1).max(4096),
      pairedAt: z.string().datetime().optional(),
    }).parse(input);
    const tokenHash = crypto.createHash("sha256").update(parsedInput.joinToken).digest("hex");
    const invite = this.nodeJoinInvites.list().find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now());
    if (!invite) {
      const error = new Error("Node join token is invalid or expired.");
      Object.assign(error, { statusCode: 401, code: "NODE_JOIN_TOKEN_INVALID" });
      throw error;
    }
    this.nodeJoinInvites.delete(invite.id);
    const timestamp = now();
    const current = this.nodes.get(parsedInput.nodeId);
    if (current) {
      const error = new Error(`Node ${parsedInput.nodeId} already exists in this control-plane.`);
      Object.assign(error, { statusCode: 409, code: "NODE_JOIN_NODE_ALREADY_EXISTS" });
      throw error;
    }
    const node = NodeSchema.parse({
      id: parsedInput.nodeId,
      name: parsedInput.nodeName || invite.nodeName || parsedInput.nodeId,
      connectionMode: "reverse-wss",
      auth: {
        mode: "paired-hmac",
        keyId: parsedInput.keyId,
        secret: parsedInput.secret,
        pairedAt: parsedInput.pairedAt || timestamp,
        pairing: { status: "paired" },
      },
      status: "unknown",
      health: "unknown",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.nodes.put(node);
  }

  async connectNodeToControlPlane(id: string, input: unknown) {
    const node = this.requireNode(id);
    const parsedInput = ConnectNodeRemoteInputSchema.parse(input);
    return this.nodeAgentGateway.connectRemote(node, parsedInput);
  }

  async listNodeRemoteControlPlanes(id: string) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.listRemotes(node);
  }

  async deleteNodeRemoteControlPlane(id: string, keyId: string) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.deleteRemote(node, keyId);
  }

  updateImage(id: string, input: unknown) {
    return this.catalogService.updateImage(id, input);
  }

  async deleteImage(id: string) {
    this.catalogService.requireImage(id);
    const project = this.listProjects().find((item) => item.defaultImageId === id);
    if (project) throw Object.assign(new Error(`Image ${id} is the default for project ${project.name}.`), { statusCode: 409, code: "IMAGE_IN_USE" });
    const folders = (await Promise.all(this.listNodes().map((node) => this.nodeAgentGateway.listLocalFolders(node)))).flat();
    const folder = folders.find((item) => item.defaultImageId === id);
    if (folder) throw Object.assign(new Error(`Image ${id} is the default for local folder ${folder.name}.`), { statusCode: 409, code: "IMAGE_IN_USE" });
    const instances = await this.listNodeInstances();
    const instance = instances.find((item) => item.imageId === id);
    if (instance) throw Object.assign(new Error(`Image ${id} is used by instance ${instance.name}.`), { statusCode: 409, code: "IMAGE_IN_USE" });
    return this.catalogService.deleteImage(id);
  }

  listNodes() {
    return this.nodes.list();
  }

  listPublicNodes() {
    return this.listNodes().map(publicNode);
  }

  async createNode(input: unknown) {
    const parsedInput = CreateNodeInputSchema.parse(input);
    const timestamp = now();
    const connectionMode = parsedInput.connectionMode || "direct-http";
    const inputRecord = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    let auth = "auth" in inputRecord
      ? parsedInput.auth
      : { mode: connectionMode === "local-ipc" || connectionMode === "local-loopback" ? "local-static-key" as const : "paired-hmac" as const };
    if ((connectionMode === "direct-http" || connectionMode === "reverse-wss") && auth.mode !== "paired-hmac") {
      const error = new Error("Remote node connections require paired-HMAC authentication.");
      Object.assign(error, { statusCode: 400, code: "NODE_AGENT_REMOTE_REQUIRES_PAIRED_HMAC" });
      throw error;
    }
    const controlEndpoint = parsedInput.controlEndpoint || parsedInput.endpoint;
    if (!controlEndpoint && connectionMode !== "reverse-wss") {
      const error = new Error("Node agent direct HTTP mode requires an endpoint.");
      Object.assign(error, { statusCode: 400, code: "NODE_AGENT_ENDPOINT_REQUIRED" });
      throw error;
    }
    const pairing = parsedInput.joinToken && controlEndpoint
      ? await this.completeNodeAgentPairing(controlEndpoint, { joinToken: parsedInput.joinToken })
      : undefined;
    if (pairing) {
      auth = {
        mode: "paired-hmac",
        keyId: pairing.keyId,
        secret: pairing.secret,
        pairedAt: pairing.pairedAt,
        pairing: { status: "paired" },
      };
    }
    if ((connectionMode === "direct-http" || connectionMode === "reverse-wss") && !auth.secret) {
      const error = new Error("Remote node connections require a paired node secret or join token.");
      Object.assign(error, { statusCode: 400, code: "NODE_AGENT_REMOTE_SECRET_REQUIRED" });
      throw error;
    }
    if ((connectionMode === "direct-http" || connectionMode === "reverse-wss") && !auth.keyId) {
      const error = new Error("Remote node connections require a paired key id.");
      Object.assign(error, { statusCode: 400, code: "NODE_AGENT_REMOTE_KEY_ID_REQUIRED" });
      throw error;
    }
    const provisionalId = parsedInput.id || pairing?.nodeId || createId("node");
    const probeNode = NodeSchema.parse({
      id: provisionalId,
      name: parsedInput.name,
      connectionMode,
      auth,
      labels: parsedInput.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const inspected = connectionMode === "reverse-wss" && (parsedInput.id || pairing?.nodeId) ? undefined : await this.inspectNodeAgent(controlEndpoint || "", probeNode);
    const id = parsedInput.id || pairing?.nodeId || inspected?.nodeId || provisionalId;
    if (!id) {
      const error = new Error("Node id is required.");
      Object.assign(error, { statusCode: 400, code: "NODE_ID_REQUIRED" });
      throw error;
    }
    if (parsedInput.id && inspected?.nodeId && inspected.nodeId !== parsedInput.id) {
      const error = new Error(`Node agent id ${inspected.nodeId} does not match requested node id ${parsedInput.id}.`);
      Object.assign(error, { statusCode: 400, code: "NODE_AGENT_ID_MISMATCH" });
      throw error;
    }
    const { joinToken: _joinToken, ...nodeInput } = parsedInput;
    const node = NodeSchema.parse({
      ...nodeInput,
      id,
      connectionMode,
      auth,
      endpoint: controlEndpoint,
      controlEndpoint,
      status: parsedInput.status || (inspected ? "online" : "unknown"),
      health: parsedInput.health || (inspected ? "ok" : "unknown"),
      capabilities: { ...(parsedInput.capabilities || {}), ...(inspected ? { agent: publicNodeAgentCapabilities(inspected.data) } : {}) },
      labels: parsedInput.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.nodes.put(node);
  }

  updateNode(id: string, input: unknown) {
    const parsedInput: UpdateNodeInput = UpdateNodeInputSchema.parse(input);
    const current = this.requireNode(id);
    const updated = NodeSchema.parse({
      ...current,
      ...parsedInput,
      id,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    return this.nodes.put(updated);
  }

  deleteNode(id: string) {
    const current = this.requireNode(id);
    if (isControlPlaneBuiltinNode(current)) {
      const error = new Error("The built-in local node connection cannot be deleted.");
      Object.assign(error, { statusCode: 400, code: "LOCAL_NODE_CANNOT_BE_DELETED" });
      throw error;
    }
    return this.nodes.delete(id);
  }

  async listNodeRuntimes(nodeId?: string) {
    const nodes = nodeId ? [this.requireNode(nodeId)] : this.listNodes();
    if (nodeId) {
      return this.nodeAgentGateway.listRuntimes(nodes[0]);
    }
    const result = await this.nodeAgentGateway.listFleetRuntimes(nodes);
    return result.items;
  }

  async listNodeRuntimesWithDiagnostics() {
    return this.nodeAgentGateway.listFleetRuntimes(this.listNodes());
  }

  async createNodeRuntime(nodeId: string, input: unknown) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.createRuntime(node, input);
  }

  async updateNodeRuntime(nodeId: string, runtimeId: string, input: unknown) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.updateRuntime(node, runtimeId, input);
  }

  async deleteNodeRuntime(nodeId: string, runtimeId: string) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.deleteRuntime(node, runtimeId);
  }

  async checkNodeRuntime(nodeId: string, runtimeId: string) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.checkRuntime(node, runtimeId);
  }

  async listControlledInstances() {
    return (await this.listNodeInstances()).map(publicInstanceWithAccess);
  }

  async listControlledInstancesWithDiagnostics() {
    const result = await this.listNodeInstancesWithDiagnostics();
    return {
      items: result.items.map(publicInstanceWithAccess),
      nodeErrors: result.nodeErrors,
    };
  }

  async instanceResourceMetrics(instanceId: string) {
    const instance = await this.requireNodeInstance(instanceId);
    return this.nodeAgentGateway.instanceResourceMetrics(this.requireNode(instance.nodeId), instance.id);
  }

  async nodeOwnsInstance(nodeId: string, instanceId: string) {
    const node = this.requireNode(nodeId);
    const instances = await this.nodeAgentGateway.listInstances(node);
    return instances.some((instance) => instance.id === instanceId && instance.nodeId === nodeId);
  }

  async createControlledInstance(input: unknown) {
    const parsedInput = CreateInstanceInputSchema.parse(input);
    const project = parsedInput.projectId ? this.requireProject(parsedInput.projectId) : undefined;
    const runtimeId = parsedInput.runtimeId || project?.defaultRuntimeId || "runtime_local_docker";
    const nodeId = parsedInput.nodeId || project?.defaultNodeId || this.defaultNodeId();
    if (!nodeId) {
      const error = new Error("At least one node connection is required before creating an instance.");
      Object.assign(error, { statusCode: 400, code: "NODE_REQUIRED" });
      throw error;
    }
    const node = this.requireNode(nodeId);
    const runtime = await this.requireNodeRuntimeOnNode(node.id, runtimeId);
    const requiresImage = typeof runtime.capabilities.requiresImage === "boolean" ? runtime.capabilities.requiresImage : runtime.type !== "local";
    const imageId = parsedInput.imageId || (requiresImage ? project?.defaultImageId : undefined);
    const image = imageId ? this.requireImage(imageId) : undefined;
    if (requiresImage && !image) {
      const error = new Error(`Runtime ${runtime.name} requires an image.`);
      Object.assign(error, { statusCode: 400, code: "RUNTIME_IMAGE_REQUIRED" });
      throw error;
    }
    let source = parsedInput.source || project?.source;
    let sourceSnapshot: Record<string, unknown> = parsedInput.sourceSnapshot || (project ? project : {});
    if (!source) {
      const error = new Error("Instance source is required.");
      Object.assign(error, { statusCode: 400, code: "INSTANCE_SOURCE_REQUIRED" });
      throw error;
    }
    if (runtime.type === "local" && source.type !== "local-folder") {
      const error = new Error("Localhost runtime currently supports local folder sources only.");
      Object.assign(error, { statusCode: 400, code: "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER" });
      throw error;
    }
    if (source.type === "local-folder") {
      if (source.ownerNodeId && source.ownerNodeId !== node.id) {
        const error = new Error(`Local folder ${source.path} belongs to node ${source.ownerNodeId}, not ${node.id}.`);
        Object.assign(error, { statusCode: 400, code: "LOCAL_FOLDER_REQUIRES_OWNER_NODE" });
        throw error;
      }
      if (source.localFolderId) {
        const folder = await this.requireNodeLocalFolder(node, source.localFolderId);
        source = { ...source, localFolderId: folder.id, ownerNodeId: folder.nodeId, path: folder.path };
        sourceSnapshot = folder as Record<string, unknown>;
      } else {
        const folder = await this.nodeAgentGateway.createLocalFolder(node, {
            name: typeof sourceSnapshot.name === "string" ? sourceSnapshot.name : "Local folder",
            path: source.path,
            defaultImageId: image?.id,
          });
        source = { ...source, localFolderId: folder.id, ownerNodeId: folder.nodeId, path: folder.path };
        sourceSnapshot = folder as Record<string, unknown>;
      }
    }

    const preparedModels = await this.prepareInstanceModels(node, parsedInput.modelSelection || {});
    const instance = await this.nodeAgentGateway.createInstance(node, {
      id: parsedInput.id,
      name: parsedInput.name,
      runtimeId,
      ...(image ? { imageId: image.id, image } : {}),
      projectId: project?.id,
      source,
      sourceSnapshot,
      config: parsedInput.config,
      modelSelection: {},
    });
    let assigned = instance;
    try {
      assigned = (await this.nodeAgentGateway.assignInstanceModels(node, instance.id, preparedModels)).instance;
    } catch (error) {
      await this.nodeAgentGateway.deleteInstance(node, instance.id).catch(() => undefined);
      throw error;
    }
    return {
      ...publicInstanceWithAccess(assigned),
      registrationToken: assigned.registrationToken,
    };
  }

  async updateControlledInstance(id: string, input: unknown) {
    const parsedInput: UpdateInstanceInput = UpdateInstanceInputSchema.parse(input);
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    const { modelSelection, ...instancePatch } = parsedInput;
    let instance = Object.keys(instancePatch).length
      ? await this.nodeAgentGateway.updateInstance(node, id, instancePatch)
      : current;
    if (modelSelection) {
      const preparedModels = await this.prepareInstanceModels(node, modelSelection);
      instance = (await this.nodeAgentGateway.assignInstanceModels(node, id, preparedModels)).instance;
    }
    return publicInstanceWithAccess(instance);
  }

  async deleteControlledInstance(id: string) {
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    const result = await this.nodeAgentGateway.deleteInstance(node, id);
    return Boolean(result.deleted);
  }

  async startControlledInstance(id: string) {
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    await this.ensureInstanceModelAssignment(current);
    const instance = await this.nodeAgentGateway.startInstance(node, id);
    return publicInstanceWithAccess(instance);
  }

  async stopControlledInstance(id: string) {
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    const instance = await this.nodeAgentGateway.stopInstance(node, id);
    return publicInstanceWithAccess(instance);
  }

  async restartControlledInstance(id: string) {
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    await this.ensureInstanceModelAssignment(current);
    const instance = await this.nodeAgentGateway.restartInstance(node, id);
    return publicInstanceWithAccess(instance);
  }

  async retryControlledInstanceImageProvisioning(id: string) {
    const current = await this.requireNodeInstance(id);
    const instance = await this.nodeAgentGateway.retryInstanceImageProvisioning(this.requireNode(current.nodeId), id);
    return publicInstanceWithAccess(instance);
  }

  async boardAsync() {
    return (await this.boardWithDiagnostics()).items;
  }

  async boardWithDiagnostics() {
    const runtimeResult = await this.listNodeRuntimesWithDiagnostics();
    const instanceResult = await this.listNodeInstancesWithDiagnostics();
    return this.instanceBoardReader.read({
      projects: this.listProjects(),
      images: this.listImages(),
      nodes: this.nodes.list(),
      runtimes: runtimeResult.items,
      instances: instanceResult.items,
      nodeErrors: [...runtimeResult.nodeErrors, ...instanceResult.nodeErrors],
    });
  }

  async bootstrapAiSessionsFromInstances() {
    const instances = await this.listNodeInstances();
    const states = await Promise.all(
      instances.map(async (instance) => {
        if (!instance.target.web || (instance.connectionStatus !== "online" && instance.agentStatus !== "online")) {
          return { streamId: `bootstrap:${instance.id}:ai.sessions`, revision: 0, lastEventAt: instance.aiSessions.updatedAt, snapshot: instance.aiSessions };
        }
        try {
          return AiSessionsStateSchema.parse(await this.instanceRequest(instance, "/ai-sessions/state"));
        } catch (error) {
          this.logWarn(
            { instanceId: instance.id, error: errorMessage(error), errorCode: "AI_SESSION_LIVE_REFRESH_FAILED" },
            "control plane failed to refresh live AI sessions",
          );
          return { streamId: `bootstrap:${instance.id}:ai.sessions`, revision: 0, lastEventAt: instance.aiSessions.updatedAt, snapshot: instance.aiSessions };
        }
      }),
    );
    return {
      updatedAt: new Date().toISOString(),
      instances: instances.map((instance, index) => ({
        instanceId: instance.id,
        streamId: states[index].streamId,
        aiSessions: states[index].snapshot,
        revision: states[index].revision,
        lastEventAt: states[index].lastEventAt,
      })),
    };
  }

  async bootstrapAppSessionsFromInstances() {
    const instances = await this.listNodeInstances();
    const states = await Promise.all(
      instances.map(async (instance) => {
        if (!instance.target.web || (instance.connectionStatus !== "online" && instance.agentStatus !== "online")) {
          const snapshot = emptyAppSessionsSnapshot();
          return { streamId: `bootstrap:${instance.id}:app.sessions`, revision: 0, lastEventAt: snapshot.updatedAt, snapshot };
        }
        try {
          return AppSessionsStateSchema.parse(await this.instanceRequest(instance, "/apps/sessions/state"));
        } catch (error) {
          this.logWarn(
            { instanceId: instance.id, error: errorMessage(error), errorCode: "APP_SESSION_LIVE_REFRESH_FAILED" },
            "control plane failed to refresh live app sessions",
          );
          const snapshot = emptyAppSessionsSnapshot();
          return { streamId: `bootstrap:${instance.id}:app.sessions`, revision: 0, lastEventAt: snapshot.updatedAt, snapshot };
        }
      }),
    );
    return {
      updatedAt: new Date().toISOString(),
      instances: instances.map((instance, index) => ({
        instanceId: instance.id,
        streamId: states[index].streamId,
        appSessions: states[index].snapshot,
        revision: states[index].revision,
        lastEventAt: states[index].lastEventAt,
      })),
    };
  }

  async recoverAiSessionDelta(instanceId: string, streamId: string, sinceRevision: number): Promise<AiSessionDeltaResponse> {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const query = new URLSearchParams({ streamId, sinceRevision: String(sinceRevision) });
    return AiSessionDeltaResponseSchema.parse(await this.instanceRequest(instance, `/ai-sessions?${query}`));
  }

  async recoverAiSessionSnapshot(instanceId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionsStateSchema.parse(await this.instanceRequest(instance, "/ai-sessions/state"));
  }

  async recoverAppSessionDelta(instanceId: string, streamId: string, sinceRevision: number): Promise<AppSessionDeltaResponse> {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const query = new URLSearchParams({ streamId, sinceRevision: String(sinceRevision) });
    return AppSessionDeltaResponseSchema.parse(await this.instanceRequest(instance, `/apps/sessions?${query}`));
  }

  async recoverAppSessionSnapshot(instanceId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AppSessionsStateSchema.parse(await this.instanceRequest(instance, "/apps/sessions/state"));
  }

  async listTriggers() {
    return this.controlPlaneTriggerService.listTriggers();
  }

  createTrigger(input: unknown) {
    return this.controlPlaneTriggerService.createTrigger(input);
  }

  async deleteTrigger(configHash: string) {
    return this.controlPlaneTriggerService.deleteTrigger(configHash);
  }

  async applyTrigger(configHash: string, input: unknown) {
    return this.controlPlaneTriggerService.applyTrigger(configHash, input);
  }

  async listInstanceTriggers(instanceId: string) {
    return this.controlPlaneTriggerService.listInstanceTriggers(instanceId);
  }

  async bindAiSessionTrigger(instanceId: string, sessionId: string, input: unknown) {
    return this.controlPlaneTriggerService.bindAiSessionTrigger(instanceId, sessionId, input);
  }

  async unbindAiSessionTrigger(instanceId: string, sessionId: string, configHash: string) {
    return this.controlPlaneTriggerService.unbindAiSessionTrigger(instanceId, sessionId, configHash);
  }

  async runInstanceTrigger(instanceId: string, configHash: string, body: unknown = {}) {
    return this.controlPlaneTriggerService.runInstanceTrigger(instanceId, configHash, body);
  }

  listChatSessions() {
    return this.chatSessionService.list();
  }

  createAppAccessToken(input: { instanceId: string; sessionId: string; mode: AppAccessMode; ttlMs?: number }) {
    return this.appAccessService.createToken(input);
  }

  resolveAppAccessToken(token: string, mode?: AppAccessMode) {
    return this.appAccessService.resolveToken(token, mode);
  }

  createChatActionToken(input:
    | { type: "instance-app-menu" | "launch-app"; instanceId: string; appId?: string; ttlMs?: number }
    | { type: "pending-decision"; routeId: string; decision: "allow" | "deny" | "skip"; ttlMs?: number }
  ) {
    return this.chatActionTokenService.create(input);
  }

  resolveChatActionToken(token: string, type?: ChatActionToken["type"]) {
    return this.chatActionTokenService.resolve(token, type);
  }

  pendingDecisionCallbackData(routeId: string, decision: "allow" | "deny" | "skip") {
    return this.chatActionTokenService.pendingDecisionCallbackData(routeId, decision);
  }

  async appAccessProxyTarget(token: string, mode: AppAccessMode, suffix = "") {
    return this.appAccessService.proxyTarget(token, mode, suffix);
  }

  listChatBridges() {
    return this.chatBridgeService.list();
  }

  requireChatBridge(id: string) {
    return this.chatBridgeService.require(id);
  }

  createChatBridge(input: unknown) {
    return this.chatBridgeService.create(input);
  }

  updateChatBridge(id: string, input: unknown) {
    return this.chatBridgeService.update(id, input);
  }

  deleteChatBridge(id: string) {
    return this.chatBridgeService.delete(id);
  }

  requireChatSession(id: string) {
    return this.chatSessionService.require(id);
  }

  upsertChatSession(input: Pick<ChatSessionBinding, "channel" | "chatSessionId"> & Partial<ChatSessionBinding>) {
    return this.chatSessionService.upsert(input);
  }

  async handleChatGatewayMessage(input: ChatGatewayMessage) {
    return this.chatSessionRuntime.handleChatGatewayMessage(input);
  }

  async handleChatGatewayAction(input: Parameters<ControlPlaneChatSessionRuntime["handleChatGatewayAction"]>[0]) {
    return this.chatSessionRuntime.handleChatGatewayAction(input);
  }

  async handleChatCommand(binding: ChatSessionBinding, text: string) {
    return this.chatSessionRuntime.handleChatCommand(binding, text);
  }

  async listPendingRoutes() {
    const timestamp = now();
    const routes: Array<PendingRoute & { project?: Project; instance: ReturnType<typeof publicInstance> }> = [];
    const aiSessions = await this.listAiSessions();
    const snapshots = new Map(aiSessions.instances.map((entry) => [entry.instanceId, entry.aiSessions]));
    const instanceResult = await this.nodeAgentGateway.listFleetInstances(this.listNodes());
    for (const instance of instanceResult.items) {
      if ((instance.connectionStatus !== "online" && instance.agentStatus !== "online") || !instance.target.web) {
        continue;
      }
      const project = instance.projectId ? this.catalogService.getProject(instance.projectId) : undefined;
      for (const session of snapshots.get(instance.id)?.sessions || []) {
        if (session.status !== "waiting") {
          continue;
        }
        const route = PendingRouteSchema.parse({
          id: `${instance.id}:ai:${session.id}`,
          instanceId: instance.id,
          projectId: instance.projectId,
          aiSessionId: session.id,
          providerSessionId: session.providerSessionId,
          result: session.summary || session.currentTool?.inputPreview || session.lastMessage || `${session.agent} is waiting for approval`,
          source: session.agent,
          kind: "approval",
          status: "pending",
          lastSeenAt: timestamp,
        });
        routes.push({
          ...route,
          project,
          instance: publicInstanceWithAccess(instance),
        });
      }
    }
    return routes;
  }

  async listAiSessionInstanceNames() {
    const result = await this.nodeAgentGateway.listFleetInstances(this.listNodes());
    return result.items.map((instance) => ({ id: instance.id, name: instance.name }));
  }

  async resolveAiSessionApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip"): Promise<AiSessionActionResult> {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionActionResultSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }));
  }

  async launchAppSession(instanceId: string, appId = "terminal-tty", options: Record<string, unknown> = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    if (instance.connectionStatus !== "online" && instance.agentStatus !== "online") {
      const error = new Error(`Instance ${instance.name} is still starting. Wait for it to connect before launching apps.`);
      Object.assign(error, { statusCode: 409, code: "INSTANCE_NOT_CONNECTED" });
      throw error;
    }
    const launchOptions = await this.resolveAppLaunchOptions(instance, options);
    const session = await this.instanceRequest(instance, "/apps/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, ...launchOptions }),
    }) as Record<string, unknown>;
    await this.listAppSessions({ refresh: true });
    return session;
  }

  async stopAppSession(instanceId: string, sessionId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const session = await this.instanceRequest(instance, `/apps/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }) as Record<string, unknown>;
    await this.listAppSessions({ refresh: true });
    return session;
  }

  async instanceAppManagement(instanceId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    try {
      return parseInstanceAppManagementSnapshot(await this.instanceRequest(instance, "/apps/management"));
    } catch (error) {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      if (error instanceof z.ZodError || record.statusCode === 404) {
        const unsupported = new Error("This controlled instance does not support managed app operations.");
        Object.assign(unsupported, { statusCode: 409, code: "INSTANCE_APP_MANAGEMENT_UNSUPPORTED" });
        throw unsupported;
      }
      throw error;
    }
  }

  async requestInstanceAppOperation(instanceId: string, appId: string, operation: "install" | "uninstall", input: AppManagementOperationRequest = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AppManagementJobResponseSchema.parse(await this.instanceRequest(instance, `/apps/${encodeURIComponent(appId)}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  }

  async instanceAppManagementJob(instanceId: string, jobId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AppManagementJobResponseSchema.parse(await this.instanceRequest(instance, `/apps/jobs/${encodeURIComponent(jobId)}`));
  }

  async renameAppSession(instanceId: string, sessionId: string, title: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const session = await this.instanceRequest(instance, `/apps/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }) as Record<string, unknown>;
    await this.listAppSessions({ refresh: true });
    return session;
  }

  async sendAiSessionMessage(instanceId: string, sessionId: string, message: string, mode?: AiSessionSendMode, attachments: AiSessionMessageAttachment[] = []): Promise<AiSessionActionResult> {
    assertAiSessionAttachmentsWithinLimit(attachments);
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const body = { message, ...(mode ? { mode } : {}), ...(attachments.length ? { attachments } : {}) };
    return AiSessionActionResultSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  async aiSessionQueue(instanceId: string, sessionId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionQueueSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/queue`));
  }

  async steerAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionActionResultSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
  }

  async retryAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionStatusSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
  }

  async removeAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionStatusSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`, {
      method: "DELETE",
    }));
  }

  async interruptAiSession(instanceId: string, sessionId: string): Promise<AiSessionActionResult> {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return AiSessionActionResultSchema.parse(await this.instanceRequest(instance, `/ai-sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
  }

  async proxyInstanceHttp(instanceId: string, path: string, init: ProxyHttpInit = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return this.controlledInstanceGateway.proxyHttp(instance, path, init);
  }

  async proxyInstanceWebSocket(instanceId: string, socket: NodeAgentWebSocket, path: string, protocols?: string | string[], headers: Record<string, string> = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    this.controlledInstanceGateway.proxyWebSocket(instance, this.nodeAgentTransportFor(this.requireNode(instance.nodeId)), socket, path, protocols, headers);
  }

  listConfigSyncPresets() {
    return configSyncPresets();
  }

  async syncInstanceConfig(instanceId: string, direction: "import" | "export", preset: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    if (direction === "export" && instance.source.type !== "local-folder") {
      const error = new Error("Exporting instance config is only available for local folder projects.");
      Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_EXPORT_REQUIRES_LOCAL_PROJECT" });
      throw error;
    }
    const presetConfig = configSyncPresets().find((item) => item.id === preset);
    if (!presetConfig) {
      const error = new Error(`Config sync preset ${preset} was not found.`);
      Object.assign(error, { statusCode: 404, code: "CONFIG_SYNC_PRESET_NOT_FOUND" });
      throw error;
    }
    return this.instanceRequest(instance, `/config-sync/${encodeURIComponent(direction)}/${encodeURIComponent(preset)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: presetConfig }),
    });
  }

  private async instanceRequest(instance: ControlledInstance, route: string, init: RequestInit = {}) {
    return this.controlledInstanceGateway.request(instance, route, init);
  }

  private async reportInstanceHeartbeat(instance: ControlledInstance, input: ControlledInstanceHeartbeat) {
    await this.controlledInstanceGateway.reportHeartbeat(instance, input, this.nodeAgentTransport);
  }

  private async nodeAgentFetch(node: Node, route: string, init: RequestInit = {}) {
    return this.nodeAgentTransportFor(node).request(node, route, init);
  }

  private nodeAgentTransportFor(node: Node): NodeAgentTransport {
    if (node.connectionMode === "reverse-wss") {
      if (!this.nodeAgentTransport) {
        const error = new Error("Reverse node agent transport is not available.");
        Object.assign(error, { statusCode: 503, code: "NODE_AGENT_REVERSE_TRANSPORT_UNAVAILABLE" });
        throw error;
      }
      return this.nodeAgentTransport;
    }
    return this.directNodeAgentTransport();
  }

  private directNodeAgentTransport(): NodeAgentTransport {
    const request = async (node: Node, route: string, init: RequestInit = {}) => {
      const endpoint = node.controlEndpoint || node.endpoint;
      if (!endpoint) {
        const error = new Error("Node agent direct HTTP mode requires an endpoint.");
        Object.assign(error, { statusCode: 400, code: "NODE_AGENT_ENDPOINT_REQUIRED" });
        throw error;
      }
      const method = init.method || "GET";
      const body = typeof init.body === "string" || init.body instanceof Buffer ? init.body : init.body === undefined || init.body === null ? undefined : String(init.body);
      const authHeaders = createDirectNodeAgentAuthHeaders(node, {
        method,
        pathWithQuery: `/api/node-agent${route}`,
        body: body || "",
      });
      return this.fetchNodeAgentEndpoint(endpoint, route, {
        ...init,
        body,
        headers: {
          ...(init.headers || {}),
          ...authHeaders,
        },
      });
    };
    return {
      request,
      requestStream: request,
      proxyWebSocket: (node, socket, route, protocols, headers = {}) => {
        const endpoint = node.controlEndpoint || node.endpoint;
        if (!endpoint) {
          throw Object.assign(new Error("Node agent direct HTTP mode requires an endpoint."), { statusCode: 400, code: "NODE_AGENT_ENDPOINT_REQUIRED" });
        }
        const ipcPath = parseNodeAgentIpcEndpoint(endpoint);
        const pathWithQuery = `/api/node-agent${route}`;
        const authHeaders = createDirectNodeAgentAuthHeaders(node, {
          method: "GET",
          pathWithQuery,
        });
        if (ipcPath) {
          assertLocalIpcSocketOwnedByCurrentUser(ipcPath);
          const upstream = createNodeAgentIpcWebSocket(ipcPath, route, protocols, { ...headers as Record<string, string>, ...authHeaders });
          upstream.on("open", () => {
            socket.on("message", (data, isBinary) => upstream.readyState === WsClient.OPEN && upstream.send(isBinary ? data : String(data)));
            socket.on("close", () => upstream.close());
            socket.on("error", () => upstream.close());
          });
          upstream.on("message", (data, isBinary) => {
            if (socket.readyState === WsClient.OPEN) {
              socket.send(isBinary ? data : data.toString());
            }
          });
          upstream.on("close", () => socket.close());
          upstream.on("error", () => socket.close(1011, "Instance websocket proxy failed."));
          return;
        }
        const url = new URL(pathWithQuery, endpoint.replace(/\/$/, ""));
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const upstream = protocols
          ? new WsClient(url.toString(), protocols, { headers: { ...headers, ...authHeaders } })
          : new WsClient(url.toString(), { headers: { ...headers, ...authHeaders } });
        upstream.on("open", () => {
          socket.on("message", (data, isBinary) => upstream.readyState === WsClient.OPEN && upstream.send(isBinary ? data : String(data)));
          socket.on("close", () => upstream.close());
          socket.on("error", () => upstream.close());
        });
        upstream.on("message", (data, isBinary) => {
          if (socket.readyState === WsClient.OPEN) {
            socket.send(isBinary ? data : data.toString());
          }
        });
        upstream.on("close", () => socket.close());
        upstream.on("error", () => socket.close(1011, "Instance websocket proxy failed."));
      },
    };
  }

  private async listNodeInstances() {
    const result = await this.listNodeInstancesWithDiagnostics();
    return result.items;
  }

  private async listNodeInstancesWithDiagnostics() {
    const result = await this.nodeAgentGateway.listFleetInstances(this.listNodes());
    return {
      items: await Promise.all(result.items.map((instance) => this.withFreshTriggerSnapshot(instance))),
      nodeErrors: result.nodeErrors,
    };
  }

  private async withFreshTriggerSnapshot(instance: ControlledInstance) {
    if (instance.connectionStatus !== "online" && instance.agentStatus !== "online") {
      return instance;
    }
    try {
      const index = TriggerIndexSchema.parse(await this.instanceRequest(instance, "/triggers"));
      return ControlledInstanceSchema.parse({
        ...instance,
        triggers: controlledInstanceTriggerSnapshot(index),
      });
    } catch {
      return instance;
    }
  }

  private async requireNodeInstance(id: string) {
    for (const node of this.listNodes()) {
      try {
        const instances = await this.nodeAgentGateway.listInstances(node);
        const instance = instances.find((item) => item.id === id);
        if (instance) {
          return instance;
        }
      } catch {
        // Offline nodes do not block lookup on other nodes.
      }
    }
    throwNotFound("CONTROLLED_INSTANCE_NOT_FOUND", `Controlled instance ${id} was not found.`);
  }

  private async requireNodeRuntimeOnNode(nodeId: string, runtimeId: string) {
    const runtime = (await this.listNodeRuntimes(nodeId)).find((item) => item.id === runtimeId);
    if (!runtime) {
      throwNotFound("NODE_RUNTIME_NOT_FOUND", `Runtime ${runtimeId} was not found on node ${nodeId}.`);
    }
    return runtime;
  }

  private async requireNodeLocalFolder(node: Node, folderId: string) {
    return this.nodeAgentGateway.requireLocalFolder(node, folderId);
  }

  private async resolveAppLaunchOptions(instance: ControlledInstance, options: Record<string, unknown>) {
    const cwdFolderId = typeof options.cwdFolderId === "string" ? options.cwdFolderId.trim() : "";
    const launchOptions = { ...options };
    delete launchOptions.cwdFolderId;
    if (!cwdFolderId) {
      return launchOptions;
    }
    const node = this.requireNode(instance.nodeId);
    const folder = await this.requireNodeLocalFolder(node, cwdFolderId);
    if (folder.nodeId !== instance.nodeId) {
      const error = new Error(`Local folder ${folder.id} belongs to node ${folder.nodeId}, not ${instance.nodeId}.`);
      Object.assign(error, { statusCode: 400, code: "LOCAL_FOLDER_REQUIRES_INSTANCE_NODE" });
      throw error;
    }
    const runtime = await this.requireNodeRuntimeOnNode(instance.nodeId, instance.runtimeId);
    return {
      ...launchOptions,
      cwd: this.appLaunchCwdForFolder(instance, folder, runtime),
    };
  }

  private appLaunchCwdForFolder(instance: ControlledInstance, folder: NodeLocalFolder, runtime: NodeRuntime) {
    if (runtime.type === "local") {
      return resolveNodePath(folder.path);
    }
    if (instance.source.type !== "local-folder") {
      const error = new Error(`App cwd folder selection is only supported for local-folder instances.`);
      Object.assign(error, { statusCode: 400, code: "APP_CWD_REQUIRES_LOCAL_FOLDER_SOURCE" });
      throw error;
    }
    const relativeSegments = relativeNodePathSegments(instance.source.path, folder.path);
    if (!relativeSegments) {
      const error = new Error(`Local folder ${folder.path} is outside the instance workspace ${instance.source.path}.`);
      Object.assign(error, { statusCode: 400, code: "APP_CWD_OUTSIDE_WORKSPACE" });
      throw error;
    }
    const workspacePath = instance.runtime.workspacePath || instance.workspace.path || workspacePolicyForSource(instance.source).path || "/workspace";
    return relativeSegments.length ? path.posix.join(workspacePath, ...relativeSegments) : workspacePath;
  }

  private async prepareInstanceModels(node: Node, selection: { codexModelHash?: string | null; claudeModelHash?: string | null }) {
    const nodeModels = await this.nodeAgentGateway.listModels(node);
    const storedSelection = {
      ...(selection.codexModelHash === null ? { codexModelHash: null } : selection.codexModelHash?.trim() ? { codexModelHash: selection.codexModelHash.trim() } : {}),
      ...(selection.claudeModelHash === null ? { claudeModelHash: null } : selection.claudeModelHash?.trim() ? { claudeModelHash: selection.claudeModelHash.trim() } : {}),
    };
    const resolve = async (app: "codex" | "claude", selectedId?: string | null) => {
      if (selectedId === null) return undefined;
      const controlPlaneModel = selectedId
        ? this.listAllModels().find((model) => model.id === selectedId)
        : this.listAllModels().find((model) => model.enabled && model.app === app);
      if (controlPlaneModel) {
        if (controlPlaneModel.app !== app) {
          throw Object.assign(new Error(`Model ${controlPlaneModel.id} is not a ${app} model.`), { statusCode: 400, code: "MODEL_APP_MISMATCH" });
        }
        if (!controlPlaneModel.enabled) {
          throw Object.assign(new Error(`Model ${controlPlaneModel.id} is disabled.`), { statusCode: 400, code: "MODEL_DISABLED" });
        }
        await this.nodeAgentGateway.deployModel(node, controlPlaneModel.id, controlPlaneModel);
        return controlPlaneModel.id;
      }
      if (!selectedId) return undefined;
      const local = nodeModels.find((model) => model.id === selectedId);
      if (!local) {
        throwNotFound("MODEL_NOT_FOUND", `Model ${selectedId} was not found on control-plane or node ${node.id}.`);
      }
      if (local.app !== app) {
        throw Object.assign(new Error(`Model ${selectedId} is not a ${app} model.`), { statusCode: 400, code: "MODEL_APP_MISMATCH" });
      }
      if (!local.enabled) throw Object.assign(new Error(`Model ${selectedId} is disabled.`), { statusCode: 400, code: "MODEL_DISABLED" });
      return local.id;
    };
    return {
      modelSelection: storedSelection,
      codexModelHash: await resolve("codex", storedSelection.codexModelHash),
      claudeModelHash: await resolve("claude", storedSelection.claudeModelHash),
    };
  }

  private async ensureInstanceModelAssignment(instance: ControlledInstance) {
    const node = this.requireNode(instance.nodeId);
    const prepared = await this.prepareInstanceModels(node, instance.modelSelection);
    return this.nodeAgentGateway.assignInstanceModels(node, instance.id, prepared);
  }

  private nextModelOrder() {
    const last = this.models.list().reduce((max, model) => Math.max(max, model.order), 0);
    return last + 100;
  }

  requireProject(id: string) {
    return this.catalogService.requireProject(id);
  }

  requireModel(id: string, includeSecret = false) {
    const record = this.models.get(id);
    if (!record) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
    }
    const model = this.normalizeModelRecord(record);
    return includeSecret ? model : publicModel(model);
  }

  private requireModelSecret(id: string) {
    const record = this.models.get(id);
    if (!record) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
    }
    return this.normalizeModelRecord(record);
  }

  private normalizeModelRecord(record: unknown) {
    const model = normalizeModel(record);
    if (model !== record) {
      this.models.put(model);
    }
    return model;
  }

  requireImage(id: string) {
    return this.catalogService.requireImage(id);
  }

  requireNode(id: string) {
    const record = this.nodes.get(id);
    if (!record) {
      throwNotFound("NODE_NOT_FOUND", `Node ${id} was not found.`);
    }
    return record;
  }

  requirePublicNode(id: string) {
    return publicNode(this.requireNode(id));
  }

  async requireControlledInstance(id: string, includeSecret = false) {
    const record = await this.requireNodeInstance(id);
    return includeSecret ? record : publicInstanceWithAccess(record);
  }
}

type ProxyHttpInit = Omit<RequestInit, "body"> & {
  body?: RequestInit["body"] | Buffer;
};

function assertAiSessionAttachmentsWithinLimit(attachments: AiSessionMessageAttachment[]) {
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes <= AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
    return;
  }
  const error = new Error(`Images must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`);
  Object.assign(error, { statusCode: 400, code: "AI_SESSION_ATTACHMENTS_TOO_LARGE" });
  throw error;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
