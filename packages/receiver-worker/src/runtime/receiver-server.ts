import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { useEffect } from "react";
import { decodeLines, encodeMessage, SocketMessageSchema, type ControlMessage } from "@task-handoff/core/core/protocol";
import { removeStaleSocket, unlinkSocket } from "@task-handoff/core/core/socket";
import { createIncomingResultHandler } from "../controllers/incoming-result-handler";
import { createReceiverChatBridgeBootstrap } from "../controllers/chat-bridge-bootstrap";
import { toPendingView, toQueuedReplyView } from "../state/pending";
import type { IncomingResultMessage, PendingItem, QueuedReply, ReceiverLogFn, ReceiverRef } from "../types";

type ReceiverServerOptions = Parameters<typeof createIncomingResultHandler>[0] &
  Parameters<typeof createReceiverChatBridgeBootstrap>[0] & {
  addLog: ReceiverLogFn;
  cancelActiveConversation: Parameters<typeof createReceiverChatBridgeBootstrap>[0]["cancelActiveConversation"];
  chatProgress: Parameters<typeof createIncomingResultHandler>[0]["chatProgress"] & { stopAll: () => void };
    chatBridgesRef: Parameters<typeof createIncomingResultHandler>[0]["chatBridgesRef"] & {
      current: Parameters<typeof createReceiverChatBridgeBootstrap>[0]["chatBridgesRef"]["current"] & {
        stopAll: () => void;
      };
    };
    removePending: (item: PendingItem) => unknown;
    serverRef: ReceiverRef<net.Server | undefined>;
    setReady: (ready: boolean) => void;
    socketPath: string;
    socketsRef: ReceiverRef<Set<net.Socket>>;
  };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function controlSuccess(requestId: string | undefined, data: unknown) {
  return encodeMessage({ type: "control.response", requestId, ok: true, data });
}

function controlError(requestId: string | undefined, code: string, message: string) {
  return encodeMessage({ type: "control.response", requestId, ok: false, error: { code, message } });
}

function useReceiverServer({
  addLog,
  addDiagnosticLog,
  aiSessions,
  bindingConversationIdForApproval,
  cancelActiveConversation,
  chatBridgesRef,
  chatProgress,
  chatRoutes,
  chatToolStateRef,
  completeProcessing,
  conversationActivityRef,
  conversationsRef,
  createNextConversation,
  defaultConversationIdRef,
  defaultTimeoutMsRef,
  ensureConversation,
  getConversationTimeoutMs,
  handleChatConversationAction,
  handleChatConversationCommand,
  handleChatSessionAction,
  handleChatText,
  handleCwdPickerAction,
  handleHistoryAction,
  nextIdRef,
  pendingRef,
  pruneInactiveConversations,
  queuedRepliesRef,
  removePending,
  replyApproval,
  replyToItem,
  resultHistoryRef,
  serverRef,
  setLatestResult,
  setReady,
  socketPath,
  socketsRef,
  startChatProgress,
  startProcessing,
  syncConversations,
  syncPending,
  syncQueuedReplies,
  syncTelegram,
  syncWechat,
  syncDingding,
  telegramConversationIdRef,
  timeoutTargetRef,
  visibleConversationIdsForApproval,
  wechatConversationIdRef,
  dingdingConversationIdRef,
}: ReceiverServerOptions) {
  useEffect(() => {
    let cancelled = false;
    const pruneTimer = setInterval(() => {
      pruneInactiveConversations();
    }, 60_000);

    const boot = async () => {
      try {
        await removeStaleSocket(socketPath);
      } catch (error: unknown) {
        addLog(errorMessage(error), "error");
        return;
      }

      if (cancelled) {
        return;
      }
      pruneInactiveConversations();

      const { telegramBridges, wechatBridges, dingdingBridges } = createReceiverChatBridgeBootstrap({
        addLog,
        addDiagnosticLog,
        chatBridgesRef,
        chatToolStateRef,
        handleChatConversationAction,
        handleChatConversationCommand,
        handleChatSessionAction,
        handleChatText,
        handleCwdPickerAction,
        handleHistoryAction,
        cancelActiveConversation,
        pendingRef,
        resultHistoryRef,
        replyApproval,
        queuedRepliesRef,
        syncQueuedReplies,
        syncTelegram,
        syncWechat,
        syncDingding,
        telegramConversationIdRef,
        wechatConversationIdRef,
        dingdingConversationIdRef,
      });

      const handleIncomingResult = createIncomingResultHandler({
        addLog,
        aiSessions,
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
        resultHistoryRef,
        setLatestResult,
        startChatProgress,
        startProcessing,
        syncConversations,
        syncPending,
        syncQueuedReplies,
        timeoutTargetRef,
        visibleConversationIdsForApproval,
        conversationsRef,
      });

      const server = net.createServer((socket) => {
        socketsRef.current.add(socket);
        const handleControlMessage = (message: ControlMessage) => {
          const requestId = message.requestId;
          if (message.action === "pending.list") {
            socket.write(
              controlSuccess(requestId, {
                pending: pendingRef.current.map(toPendingView),
                queuedReplies: queuedRepliesRef.current.map((item: QueuedReply & { label?: string }) => toQueuedReplyView(item)),
              }),
            );
            socket.end();
            return;
          }

          if (message.action === "receiver.message") {
            const conversationId = Number(message.conversationId || defaultConversationIdRef.current) || 1;
            ensureConversation(conversationId);
            const status = handleChatText({
              channel: message.channel,
              conversationId,
              text: message.text,
              label: `chat gateway ${message.channel}`,
              route: {
                channel: message.channel,
                conversationId,
                routeKey: message.chatSessionId,
                target: {
                  chatId: message.chatSessionId,
                  userId: message.userId,
                },
              },
            });
            socket.write(
              controlSuccess(requestId, {
                accepted: true,
                conversationId,
                status,
              }),
            );
            socket.end();
            return;
          }

          const item = pendingRef.current.find((entry) => entry.id === message.id);
          if (!item) {
            socket.write(controlError(requestId, "PENDING_TASK_NOT_FOUND", "Pending task not found."));
            socket.end();
            return;
          }

          if (message.action === "pending.reply") {
            if (item.kind === "approval") {
              socket.write(controlError(requestId, "PENDING_TASK_KIND_INVALID", "Approval requests must be handled with approve, deny, or skip."));
              socket.end();
              return;
            }
            const handled = replyToItem(item, message.markdown, `web reply #${item.id}`);
            socket.write(handled ? controlSuccess(requestId, { id: item.id, status: "replied" }) : controlError(requestId, "PENDING_TASK_REPLY_FAILED", "Could not reply to pending task."));
            socket.end();
            return;
          }

          if (message.action === "pending.drop") {
            if (item.kind === "approval") {
              socket.write(controlError(requestId, "PENDING_TASK_KIND_INVALID", "Approval requests cannot be dropped as task replies."));
              socket.end();
              return;
            }
            const handled = replyToItem(item, "continue", `web dropped #${item.id}`);
            socket.write(handled ? controlSuccess(requestId, { id: item.id, status: "dropped" }) : controlError(requestId, "PENDING_TASK_DROP_FAILED", "Could not drop pending task."));
            socket.end();
            return;
          }

          if (message.action === "pending.approval") {
            const handled = replyApproval(message.id, message.decision, `web ${message.decision}`);
            socket.write(handled ? controlSuccess(requestId, { id: item.id, status: message.decision }) : controlError(requestId, "PENDING_APPROVAL_FAILED", "Could not handle approval request."));
            socket.end();
          }
        };

        decodeLines(socket, SocketMessageSchema, (message) => {
          if (message.type === "control") {
            handleControlMessage(message);
            return;
          }
          handleIncomingResult(message as IncomingResultMessage, socket);
        });

        socket.on("close", () => {
          socketsRef.current.delete(socket);
          const item = pendingRef.current.find((entry) => entry.socket === socket);
          if (item) {
            removePending(item);
          }
        });
      });

      server.on("error", (error: unknown) => {
        addLog(`Receiver error: ${errorMessage(error)}`, "error");
      });

      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      server.listen(socketPath, () => {
        serverRef.current = server;
        setReady(true);
        addLog(`listening at ${socketPath}`, "success");
        telegramBridges.forEach((telegram) => {
          if (telegram.enabled) {
            telegram.start();
          }
        });
        wechatBridges.forEach((wechat) => {
          if (wechat.enabled) {
            wechat.start();
          }
        });
        dingdingBridges.forEach((dingding) => {
          if (dingding.enabled) {
            dingding.start();
          }
        });
      });
    };

    boot();

    return () => {
      cancelled = true;
      clearInterval(pruneTimer);
      chatProgress.stopAll();
      chatBridgesRef.current.stopAll();
      socketsRef.current.forEach((socket) => socket.destroy());
      serverRef.current?.close(() => unlinkSocket(socketPath));
    };
  }, [
    addLog,
    bindingConversationIdForApproval,
    cancelActiveConversation,
    chatProgress,
    chatRoutes,
    getConversationTimeoutMs,
    handleChatConversationAction,
    handleChatConversationCommand,
    handleChatSessionAction,
    handleChatText,
    handleCwdPickerAction,
    handleHistoryAction,
    pruneInactiveConversations,
    removePending,
    replyApproval,
    replyToItem,
    socketPath,
    startChatProgress,
    startProcessing,
    syncPending,
    syncQueuedReplies,
    syncTelegram,
    syncWechat,
    syncDingding,
    visibleConversationIdsForApproval,
  ]);
}

export { useReceiverServer };
