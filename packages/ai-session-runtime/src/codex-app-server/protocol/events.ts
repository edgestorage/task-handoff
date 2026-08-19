import { codexSubAgentUpdates, codexToolDescriptor, isoTimestampFromMs, isoTimestampFromSeconds } from "./items";
import type { CodexAppServerEvent, CodexThread, CodexThreadStatus, JsonValue } from "./types";
import { asRecord } from "./values";

export function codexNotification(method: string, params: JsonValue): CodexAppServerEvent | undefined {
  if (method === "thread/started") {
    const thread = params.thread && typeof params.thread === "object" ? params.thread as CodexThread : undefined;
    return thread ? { type: "thread", thread } : undefined;
  }
  if (method === "thread/status/changed" && typeof params.threadId === "string") return { type: "thread-status", threadId: params.threadId, status: (params.status || {}) as CodexThreadStatus };
  if (method === "thread/closed" && typeof params.threadId === "string") return { type: "thread-closed", threadId: params.threadId };
  if (method === "thread/name/updated" && typeof params.threadId === "string" && typeof params.threadName === "string") return { type: "thread-name", threadId: params.threadId, name: params.threadName };
  if (method === "thread/compacted" && typeof params.threadId === "string" && typeof params.turnId === "string") {
    return { type: "context-compaction", threadId: params.threadId, turnId: params.turnId, itemId: `context_compaction:${params.turnId}`, status: "completed" };
  }
  if (method === "turn/started" && typeof params.threadId === "string") {
    const turn = asRecord(params.turn);
    const observedAt = isoTimestampFromSeconds(turn.startedAt);
    return { type: "turn-started", threadId: params.threadId, turnId: typeof turn.id === "string" ? turn.id : undefined, ...(observedAt ? { observedAt } : {}) };
  }
  if (method === "error" && typeof params.threadId === "string" && typeof params.turnId === "string") {
    const error = codexTurnErrorMessage(params.error);
    return error ? {
      type: "turn-error",
      threadId: params.threadId,
      turnId: params.turnId,
      error,
      willRetry: params.willRetry === true,
    } : undefined;
  }
  if (method === "turn/completed" && typeof params.threadId === "string") {
    const turn = asRecord(params.turn);
    const observedAt = isoTimestampFromSeconds(turn.completedAt);
    return { type: "turn-completed", threadId: params.threadId, turnId: typeof turn.id === "string" ? turn.id : undefined, status: typeof turn.status === "string" ? turn.status : undefined, error: codexTurnErrorMessage(turn.error), ...(observedAt ? { observedAt } : {}) };
  }
  if (method === "thread/realtime/error" && typeof params.threadId === "string" && typeof params.message === "string" && params.message.trim()) {
    return { type: "thread-error", threadId: params.threadId, error: params.message.trim() };
  }
  if ((method === "item/started" || method === "item/completed") && typeof params.threadId === "string") {
    const item = asRecord(params.item);
    if (item.type === "reasoning") return undefined;
    if (item.type === "contextCompaction" && typeof params.turnId === "string" && typeof item.id === "string") {
      const observedAt = isoTimestampFromMs(method === "item/started" ? params.startedAtMs as number | undefined : params.completedAtMs as number | undefined);
      return {
        type: "context-compaction",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: `context_compaction:${params.turnId}`,
        status: method === "item/started" ? "running" : "completed",
        observedAt,
        timelineItem: withItemStatus(item, method),
      };
    }
    if (item.type === "userMessage") {
      const text = textFromUserMessageItem(item);
      return text && typeof item.id === "string" ? { type: "user-message", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, itemId: item.id, timelineItem: withItemStatus(item, method), text } : undefined;
    }
    const observedAt = isoTimestampFromMs(method === "item/started" ? params.startedAtMs as number | undefined : params.completedAtMs as number | undefined);
    const subAgents = codexSubAgentUpdates(item).map((subAgent) => observedAt ? { ...subAgent, observedAt } : subAgent);
    if (item.type === "subAgentActivity" && subAgents[0]) return { type: "sub-agent-activity", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, timelineItem: withItemStatus(item, method), subAgent: subAgents[0] };
    const tool = codexToolDescriptor(item, method === "item/started" && typeof params.startedAtMs === "number" ? params.startedAtMs : undefined);
    if (tool) return { type: method === "item/started" ? "tool-item-started" : "tool-item-completed", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, item, timelineItem: withItemStatus(item, method), tool, subAgents: subAgents.length ? subAgents : undefined };
    if (item.type !== "agentMessage" && typeof params.turnId === "string" && typeof item.id === "string") return { type: "timeline-item", threadId: params.threadId, turnId: params.turnId, timelineItem: withItemStatus(item, method) };
  }
  if (method === "item/agentMessage/delta" && typeof params.threadId === "string" && typeof params.turnId === "string" && typeof params.itemId === "string" && typeof params.delta === "string") return { type: "agent-message-delta", threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta };
  if (method === "item/completed" && typeof params.threadId === "string") {
    const item = asRecord(params.item);
    if (item.type === "agentMessage" && typeof params.turnId === "string" && typeof item.id === "string" && typeof item.text === "string") return { type: "agent-message-completed", threadId: params.threadId, turnId: params.turnId, itemId: item.id, timelineItem: withItemStatus(item, method), text: item.text };
  }
  return undefined;
}

function withItemStatus(item: JsonValue, method: "item/started" | "item/completed"): JsonValue {
  return typeof item.status === "string" ? item : { ...item, status: method === "item/started" ? "inProgress" : "completed" };
}

export function codexTurnErrorMessage(value: unknown) {
  const error = asRecord(value);
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const details = typeof error.additionalDetails === "string" ? error.additionalDetails.trim() : "";
  const diagnostic = codexErrorInfoMessage(error.codexErrorInfo);
  return [message, details, diagnostic].filter((part, index, parts) => part && parts.indexOf(part) === index).join("\n\n") || undefined;
}

function codexErrorInfoMessage(value: unknown) {
  if (typeof value === "string" && value.trim()) return `Codex error: ${value.trim()}`;
  const info = asRecord(value);
  const [code, rawDetails] = Object.entries(info)[0] || [];
  if (!code) return "";
  const infoDetails = asRecord(rawDetails);
  const status = typeof infoDetails.httpStatusCode === "number" ? infoDetails.httpStatusCode : undefined;
  return `Codex error: ${code}${status ? ` (HTTP ${status})` : ""}`;
}
function textFromUserMessageItem(item: JsonValue) { const content = Array.isArray(item.content) ? item.content : []; return content.map((value) => { const input = asRecord(value); return input.type === "text" && typeof input.text === "string" ? input.text.trim() : ""; }).filter(Boolean).join("\n").trim(); }
