import { AUTO_TARGET_SAFETY_MS } from "@task-handoff/core/core/config";
import { createChatApprovalPayload, createChatBridgeRegistry, createChatResultPayload, createChatTaskPayload, chatRoutesForConversation, deliverChatPayload } from "@task-handoff/core/core/chat";
import type { ChatRoute, ProgressItem } from "@task-handoff/core/core/chat";
import { encodeMessage } from "@task-handoff/core/core/protocol";
import { formatDuration } from "@task-handoff/terminal-ui";
import { patchSettings } from "@task-handoff/core/core/persistence";
import { markConversationActive, ownerKeysFromMessage, shouldAssignNewConversation } from "../state/activity";
import { toPendingView } from "../state/pending";
import { addResultHistory } from "../state/result-history";
import type { AiSessionRegistry } from "@task-handoff/ai-session-runtime";
import {
  createIncomingPendingItem,
  createIncomingResultEnvelope,
  incomingDeliveryConversationIds,
  incomingResultBindingPatch,
  incomingTimeoutReply,
} from "./incoming-result-workflow";
import type { ConversationActivity } from "../state/activity";
import type { ResultHistoryStore } from "../state/result-history";
import type {
  IncomingResultMessage,
  PendingItem,
  QueuedReply,
  ReceiverConversation,
  ReceiverLogFn,
  ReceiverProcessing,
  ReceiverRef,
  ReceiverSocket,
} from "../types";

type IncomingResultHandlerOptions = {
  aiSessions: AiSessionRegistry;
  addLog: ReceiverLogFn;
  bindingConversationIdForApproval: (message: IncomingResultMessage, fallbackConversationId: number, visibleConversationIds: number[]) => number;
  chatBridgesRef: ReceiverRef<ReturnType<typeof createChatBridgeRegistry>>;
  chatProgress: {
    markIntervening: (conversationId: number) => void;
    finishRoute: (route: unknown, conversationId: number, payload: unknown) => Promise<boolean>;
  };
  chatRoutes: () => ChatRoute[];
  completeProcessing: (conversationId: number) => void;
  conversationActivityRef: ReceiverRef<ConversationActivity>;
  createNextConversation: () => ReceiverConversation;
  defaultConversationIdRef: ReceiverRef<number>;
  defaultTimeoutMsRef: ReceiverRef<number>;
  getConversationTimeoutMs: (conversationId: number) => number;
  ensureConversation: (conversationId: number) => ReceiverConversation;
  nextIdRef: ReceiverRef<number>;
  pendingRef: ReceiverRef<PendingItem[]>;
  pruneInactiveConversations: () => number[];
  queuedRepliesRef: ReceiverRef<QueuedReply[]>;
  replyToItem: (item: PendingItem, value: string, label?: string, processing?: ReceiverProcessing) => unknown;
  setLatestResult: (item: ReturnType<typeof toPendingView>) => void;
  resultHistoryRef: ReceiverRef<ResultHistoryStore>;
  startChatProgress: (item: ProgressItem) => unknown;
  startProcessing: (conversationId: number, processing?: ReceiverProcessing) => void;
  syncConversations: (conversations: ReceiverConversation[]) => void;
  syncPending: () => void;
  syncQueuedReplies: () => void;
  timeoutTargetRef: ReceiverRef<string | undefined>;
  visibleConversationIdsForApproval: (message: IncomingResultMessage, conversationId: number) => number[];
  conversationsRef: ReceiverRef<ReceiverConversation[]>;
};

function createIncomingResultHandler({
  aiSessions,
  addLog,
  bindingConversationIdForApproval,
  chatBridgesRef,
  chatProgress,
  chatRoutes,
  completeProcessing,
  conversationActivityRef,
  createNextConversation,
  defaultConversationIdRef,
  defaultTimeoutMsRef,
  getConversationTimeoutMs,
  ensureConversation,
  nextIdRef,
  pendingRef,
  pruneInactiveConversations,
  queuedRepliesRef,
  replyToItem,
  setLatestResult,
  resultHistoryRef,
  startChatProgress,
  startProcessing,
  syncConversations,
  syncPending,
  syncQueuedReplies,
  timeoutTargetRef,
  visibleConversationIdsForApproval,
  conversationsRef,
}: IncomingResultHandlerOptions) {
  return (message: IncomingResultMessage, socket: ReceiverSocket) => {
    const prunedConversationIds = pruneInactiveConversations();
    let conversationId = Number(message.conversationId) || defaultConversationIdRef.current;
    const source = message.source === "mcp" ? "mcp" : "cli";
    const ownerKeys = ownerKeysFromMessage(message);
    if (prunedConversationIds.includes(conversationId)) {
      const originalConversationId = conversationId;
      const conversation = createNextConversation();
      conversationId = conversation.id;
      addLog(`${source} requested pruned c${originalConversationId}; assigned new c${conversationId}`, "warn");
    } else if (shouldAssignNewConversation(conversationActivityRef.current, conversationId, ownerKeys)) {
      const originalConversationId = conversationId;
      const conversation = createNextConversation();
      conversationId = conversation.id;
      addLog(`${source} requested active c${originalConversationId}; assigned new c${conversationId}`, "warn");
    }
    markConversationActive(conversationActivityRef.current, conversationId, source, ownerKeys);
    const conversation = ensureConversation(conversationId);
    if (conversation.status === "closed") {
      const now = new Date().toISOString();
      syncConversations(
        conversationsRef.current.map((entry) =>
          entry.id === conversationId ? { ...entry, status: "open", updatedAt: now, closedAt: undefined } : entry,
        ),
      );
      addLog(`conversation ${conversationId} reopened by incoming sender`, "warn");
    }

    const envelope = createIncomingResultEnvelope({
      message,
      conversationId,
      visibleConversationIdsForApproval,
      bindingConversationIdForApproval,
    });
    const item = createIncomingPendingItem({
      ...envelope,
      id: nextIdRef.current,
      conversationId,
      socket,
      message,
      timeoutMs: Number(message.timeoutMs) || getConversationTimeoutMs(conversationId) || defaultTimeoutMsRef.current,
    });
    if (item.kind === "approval") {
      aiSessions.markWaitingByConversation(envelope.bindingConversationId || item.conversationId, item.result);
    }
    patchSettings(incomingResultBindingPatch(message, envelope.kind, envelope.bindingConversationId, conversationActivityRef.current));
    nextIdRef.current += 1;

    setLatestResult(toPendingView(item));
    if (!envelope.isReadyResult && item.kind === "task") {
      addResultHistory(resultHistoryRef, {
        conversationId: item.conversationId,
        taskId: item.id,
        source: item.source,
        kind: "task",
        result: item.result,
        attachments: item.attachments || [],
      });
    }
    addLog(`incoming c${item.conversationId} #${item.id} (${formatDuration(item.timeoutMs)})`, "success");
    completeProcessing(item.conversationId);
    const chatTaskPayload = createChatTaskPayload({
      conversationId: item.conversationId,
      id: item.id,
      timeoutLabel: formatDuration(item.timeoutMs),
      body: item.result,
      attachments: item.attachments,
    });
    if (!envelope.isReadyResult) {
      const chatResultPayload = createChatResultPayload({ conversationId: item.conversationId, id: item.id, body: item.result, attachments: item.attachments });

      if (item.kind === "approval") {
        for (const visibleConversationId of item.visibleConversationIds) {
          chatProgress.markIntervening(visibleConversationId);
        }
      }

      const deliverConversationIds = incomingDeliveryConversationIds(item);
      for (const deliverConversationId of deliverConversationIds) {
        const routes = chatRoutesForConversation(chatBridgesRef.current, chatRoutes(), deliverConversationId);
        if (item.kind === "approval") {
          const payload = createChatApprovalPayload({
            conversationId: deliverConversationId,
            id: item.id,
            timeoutLabel: formatDuration(item.timeoutMs),
            body: item.result,
            attachments: item.attachments,
          });
          for (const route of routes) {
            void deliverChatPayload(route, payload);
          }
          continue;
        }
        for (const route of routes) {
          if (route.capabilities.progress) {
            void chatProgress.finishRoute(route, item.conversationId, chatResultPayload).then((finished: boolean) => {
              if (!finished) {
                void deliverChatPayload(route, chatResultPayload);
              }
            });
          } else {
            void deliverChatPayload(route, chatTaskPayload);
          }
        }
      }
    }

    const queuedReplyIndex =
      item.kind === "approval"
        ? -1
        : queuedRepliesRef.current.findIndex((reply) => reply.conversationId === item.conversationId);
    const queuedReply = queuedReplyIndex === -1 ? undefined : queuedRepliesRef.current.splice(queuedReplyIndex, 1)[0];
    if (queuedReply) {
      syncQueuedReplies();
      item.socket.write(encodeMessage({ type: "reply", value: queuedReply.value }), () => {
        item.socket.end();
        addLog(`sent queued c${queuedReply.conversationId} #${queuedReply.id}: ${queuedReply.value}`, "success");
        startProcessing(item.conversationId, queuedReply.processing);
        startChatProgress(item);
      });
      return;
    }

    if (item.kind !== "approval") {
      const autoDelay = Math.max(0, item.timeoutMs - AUTO_TARGET_SAFETY_MS);
      item.autoTimer = setTimeout(() => {
        if (pendingRef.current.includes(item)) {
          const reply =
            timeoutTargetRef.current !== undefined
              ? incomingTimeoutReply(item.source, timeoutTargetRef.current)
              : incomingTimeoutReply(item.source);
          replyToItem(
            item,
            reply,
            timeoutTargetRef.current !== undefined ? `sent timeout target for #${item.id}` : `sent timeout reply for #${item.id}`,
          );
        }
      }, autoDelay);
    }

    pendingRef.current.push(item);
    syncPending();
  };
}

export { createIncomingResultHandler };
