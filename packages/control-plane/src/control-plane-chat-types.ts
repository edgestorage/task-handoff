import type {
  ChatSessionBinding,
  ControlledInstance,
  PendingRoute,
  Project,
} from "@task-handoff/protocol/control-plane";
import type {
  AiSessionActionResult,
  AiSessionMessageAttachment,
  InstanceBoardAiSummary,
  AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import type { AppSessionsSnapshot } from "@task-handoff/protocol/app-sessions";
import type { AppAccessMode, AppAccessToken } from "./app-access-service.ts";
import type { ChatActionToken } from "./chat-action-token-service.ts";

export type ChatBoardInstance = {
  id: string;
  name: string;
  projectId?: string;
  status: string;
  connectionStatus: string;
  receiver: { pendingCount: number };
  aiSessions: InstanceBoardAiSummary;
  apps?: {
    runningCount?: number;
    problemCount?: number;
    updatedAt?: string;
    revision?: number;
    sessions?: Record<string, unknown>[];
  };
  capabilities?: Record<string, unknown>;
  image?: Record<string, unknown>;
  project?: { name?: string };
  sourceSnapshot: Record<string, unknown>;
};

export type ChatPendingRoute = PendingRoute & {
  id: string;
  instanceId: string;
  aiSessionId?: string;
};

export type ChatLookupInstance = {
  id: string;
  name: string;
  projectId?: string;
};

export type ChatActionTokenInput =
  | { type: "instance-app-menu" | "launch-app"; instanceId: string; appId?: string; ttlMs?: number }
  | { type: "pending-decision"; routeId: string; decision: "allow" | "deny" | "skip"; ttlMs?: number };

export type ChatSessionStoreDeps = {
  upsertChatSession: (input: Pick<ChatSessionBinding, "channel" | "chatSessionId"> & Partial<ChatSessionBinding>) => ChatSessionBinding;
};

export type ChatBoardDeps = {
  boardAsync: () => Promise<ChatBoardInstance[]>;
};

export type ChatAiSessionSnapshotDeps = {
  listAiSessions: (options?: { refresh?: boolean }) => Promise<{ instances: Array<{ instanceId: string; aiSessions: AiSessionsSnapshot }> }>;
};

export type ChatAppSessionSnapshotDeps = {
  listAppSessions: (options?: { refresh?: boolean }) => Promise<{ instances: Array<{ instanceId: string; appSessions: AppSessionsSnapshot }> }>;
};

export type ChatInstanceLookupDeps = {
  listNodeInstances: () => Promise<ControlledInstance[]>;
  requireControlledInstance: (id: string, includeSecret?: boolean) => Promise<ChatLookupInstance>;
};

export type ChatProjectLookupDeps = {
  requireProject: (id: string) => Project;
  getProject: (id: string) => Project | undefined;
  listProjects: () => Project[];
};

export type ChatPendingDeps = {
  listPendingRoutes: () => Promise<ChatPendingRoute[]>;
  pendingDecisionCallbackData: (routeId: string, decision: "allow" | "deny" | "skip") => string;
  resolveAiSessionApproval: (instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") => Promise<AiSessionActionResult>;
};

export type ChatAiSessionActionDeps = {
  sendAiSessionMessage: (instanceId: string, sessionId: string, message: string, mode?: "auto" | "queue" | "steer" | "immediate", attachments?: AiSessionMessageAttachment[]) => Promise<AiSessionActionResult>;
  interruptAiSession: (instanceId: string, sessionId: string) => Promise<AiSessionActionResult>;
};

export type ChatAppAccessDeps = {
  createChatActionToken: (input: ChatActionTokenInput) => ChatActionToken;
  createAppAccessToken: (input: { instanceId: string; sessionId: string; mode: AppAccessMode; ttlMs?: number }) => AppAccessToken;
  controlPlanePublicBaseUrl: () => string | undefined;
  launchAppSession: (instanceId: string, appId?: string, options?: Record<string, unknown>) => Promise<unknown>;
};
