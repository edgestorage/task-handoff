import type { AiSessionReasoningEffort, AiSessionSubAgent } from "@task-handoff/protocol/ai-sessions";

export type JsonValue = Record<string, unknown>;
export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };
export type CodexThreadStatus = {
  type?: unknown;
  activeFlags?: unknown;
};
export type CodexThread = {
  id?: unknown;
  sessionId?: unknown;
  forkedFromId?: unknown;
  cwd?: unknown;
  name?: unknown;
  preview?: unknown;
  ephemeral?: unknown;
  historyMode?: unknown;
  path?: unknown;
  status?: CodexThreadStatus;
  turns?: unknown;
  /** Authoritative values returned beside thread snapshots by start/resume/fork. */
  model?: unknown;
  modelProvider?: unknown;
  reasoningEffort?: AiSessionReasoningEffort | unknown;
};
export type CodexThreadItemEntry = {
  turnId: string;
  item: JsonValue;
};
export type CodexApprovalKind = "command" | "file-change" | "permissions";
export type CodexApprovalRequest = {
  id: number;
  method: string;
  kind: CodexApprovalKind;
  threadId: string;
  turnId?: string;
  itemId?: string;
  summary: string;
  params: JsonValue;
};
export type CodexToolDescriptor = {
  id: string;
  kind: string;
  name: string;
  inputPreview?: string;
  startedAt?: string;
};
export type CodexToolActivityState = {
  seenToolIds: string[];
  activeTools: CodexToolDescriptor[];
  toolCallsSinceLastMessage: number;
  currentTool?: CodexToolDescriptor;
};
export type CodexSubAgentUpdate = Omit<AiSessionSubAgent, "updatedAt"> & {
  observation: "state" | "activity";
  observedAt?: string;
};
export type CodexAppServerEvent =
  | { type: "thread"; thread: CodexThread }
  | { type: "thread-status"; threadId: string; status: CodexThreadStatus }
  | { type: "thread-closed"; threadId: string }
  | { type: "thread-name"; threadId: string; name: string }
  | { type: "turn-started"; threadId: string; turnId?: string; observedAt?: string }
  | { type: "turn-error"; threadId: string; turnId: string; error: string; willRetry: boolean }
  | { type: "turn-completed"; threadId: string; turnId?: string; status?: string; error?: string; observedAt?: string }
  | { type: "thread-error"; threadId: string; error: string }
  | { type: "context-compaction"; threadId: string; turnId: string; itemId: string; status: "running" | "completed"; observedAt?: string; timelineItem?: JsonValue }
  | { type: "approval-request"; request: CodexApprovalRequest }
  | { type: "tool-item-started"; threadId: string; turnId?: string; item: JsonValue; timelineItem: JsonValue; tool: CodexToolDescriptor; subAgents?: CodexSubAgentUpdate[] }
  | { type: "tool-item-completed"; threadId: string; turnId?: string; item: JsonValue; timelineItem: JsonValue; tool: CodexToolDescriptor; subAgents?: CodexSubAgentUpdate[] }
  | { type: "sub-agent-activity"; threadId: string; turnId?: string; timelineItem: JsonValue; subAgent: CodexSubAgentUpdate }
  | { type: "user-message"; threadId: string; turnId?: string; itemId: string; timelineItem: JsonValue; text: string }
  | { type: "timeline-item"; threadId: string; turnId: string; timelineItem: JsonValue }
  | { type: "agent-message-delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "agent-message-completed"; threadId: string; turnId?: string; itemId: string; timelineItem: JsonValue; text: string };
