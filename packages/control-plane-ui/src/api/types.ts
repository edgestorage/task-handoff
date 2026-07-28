import type {
  AiSessionHistoryItem,
  AiSessionHistoryList,
  AiSessionHistoryDetail,
  AiSessionMentionCandidate,
  AiSessionMentionCatalog,
  AiSessionMentionDiagnostic,
  AiSessionMentionFileSearch,
  AiSessionReference,
  AiSessionResumeResult,
  AiSessionPermissionMode,
} from "@task-handoff/protocol/ai-sessions";
import type { AiSessionContextCompaction as ProtocolAiSessionContextCompaction } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSubAgent as ProtocolAiSessionSubAgent } from "@task-handoff/protocol/ai-sessions";
import type {
  ImagePullProgress,
  ApplyUpdateRequest,
  NodeRolloutSummary,
  NodeUpdateImpact,
  RuntimeVersionState,
  UpdateCheckResult as ProtocolUpdateCheckResult,
  UpdateJob as ProtocolUpdateJob,
} from "@task-handoff/protocol/control-plane";

export type { AiSessionHistoryDetail, AiSessionHistoryItem, AiSessionHistoryList, AiSessionMentionCandidate, AiSessionMentionCatalog, AiSessionMentionDiagnostic, AiSessionMentionFileSearch, AiSessionReference, AiSessionResumeResult };

export type HealthResponse = {
  ok: boolean;
  role?: "control-plane" | string;
  protocolVersion?: string;
  build?: BuildInfo;
  dataDir?: string;
  serverTime?: string;
};

export const AiSessionEventType = {
  Snapshot: "ai-session.snapshot",
  Patch: "ai-session.patch",
  Removed: "ai-session.removed",
  MessageDelta: "ai-session.message-delta",
  SyncRequired: "ai-session.sync-required",
} as const;
export const AiSessionUnreadEventType = {
  Updated: "ai-session.unread.updated",
} as const;

export type AiSessionEventType = (typeof AiSessionEventType)[keyof typeof AiSessionEventType];

export const AppSessionEventType = {
  Snapshot: "app-session.snapshot",
  Patch: "app-session.patch",
  Removed: "app-session.removed",
  SyncRequired: "app-session.sync-required",
} as const;

export type AppSessionEventType = (typeof AppSessionEventType)[keyof typeof AppSessionEventType];

export type ControlPlaneStatusResponse = {
  protocolVersion: string;
  build?: BuildInfo;
  storage: Record<string, string>;
};

export type ControlPlaneSettings = {
  publicBaseUrl?: string;
  updateChannel: UpdateChannel;
  mentionTrigger: string;
  commandTrigger: string;
};

export type BuildInfo = {
  component: "control-plane" | "node-agent" | "controlled-instance";
  packageName?: string;
  packageVersion?: string;
  protocolVersion?: string;
  buildId?: string;
  builtAt?: string;
  gitCommit?: string;
  imageRef?: string;
  imageDigest?: string;
};

export type UpdateChannel = "stable" | "beta" | "alpha";
export type UpdateCheckResult = ProtocolUpdateCheckResult;
export type UpdateJob = ProtocolUpdateJob;
export type { NodeRolloutSummary, NodeUpdateImpact, RuntimeVersionState };
export type { ApplyUpdateRequest };

export type AuthUser = {
  id: string;
  username: string;
  role: "admin";
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type AuthSession = {
  mode: "disabled" | "password";
  enabled: boolean;
  requiresBootstrap: boolean;
  authenticated: boolean;
  user?: AuthUser;
};

export type ProjectSource =
  | { type: "local-folder"; path: string; ownerNodeId?: string; localFolderId?: string }
  | {
      type: "git-repository";
      repositoryId?: string;
      url: string;
      provider?: string;
      ref?: { type: "branch" | "tag" | "commit"; name?: string; commit?: string };
      auth?: { type: "none" | "ssh-key" | "https-token"; secretId?: string };
      clone?: { depth?: number; submodules?: boolean; lfs?: boolean; subdirectory?: string };
    };

export type WorkspacePolicy = {
  mode: "local-bind" | "git-clone" | "empty-volume" | "persistent-volume";
  path: string;
  volumeName?: string;
  readOnly?: boolean;
};

export type Project = {
  id: string;
  name: string;
  source: ProjectSource;
  defaultImageSelection?: ImageSelection;
  defaultNodeId?: string;
  defaultRuntimeId?: string;
  workspacePolicy: WorkspacePolicy;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type ModelApp = "codex" | "claude";

export type ModelConfig = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  app: ModelApp;
  enabled: boolean;
  order: number;
  labels: Record<string, string>;
  keyPreview?: string;
  keySet?: boolean;
  createdAt: string;
  updatedAt: string;
  locations?: ModelLocation[];
  referenceCount?: number;
};

export type ModelLocation =
  | { type: "control-plane"; name: string; enabled: boolean; order: number }
  | { type: "node"; nodeId: string; name: string; enabled: boolean; order: number; referenceCount: number };

export type FederatedModelRegistry = {
  models: Array<{
    id: string;
    model: Omit<ModelConfig, "locations" | "referenceCount">;
    locations: ModelLocation[];
    referenceCount: number;
  }>;
  nodeDiagnostics: Array<{ nodeId: string; code: string; message: string }>;
  updatedAt: string;
};

export type ImageSelection = {
  imageId: string;
  tag?: string;
};

export type ImageCover =
  | { kind: "builtin"; key: string }
  | { kind: "remote"; url: string; sha256?: string };

export type CustomImageProfile = {
  id: string;
  origin: "custom";
  name: string;
  description?: string;
  localizedDescriptions?: Record<string, string>;
  cover?: ImageCover;
  reference: string;
  repository: string;
  tag?: string;
  digest?: string;
  pullPolicy: "if-not-present";
  capabilities: string[];
  optionalApps: string[];
  defaultEnv: Record<string, string>;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

/** @deprecated Use CustomImageProfile for editable records or SelectableImage for choices. */
export type ImageProfile = CustomImageProfile;

export type MarketImageTag = {
  name: string;
  reference: string;
  platforms: Array<{
    os: string;
    architecture: string;
    variant?: string;
    digest?: string;
    downloadSizeBytes?: number;
    unpackedSizeBytes?: number;
  }>;
  status: "active" | "deprecated" | "yanked";
};

export type MarketImage = {
  id: string;
  publisher: string;
  slug: string;
  name: string;
  description: string;
  localizedDescriptions?: Record<string, string>;
  cover?: ImageCover;
  repository: string;
  defaultTag: string;
  tags: MarketImageTag[];
  capabilities: string[];
  optionalApps: string[];
  defaultEnv: Record<string, string>;
  labels: Record<string, string>;
  status: "active" | "deprecated" | "yanked";
};

export type MarketCatalog = {
  catalog: {
    protocolVersion: string;
    catalogId: string;
    revision: string;
    source: "embedded" | "remote" | "cache";
    generatedAt: string;
    items: MarketImage[];
  };
  status: {
    source: "embedded" | "remote" | "cache";
    state: "ready" | "stale" | "failed";
    revision?: string;
    updatedAt: string;
    error?: string;
  };
};

export type SelectableImage = {
  id: string;
  origin: "market" | "custom";
  name: string;
  description?: string;
  localizedDescriptions?: Record<string, string>;
  cover?: ImageCover;
  repository: string;
  tag?: string;
  reference: string;
  digest?: string;
  lifecycleStatus?: "active" | "deprecated" | "yanked";
  availableTags: Array<{
    name: string;
    version?: string;
    reference: string;
    manifestDigest?: string;
    status: "active" | "deprecated" | "yanked";
  }>;
  downloadSizeBytes?: number;
  unpackedSizeBytes?: number;
  capabilities: string[];
  optionalApps: string[];
  defaultEnv: Record<string, string>;
  labels: Record<string, string>;
  readOnly: boolean;
  market?: { catalogId: string; catalogRevision: string; publisher: string; version?: string };
};

export type LocalDockerImage = {
  repository: string;
  tag: string;
  id: string;
  createdSince?: string;
  size?: string;
  sizeBytes?: number;
  reference: string;
  repoDigests: string[];
};

export type NodeImageAvailability = {
  image: SelectableImage;
  status: "available" | "pull-required" | "unknown";
  localImage?: LocalDockerImage;
  localSizeBytes?: number;
  downloadSizeBytes?: number;
  unpackedSizeBytes?: number;
  error?: string;
};

export type InstanceImageSnapshot = {
  id: string;
  origin: "market" | "custom";
  name: string;
  description?: string;
  localizedDescriptions?: Record<string, string>;
  cover?: ImageCover;
  repository: string;
  tag?: string;
  pullPolicy: "if-not-present";
  capabilities: string[];
  optionalApps: string[];
  defaultEnv: Record<string, string>;
  labels: Record<string, string>;
  requestedReference: string;
  resolvedDigest?: string;
  resolvedReference?: string;
  catalogId?: string;
  catalogRevision?: string;
};

export type ImageProvisioning = {
  phase: "checking-image" | "pulling-image" | "resolving-image" | "ready" | "failed";
  requestedReference: string;
  generation: number;
  error?: string;
  startedAt: string;
  updatedAt: string;
};

export type Node = {
  id: string;
  name: string;
  connectionMode: "local-ipc" | "local-loopback" | "direct-http" | "reverse-wss";
  auth?: {
    mode: "local-static-key" | "paired-hmac";
    keyId?: string;
    pairedAt?: string;
    pairing?: {
      status: "pending" | "paired" | "expired";
      expiresAt?: string;
    };
  };
  endpoint?: string;
  controlEndpoint?: string;
  containerEndpoint?: string;
  publicWebBase?: string;
  status: "unknown" | "online" | "offline" | "degraded";
  health: "unknown" | "ok" | "degraded" | "failed";
  capabilities: Record<string, unknown>;
  labels: Record<string, string>;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type NodeAgentExternalListener = {
  bindScope: "loopback" | "all-ipv4";
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  status: "listening" | "error";
  source: "bootstrap" | "persisted";
  error?: string;
};

export type UpdateNodeAgentExternalListener = Pick<NodeAgentExternalListener, "bindScope" | "port">;

export type NodeRuntime = {
  id: string;
  nodeId: string;
  name: string;
  type: "docker" | "kubernetes" | "local";
  status: "unknown" | "online" | "offline" | "degraded";
  accessStrategy: "node-proxy" | "direct-port" | "kubernetes-ingress" | "kubernetes-port-forward";
  capabilities: Record<string, unknown>;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type NodeAgentScopedError = {
  nodeId: string;
  route: string;
  method: string;
  code: string;
  message: string;
  statusCode?: number;
  issues?: Array<{
    path?: Array<string | number>;
    message: string;
  }>;
};

export type NodeDiagnosticsMeta = {
  nodeErrors?: NodeAgentScopedError[];
};

export type NodeRuntimesPayload = {
  data: NodeRuntime[];
  meta?: NodeDiagnosticsMeta;
};

export type NodeLocalFolder = {
  id: string;
  nodeId: string;
  name: string;
  path: string;
  defaultImageSelection?: ImageSelection;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type NodeFolderTreeEntry = {
  name: string;
  path: string;
  children: NodeFolderTreeEntry[];
};

export type NodeStatus = {
  id: string;
  status: "online" | "offline" | "unsupported" | string;
  checkedAt: string;
  error?: string;
  agent?: Record<string, unknown>;
};

export type NodePairingInvite = {
  nodeId: string;
  joinToken: string;
  expiresAt: string;
};

export type NodeJoinInvite = {
  id: string;
  joinToken: string;
  expiresAt: string;
};

export type ConnectNodeRemoteInput = {
  controlPlaneUrl: string;
  joinToken: string;
  controlPlaneName?: string;
  activate?: boolean;
};

export type NodeRemoteConnectResult = {
  remote: {
    id: string;
    url?: string;
    keyId: string;
    pairedAt: string;
    active: boolean;
  };
  tunnel: {
    status: "disabled" | "saved" | "connecting" | "connected" | "failed";
    error?: string;
  };
};

export type NodeRemoteControlPlane = {
  id: string;
  keyId: string;
  name?: string;
  url?: string;
  pairedAt: string;
  updatedAt: string;
  active?: boolean;
  current: boolean;
};

export type ConfigSyncPreset = {
  id: string;
  label: string;
  projectRoot: string;
  items: Array<{
    id: string;
    type: "file" | "dir";
    projectPath: string;
    containerPath: string;
  }>;
};

export type InstanceAccess = {
  strategy: "control-plane-proxy" | "direct-port" | "node-proxy" | "kubernetes-ingress" | "kubernetes-port-forward" | string;
  web?: string;
  api?: string;
  ws?: string;
  status: "unknown" | "reachable" | "endpoint-unreachable";
};

export type InstanceAppInventoryItem = {
  id: string;
  name: string;
  kind: "tty" | "gui" | "web";
  source: "builtin" | "custom";
  availability: "available" | "missing-dependency";
  capabilities: {
    automation?: "cdp";
    supportsCwdSelection: boolean;
  };
  diagnosticCode?: "APP_EXECUTABLE_NOT_FOUND";
};

export type InstanceAppInventory = {
  items: InstanceAppInventoryItem[];
  observedAt: string;
  issues: Array<{
    code: "APP_CATALOG_INVALID";
    message: string;
  }>;
};

export type ControlledInstance = {
  id: string;
  name: string;
  projectId?: string;
  source: ProjectSource;
  sourceSnapshot: Record<string, unknown>;
  modelSelection: ModelSelection;
  nodeId: string;
  runtimeId: string;
  imageSelection?: ImageSelection;
  imageSnapshot?: InstanceImageSnapshot;
  imageProvisioning?: ImageProvisioning;
  stateRevision: number;
  status: "created" | "provisioning" | "starting" | "registering" | "registered" | "running" | "stopping" | "stopped" | "failed" | "unhealthy";
  health: "unknown" | "ok" | "degraded" | "failed";
  connectionStatus: "unknown" | "online" | "offline" | "endpoint-unreachable";
  controlMode: "standalone" | "controlled";
  protocolVersion?: string;
  instanceVersion?: string;
  build?: BuildInfo;
  runtimeVersion?: RuntimeVersionState;
  capabilities: Record<string, unknown>;
  appInventory?: InstanceAppInventory;
  config: {
    autoImportAgentConfigs: boolean;
    defaultCodexPermissionMode: AiSessionPermissionMode;
  };
  workspace: {
    mode?: WorkspacePolicy["mode"];
    status: "unknown" | "pending" | "ready" | "failed";
    path?: string;
    resolvedCommit?: string;
    error?: string;
  };
  access: InstanceAccess;
  apps: {
    runningCount: number;
    sessions: Array<Record<string, unknown>>;
  };
  aiSessions: AiSessionsSnapshot;
  triggers?: {
    configs: Array<{
      configHash: string;
      config: TriggerConfig;
      deployments: TriggerDeployment[];
      runtime: TriggerRuntimeState[];
    }>;
    recentRuns: TriggerRun[];
    updatedAt: string;
  };
  runtime: {
    kind?: string;
    containerName?: string;
    containerId?: string;
    workspacePath?: string;
    pid?: number;
    port?: number;
    labels: Record<string, string>;
  };
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelSelection = {
  codexModelHash?: string | null;
  claudeModelHash?: string | null;
};

export type {
  AppManagementError,
  AppManagementEvent,
  AppManagementJob,
  AppManagementJobResponse,
  AppManagementOperation,
  AppManagementSnapshot,
  InstanceResourceMetrics,
  ManagedAppProjection,
} from "@task-handoff/protocol/control-plane";

export type TriggerSource =
  | { type: "schedule"; scheduleKind?: "interval"; intervalMs: number }
  | { type: "schedule"; scheduleKind: "daily"; timeOfDay: string; timezone: string }
  | { type: "schedule"; scheduleKind: "weekly"; weekdays: number[]; timeOfDay: string; timezone: string }
  | { type: "file-change"; roots: string[]; globs: string[]; ignore?: string[]; debounceMs: number }
  | { type: "ai-session"; agent?: string; statuses?: string[]; phases?: string[] };

export type TriggerTarget = { type: "ai-session"; aiSessionId: string };

export type TriggerConfig = {
  configHash: string;
  name: string;
  description?: string;
  source: TriggerSource;
  action: { promptTemplate: string };
  policy: {
    cooldownMs?: number;
    maxConcurrentRuns: number;
    whenBusy: "skip" | "queue";
  };
  createdAt: string;
  updatedAt: string;
};

export type TriggerDeployment = {
  configHash: string;
  deploymentId?: string;
  instanceId: string;
  origin: "control-plane" | "controlled-instance";
  enabled: boolean;
  target: TriggerTarget;
  localName?: string;
  createdAt: string;
  updatedAt: string;
};

export type TriggerRuntimeState = {
  configHash: string;
  deploymentId?: string;
  instanceId: string;
  status: "idle" | "running" | "disabled" | "error";
  lastTriggeredAt?: string;
  lastCompletedAt?: string;
  lastSkippedAt?: string;
  lastError?: string;
  runCount: number;
  skippedCount: number;
};

export type TriggerRun = {
  id: string;
  configHash: string;
  deploymentId?: string;
  instanceId: string;
  instanceName?: string;
  eventType: "manual" | "schedule" | "file-change" | "ai-session";
  status: "started" | "completed" | "failed" | "skipped";
  target: TriggerTarget;
  promptPreview: string;
  eventSummary?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type ControlPlaneTrigger = {
  configHash: string;
  config: TriggerConfig;
  deploymentCount: number;
  enabledCount: number;
  runningCount: number;
  errorCount: number;
  ownedByControlPlane?: boolean;
  controlPlaneDeploymentCount?: number;
  deployments: Array<{
    instanceId: string;
    instanceName: string;
    deployment: TriggerDeployment;
    runtime?: TriggerRuntimeState;
  }>;
  recentRuns: TriggerRun[];
};

export type ControlPlaneTriggers = {
  updatedAt: string;
  triggers: ControlPlaneTrigger[];
};

export type AppSessionsSnapshot = {
  runningCount: number;
  problemCount: number;
  sessions: AppSession[];
  updatedAt: string;
};

export type AppSessionSnapshotEvent = {
  meta: {
    streamId: string;
    instanceId: string;
    nodeId?: string;
    revision: number;
    previousRevision?: number;
    traceId: string;
    generatedAt: string;
    reason: string;
  };
  snapshot: AppSessionsSnapshot;
};

export type AppSessionPatchEvent = {
  meta: AppSessionSnapshotEvent["meta"];
  session: AppSession;
};

export type AppSessionRemovedEvent = {
  meta: AppSessionSnapshotEvent["meta"];
  sessionId: string;
  tombstone?: AppSession;
  expiresAt?: string;
};

export type AppSessionDeltaResponse = {
  streamId: string;
  instanceId: string;
  sinceRevision: number;
  latestRevision: number;
  earliestRetainedRevision: number;
  syncRequired: boolean;
  events: Array<
    | { type: typeof AppSessionEventType.Snapshot; payload: AppSessionSnapshotEvent }
    | { type: typeof AppSessionEventType.Patch; payload: AppSessionPatchEvent }
    | { type: typeof AppSessionEventType.Removed; payload: AppSessionRemovedEvent }
  >;
};

export type ControlPlaneAppSessions = {
  updatedAt: string;
  instances: Array<{
    instanceId: string;
    streamId: string;
    appSessions: AppSessionsSnapshot;
    revision?: number;
    lastEventAt?: string;
  }>;
};

export type CreateControlPlaneTriggerInput = {
  name: string;
  description?: string;
  source: TriggerSource;
  action: { promptTemplate: string };
  policy?: Partial<TriggerConfig["policy"]>;
};

export type AiSessionLifecycle = "running" | "waiting" | "idle" | "failed";

export type AiSessionPhase = "thinking" | "tool" | "editing" | "approval" | "responding" | "unknown";
export type AiSessionSource = "control" | "realtime" | "adapter-snapshot" | "transcript-tail" | "transcript-scan" | "process-scan" | "app-session";

export type AiSessionAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  expiresAt?: string;
};

export type AiSessionAttachmentRef = {
  id: string;
  kind?: "image" | "file";
  source?: { type: "upload-ref" };
} | {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  source: { type: "runtime-path"; path: string };
};

export type AiSessionTurn = {
  id: string;
  providerTurnId?: string;
  source?: AiSessionSource;
  userPrompt?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  phase?: AiSessionPhase;
  summary?: string;
  lastMessage?: string;
  lastMessageItemId?: string;
  contextCompactions?: ProtocolAiSessionContextCompaction[];
  revision: number;
  sourcePriority?: number;
  snapshotVersion?: number;
  observedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
};

export type AiSessionQueuedMessage = {
  id: string;
  message: string;
  attachments?: AiSessionAttachment[];
  status: "queued" | "sending" | "failed";
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type AiSessionQueue = {
  pendingCount: number;
  items: AiSessionQueuedMessage[];
};

export type AiSessionTool = {
  id?: string;
  kind?: string;
  name: string;
  inputPreview?: string;
  startedAt?: string;
};

export type AiSessionSubAgent = ProtocolAiSessionSubAgent;

export type AiSessionSummary = {
  id: string;
  agent: string;
  appSessionId?: string;
  appId?: string;
  providerSessionId?: string;
  providerMeta?: Record<string, unknown>;
  appBindingKeys?: string[];
  actions?: {
    send?: boolean;
    interrupt?: boolean;
    approval?: boolean;
  };
  activeTurnId?: string;
  title?: string;
  cwd?: string;
  userPrompt?: string;
  turns?: AiSessionTurn[];
  status: AiSessionLifecycle;
  phase: AiSessionPhase;
  summary?: string;
  lastMessage?: string;
  lastMessageItemId?: string;
  currentTool?: AiSessionTool;
  toolCallsSinceLastMessage: number;
  subAgents: AiSessionSubAgent[];
  queue: AiSessionQueue;
  startedAt: string;
  updatedAt: string;
  error?: string;
  unread: boolean;
};

export type AiSessionUnreadState = {
  instanceId: string;
  sessionId: string;
  unread: boolean;
  sessionUpdatedAt: string;
  updatedAt: string;
};

export type AiSessionsSnapshot = {
  runningCount: number;
  waitingCount: number;
  staleCount: number;
  sessions: AiSessionSummary[];
  updatedAt: string;
};

export type InstanceBoardAiSummary = {
  runningCount: number;
  waitingCount: number;
  staleCount: number;
  idleCount: number;
  problemCount: number;
  updatedAt: string;
  revision?: number;
};

export type ControlPlaneAiSessions = {
  updatedAt: string;
  instances: Array<{
    instanceId: string;
    streamId: string;
    aiSessions: AiSessionsSnapshot;
    revision?: number;
    lastEventAt?: string;
  }>;
};

export type AiSessionEventMeta = {
  streamId: string;
  instanceId: string;
  nodeId?: string;
  revision: number;
  previousRevision?: number;
  traceId: string;
  generatedAt: string;
  reason: string;
};

export type AiSessionSnapshotEvent = {
  meta: AiSessionEventMeta;
  snapshot: AiSessionsSnapshot;
};

export type AiSessionPatchEvent = {
  meta: AiSessionEventMeta;
  upserted: AiSessionSummary[];
  removed: string[];
};

export type AiSessionRemovedEvent = {
  meta: AiSessionEventMeta;
  sessionIds: string[];
  expiresAt: string;
};

export type AiSessionMessageDeltaEvent = {
  instanceId: string;
  nodeId?: string;
  sessionId: string;
  providerSessionId: string;
  turnId: string;
  itemId: string;
  delta: string;
  generatedAt: string;
};

export type AiSessionDeltaResponse = {
  streamId: string;
  instanceId: string;
  sinceRevision: number;
  latestRevision: number;
  earliestRetainedRevision: number;
  syncRequired: boolean;
  events: Array<
    | { type: typeof AiSessionEventType.Snapshot; payload: AiSessionSnapshotEvent }
    | { type: typeof AiSessionEventType.Patch; payload: AiSessionPatchEvent }
    | { type: typeof AiSessionEventType.Removed; payload: AiSessionRemovedEvent }
  >;
};

export type ChatChannel = "web" | "telegram" | "wechat" | "dingding";

export type ChatBridgeConfig = {
  id: string;
  channel: ChatChannel;
  name: string;
  enabled: boolean;
  tokenSet?: boolean;
  defaultChatId?: string;
  allowedUserIds: string[];
  pollIntervalMs: number;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ChatGatewayStatus = {
  running: boolean;
  bridges: Array<{
    id: string;
    channel: ChatChannel;
    name: string;
    running: boolean;
    tokenSet: boolean;
    defaultChatId?: string;
    lastUpdateId?: number;
    error?: string;
  }>;
};

export type CreateChatBridgeInput = {
  channel: ChatChannel;
  name?: string;
  enabled?: boolean;
  token?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  pollIntervalMs?: number;
  settings?: Record<string, unknown>;
};

export type UpdateChatBridgeInput = {
  name?: string;
  enabled?: boolean;
  token?: string;
  defaultChatId?: string;
  allowedUserIds?: string[];
  pollIntervalMs?: number;
  settings?: Record<string, unknown>;
};

export type AppSession = {
  id: string;
  appId: string;
  title?: string;
  kind?: "tty" | "gui" | "web" | string;
  status?: string;
  bindings?: Array<{
    type: "app-session" | "provider-session" | "adapter-key";
    id: string;
    agent?: string;
    adapter?: string;
    key?: string;
  }>;
  workspace?: {
    cwd?: string;
  };
  tty?: {
    webPath?: string;
    shell?: string;
    cwd?: string;
  };
  web?: {
    webPath?: string;
    host?: string;
    port?: number;
  };
  vnc?: {
    webPath?: string;
    noVncPath?: string;
  };
  [key: string]: unknown;
};

export type InstanceBoardItem = Omit<ControlledInstance, "aiSessions"> & {
  aiSessions: InstanceBoardAiSummary;
  heartbeatAgeMs?: number;
  project?: Project;
  image?: SelectableImage | InstanceImageSnapshot;
  node?: Node;
  runtime?: NodeRuntime;
  protocolCompatible: boolean;
  imagePullProgress?: ImagePullProgress;
};

export type InstanceWithAiSessions = Omit<InstanceBoardItem, "aiSessions"> & {
  aiSessions: AiSessionsSnapshot & InstanceBoardAiSummary;
};

export type InstanceBoardPayload = {
  data: InstanceBoardItem[];
  meta?: NodeDiagnosticsMeta;
};

export type CreateControlledInstanceInput = {
  name?: string;
  projectId?: string;
  source?: ProjectSource;
  sourceSnapshot?: Record<string, unknown>;
  imageSelection?: ImageSelection;
  nodeId: string;
  runtimeId: string;
  config?: {
    autoImportAgentConfigs?: boolean;
    defaultCodexPermissionMode?: AiSessionPermissionMode;
  };
  modelSelection?: ModelSelection;
  start?: boolean;
};

export type CreateControlledInstanceResult = InstanceBoardItem & {
  registrationToken?: string;
  startOutcome: {
    status: "not-requested" | "started" | "failed";
    error?: { code: string; message: string };
  };
};

export type UpdateControlledInstanceInput = {
  name?: string;
  config?: {
    autoImportAgentConfigs?: boolean;
    defaultCodexPermissionMode?: AiSessionPermissionMode;
  };
  modelSelection?: ModelSelection;
};

export type CreateProjectInput = {
  name: string;
  source: ProjectSource;
  defaultImageSelection?: ImageSelection;
  defaultNodeId?: string;
  defaultRuntimeId?: string;
};

export type CreateModelInput = {
  name: string;
  endpoint: string;
  key: string;
  model: string;
  app: ModelApp;
  enabled?: boolean;
  order?: number;
  labels?: Record<string, string>;
};

export type UpdateModelInput = Partial<CreateModelInput>;

export type UpdateProjectInput = Partial<CreateProjectInput>;

export type CreateImageInput = {
  name: string;
  reference: string;
  pullPolicy?: "if-not-present";
  capabilities?: string[];
  optionalApps?: string[];
  defaultEnv?: Record<string, string>;
  labels?: Record<string, string>;
};

export type CreateNodeInput = {
  name: string;
  connectionMode?: Node["connectionMode"];
  joinToken?: string;
  endpoint?: string;
  controlEndpoint?: string;
  containerEndpoint?: string;
  publicWebBase?: string;
  labels?: Record<string, string>;
};

export type UpdateNodeInput = Pick<Node, "name">;

export type CreateNodeLocalFolderInput = {
  name: string;
  path: string;
  defaultImageSelection?: ImageSelection;
  labels?: Record<string, string>;
};

export type CreateNodeRuntimeInput = {
  id?: string;
  name: string;
  type: NodeRuntime["type"];
  status?: NodeRuntime["status"];
  accessStrategy?: NodeRuntime["accessStrategy"];
  capabilities?: Record<string, unknown>;
  labels?: Record<string, string>;
};

export type LaunchAppSessionInput = {
  appId?: string;
  cwdFolderId?: string;
  options?: Record<string, unknown>;
};
