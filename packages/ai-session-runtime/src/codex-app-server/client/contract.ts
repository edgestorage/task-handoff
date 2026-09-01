import type { EventEmitter } from "node:events";
import type { AiSessionApprovalInput, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";
import type { CodexApprovalRequest, CodexThread, CodexThreadItemEntry, CodexUserInput, JsonValue } from "../protocol/types";

type CodexApprovalDecision = AiSessionApprovalInput["decision"];

export type CodexTurnPermissionOverrides = {
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  permissions: ":workspace" | ":danger-full-access";
};

export type CodexThreadStartOptions = {
  cwd: string;
  historyMode?: "paginated";
  model?: string;
  modelProvider?: string;
  runtimeWorkspaceRoots?: string[];
  permissions?: CodexTurnPermissionOverrides;
  reasoningEffort?: AiSessionReasoningEffort;
  dynamicTools?: CodexDynamicToolSpec[];
};

export type CodexDynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

export type CodexDynamicToolCall = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string;
  tool: string;
  arguments: JsonValue;
};

export type CodexDynamicToolCallResult = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

export type CodexThreadForkOptions = {
  threadId: string;
  lastTurnId?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: AiSessionReasoningEffort;
};

export type CodexThreadResumeOptions = {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: AiSessionReasoningEffort;
};

export type CodexThreadSettings = {
  model?: string;
  effort?: AiSessionReasoningEffort;
};

export type CodexThreadSettingsResult = CodexThreadSettings & {
  modelProvider?: string;
};

export type CodexThreadForkCapabilities = {
  fullHistory: boolean;
  throughTurn: boolean;
};

export type CodexAppServerClientLike = EventEmitter & {
  start: () => Promise<void>;
  stop: () => void;
  listLoadedThreadIds: () => Promise<string[]>;
  threadForkCapabilities?: () => CodexThreadForkCapabilities;
  startThread?: (options: CodexThreadStartOptions) => Promise<CodexThread>;
  updateThreadSettings?: (threadId: string, settings: CodexThreadSettings) => Promise<CodexThreadSettingsResult>;
  supportsThreadSettingsUpdate?: () => boolean;
  forkThread?: (options: CodexThreadForkOptions) => Promise<CodexThread>;
  readThread?: (threadId: string, options?: { includeTurns?: boolean }) => Promise<CodexThread | undefined>;
  listThreadItems?: (threadId: string, turnId?: string) => Promise<CodexThreadItemEntry[] | undefined>;
  supportsPaginatedTimeline?: () => boolean;
  listThreads?: () => Promise<CodexThread[]>;
  activeThreadExists?: (threadId: string) => Promise<boolean>;
  startTurn?: (threadId: string, message: string, inputs?: CodexUserInput[], permissions?: CodexTurnPermissionOverrides) => Promise<{ turnId?: string }>;
  steerTurn?: (threadId: string, turnId: string, message: string, inputs?: CodexUserInput[]) => Promise<{ turnId?: string }>;
  listSkills?: (cwd: string) => Promise<JsonValue>;
  listPlugins?: (cwd: string) => Promise<JsonValue>;
  listApps?: (threadId: string) => Promise<JsonValue>;
  startFuzzyFileSearch?: (sessionId: string, cwd: string) => Promise<void>;
  updateFuzzyFileSearch?: (sessionId: string, query: string) => Promise<void>;
  stopFuzzyFileSearch?: (sessionId: string) => Promise<void>;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
  resumeThread?: (threadId: string, options?: CodexThreadResumeOptions) => Promise<CodexThread | undefined>;
  archiveThread?: (threadId: string) => Promise<void>;
  unarchiveThread?: (threadId: string) => Promise<void>;
  deleteThread?: (threadId: string) => Promise<void>;
  unsubscribeThread?: (threadId: string) => Promise<void>;
  startReview?: (threadId: string) => Promise<{ turnId?: string }>;
  setThreadName?: (threadId: string, name: string) => Promise<void>;
  setThreadGoal?: (threadId: string, objective: string) => Promise<JsonValue>;
  getThreadGoal?: (threadId: string) => Promise<JsonValue>;
  compactThread?: (threadId: string) => Promise<void>;
  respondToApproval?: (request: CodexApprovalRequest, decision: CodexApprovalDecision) => Promise<void>;
};
