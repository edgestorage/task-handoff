export type StatusResponse = {
  version: string;
  startedAt: string;
  runningAppCount: number;
  storage: Record<string, string>;
};

export const AiSessionEventType = {
  Snapshot: "ai-session.snapshot",
  Patch: "ai-session.patch",
  Removed: "ai-session.removed",
  SyncRequired: "ai-session.sync-required",
} as const;

export type AiSessionEventType = (typeof AiSessionEventType)[keyof typeof AiSessionEventType];

export const AppSessionEventType = {
  Snapshot: "app-session.snapshot",
  Patch: "app-session.patch",
  Removed: "app-session.removed",
  SyncRequired: "app-session.sync-required",
} as const;

export type AppSessionEventType = (typeof AppSessionEventType)[keyof typeof AppSessionEventType];

export type AiSessionSnapshotEvent = {
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
  snapshot: AiSessionsSnapshot;
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

export type AiSessionLifecycle = "running" | "waiting" | "idle" | "failed";

export type AiSessionPhase = "thinking" | "tool" | "editing" | "approval" | "responding" | "unknown";
export type AiSessionSource = "control" | "realtime" | "adapter-snapshot" | "transcript-tail" | "transcript-scan" | "process-scan" | "app-session";

export type AiSessionTurn = {
  id: string;
  providerTurnId?: string;
  source?: AiSessionSource;
  userPrompt?: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  phase?: AiSessionPhase;
  summary?: string;
  lastMessage?: string;
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
  status: "queued" | "sending" | "failed";
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type AiSessionQueue = {
  pendingCount: number;
  items: AiSessionQueuedMessage[];
};

export type AiSessionStatus = {
  id: string;
  agent: string;
  appSessionId?: string;
  appId?: string;
  providerSessionId?: string;
  providerMeta?: Record<string, unknown>;
  activeTurnId?: string;
  conversationId?: number;
  title?: string;
  cwd?: string;
  userPrompt?: string;
  turns?: AiSessionTurn[];
  status: AiSessionLifecycle;
  phase: AiSessionPhase;
  summary?: string;
  lastMessage?: string;
  currentTool?: {
    name: string;
    inputPreview?: string;
    startedAt?: string;
  };
  transcriptPath?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  counters: {
    toolCalls: number;
    edits: number;
    approvals: number;
  };
  queue: AiSessionQueue;
};

export type AiSessionSummary = Pick<
  AiSessionStatus,
  "id" | "agent" | "appSessionId" | "appId" | "providerSessionId" | "providerMeta" | "activeTurnId" | "conversationId" | "title" | "cwd" | "userPrompt" | "turns" | "status" | "phase" | "summary" | "startedAt" | "updatedAt" | "error"
  | "lastMessage" | "currentTool"
  | "queue"
>;

export type AiSessionsSnapshot = {
  runningCount: number;
  waitingCount: number;
  staleCount: number;
  sessions: AiSessionSummary[];
  updatedAt: string;
};

export type TriggerSource =
  | { type: "schedule"; scheduleKind?: "interval"; intervalMs: number }
  | { type: "schedule"; scheduleKind: "daily"; timeOfDay: string; timezone: string }
  | { type: "schedule"; scheduleKind: "weekly"; weekdays: number[]; timeOfDay: string; timezone: string }
  | { type: "file-change"; roots: string[]; globs: string[]; ignore?: string[]; debounceMs: number }
  | { type: "ai-session"; agent?: string; statuses?: AiSessionLifecycle[]; phases?: AiSessionPhase[] };

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
  eventType: "manual" | "schedule" | "file-change" | "ai-session";
  status: "started" | "completed" | "failed" | "skipped";
  target: TriggerTarget;
  promptPreview: string;
  eventSummary?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type TriggerIndex = {
  schemaVersion: 1;
  configs: TriggerConfig[];
  deployments: TriggerDeployment[];
  runtime: TriggerRuntimeState[];
  recentRuns: TriggerRun[];
};

export type TriggerCreateInput = {
  name: string;
  description?: string;
  source: TriggerSource;
  action: { promptTemplate: string };
  policy?: Partial<TriggerConfig["policy"]>;
  deployment: {
    enabled?: boolean;
    origin?: TriggerDeployment["origin"];
    target: TriggerTarget;
    localName?: string;
  };
};

export type AiSessionTranscriptTail = {
  path: string;
  lineCount: number;
  tail: string;
};

export type AuthStatusResponse = {
  enabled: boolean;
  source?: "env" | "file" | "generated";
  tokenFile?: string;
};

export type DiagnosticsResponse = {
  ok: boolean;
  runtime: {
    platform: string;
    arch: string;
    linuxRuntime: boolean;
    node: string;
    pid: number;
    hostname: string;
    uptimeSeconds: number;
  };
  noVnc: {
    available: boolean;
    root?: string;
  };
  commands: Array<{
    name: string;
    command: string;
    available: boolean;
    path?: string;
    requiredFor: string[];
  }>;
  storage: Array<{
    key: string;
    path: string;
    exists: boolean;
    type: "file" | "directory" | "missing";
    writable: boolean;
  }>;
};

export type AppCatalogItem = {
  id: string;
  name: string;
  kind: "tty" | "gui" | "web";
  description?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  display?: {
    width?: number;
    height?: number;
    depth?: number;
  };
  defaultDisplayTarget?: {
    mode: "isolated" | "shared";
    id?: string;
    autoCreate?: boolean;
  };
  automation?: {
    type: "cdp";
    portArg?: string;
    endpointPath?: string;
  };
  web?: {
    portArg?: string;
    readyPath?: string;
  };
};

export type CustomAppCatalog = {
  path: string;
  schemaVersion: 1;
  items: AppCatalogItem[];
};

export type AppLaunchOptions = {
  title?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  display?: {
    width?: number;
    height?: number;
    depth?: number;
  };
  displayTarget?: {
    mode: "isolated" | "shared";
    id?: string;
    autoCreate?: boolean;
  };
};

export type AppSession = {
  id: string;
  appId: string;
  title: string;
  kind: "tty" | "gui" | "web";
  status: "created" | "running" | "stopping" | "stopped" | "exited" | "failed";
  createdAt: string;
  updatedAt: string;
  launch?: AppLaunchOptions;
  tty?: {
    webPath: string;
    shell: string;
    cwd: string;
    mode?: "pty" | "claude-attach";
  };
  display?: {
    display: string;
    mode?: "isolated" | "shared";
    displaySessionId?: string;
    width: number;
    height: number;
    depth: number;
    xPid?: number;
    wmPid?: number;
    compositorPid?: number;
    xauthority?: string;
  };
  vnc?: {
    backend?: "novnc" | "kasmvnc";
    host: string;
    port: number;
    websockifyPort?: number;
    webPath: string;
    noVncPath: string;
  };
  web?: {
    host: string;
    port: number;
    webPath: string;
    readyPath?: string;
  };
  automation?: {
    type: "cdp";
    endpoint: string;
    port: number;
  };
  process?: {
    pid?: number;
    command: string;
    exitCode?: number | null;
    signal?: string | null;
  };
  ai?: Record<string, unknown>;
  paths: {
    sessionDir: string;
    logDir: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

export type AppAutomationStatus = {
  sessionId: string;
  type: "cdp";
  endpoint: string;
  port: number;
  ready: boolean;
  browser?: string;
  protocolVersion?: string;
  webSocketDebuggerUrl?: string;
  error?: {
    code: string;
    message: string;
  };
};

export type AppSessionLogs = {
  sessionId: string;
  logDir: string;
  maxBytes: number;
  files: Array<{
    name: string;
    size: number;
    updatedAt: string;
    truncated: boolean;
    content: string;
  }>;
};
