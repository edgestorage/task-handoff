import { normalizeCliMarkdown } from "@task-handoff/core/core/text";
import type { SenderAttachment } from "@task-handoff/core/core/attachments";
import { waitingForTaskMessage } from "@task-handoff/protocol/sender";
import { codexIdFromMessage, claudeIdFromMessage } from "../state/bindings";
import { buildConversationBindingPatch, buildSessionConversationBindingPatch } from "../state/conversation-bindings";
import { formatTimeoutTargetReply } from "../state/timeout";
import type { ConversationActivity } from "../state/activity";
import type { IncomingResultMessage, PendingItem, ReceiverSocket } from "../types";

type IncomingResultKind = "task" | "approval";

type IncomingResultEnvelope = {
  source: "cli" | "mcp";
  normalizedResult: string;
  attachments: SenderAttachment[];
  kind: IncomingResultKind;
  visibleConversationIds: number[];
  bindingConversationId: number;
  isReadyResult: boolean;
};

type CreateIncomingResultEnvelopeOptions = {
  message: IncomingResultMessage;
  conversationId: number;
  visibleConversationIdsForApproval: (message: IncomingResultMessage, conversationId: number) => number[];
  bindingConversationIdForApproval: (message: IncomingResultMessage, fallbackConversationId: number, visibleConversationIds: number[]) => number;
};

type CreateIncomingPendingItemOptions = IncomingResultEnvelope & {
  id: number;
  conversationId: number;
  socket: ReceiverSocket;
  message: IncomingResultMessage;
  timeoutMs: number;
};

function createIncomingResultEnvelope({
  message,
  conversationId,
  visibleConversationIdsForApproval,
  bindingConversationIdForApproval,
}: CreateIncomingResultEnvelopeOptions): IncomingResultEnvelope {
  const normalizedResult = normalizeCliMarkdown(message.result);
  const attachments = Array.isArray(message.attachments) ? (message.attachments as SenderAttachment[]) : [];
  const kind = message.kind === "approval" ? "approval" : "task";
  const visibleConversationIds = kind === "approval" ? visibleConversationIdsForApproval(message, conversationId) : [conversationId];
  const bindingConversationId =
    kind === "approval"
      ? bindingConversationIdForApproval(message, conversationId, visibleConversationIds)
      : conversationId;

  return {
    source: message.source === "mcp" ? "mcp" : "cli",
    normalizedResult,
    attachments,
    kind,
    visibleConversationIds,
    bindingConversationId,
    isReadyResult: normalizedResult.trim().toLowerCase() === "ready",
  };
}

function createIncomingPendingItem({
  id,
  conversationId,
  visibleConversationIds,
  socket,
  normalizedResult,
  attachments,
  timeoutMs,
  source,
  kind,
  message,
}: CreateIncomingPendingItemOptions): PendingItem {
  return {
    id,
    conversationId,
    visibleConversationIds,
    socket,
    result: normalizedResult,
    attachments,
    timeoutMs,
    source,
    kind,
    codexId: codexIdFromMessage(message),
    claudeId: claudeIdFromMessage(message),
    cwd: message.cwd,
    autoTimer: undefined,
  };
}

function incomingResultBindingPatch(
  message: IncomingResultMessage,
  kind: IncomingResultKind,
  bindingConversationId: number,
  conversationActivity: ConversationActivity,
) {
  return {
    ...(kind === "approval"
      ? buildSessionConversationBindingPatch(message, bindingConversationId)
      : buildConversationBindingPatch(message, bindingConversationId)),
    conversationActivity,
  };
}

function incomingDeliveryConversationIds(item: PendingItem) {
  return item.kind === "approval" ? item.visibleConversationIds || [] : [item.conversationId];
}

function incomingTimeoutReply(source: string, timeoutTarget?: string) {
  return timeoutTarget !== undefined
    ? formatTimeoutTargetReply(timeoutTarget, source)
    : waitingForTaskMessage(source === "mcp" ? "mcp" : "cli");
}

export {
  createIncomingPendingItem,
  createIncomingResultEnvelope,
  incomingDeliveryConversationIds,
  incomingResultBindingPatch,
  incomingTimeoutReply,
};
