import type { EventEmitter } from "node:events";
import type { AiSessionApprovalInput } from "@task-handoff/protocol/ai-sessions";
import type { CodexApprovalRequest, CodexThread } from "../protocol/types";

type CodexApprovalDecision = AiSessionApprovalInput["decision"];

export type CodexAppServerClientLike = EventEmitter & {
  start: () => Promise<void>;
  stop: () => void;
  listLoadedThreadIds: () => Promise<string[]>;
  readThread?: (threadId: string, options?: { includeTurns?: boolean }) => Promise<CodexThread | undefined>;
  listThreads?: () => Promise<CodexThread[]>;
  startTurn?: (threadId: string, message: string) => Promise<{ turnId?: string }>;
  steerTurn?: (threadId: string, turnId: string, message: string) => Promise<{ turnId?: string }>;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
  resumeThread?: (threadId: string) => Promise<CodexThread | undefined>;
  respondToApproval?: (request: CodexApprovalRequest, decision: CodexApprovalDecision) => Promise<void>;
};
