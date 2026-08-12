import type { EventEmitter } from "node:events";
import type { AiSessionApprovalInput } from "@task-handoff/protocol/ai-sessions";
import type { CodexApprovalRequest, CodexThread, CodexUserInput, JsonValue } from "../protocol/types";

type CodexApprovalDecision = AiSessionApprovalInput["decision"];

export type CodexTurnPermissionOverrides = {
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  permissions: ":workspace" | ":danger-full-access";
};

export type CodexThreadStartOptions = {
  cwd: string;
  model?: string;
  modelProvider?: string;
  runtimeWorkspaceRoots?: string[];
  permissions?: CodexTurnPermissionOverrides;
};

export type CodexThreadForkOptions = {
  threadId: string;
  lastTurnId?: string;
  cwd?: string;
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
  forkThread?: (options: CodexThreadForkOptions) => Promise<CodexThread>;
  readThread?: (threadId: string, options?: { includeTurns?: boolean }) => Promise<CodexThread | undefined>;
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
  resumeThread?: (threadId: string) => Promise<CodexThread | undefined>;
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
