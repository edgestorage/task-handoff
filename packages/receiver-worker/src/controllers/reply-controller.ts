import { useCallback } from "react";
import { encodeMessage } from "@task-handoff/core/core/protocol";
import { normalizeCliMarkdown } from "@task-handoff/core/core/text";
import { toPendingView, toQueuedReplyView } from "../state/pending";
import type { ProgressItem } from "@task-handoff/core/core/chat";
import type {
  PendingItem,
  PendingViewItem,
  QueuedReply,
  QueuedReplyViewItem,
  ReceiverLogFn,
  ReceiverProcessing,
  ReceiverRef,
} from "../types";

type ReplyTargetOptions = {
  includeApproval?: boolean;
};

type ReceiverReplyControllerOptions = {
  activeConversationIdRef: ReceiverRef<number>;
  activeProcessingRef: ReceiverRef<Map<number, ReceiverProcessing>>;
  addLog: ReceiverLogFn;
  chatProgress: { start: (item: ProgressItem) => unknown };
  focusedIdRef: ReceiverRef<number | undefined>;
  pendingRef: ReceiverRef<PendingItem[]>;
  queuedRepliesRef: ReceiverRef<QueuedReply[]>;
  setFocusedId: (id: number | undefined) => void;
  setPending: (items: PendingViewItem[]) => void;
  setQueuedReplies: (items: QueuedReplyViewItem[]) => void;
};

function useReceiverReplyController({
  activeConversationIdRef,
  activeProcessingRef,
  addLog,
  chatProgress,
  focusedIdRef,
  pendingRef,
  queuedRepliesRef,
  setFocusedId,
  setPending,
  setQueuedReplies,
}: ReceiverReplyControllerOptions) {
  const syncPending = useCallback(() => {
    setPending(pendingRef.current.map(toPendingView));
  }, [pendingRef, setPending]);

  const syncQueuedReplies = useCallback(() => {
    setQueuedReplies(queuedRepliesRef.current.map(toQueuedReplyView));
  }, [queuedRepliesRef, setQueuedReplies]);

  const findPendingById = useCallback((id: number) => pendingRef.current.find((item) => item.id === id), [pendingRef]);

  const currentReplyTarget = useCallback((conversationId = activeConversationIdRef.current, options: ReplyTargetOptions = {}) => {
    const includeApproval = Boolean(options.includeApproval);
    const isVisible = (item: PendingItem) => (item.visibleConversationIds || [item.conversationId]).includes(conversationId);
    const isEligible = (item: PendingItem) => isVisible(item) && (includeApproval || item.kind !== "approval");
    if (focusedIdRef.current) {
      const focused = findPendingById(focusedIdRef.current);
      if (focused && isEligible(focused)) {
        return focused;
      }
      focusedIdRef.current = undefined;
      setFocusedId(undefined);
    }
    return pendingRef.current.find(isEligible);
  }, [activeConversationIdRef, findPendingById, focusedIdRef, pendingRef, setFocusedId]);

  const removePending = useCallback(
    (item: PendingItem) => {
      const index = pendingRef.current.indexOf(item);
      if (index !== -1) {
        pendingRef.current.splice(index, 1);
      }
      clearTimeout(item.autoTimer);
      if (focusedIdRef.current === item.id) {
        focusedIdRef.current = undefined;
        setFocusedId(undefined);
      }
      syncPending();
    },
    [focusedIdRef, pendingRef, setFocusedId, syncPending],
  );

  const completeProcessing = useCallback((conversationId: number) => {
    const processing = activeProcessingRef.current.get(conversationId);
    if (!processing) {
      return;
    }
    activeProcessingRef.current.delete(conversationId);
    processing.done?.();
  }, [activeProcessingRef]);

  const startProcessing = useCallback(
    (conversationId: number, processing?: ReceiverProcessing) => {
      if (!processing) {
        return;
      }
      completeProcessing(conversationId);
      processing.start?.();
      activeProcessingRef.current.set(conversationId, processing);
    },
    [activeProcessingRef, completeProcessing],
  );

  const startChatProgress = useCallback(
    (item: PendingItem, processing?: ReceiverProcessing) =>
      chatProgress.start({ ...item, routeTarget: processing?.progressRouteTarget }),
    [chatProgress],
  );

  const replyToItem = useCallback(
    (item: PendingItem | undefined, value: string, label = "sent", processing?: ReceiverProcessing) => {
      if (!item) {
        return false;
      }
      const replyValue = normalizeCliMarkdown(value);
      if (item.socket.destroyed) {
        removePending(item);
        return false;
      }

      removePending(item);
      item.socket.write(encodeMessage({ type: "reply", value: replyValue }), () => {
        item.socket.end();
        addLog(`${label}: ${replyValue}`, "success");
        startProcessing(item.conversationId, processing);
        startChatProgress(item, processing);
      });
      return true;
    },
    [addLog, removePending, startChatProgress, startProcessing],
  );

  const replyApproval = useCallback(
    (id: number | undefined, decision: string, label = decision) => {
      const item = id
        ? findPendingById(id)
        : pendingRef.current.find(
            (entry) =>
              entry.kind === "approval" &&
              (entry.visibleConversationIds || [entry.conversationId]).includes(activeConversationIdRef.current),
          );
      if (!item || item.kind !== "approval") {
        addLog(id ? `Approval request #${id} not found.` : "No approval request in the active conversation.", "warn");
        return false;
      }
      return replyToItem(item, decision, `${label} #${item.id}`);
    },
    [activeConversationIdRef, addLog, findPendingById, pendingRef, replyToItem],
  );

  return {
    completeProcessing,
    currentReplyTarget,
    findPendingById,
    removePending,
    replyApproval,
    replyToItem,
    startChatProgress,
    startProcessing,
    syncPending,
    syncQueuedReplies,
  };
}

export { useReceiverReplyController };
