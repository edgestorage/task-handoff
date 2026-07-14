import type { PendingItem, PendingViewItem, QueuedReply, QueuedReplyViewItem } from "../types";

export function toPendingView(item: PendingItem): PendingViewItem {
  return {
    id: item.id,
    conversationId: item.conversationId,
    visibleConversationIds: item.visibleConversationIds,
    result: item.result,
    timeoutMs: item.timeoutMs,
    source: item.source,
    kind: item.kind,
  };
}

export function toQueuedReplyView(item: QueuedReply & { label?: string }): QueuedReplyViewItem {
  return {
    id: item.id,
    conversationId: item.conversationId,
    value: item.value,
    label: item.label,
  };
}

export function parseTaskId(value: unknown) {
  const match = String(value || "").match(/^#?(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export function splitTaskScopedText(rest: string) {
  const [first, ...parts] = rest.trim().split(/\s+/);
  const id = parseTaskId(first);
  if (!id) {
    return { text: rest.trim() };
  }
  return { id, text: parts.join(" ").trim() };
}
