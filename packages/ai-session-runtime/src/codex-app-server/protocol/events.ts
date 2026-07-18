import { codexSubAgentUpdates, codexToolDescriptor, isoTimestampFromMs } from "./items";
import type { CodexAppServerEvent, CodexThread, CodexThreadStatus, JsonValue } from "./types";
import { asRecord } from "./values";

export function codexNotification(method: string, params: JsonValue): CodexAppServerEvent | undefined {
  if (method === "thread/started") {
    const thread = params.thread && typeof params.thread === "object" ? params.thread as CodexThread : undefined;
    return thread ? { type: "thread", thread } : undefined;
  }
  if (method === "thread/status/changed" && typeof params.threadId === "string") return { type: "thread-status", threadId: params.threadId, status: (params.status || {}) as CodexThreadStatus };
  if (method === "thread/closed" && typeof params.threadId === "string") return { type: "thread-closed", threadId: params.threadId };
  if (method === "turn/started" && typeof params.threadId === "string") {
    const turn = asRecord(params.turn);
    return { type: "turn-started", threadId: params.threadId, turnId: typeof turn.id === "string" ? turn.id : undefined };
  }
  if (method === "turn/completed" && typeof params.threadId === "string") {
    const turn = asRecord(params.turn);
    return { type: "turn-completed", threadId: params.threadId, turnId: typeof turn.id === "string" ? turn.id : undefined, status: typeof turn.status === "string" ? turn.status : undefined, error: turnErrorMessage(turn.error) };
  }
  if ((method === "item/started" || method === "item/completed") && typeof params.threadId === "string") {
    const item = asRecord(params.item);
    if (item.type === "userMessage") {
      const text = textFromUserMessageItem(item);
      return text ? { type: "user-message", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, text } : undefined;
    }
    const observedAt = isoTimestampFromMs(method === "item/started" ? params.startedAtMs as number | undefined : params.completedAtMs as number | undefined);
    const subAgents = codexSubAgentUpdates(item).map((subAgent) => observedAt ? { ...subAgent, observedAt } : subAgent);
    if (item.type === "subAgentActivity" && subAgents[0]) return { type: "sub-agent-activity", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, subAgent: subAgents[0] };
    const tool = codexToolDescriptor(item, method === "item/started" && typeof params.startedAtMs === "number" ? params.startedAtMs : undefined);
    if (tool) return { type: method === "item/started" ? "tool-item-started" : "tool-item-completed", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, tool, subAgents: subAgents.length ? subAgents : undefined };
  }
  if (method === "item/agentMessage/delta" && typeof params.threadId === "string" && typeof params.delta === "string") return { type: "agent-message-delta", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, itemId: typeof params.itemId === "string" ? params.itemId : undefined, delta: params.delta };
  if (method === "item/completed" && typeof params.threadId === "string") {
    const item = asRecord(params.item);
    if (item.type === "agentMessage" && typeof item.text === "string") return { type: "agent-message-completed", threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : undefined, text: item.text };
  }
  return undefined;
}

function turnErrorMessage(value: unknown) { const error = asRecord(value); const message = typeof error.message === "string" ? error.message.trim() : ""; const details = typeof error.additionalDetails === "string" ? error.additionalDetails.trim() : ""; return message && details ? `${message}\n\n${details}` : message || details || undefined; }
function textFromUserMessageItem(item: JsonValue) { const content = Array.isArray(item.content) ? item.content : []; return content.map((value) => { const input = asRecord(value); return input.type === "text" && typeof input.text === "string" ? input.text.trim() : ""; }).filter(Boolean).join("\n").trim(); }
