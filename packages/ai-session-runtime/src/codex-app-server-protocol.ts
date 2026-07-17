import type { AiSessionLifecycle, AiSessionPhase, AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { isSyntheticUserTranscriptText } from "@task-handoff/core/core/transcript";
import type { AiSessionApprovalDecision } from "./ai-session-control";

export type JsonValue = Record<string, unknown>;

export type CodexThreadStatus = {
  type?: unknown;
  activeFlags?: unknown;
};

export type CodexThread = {
  id?: unknown;
  cwd?: unknown;
  name?: unknown;
  preview?: unknown;
  ephemeral?: unknown;
  path?: unknown;
  status?: CodexThreadStatus;
  turns?: unknown;
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

export type CodexAppServerEvent =
  | { type: "thread"; thread: CodexThread }
  | { type: "thread-status"; threadId: string; status: CodexThreadStatus }
  | { type: "thread-closed"; threadId: string }
  | { type: "turn-started"; threadId: string; turnId?: string }
  | { type: "turn-completed"; threadId: string; turnId?: string; status?: string; error?: string }
  | { type: "approval-request"; request: CodexApprovalRequest }
  | { type: "tool-item-started"; threadId: string; turnId?: string; tool: CodexToolDescriptor }
  | { type: "tool-item-completed"; threadId: string; turnId?: string; tool: CodexToolDescriptor }
  | { type: "user-message"; threadId: string; turnId?: string; text: string }
  | { type: "agent-message-delta"; threadId: string; turnId?: string; itemId?: string; delta: string }
  | { type: "agent-message-completed"; threadId: string; turnId?: string; text: string };

export function codexNotification(method: string, params: JsonValue): CodexAppServerEvent | undefined {
  if (method === "thread/started") {
    const thread = params.thread && typeof params.thread === "object" ? params.thread as CodexThread : undefined;
    return thread ? { type: "thread", thread } : undefined;
  }
  if (method === "thread/status/changed" && typeof params.threadId === "string") {
    return { type: "thread-status", threadId: params.threadId, status: (params.status || {}) as CodexThreadStatus };
  }
  if (method === "thread/closed" && typeof params.threadId === "string") {
    return { type: "thread-closed", threadId: params.threadId };
  }
  if (method === "turn/started" && typeof params.threadId === "string") {
    const turn = params.turn && typeof params.turn === "object" ? params.turn as JsonValue : {};
    return { type: "turn-started", threadId: params.threadId, turnId: typeof turn.id === "string" ? turn.id : undefined };
  }
  if (method === "turn/completed" && typeof params.threadId === "string") {
    const turn = params.turn && typeof params.turn === "object" ? params.turn as JsonValue : {};
    const error = turnErrorMessage(turn.error);
    return {
      type: "turn-completed",
      threadId: params.threadId,
      turnId: typeof turn.id === "string" ? turn.id : undefined,
      status: typeof turn.status === "string" ? turn.status : undefined,
      error,
    };
  }
  if ((method === "item/started" || method === "item/completed") && typeof params.threadId === "string") {
    const item = params.item && typeof params.item === "object" ? params.item as JsonValue : {};
    if (item.type === "userMessage") {
      const text = textFromUserMessageItem(item);
      return text
        ? {
            type: "user-message",
            threadId: params.threadId,
            turnId: typeof params.turnId === "string" ? params.turnId : undefined,
            text,
          }
        : undefined;
    }
    const tool = codexToolDescriptor(
      item,
      method === "item/started" && typeof params.startedAtMs === "number" ? params.startedAtMs : undefined,
    );
    if (tool) {
      return {
        type: method === "item/started" ? "tool-item-started" : "tool-item-completed",
        threadId: params.threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        tool,
      };
    }
  }
  if (method === "item/agentMessage/delta" && typeof params.threadId === "string" && typeof params.delta === "string") {
    return {
      type: "agent-message-delta",
      threadId: params.threadId,
      turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      itemId: typeof params.itemId === "string" ? params.itemId : undefined,
      delta: params.delta,
    };
  }
  if (method === "item/completed" && typeof params.threadId === "string") {
    const item = params.item && typeof params.item === "object" ? params.item as JsonValue : {};
    if (item.type === "agentMessage" && typeof item.text === "string") {
      return {
        type: "agent-message-completed",
        threadId: params.threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        text: item.text,
      };
    }
  }
  return undefined;
}

export function codexThreadItemKind(item: JsonValue): "tool" | "non-tool" | "unknown" {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "sleep":
    case "imageGeneration":
      return "tool";
    case "userMessage":
    case "hookPrompt":
    case "agentMessage":
    case "plan":
    case "reasoning":
    case "subAgentActivity":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return "non-tool";
    default:
      return "unknown";
  }
}

export function codexToolDescriptor(item: JsonValue, startedAtMs?: number): CodexToolDescriptor | undefined {
  const classification = codexThreadItemKind(item);
  if (classification === "non-tool") return undefined;
  if (classification === "unknown") {
    if (typeof item.type === "string" && item.type) {
      console.warn(`[codex-app-server] ignoring unknown ThreadItem.type: ${item.type}`);
    }
    return undefined;
  }
  const id = stringField(item, "id");
  const kind = stringField(item, "type");
  if (!id || !kind) return undefined;
  const projected = projectCodexTool(item, kind);
  return {
    id,
    kind,
    name: projected.name,
    inputPreview: compactToolPreview(projected.inputPreview),
    startedAt: isoTimestampFromMs(startedAtMs),
  };
}

function isoTimestampFromMs(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function projectCodexTool(item: JsonValue, kind: string): { name: string; inputPreview?: string } {
  switch (kind) {
    case "commandExecution":
      return { name: "Command", inputPreview: stringField(item, "command") };
    case "fileChange": {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change) => stringField(asRecord(change), "path")).filter((path): path is string => Boolean(path))
        : [];
      return { name: "File change", inputPreview: [...new Set(paths)].join(", ") || undefined };
    }
    case "mcpToolCall": {
      const server = stringField(item, "server");
      const tool = stringField(item, "tool") || "Tool";
      return { name: server ? `${server} · ${tool}` : tool, inputPreview: safeJsonPreview(item.arguments) };
    }
    case "dynamicToolCall": {
      const namespace = stringField(item, "namespace");
      const tool = stringField(item, "tool") || "Tool";
      return { name: namespace ? `${namespace} · ${tool}` : tool, inputPreview: safeJsonPreview(item.arguments) };
    }
    case "collabAgentToolCall": {
      const tool = stringField(item, "tool") || "collabAgentToolCall";
      const names: Record<string, string> = {
        spawnAgent: "Spawn agent",
        sendInput: "Send agent input",
        resumeAgent: "Resume agent",
        wait: "Wait for agents",
        closeAgent: "Close agent",
      };
      return { name: names[tool] || tool, inputPreview: stringField(item, "prompt") };
    }
    case "webSearch":
      return { name: "Web search", inputPreview: stringField(item, "query") };
    case "imageView":
      return { name: "View image", inputPreview: stringField(item, "path") };
    case "sleep":
      return { name: "Sleep", inputPreview: typeof item.durationMs === "number" ? `${item.durationMs} ms` : undefined };
    case "imageGeneration":
      return { name: "Image generation", inputPreview: stringField(item, "revisedPrompt") };
    default:
      return { name: kind };
  }
}

function compactToolPreview(value: string | undefined) {
  const compacted = value?.replace(/\s+/g, " ").trim();
  if (!compacted) return undefined;
  return compacted.length > 500 ? `${compacted.slice(0, 497)}...` : compacted;
}

function safeJsonPreview(value: unknown) {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function explicitToolActivity(item: JsonValue): "active" | "inactive" | "unknown" {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "imageGeneration":
      return item.status === "inProgress" ? "active" : typeof item.status === "string" ? "inactive" : "unknown";
    case "webSearch":
    case "imageView":
    case "sleep":
      return "unknown";
    default:
      return "inactive";
  }
}

export class CodexToolActivityTracker {
  private readonly seenToolIds = new Set<string>();
  private readonly activeTools = new Map<string, CodexToolDescriptor>();

  replace(state: CodexToolActivityState) {
    this.seenToolIds.clear();
    this.activeTools.clear();
    for (const id of state.seenToolIds) this.seenToolIds.add(id);
    for (const tool of state.activeTools) this.activeTools.set(tool.id, tool);
    return this.snapshot();
  }

  started(tool: CodexToolDescriptor) {
    if (this.seenToolIds.has(tool.id)) return this.snapshot();
    this.seenToolIds.add(tool.id);
    this.activeTools.set(tool.id, tool);
    return this.snapshot();
  }

  completed(tool: CodexToolDescriptor) {
    this.seenToolIds.add(tool.id);
    this.activeTools.delete(tool.id);
    return this.snapshot();
  }

  restoreActive(tool: CodexToolDescriptor) {
    this.seenToolIds.add(tool.id);
    this.activeTools.delete(tool.id);
    this.activeTools.set(tool.id, tool);
    return this.snapshot();
  }

  resetForAgentMessage() {
    this.seenToolIds.clear();
    this.activeTools.clear();
    return this.snapshot();
  }

  clearActiveTools() {
    this.activeTools.clear();
    return this.snapshot();
  }

  snapshot(): CodexToolActivityState {
    const activeTools = [...this.activeTools.values()];
    return {
      seenToolIds: [...this.seenToolIds],
      activeTools,
      toolCallsSinceLastMessage: this.seenToolIds.size,
      currentTool: activeTools.at(-1),
    };
  }
}

export function rebuildCodexToolActivity(thread: CodexThread): CodexToolActivityState {
  const tracker = new CodexToolActivityTracker();
  let lastItemAfterBoundary: { item: JsonValue; tool?: CodexToolDescriptor } | undefined;
  let lastTurnActive = false;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn);
    lastTurnActive = turn.status === "inProgress";
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (item.type === "agentMessage") {
        tracker.resetForAgentMessage();
        lastItemAfterBoundary = undefined;
        continue;
      }
      const tool = codexToolDescriptor(item);
      lastItemAfterBoundary = { item, tool };
      if (!tool) continue;
      const activity = explicitToolActivity(item);
      if (activity === "active") tracker.started(tool);
      else tracker.completed(tool);
    }
  }
  const threadActive = thread.status?.type === "active";
  if (threadActive && lastTurnActive && lastItemAfterBoundary?.tool && explicitToolActivity(lastItemAfterBoundary.item) === "unknown") {
    tracker.restoreActive(lastItemAfterBoundary.tool);
  }
  return tracker.snapshot();
}

export function codexApprovalRequest(id: number, method: string, params: JsonValue): CodexApprovalRequest | undefined {
  if (method === "item/commandExecution/requestApproval") {
    const threadId = stringField(params, "threadId");
    if (!threadId) {
      return undefined;
    }
    const command = stringField(params, "command");
    const reason = stringField(params, "reason");
    return {
      id,
      method,
      kind: "command",
      threadId,
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      summary: reason || (command ? `Approve command: ${command}` : "Codex is requesting command approval."),
      params,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const threadId = stringField(params, "threadId");
    if (!threadId) {
      return undefined;
    }
    const grantRoot = stringField(params, "grantRoot");
    return {
      id,
      method,
      kind: "file-change",
      threadId,
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      summary: stringField(params, "reason") || (grantRoot ? `Approve file changes under ${grantRoot}` : "Codex is requesting file change approval."),
      params,
    };
  }
  if (method === "item/permissions/requestApproval") {
    const threadId = stringField(params, "threadId");
    if (!threadId) {
      return undefined;
    }
    return {
      id,
      method,
      kind: "permissions",
      threadId,
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      summary: stringField(params, "reason") || "Codex is requesting additional permissions.",
      params,
    };
  }
  return undefined;
}

export function approvalResponseForRequest(request: CodexApprovalRequest, decision: AiSessionApprovalDecision): JsonValue {
  if (request.kind === "command") {
    return { decision: decision === "allow" ? "accept" : decision === "skip" ? "cancel" : "decline" };
  }
  if (request.kind === "file-change") {
    return { decision: decision === "allow" ? "accept" : decision === "skip" ? "cancel" : "decline" };
  }
  if (decision !== "allow") {
    return { permissions: {}, scope: "turn" };
  }
  const requested = asRecord(request.params.permissions);
  const fileSystem = asRecord(requested.fileSystem);
  return {
    permissions: {
      ...(requested.network ? { network: requested.network } : {}),
      ...(Object.keys(fileSystem).length
        ? {
            fileSystem: {
              ...(Array.isArray(fileSystem.read) ? { read: fileSystem.read } : {}),
              ...(Array.isArray(fileSystem.write) ? { write: fileSystem.write } : {}),
              ...(Array.isArray(fileSystem.entries) ? { entries: fileSystem.entries } : {}),
              ...(fileSystem.globScanMaxDepth ? { globScanMaxDepth: fileSystem.globScanMaxDepth } : {}),
            },
          }
        : {}),
    },
    scope: "turn",
  };
}

export function approvalDecisionVerb(decision: AiSessionApprovalDecision) {
  if (decision === "allow") {
    return "allowed";
  }
  if (decision === "deny") {
    return "denied";
  }
  return "skipped";
}

export function asRecord(value: unknown): JsonValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonValue : {};
}

function turnErrorMessage(value: unknown) {
  const error = asRecord(value);
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const details = typeof error.additionalDetails === "string" ? error.additionalDetails.trim() : "";
  if (message && details) {
    return `${message}\n\n${details}`;
  }
  return message || details || undefined;
}

export function summarizeThreadTurns(thread: CodexThread): {
  activeTurnId?: string;
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  summary?: string;
  lastMessage?: string;
  toolActivity: CodexToolActivityState;
} {
  let activeTurnId: string | undefined;
  let userPrompt: string | undefined;
  let lastMessage: string | undefined;
  const historyTurns: NonNullable<AiSessionStatus["turns"]> = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const [index, turn] of turns.entries()) {
    const record = asRecord(turn);
    const turnId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `turn_${index}`;
    const providerStatus = typeof record.status === "string" ? record.status : "completed";
    const historyTurn: NonNullable<AiSessionStatus["turns"]>[number] = {
      id: turnId,
      status: providerStatus === "inProgress" ? "running" : providerStatus === "failed" ? "failed" : "completed",
      revision: 0,
    };
    if (providerStatus === "inProgress") {
      activeTurnId = turnId;
    }
    const items = Array.isArray(record.items) ? record.items as unknown[] : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (item.type === "userMessage") {
        const text = textFromUserMessageItem(item);
        if (text && !isSyntheticUserTranscriptText(text)) {
          userPrompt = text;
          historyTurn.userPrompt = text;
        }
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        lastMessage = item.text.trim();
        historyTurn.lastMessage = lastMessage;
        historyTurn.summary = lastMessage.length > 1000 ? `${lastMessage.slice(0, 997)}...` : lastMessage;
      }
    }
    if (historyTurn.userPrompt || historyTurn.lastMessage || historyTurn.summary) {
      historyTurns.push(historyTurn);
    }
  }
  return {
    activeTurnId,
    userPrompt,
    turns: historyTurns,
    summary: lastMessage,
    lastMessage,
    toolActivity: rebuildCodexToolActivity(thread),
  };
}

export function turnIdFromResult(result: JsonValue) {
  const turn = result.turn && typeof result.turn === "object" ? result.turn as JsonValue : undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}

export function isNoActiveTurnError(error: unknown) {
  return error instanceof Error && /no active turn/i.test(error.message);
}

export function activeTurnMismatchFoundId(error: unknown) {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return error.message.match(/expected active turn id `[^`]+` but found `([^`]+)`/i)?.[1];
}

export async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

export function lifecycleForStatus(status: CodexThreadStatus): { status: AiSessionLifecycle; phase: AiSessionPhase } {
  const type = String(status.type || "");
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags.map(String) : [];
  if (type === "active" && flags.includes("waitingOnApproval")) {
    return { status: "waiting", phase: "approval" };
  }
  if (type === "active" && flags.includes("waitingOnUserInput")) {
    return { status: "waiting", phase: "thinking" };
  }
  if (type === "active") {
    return { status: "running", phase: "thinking" };
  }
  if (type === "systemError") {
    return { status: "failed", phase: "unknown" };
  }
  return { status: "idle", phase: "unknown" };
}

function stringField(record: JsonValue, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function textFromUserInput(value: unknown) {
  const input = asRecord(value);
  return input.type === "text" && typeof input.text === "string" ? input.text.trim() : "";
}

function textFromUserMessageItem(item: JsonValue) {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map(textFromUserInput).filter(Boolean).join("\n").trim();
}
