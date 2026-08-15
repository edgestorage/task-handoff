import {
  ChatBridgeConfigSchema,
  ChatSessionBindingSchema,
  CONTROL_PLANE_PROTOCOL_VERSION,
  AppManagementJobResponseSchema,
  AppManagementSnapshotSchema,
  ControlledInstanceSchema,
  controlledInstanceAcceptsTraffic,
  CustomImageProfileSchema,
  InstanceDeleteInputSchema,
  LEGACY_MARKET_IMAGE_IDS,
  NodeImageAvailabilitySchema,
  NodeFolderTreeEntrySchema,
  sanitizeStoredImageProfile,
  sanitizeStoredNode,
  sanitizeStoredProject,
  ModelConfigSchema,
  NodeSchema,
  PendingRouteSchema,
  ProjectSchema,
  type ChatGatewayMessage,
  type ChatBridgeConfig,
  type ChatSessionBinding,
  type ControlledInstance,
  type ControlledInstanceHeartbeat,
  type CustomImageProfile,
  type ModelConfig,
  type Node,
  type NodeLocalFolder,
  type NodeRuntime,
  type PendingRoute,
  type Project,
  type UpdateCheckRequest,
  type ApplyUpdateRequest,
  type AppManagementOperationRequest,
} from "@task-handoff/protocol/control-plane";
import { parseResponse } from "@task-handoff/protocol/response-validation";
import {
  ConfigSyncBatchResultSchema,
  ConfigSyncProgramSchema,
  ConfigSyncRequestSchema,
  ConfigSyncStateSchema,
  type ConfigSyncRequest,
} from "@task-handoff/protocol/config-sync";
import {
  AiSessionDeltaResponseSchema,
  AiSessionsStateSchema,
  type AiSessionCommandInput,
  type AiSessionDeltaResponse,
  type AiSessionCreateInput,
  type AiSessionForkInput,
  type AiSessionMessageAttachment,
  type AiSessionPermissionMode,
  type AiSessionReference,
  type AiSessionSendMode,
  type AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import { AppSessionDeltaResponseSchema, AppSessionsStateSchema, emptyAppSessionsSnapshot, type AppSessionDeltaResponse, type AppSessionsSnapshot } from "@task-handoff/protocol/app-sessions";
import type { RepositoryAiSessionGitSelection } from "@task-handoff/protocol/repository";
import { AiSessionActionService } from "../sessions/ai-session-actions.ts";
export { assertAiSessionRuntimePathSupport } from "../sessions/ai-session-actions.ts";
import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { CommandRunner } from "../../shared/process/command-runner.ts";
import { ControlPlaneNodeAgentClient, type NodeAgentTransport, type NodeAgentWebSocket } from "../nodes/client.ts";
import { ControlPlaneNodeAgentGateway } from "../nodes/gateway.ts";
import { createDirectNodeAgentTransport } from "../nodes/direct-transport.ts";
import { NodeAgentTransportResolver } from "../nodes/transport-resolver.ts";
import { ControlPlaneProxyNodeAgentTransport } from "../nodes/control-plane-proxy-transport.ts";
import { ControlPlaneProxyPrivateStore, controlPlaneProxyPrivateStorePaths } from "../nodes/control-plane-proxy-private-store.ts";
import { ControlPlaneProxyLifecycle } from "../nodes/proxy-lifecycle.ts";
import { NodeConnectionManager, PendingPairingRevokeSchema, type PendingPairingRevoke } from "../nodes/connection-manager.ts";
import { NodeJoinService } from "../nodes/join-service.ts";
import { ControlPlaneModelService } from "../models/service.ts";
import { ControlledInstanceGateway } from "../instances/gateway.ts";
import { InstanceBoardReader } from "../instances/board-reader.ts";
import { ControlledInstanceCreator } from "../instances/creator.ts";
import { ControlPlaneTriggerService } from "../triggers/service.ts";
import { ControlPlaneCatalogService } from "../catalog/service.ts";
import { EmbeddedMarketCatalogProvider, MarketCatalogService } from "../catalog/market.ts";
import { AppAccessService, type AppAccessMode } from "../instances/app-access-service.ts";
import { ChatActionTokenService, type ChatActionToken } from "../chat/action-token-service.ts";
import { ChatBridgeService } from "../chat/bridges/service.ts";
import { ChatSessionService } from "../chat/sessions/service.ts";
import { ControlPlaneChatSessionRuntime } from "../chat/sessions/runtime.ts";
import {
  ConfigSyncPreferenceRecordSchema,
  defaultConfigSyncPreferences,
  normalizeConfigSyncWorkspaceFolder,
  sanitizeStoredConfigSyncPreferenceRecord,
  type ConfigSyncPreferenceRecord,
} from "../instances/config-sync.ts";
import { relativeNodePathSegments, resolveNodePath } from "../nodes/path.ts";
import { publicInstance, publicInstanceWithAccess, publicNode, publicNodeAgentCapabilities, publicProject, workspacePolicyForSource } from "../public-records.ts";
import { controlPlaneDiagnosticLogsEnabled, errorMessage, now, throwNotFound } from "./helpers.ts";
import {
  CreateNodeControlPlaneConnectionInputSchema,
  ControlPlaneTriggerRecordSchema,
  ControlPlaneSettingsSchema,
  sanitizeStoredControlPlaneSettings,
  UpdateInstanceInputSchema,
  UpdateNodeInputSchema,
  type ControlPlaneSettings,
  type ControlPlaneTriggerRecord,
  type UpdateInstanceInput,
  type UpdateNodeInput,
} from "./inputs.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import { ControlPlanePersistenceMaintenance } from "../persistence/maintenance.ts";
import { JsonCollection, JsonFile } from "../../shared/persistence/store.ts";
import type { ControlPlaneProxyError, ProxyTargetEvent, ProxyTargetSnapshot } from "@task-handoff/protocol/control-plane-proxy";
import type { NodeConnectionRuntime } from "../nodes/connection-runtime.ts";

export function parseInstanceAppManagementSnapshot(value: unknown) {
  try {
    return parseResponse(AppManagementSnapshotSchema, value);
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
const CONTROL_PLANE_LOCAL_NODE_LABEL = "task-handoff.control-plane.local";
const CONTROL_PLANE_BUILTIN_NODE_LABEL = "task-handoff.control-plane.builtin";

export type ControlPlaneServiceOptions = {
  fetchImpl?: FetchImpl;
  dockerCommandRunner?: CommandRunner;
  nodeAgentTransport?: NodeAgentTransport;
  logger?: ServiceLogger;
  nodeConnectionRuntime?: NodeConnectionRuntime;
};

function isControlPlaneLocalNode(node: Node) {
  return node.labels[CONTROL_PLANE_LOCAL_NODE_LABEL] === "true";
}

function isControlPlaneBuiltinNode(node: Node) {
  return node.labels[CONTROL_PLANE_BUILTIN_NODE_LABEL] === "true";
}

export class ControlPlaneService {
  private readonly projects: JsonCollection<Project>;
  readonly models: JsonCollection<ModelConfig>;
  private readonly modelService: ControlPlaneModelService;
  private readonly images: JsonCollection<CustomImageProfile>;
  readonly nodes: JsonCollection<Node>;
  private readonly pendingPairingRevokes: JsonCollection<PendingPairingRevoke>;
  readonly chatSessions: JsonCollection<ChatSessionBinding>;
  readonly chatBridges: JsonCollection<ChatBridgeConfig>;
  readonly triggers: JsonCollection<ControlPlaneTriggerRecord>;
  private readonly nodeJoinService: NodeJoinService;
  private readonly configSyncPreferences: JsonCollection<ConfigSyncPreferenceRecord>;
  private readonly settings: JsonFile<ControlPlaneSettings>;
  readonly paths: ControlPlaneStorePaths;
  private readonly fetchImpl: FetchImpl;
  private readonly dockerCommandRunner: CommandRunner | undefined;
  private readonly logger: ServiceLogger | undefined;
  private diagnosticLogsState: boolean;
  private readonly nodeConnectionRuntime: NodeConnectionRuntime | undefined;
  private readonly appAccessService: AppAccessService;
  private readonly persistenceMaintenance: ControlPlanePersistenceMaintenance;
  private readonly chatActionTokenService = new ChatActionTokenService();
  private readonly nodeAgentTransportResolver: NodeAgentTransportResolver;
  readonly proxyPrivateStore: ControlPlaneProxyPrivateStore;
  private readonly proxyLifecycle: ControlPlaneProxyLifecycle;
  private readonly nodeConnectionManager: NodeConnectionManager;
  private readonly nodeAgentGateway: ControlPlaneNodeAgentGateway;
  private readonly controlledInstanceGateway: ControlledInstanceGateway;
  private readonly aiSessionActionService: AiSessionActionService;
  private readonly controlledInstanceCreator: ControlledInstanceCreator;
  private readonly instanceBoardReader = new InstanceBoardReader();
  private readonly controlPlaneTriggerService: ControlPlaneTriggerService;
  private readonly catalogService: ControlPlaneCatalogService;
  private readonly marketCatalogService: MarketCatalogService;
  private readonly chatBridgeService: ChatBridgeService;
  private readonly chatSessionService: ChatSessionService;
  private readonly chatSessionRuntime: ControlPlaneChatSessionRuntime;
  private aiSessionSnapshotProvider: ((options?: { refresh?: boolean }) => Promise<{ updatedAt: string; instances: Array<{ instanceId: string; streamId: string; aiSessions: AiSessionsSnapshot; revision: number; lastEventAt: string }> }>) | undefined;
  private appSessionSnapshotProvider: ((options?: { refresh?: boolean }) => Promise<{ updatedAt: string; instances: Array<{ instanceId: string; streamId: string; appSessions: AppSessionsSnapshot; revision: number; lastEventAt: string }> }>) | undefined;

  constructor(paths: ControlPlaneStorePaths, options: ControlPlaneServiceOptions = {}) {
    this.paths = paths;
    this.fetchImpl = options.fetchImpl || fetch;
    this.dockerCommandRunner = options.dockerCommandRunner;
    this.nodeConnectionRuntime = options.nodeConnectionRuntime;
    this.persistenceMaintenance = new ControlPlanePersistenceMaintenance(paths, {
      logger: (message, details) => this.logWarn(details, message),
    });
    const storeOptions = <T,>(schema: z.ZodType<T>) => ({
      schema,
      logger: (message: string, details: Record<string, unknown>) => this.logWarn(details, message),
    });
    this.proxyPrivateStore = new ControlPlaneProxyPrivateStore(
      controlPlaneProxyPrivateStorePaths(paths.dataDir),
      (message, details) => this.logWarn(details, message),
    );
    this.nodeAgentTransportResolver = new NodeAgentTransportResolver({
      direct: createDirectNodeAgentTransport(this.fetchImpl),
      tunnel: options.nodeAgentTransport,
      proxy: new ControlPlaneProxyNodeAgentTransport({
        credentialForNode: (node) => this.proxyPrivateStore.nodeCredential(node.id),
        fetchImpl: this.fetchImpl,
      }),
    });
    const diagnosticLogsDefault = controlPlaneDiagnosticLogsEnabled();
    this.diagnosticLogsState = diagnosticLogsDefault;
    this.settings = new JsonFile(paths.settingsPath, () => ControlPlaneSettingsSchema.parse({ diagnosticLogs: diagnosticLogsDefault }), {
      ...storeOptions(ControlPlaneSettingsSchema),
      sanitize: (value) => sanitizeStoredControlPlaneSettings(value, { diagnosticLogs: diagnosticLogsDefault }),
    });
    this.logger = options.logger ? {
      info: (data, message) => { if (this.diagnosticLogsEnabled()) options.logger?.info?.(data, message); },
      warn: (data, message) => { if (this.diagnosticLogsEnabled()) options.logger?.warn?.(data, message); },
      error: (data, message) => { if (this.diagnosticLogsEnabled()) options.logger?.error?.(data, message); },
    } : undefined;
    const nodeAgentClient = new ControlPlaneNodeAgentClient({
      request: (node, route, init) => this.nodeAgentFetch(node, route, init),
      logger: this.logger,
    });
    this.nodeAgentGateway = new ControlPlaneNodeAgentGateway(nodeAgentClient);
    this.controlledInstanceGateway = new ControlledInstanceGateway({
      requireNode: (nodeId) => this.requireNode(nodeId),
      nodeAgentTransport: (node) => this.nodeAgentTransportResolver.resolve(node),
    });
    this.aiSessionActionService = new AiSessionActionService({
      requireInstance: (instanceId) => this.requireControlledInstance(instanceId, true) as Promise<ControlledInstance>,
      request: (instance, route, init) => this.instanceRequest(instance, route, init),
      requireRuntime: (nodeId, runtimeId) => this.requireNodeRuntimeOnNode(nodeId, runtimeId),
      refreshSnapshots: () => Promise.all([
        this.listAppSessions({ refresh: true }),
        this.listAiSessions({ refresh: true }),
      ]),
      warn: (data, message) => this.logWarn(data, message),
    });
    this.projects = new JsonCollection(paths.projectsDir, { ...storeOptions(ProjectSchema), sanitize: sanitizeStoredProject });
    this.models = new JsonCollection(paths.modelsDir, storeOptions(ModelConfigSchema));
    this.modelService = new ControlPlaneModelService({
      models: this.models,
      gateway: this.nodeAgentGateway,
      listNodes: () => this.listNodes(),
      requireNode: (id) => this.requireNode(id),
      fetchImpl: this.fetchImpl,
    });
    this.images = new JsonCollection(paths.imagesDir, {
      ...storeOptions(CustomImageProfileSchema),
      sanitize: (value) => sanitizeStoredImageProfile(value, (warning) => this.logWarn(warning, "legacy image profile field was migrated")),
    });
    this.nodes = new JsonCollection(paths.nodesDir, {
      ...storeOptions(NodeSchema),
      sanitize: (value) => sanitizeStoredNode(value, (warning) => this.logWarn(warning, "unknown stored node field was ignored")),
    });
    this.pendingPairingRevokes = new JsonCollection(paths.pendingPairingRevokesDir, storeOptions(PendingPairingRevokeSchema));
    this.proxyLifecycle = new ControlPlaneProxyLifecycle({
      nodes: this.nodes,
      privateStore: this.proxyPrivateStore,
      fetchImpl: this.fetchImpl,
      requireNode: (id) => this.requireNode(id),
      deleteNode: (id) => this.deleteNode(id),
    });
    this.nodeConnectionManager = new NodeConnectionManager({
      nodes: this.nodes,
      pendingPairingRevokes: this.pendingPairingRevokes,
      fetchImpl: this.fetchImpl,
      localNodeLabel: CONTROL_PLANE_LOCAL_NODE_LABEL,
      builtinNodeLabel: CONTROL_PLANE_BUILTIN_NODE_LABEL,
      info: (data, message) => this.logInfo(data, message),
      warn: (data, message) => this.logWarn(data, message),
    });
    this.chatSessions = new JsonCollection(paths.chatSessionsDir, storeOptions(ChatSessionBindingSchema));
    this.chatBridges = new JsonCollection(paths.chatBridgesDir, storeOptions(ChatBridgeConfigSchema));
    this.triggers = new JsonCollection(paths.triggersDir, storeOptions(ControlPlaneTriggerRecordSchema));
    this.nodeJoinService = new NodeJoinService({
      nodes: this.nodes,
    });
    this.configSyncPreferences = new JsonCollection(path.join(paths.dataDir, "config-sync-preferences"), {
      ...storeOptions(ConfigSyncPreferenceRecordSchema),
      sanitize: sanitizeStoredConfigSyncPreferenceRecord,
    });
    this.marketCatalogService = new MarketCatalogService();
    this.catalogService = new ControlPlaneCatalogService({
      projects: this.projects,
      images: this.images,
      market: this.marketCatalogService,
      settings: this.settings,
      defaultNodeId: () => this.defaultNodeId(),
    });
    this.controlledInstanceCreator = new ControlledInstanceCreator({
      gateway: this.nodeAgentGateway,
      defaultNodeId: () => this.defaultNodeId(),
      requireProject: (id) => this.requireProject(id),
      requireNode: (id) => this.requireNode(id),
      requireRuntime: (nodeId, runtimeId) => this.requireNodeRuntimeOnNode(nodeId, runtimeId),
      requireLocalFolder: (node, folderId) => this.requireNodeLocalFolder(node, folderId),
      resolveImageSelection: (selection) => this.catalogService.resolveImageSelection(selection),
      prepareModels: (node, selection) => this.modelService.prepareAssignment(node, selection),
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
    this.nodeAgentTransportResolver.setTunnel(transport);
  }

  resolveNodeAgentTransport(node: Node) {
    return this.nodeAgentTransportResolver.resolve(node);
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
    this.runPersistenceMaintenance();
    this.projects.init();
    this.models.init();
    this.images.init();
    this.nodes.init();
    this.pendingPairingRevokes.init();
    this.chatSessions.init();
    this.chatBridges.init();
    this.triggers.init();
    this.proxyPrivateStore.init();
    this.proxyPrivateStore.gcNodeCredentials((credential) => {
      const node = this.nodes.get(credential.nodeId);
      return node?.connectionMode === "control-plane-proxy"
        && node.connectionPath.kind === "control-plane-proxy"
        && node.connectionPath.proxyBindingId === credential.proxyBindingId
        && node.connectionPath.targetNodeId === credential.targetNodeId;
    });
    this.settings.init();
    const normalizedSettings = this.settings.put(this.settings.get());
    this.diagnosticLogsState = normalizedSettings.diagnosticLogs;
    this.migrateLegacyImageCatalog();
    this.seedDefaults();
  }

  runPersistenceMaintenance() {
    try {
      return this.persistenceMaintenance.run();
    } catch (error) {
      this.logWarn({ error: error instanceof Error ? error.message : String(error) }, "control-plane persistence maintenance failed");
      return [];
    }
  }

  private migrateLegacyImageCatalog() {
    const legacyIds = Object.keys(LEGACY_MARKET_IMAGE_IDS);
    const legacyFiles = [] as Array<{ id: string; filePath: string; record: unknown }>;
    for (const legacyId of legacyIds) {
      const filePath = this.images.filePath(legacyId);
      if (!fs.existsSync(filePath)) continue;
      try {
        legacyFiles.push({ id: legacyId, filePath, record: JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown });
      } catch (error) {
        this.writeMarketMigrationState("failed", { code: "LEGACY_IMAGE_BACKUP_READ_FAILED", legacyId, error: errorMessage(error) });
        this.logWarn({ legacyId, error: errorMessage(error) }, "legacy embedded image migration was not applied");
        return;
      }
    }
    if (!legacyFiles.length) return;

    const projectFiles = fs.readdirSync(this.paths.projectsDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(this.paths.projectsDir, name));
    const projects = [] as Array<{ filePath: string; raw: unknown; migrated: Project }>;
    for (const filePath of projectFiles) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        const migrated = ProjectSchema.parse(sanitizeStoredProject(raw));
        projects.push({ filePath, raw, migrated });
      } catch (error) {
        this.writeMarketMigrationState("failed", { code: "PROJECT_REFERENCE_VALIDATION_FAILED", filePath, error: errorMessage(error) });
        this.logWarn({ filePath, error: errorMessage(error) }, "legacy embedded image migration was not applied");
        return;
      }
    }

    const unresolved = projects.find(({ migrated }) => {
      const selectedId = migrated.defaultImageSelection?.imageId;
      return selectedId ? legacyIds.includes(selectedId) : false;
    });
    if (unresolved) {
      this.writeMarketMigrationState("failed", { code: "PROJECT_REFERENCE_MIGRATION_INCOMPLETE", filePath: unresolved.filePath });
      return;
    }

    fs.mkdirSync(this.paths.marketDir, { recursive: true });
    writeFileAtomic.sync(this.paths.marketMigrationBackupPath, `${JSON.stringify({
      version: CONTROL_PLANE_PROTOCOL_VERSION,
      createdAt: now(),
      images: legacyFiles.map(({ id, record }) => ({ id, record })),
      projects: projects.map(({ filePath, raw }) => ({ file: path.basename(filePath), record: raw })),
    }, null, 2)}\n`, { encoding: "utf8" });

    for (const { migrated } of projects) this.projects.put(migrated);
    for (const { id } of legacyFiles) {
      this.images.delete(id);
      this.logWarn({ legacyId: id, marketId: LEGACY_MARKET_IMAGE_IDS[id] }, "embedded image profile migrated to Market");
    }
    this.writeMarketMigrationState("complete", {
      code: "LEGACY_IMAGE_MIGRATION_COMPLETE",
      migratedImageIds: legacyFiles.map(({ id }) => id),
      backupPath: this.paths.marketMigrationBackupPath,
    });
  }

  private writeMarketMigrationState(status: "complete" | "failed", details: Record<string, unknown>) {
    fs.mkdirSync(this.paths.marketDir, { recursive: true });
    writeFileAtomic.sync(this.paths.marketStatePath, `${JSON.stringify({ status, updatedAt: now(), ...details }, null, 2)}\n`, { encoding: "utf8" });
  }

  getSettings() {
    return this.catalogService.getSettings();
  }

  diagnosticLogsEnabled() {
    return this.diagnosticLogsState;
  }

  updateSettings(input: unknown) {
    const settings = this.catalogService.updateSettings(input);
    this.diagnosticLogsState = settings.diagnosticLogs;
    return settings;
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

  async syncLocalNodeConnection() {
    const node = await this.nodeConnectionManager.syncLocal();
    this.nodeConnectionRuntime?.observedReachable(node);
    return this.projectNodeConnection(node);
  }

  recoverPendingPairingRevokes() {
    return this.nodeConnectionManager.recoverPendingPairingRevokes();
  }

  listModels() {
    return this.modelService.list();
  }

  listFederatedModels(signal?: AbortSignal) {
    return this.modelService.listFederated(signal);
  }

  createModel(input: unknown) {
    return this.modelService.create(input);
  }

  updateModel(id: string, input: unknown) {
    return this.modelService.update(id, input);
  }

  deleteModel(id: string) {
    return this.modelService.delete(id);
  }

  reorderModels(ids: string[]) {
    return this.modelService.reorder(ids);
  }

  createNodeModel(nodeId: string, input: unknown) {
    return this.modelService.createOnNode(nodeId, input);
  }

  updateNodeModel(nodeId: string, modelId: string, input: unknown) {
    return this.modelService.updateOnNode(nodeId, modelId, input);
  }

  deleteNodeModel(nodeId: string, modelId: string) {
    return this.modelService.deleteOnNode(nodeId, modelId);
  }

  discoverModels(input: unknown) {
    return this.modelService.discover(input);
  }

  testModel(input: unknown) {
    return this.modelService.test(input);
  }

  discoverNodeModels(nodeId: string, input: unknown) {
    return this.modelService.discoverOnNode(nodeId, input);
  }

  testNodeModel(nodeId: string, input: unknown) {
    return this.modelService.testOnNode(nodeId, input);
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

  getMarketCatalog() {
    return this.catalogService.getMarketCatalog();
  }

  async refreshMarketCatalog() {
    await this.marketCatalogService.refresh(new EmbeddedMarketCatalogProvider());
    return this.getMarketCatalog();
  }

  listImageOptions() {
    return this.catalogService.listImageOptions();
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
    const agent = node.capabilities.agent && typeof node.capabilities.agent === "object"
      ? node.capabilities.agent as Record<string, unknown>
      : {};
    const platform = {
      os: typeof agent.platform === "string" ? agent.platform : undefined,
      architecture: typeof agent.arch === "string" ? (agent.arch === "x64" ? "amd64" : agent.arch) : undefined,
    };
    const images = this.catalogService.listImageOptions(platform);
    try {
      const localImages = await this.nodeAgentGateway.listDockerImages(node);
      return images.map((image) => {
        const localImage = localImages.find((local) => local.reference === image.reference
          || (image.digest ? local.repoDigests.some((digest) => digest.endsWith(`@${image.digest}`)) : false)
          || local.repoDigests.includes(image.reference));
        return NodeImageAvailabilitySchema.parse({
          image,
          status: localImage ? "available" : "pull-required",
          localImage,
          localSizeBytes: localImage?.sizeBytes,
          downloadSizeBytes: localImage ? undefined : image.downloadSizeBytes,
          unpackedSizeBytes: localImage ? undefined : image.unpackedSizeBytes,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return images.map((image) => NodeImageAvailabilitySchema.parse({ image, status: "unknown", error: message }));
    }
  }

  async listNodeLocalFolders(nodeId: string, signal?: AbortSignal) {
    const node = this.requireNode(nodeId);
    return this.nodeAgentGateway.listLocalFolders(node, { signal });
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
      this.nodeConnectionRuntime?.observedReachable(updated);
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
      this.nodeConnectionRuntime?.observedFailure(updated, errorMessage(error));
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

  async applyNodeUpdate(id: string, input: ApplyUpdateRequest) {
    return this.nodeAgentGateway.applyUpdate(this.requireNode(id), input);
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

  createNodeJoinInvite(input: unknown = {}) {
    return this.nodeJoinService.createInvite(input);
  }

  completeNodeJoin(input: unknown) {
    return this.nodeJoinService.complete(input);
  }

  async connectNodeToControlPlane(id: string, input: unknown) {
    const node = this.requireNode(id);
    const parsedInput = CreateNodeControlPlaneConnectionInputSchema.parse(input);
    return this.nodeAgentGateway.createControlPlaneConnection(node, parsedInput);
  }

  async listNodeControlPlanePairings(id: string) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.listControlPlanePairings(node);
  }

  async deleteNodeControlPlanePairing(id: string, keyId: string) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.deleteControlPlanePairing(node, keyId);
  }

  async listNodeControlPlaneConnections(id: string) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.listControlPlaneConnections(node);
  }

  async deleteNodeControlPlaneConnection(id: string, connectionId: string) {
    const node = this.requireNode(id);
    return this.nodeAgentGateway.deleteControlPlaneConnection(node, connectionId);
  }

  updateImage(id: string, input: unknown) {
    return this.catalogService.updateImage(id, input);
  }

  async deleteImage(id: string) {
    this.catalogService.requireImage(id);
    const project = this.listProjects().find((item) => item.defaultImageSelection?.imageId === id);
    if (project) throw Object.assign(new Error(`Image ${id} is the default for project ${project.name}.`), { statusCode: 409, code: "IMAGE_IN_USE" });
    const folders = (await Promise.all(this.listNodes().map((node) => this.nodeAgentGateway.listLocalFolders(node)))).flat();
    const folder = folders.find((item) => item.defaultImageSelection?.imageId === id);
    if (folder) throw Object.assign(new Error(`Image ${id} is the default for local folder ${folder.name}.`), { statusCode: 409, code: "IMAGE_IN_USE" });
    const instances = await this.listNodeInstances();
    const instance = instances.find((item) => item.imageSelection?.imageId === id);
    if (instance) throw Object.assign(new Error(`Image ${id} is used by instance ${instance.name}.`), { statusCode: 409, code: "IMAGE_IN_USE" });
    return this.catalogService.deleteImage(id);
  }

  listNodes() {
    return this.nodes.list();
  }

  listPublicNodes() {
    return this.listNodes().map((node) => publicNode(this.projectNodeConnection(node)));
  }

  projectNodeConnection(node: Node) {
    return this.nodeConnectionRuntime?.project(node) || node;
  }

  createNode(input: unknown) {
    return this.nodeConnectionManager.create(input);
  }

  listPendingProxyClaims() {
    return this.proxyLifecycle.listPendingClaims();
  }

  claimProxyNode(input: unknown) {
    return this.proxyLifecycle.claimNode(input);
  }

  resumeProxyClaim(claimId: string) {
    return this.proxyLifecycle.resumeClaim(claimId);
  }

  cancelProxyClaim(claimId: string) {
    return this.proxyLifecycle.cancelClaim(claimId);
  }

  applyProxyTargetSnapshot(nodeId: string, snapshot: ProxyTargetSnapshot) {
    return this.proxyLifecycle.applyTargetSnapshot(nodeId, snapshot);
  }

  applyProxyTargetEvent(nodeId: string, event: ProxyTargetEvent) {
    return this.proxyLifecycle.applyTargetEvent(nodeId, event);
  }

  markProxyUnavailable(nodeId: string, error: ControlPlaneProxyError) {
    return this.proxyLifecycle.markUnavailable(nodeId, error);
  }

  markProxyBindingRevoked(nodeId: string, error: ControlPlaneProxyError) {
    return this.proxyLifecycle.markBindingRevoked(nodeId, error);
  }

  updateNode(id: string, input: unknown) {
    const parsedInput: UpdateNodeInput = UpdateNodeInputSchema.parse(input);
    const current = this.requireNode(id);
    this.proxyLifecycle.assertIdentityPatch(current, parsedInput);
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

  async deleteNodeWithProxyLifecycle(id: string, force = false) {
    return this.proxyLifecycle.deleteNode(this.requireNode(id), force);
  }

  async listNodeRuntimes(nodeId?: string, signal?: AbortSignal) {
    const nodes = nodeId ? [this.requireNode(nodeId)] : this.listNodes();
    if (nodeId) {
      return this.nodeAgentGateway.listRuntimes(nodes[0], { signal });
    }
    const result = await this.nodeAgentGateway.listFleetRuntimes(nodes, { signal });
    return result.items;
  }

  async listNodeRuntimesWithDiagnostics(signal?: AbortSignal) {
    return this.nodeAgentGateway.listFleetRuntimes(this.listNodes().map((node) => this.projectNodeConnection(node)), { signal });
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

  createControlledInstance(input: unknown) {
    return this.controlledInstanceCreator.create(input);
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
      const preparedModels = await this.modelService.prepareAssignment(node, modelSelection);
      instance = (await this.nodeAgentGateway.assignInstanceModels(node, id, preparedModels)).instance;
    }
    return publicInstanceWithAccess(instance);
  }

  async deleteControlledInstance(id: string, input: unknown) {
    const parsedInput = InstanceDeleteInputSchema.parse(input);
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    const result = await this.nodeAgentGateway.deleteInstance(node, id, parsedInput);
    if (result.completed) this.configSyncPreferences.delete(id);
    return result;
  }

  listEnvironmentTemplates(nodeId: string) {
    return this.nodeAgentGateway.listEnvironmentTemplates(this.requireNode(nodeId));
  }

  getEnvironmentTemplate(nodeId: string, templateId: string) {
    return this.nodeAgentGateway.getEnvironmentTemplate(this.requireNode(nodeId), templateId);
  }

  async createEnvironmentTemplate(instanceId: string, input: unknown) {
    const instance = await this.requireNodeInstance(instanceId);
    return this.nodeAgentGateway.createEnvironmentTemplate(this.requireNode(instance.nodeId), instanceId, input);
  }

  deleteEnvironmentTemplate(nodeId: string, templateId: string) {
    return this.nodeAgentGateway.deleteEnvironmentTemplate(this.requireNode(nodeId), templateId);
  }

  async startControlledInstance(id: string) {
    const current = await this.requireNodeInstance(id);
    const node = this.requireNode(current.nodeId);
    await this.modelService.ensureInstanceAssignment(current);
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
    await this.modelService.ensureInstanceAssignment(current);
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

  async boardWithDiagnostics(signal?: AbortSignal) {
    const [runtimeResult, instanceResult] = await Promise.all([
      this.listNodeRuntimesWithDiagnostics(signal),
      this.listNodeInstancesWithDiagnostics(signal),
    ]);
    return this.instanceBoardReader.read({
      projects: this.listProjects(),
      images: this.listImageOptions(),
      nodes: this.nodes.list().map((node) => this.projectNodeConnection(node)),
      runtimes: runtimeResult.items,
      instances: instanceResult.items,
      nodeErrors: [...runtimeResult.nodeErrors, ...instanceResult.nodeErrors],
    });
  }

  async bootstrapAiSessionsFromInstances() {
    const instances = await this.listNodeInstances();
    const states = await Promise.all(
      instances.map(async (instance) => {
        if (!controlledInstanceAcceptsTraffic(instance) || !instance.target.web || (instance.connectionStatus !== "online" && instance.agentStatus !== "online")) {
          return { streamId: `bootstrap:${instance.id}:ai.sessions`, revision: 0, lastEventAt: instance.aiSessions.updatedAt, snapshot: instance.aiSessions };
        }
        try {
          return parseResponse(AiSessionsStateSchema, await this.instanceRequest(instance, "/ai-sessions/state"));
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
        if (!controlledInstanceAcceptsTraffic(instance) || !instance.target.web || (instance.connectionStatus !== "online" && instance.agentStatus !== "online")) {
          const snapshot = emptyAppSessionsSnapshot();
          return { streamId: `bootstrap:${instance.id}:app.sessions`, revision: 0, lastEventAt: snapshot.updatedAt, snapshot };
        }
        try {
          return parseResponse(AppSessionsStateSchema, await this.instanceRequest(instance, "/apps/sessions/state"));
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
    return parseResponse(AiSessionDeltaResponseSchema, await this.instanceRequest(instance, `/ai-sessions?${query}`));
  }

  async recoverAiSessionSnapshot(instanceId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return parseResponse(AiSessionsStateSchema, await this.instanceRequest(instance, "/ai-sessions/state"));
  }

  async recoverAppSessionDelta(instanceId: string, streamId: string, sinceRevision: number): Promise<AppSessionDeltaResponse> {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const query = new URLSearchParams({ streamId, sinceRevision: String(sinceRevision) });
    return parseResponse(AppSessionDeltaResponseSchema, await this.instanceRequest(instance, `/apps/sessions?${query}`));
  }

  async recoverAppSessionSnapshot(instanceId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return parseResponse(AppSessionsStateSchema, await this.instanceRequest(instance, "/apps/sessions/state"));
  }

  async listTriggers() {
    return this.controlPlaneTriggerService.listTriggers();
  }

  createTrigger(input: unknown) {
    return this.controlPlaneTriggerService.createTrigger(input);
  }

  async updateTrigger(configHash: string, input: unknown) {
    return this.controlPlaneTriggerService.updateTrigger(configHash, input);
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

  createAppSessionAccessToken(input: { instanceId: string; sessionId: string; ttlMs?: number }) {
    return this.appAccessService.createSessionToken(input);
  }

  revokeAppSessionAccessToken(token: string, expected: { instanceId: string; sessionId: string }) {
    this.appAccessService.revokeToken(token, expected);
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

  resolveAiSessionApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") {
    return this.aiSessionActionService.resolveApproval(instanceId, sessionId, decision);
  }

  listAiSessionHistory(instanceId: string) {
    return this.aiSessionActionService.listHistory(instanceId);
  }

  getAiSessionHistoryDetail(instanceId: string, aiSessionId: string) {
    return this.aiSessionActionService.historyDetail(instanceId, aiSessionId);
  }

  getAiSessionTimeline(instanceId: string, aiSessionId: string) {
    return this.aiSessionActionService.timeline(instanceId, aiSessionId);
  }

  resumeAiSession(instanceId: string, aiSessionId: string) {
    return this.aiSessionActionService.resume(instanceId, aiSessionId);
  }

  async createAiSession(instanceId: string, input: Omit<AiSessionCreateInput, "cwd"> & {
    cwdFolderId?: string;
    gitSelection?: RepositoryAiSessionGitSelection;
  }) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const { cwdFolderId: _cwdFolderId, ...resolvedInput } = input;
    const cwdPath = input.cwdFolderId
      ? await this.runtimeCwdForFolderId(instance, input.cwdFolderId)
      : instance.runtime.workspacePath || instance.workspace.path || workspacePolicyForSource(instance.source).path || "/workspace";
    const cwd = { type: "runtime-path" as const, path: cwdPath };
    return this.aiSessionActionService.create(instanceId, {
      ...resolvedInput,
      cwd,
      ...(input.cwdFolderId ? { cwdFolderId: input.cwdFolderId } : {}),
    });
  }

  async inspectAiSessionWorkspace(instanceId: string, cwdFolderId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const cwd = { type: "runtime-path" as const, path: await this.runtimeCwdForFolderId(instance, cwdFolderId) };
    return this.aiSessionActionService.inspectWorkspace(instanceId, cwd);
  }

  forkAiSession(instanceId: string, aiSessionId: string, input: AiSessionForkInput) {
    return this.aiSessionActionService.fork(instanceId, aiSessionId, input);
  }

  openAiSessionApp(instanceId: string, aiSessionId: string, clientRequestId: string) {
    return this.aiSessionActionService.openApp(instanceId, aiSessionId, clientRequestId);
  }

  closeAiSession(instanceId: string, aiSessionId: string, clientRequestId: string) {
    return this.aiSessionActionService.close(instanceId, aiSessionId, clientRequestId);
  }

  aiSessionActionDiagnostics() {
    return this.aiSessionActionService.diagnostics();
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
    return parseResponse(AppManagementJobResponseSchema, await this.instanceRequest(instance, `/apps/${encodeURIComponent(appId)}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  }

  async instanceAppManagementJob(instanceId: string, jobId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return parseResponse(AppManagementJobResponseSchema, await this.instanceRequest(instance, `/apps/jobs/${encodeURIComponent(jobId)}`));
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

  sendAiSessionMessage(
    instanceId: string,
    sessionId: string,
    message: string,
    mode?: AiSessionSendMode,
    attachments: AiSessionMessageAttachment[] = [],
    references: AiSessionReference[] = [],
    permissionMode?: AiSessionPermissionMode,
  ) {
    return this.aiSessionActionService.sendMessage(
      instanceId,
      sessionId,
      message,
      mode,
      attachments,
      references,
      permissionMode,
    );
  }

  aiSessionMentionCatalog(instanceId: string, sessionId: string) {
    return this.aiSessionActionService.mentionCatalog(instanceId, sessionId);
  }

  searchAiSessionMentionFiles(instanceId: string, sessionId: string, query: string) {
    return this.aiSessionActionService.searchMentionFiles(instanceId, sessionId, query);
  }

  executeAiSessionCommand(instanceId: string, sessionId: string, input: AiSessionCommandInput) {
    return this.aiSessionActionService.executeCommand(instanceId, sessionId, input);
  }

  aiSessionQueue(instanceId: string, sessionId: string) {
    return this.aiSessionActionService.queue(instanceId, sessionId);
  }

  steerAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    return this.aiSessionActionService.steerQueuedMessage(instanceId, sessionId, queueId);
  }

  retryAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    return this.aiSessionActionService.retryQueuedMessage(instanceId, sessionId, queueId);
  }

  removeAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
    return this.aiSessionActionService.removeQueuedMessage(instanceId, sessionId, queueId);
  }

  editAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string, input: { expectedRevision: number; message: string }) {
    return this.aiSessionActionService.editQueuedMessage(instanceId, sessionId, queueId, input);
  }

  reorderAiSessionQueuedMessages(instanceId: string, sessionId: string, input: { expectedRevision: number; queueIds: string[] }) {
    return this.aiSessionActionService.reorderQueuedMessages(instanceId, sessionId, input);
  }

  interruptAiSession(instanceId: string, sessionId: string) {
    return this.aiSessionActionService.interrupt(instanceId, sessionId);
  }

  async proxyInstanceHttp(instanceId: string, path: string, init: ProxyHttpInit = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    return this.controlledInstanceGateway.proxyHttp(instance, path, init);
  }

  async proxyInstanceWebSocket(instanceId: string, socket: NodeAgentWebSocket, path: string, protocols?: string | string[], headers: Record<string, string> = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    this.controlledInstanceGateway.proxyWebSocket(instance, socket, path, protocols, headers);
  }

  async instanceConfigSyncState(instanceId: string) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const programs = z.array(ConfigSyncProgramSchema).parse(await this.instanceRequest(instance, "/config-sync/programs"));
    return ConfigSyncStateSchema.parse({
      programs,
      preferences: this.configSyncPreferences.get(instanceId)?.preferences || defaultConfigSyncPreferences(),
    });
  }

  async listInstanceConfigSyncFolders(instanceId: string, input: { path?: string; depth?: number } = {}) {
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    const params = new URLSearchParams();
    if (input.path) params.set("path", input.path);
    if (input.depth !== undefined) params.set("depth", String(input.depth));
    return z.array(NodeFolderTreeEntrySchema).parse(
      await this.instanceRequest(instance, `/config-sync/folders${params.size ? `?${params}` : ""}`),
    );
  }

  async syncInstanceConfigs(instanceId: string, input: unknown) {
    const request: ConfigSyncRequest = ConfigSyncRequestSchema.parse(input);
    const instance = await this.requireControlledInstance(instanceId, true) as ControlledInstance;
    if (request.direction === "export" && instance.source.type !== "local-folder") {
      const error = new Error("Exporting instance config is only available for local folder projects.");
      Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_EXPORT_REQUIRES_LOCAL_PROJECT" });
      throw error;
    }
    const workspaceFolder = normalizeConfigSyncWorkspaceFolder(request.workspaceFolder);
    const normalizedRequest = { ...request, workspaceFolder };
    const result = parseResponse(ConfigSyncBatchResultSchema, await this.instanceRequest(instance, "/config-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(normalizedRequest),
    }));
    const timestamp = now();
    const current = this.configSyncPreferences.get(instanceId);
    this.configSyncPreferences.put({
      id: instanceId,
      preferences: {
        ...(current?.preferences || defaultConfigSyncPreferences()),
        [request.direction]: workspaceFolder,
      },
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return result;
  }

  private async instanceRequest(instance: ControlledInstance, route: string, init: RequestInit = {}) {
    return this.controlledInstanceGateway.request(instance, route, init);
  }

  private async reportInstanceHeartbeat(instance: ControlledInstance, input: ControlledInstanceHeartbeat) {
    await this.controlledInstanceGateway.reportHeartbeat(instance, input);
  }

  private async nodeAgentFetch(node: Node, route: string, init: RequestInit = {}) {
    const observesDirectControl = node.connectionMode !== "reverse-wss"
      && node.connectionMode !== "control-plane-proxy";
    try {
      const response = await this.nodeAgentTransportResolver.resolve(node).request(node, route, init);
      if (observesDirectControl) this.nodeConnectionRuntime?.observedReachable(node);
      return response;
    } catch (error) {
      if (observesDirectControl && !init.signal?.aborted && !isAbortError(error)) {
        this.nodeConnectionRuntime?.observedFailure(node, errorMessage(error));
      }
      throw error;
    }
  }

  private async listNodeInstances() {
    const result = await this.listNodeInstancesWithDiagnostics();
    return result.items;
  }

  private async listNodeInstancesWithDiagnostics(signal?: AbortSignal) {
    return this.nodeAgentGateway.listFleetInstances(this.listNodes().map((node) => this.projectNodeConnection(node)), { signal });
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
    return {
      ...launchOptions,
      cwd: await this.runtimeCwdForFolderId(instance, cwdFolderId),
    };
  }

  private async runtimeCwdForFolderId(instance: ControlledInstance, cwdFolderId: string) {
    const node = this.requireNode(instance.nodeId);
    const folder = await this.requireNodeLocalFolder(node, cwdFolderId);
    if (folder.nodeId !== instance.nodeId) {
      const error = new Error(`Local folder ${folder.id} belongs to node ${folder.nodeId}, not ${instance.nodeId}.`);
      Object.assign(error, { statusCode: 400, code: "LOCAL_FOLDER_REQUIRES_INSTANCE_NODE" });
      throw error;
    }
    const runtime = await this.requireNodeRuntimeOnNode(instance.nodeId, instance.runtimeId);
    return this.appLaunchCwdForFolder(instance, folder, runtime);
  }

  private appLaunchCwdForFolder(instance: ControlledInstance, folder: NodeLocalFolder, runtime: NodeRuntime) {
    const cwd = runtimeCwdForNodePath(instance, folder.path, runtime);
    if (cwd) return cwd;
    if (instance.source.type !== "local-folder") {
      const error = new Error(`App cwd folder selection is only supported for local-folder instances.`);
      Object.assign(error, { statusCode: 400, code: "APP_CWD_REQUIRES_LOCAL_FOLDER_SOURCE" });
      throw error;
    }
    const error = new Error(`Local folder ${folder.path} is outside the instance workspace ${instance.source.path}.`);
    Object.assign(error, { statusCode: 400, code: "APP_CWD_OUTSIDE_WORKSPACE" });
    throw error;
  }

  requireProject(id: string) {
    return this.catalogService.requireProject(id);
  }

  requireModel(id: string, includeSecret = false) {
    return this.modelService.require(id, includeSecret);
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
    return publicNode(this.projectNodeConnection(this.requireNode(id)));
  }

  async requireControlledInstance(id: string, includeSecret = false) {
    const record = await this.requireNodeInstance(id);
    return includeSecret ? record : publicInstanceWithAccess(record);
  }
}

type ProxyHttpInit = Omit<RequestInit, "body"> & {
  body?: RequestInit["body"] | Buffer;
};

export function runtimeCwdForNodePath(instance: ControlledInstance, nodePath: string, runtime: NodeRuntime) {
  if (runtime.type === "local") return resolveNodePath(nodePath);
  if (instance.source.type !== "local-folder") return undefined;
  const relativeSegments = relativeNodePathSegments(instance.source.path, nodePath);
  if (!relativeSegments) return undefined;
  const workspacePath = instance.runtime.workspacePath || instance.workspace.path || workspacePolicyForSource(instance.source).path || "/workspace";
  return relativeSegments.length ? path.posix.join(workspacePath, ...relativeSegments) : workspacePath;
}

function isAbortError(error: unknown) {
  return error instanceof Error
    && (error.name === "AbortError" || (error as Error & { code?: string }).code === "ABORT_ERR");
}
