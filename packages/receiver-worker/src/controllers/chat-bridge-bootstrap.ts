import { CONFIG_PATH, patchSettings } from "@task-handoff/core/core/persistence";
import { findAttachment } from "@task-handoff/core/core/attachments";
import type { SenderAttachment } from "@task-handoff/core/core/attachments";
import { DingdingBridge } from "../integrations/dingding";
import { TelegramBridge } from "../integrations/telegram";
import { WechatBridge } from "../integrations/wechat";
import { bindChatToConversation } from "../state/chat-tools";
import type { Channel, ChatToolState } from "../state/chat-tools";
import type { QueuedReply, ReceiverLogFn, ReceiverProcessing, ReceiverRef } from "../types";

type ChatToolConfig = Record<string, unknown> & {
  token?: string;
  allowedUserIds?: string | string[];
  baseUrl?: string;
  chatId?: string;
  defaultChatId?: string;
  contextToken?: string;
  sessionWebhook?: string;
  clientId?: string;
  clientSecret?: string;
  corpId?: string;
  robotCode?: string;
  cardTemplateId?: string;
  cardCallbackRouteKey?: string;
  cardUserIdType?: number;
  updatesBuf?: string;
};

type ChatMessageMeta = {
  chatId?: string;
  messageId?: number;
  contextToken?: string;
  sessionWebhook?: string;
  senderId?: string;
};

type TelegramAction = {
  type: string;
  id?: number;
  decision?: string;
  conversationId?: number;
  index?: number;
  chatId?: string;
  senderId?: string;
  sessionWebhook?: string;
  token?: string;
  action?: string;
  attachmentId?: string;
  agent?: string;
  sessionId?: string;
};

type ReceiverChatBridgeBootstrapOptions = {
  addLog: ReceiverLogFn;
  addDiagnosticLog?: ReceiverLogFn;
  chatBridgesRef: ReceiverRef<{ set: (key: string, bridge: unknown) => void }>;
  chatToolStateRef: ReceiverRef<ChatToolState>;
  handleChatConversationAction: (options: Record<string, unknown>) => unknown;
  handleChatConversationCommand: (options: Record<string, unknown>) => boolean | void;
  handleChatSessionAction: (options: Record<string, unknown>) => unknown;
  handleChatText: (options: Record<string, unknown>) => "queued" | string | void;
  handleCwdPickerAction: (action: unknown) => unknown;
  handleHistoryAction: (action: TelegramAction) => unknown;
  cancelActiveConversation: (conversationId: number) => boolean;
  pendingRef: ReceiverRef<Array<{ id: number; attachments?: SenderAttachment[] }>>;
  resultHistoryRef: ReceiverRef<{ entries: Array<{ conversationId?: number; taskId?: number; attachments?: SenderAttachment[] }> }>;
  replyApproval: (id: number | undefined, decision: string | undefined, label?: string) => unknown;
  queuedRepliesRef: ReceiverRef<Array<QueuedReply & { label?: string }>>;
  syncQueuedReplies: () => void;
  syncTelegram: () => void;
  syncWechat: () => void;
  syncDingding: () => void;
  telegramConversationIdRef: ReceiverRef<number>;
  wechatConversationIdRef: ReceiverRef<number>;
  dingdingConversationIdRef: ReceiverRef<number>;
};

function createReceiverChatBridgeBootstrap({
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
}: ReceiverChatBridgeBootstrapOptions) {
  const persistChatToolState = () => {
    patchSettings({
      chatTools: chatToolStateRef.current.chatTools,
      chatBindings: chatToolStateRef.current.chatBindings,
    });
  };

  const attachmentForAction = (action: TelegramAction) => {
    const taskId = Number(action.id);
    const pending = pendingRef.current.find((item) => item.id === taskId);
    const attachment = findAttachment(pending?.attachments, action.attachmentId);
    if (attachment) {
      return attachment;
    }
    for (const entry of resultHistoryRef.current.entries.slice().reverse()) {
      if (Number(entry.taskId) !== taskId || Number(entry.conversationId) !== Number(action.conversationId)) {
        continue;
      }
      const historyAttachment = findAttachment(entry.attachments, action.attachmentId);
      if (historyAttachment) {
        return historyAttachment;
      }
    }
    return undefined;
  };

  const handleActiveCancelAction = (action: TelegramAction) => {
    const conversationId = Number(action.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return { cancelled: false, message: "invalid conversation" };
    }
    const cancelled = cancelActiveConversation(conversationId);
    return {
      cancelled,
      message: cancelled ? `已请求取消 c${conversationId}` : `c${conversationId} 没有正在执行的任务`,
    };
  };

  const conversationIdForChat = (channel: Channel, instanceId: string, chatId: string, fallbackConversationId: number, extra: Record<string, unknown> = {}) => {
    if (!chatId) {
      return fallbackConversationId;
    }
    const binding = chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId];
    if (binding?.conversationId) {
      if (Object.keys(extra).length > 0) {
        bindChatToConversation(chatToolStateRef.current, channel, instanceId, chatId, binding.conversationId, extra);
        persistChatToolState();
      }
      return binding.conversationId;
    }
    bindChatToConversation(chatToolStateRef.current, channel, instanceId, chatId, fallbackConversationId, extra);
    persistChatToolState();
    return fallbackConversationId;
  };

  const telegramBridges = [];
  for (const [instanceId, tool] of Object.entries(chatToolStateRef.current.chatTools.telegram) as [string, ChatToolConfig][]) {
    const updateQueuedTelegramReply = (chatId: string, messageId: number, text: string) => {
      const queued = queuedRepliesRef.current.find(
        (item) =>
          item.source?.channel === "telegram" &&
          item.source.instanceId === instanceId &&
          String(item.source.chatId || "") === chatId &&
          item.source.messageId === messageId,
      );
      if (!queued) {
        return false;
      }
      queued.value = text;
      syncQueuedReplies();
      addLog(`updated queued c${queued.conversationId} #${queued.id} from Telegram edit`, "success");
      return true;
    };

    const telegram = new TelegramBridge({
      token: tool.token,
      chatId: tool.defaultChatId,
      allowedUserIds: tool.allowedUserIds,
      multiChat: true,
      onChange: ({ token, chatId, allowedUserIds }: { token?: string; chatId?: string; allowedUserIds?: string[] }) => {
        chatToolStateRef.current.chatTools.telegram[instanceId] = {
          ...chatToolStateRef.current.chatTools.telegram[instanceId],
          token,
          allowedUserIds,
          defaultChatId: chatId,
          enabled: Boolean(token),
        };
        if (chatId) {
          bindChatToConversation(
            chatToolStateRef.current,
            "telegram",
            instanceId,
            chatId,
            telegramConversationIdRef.current,
          );
        }
        persistChatToolState();
        addLog(`telegram ${instanceId} settings saved to ${CONFIG_PATH}`, "success");
        syncTelegram();
      },
      onLog: (message: string) => {
        addLog(message);
        syncTelegram();
      },
      onDiagnostic: (message: string) => {
        addDiagnosticLog?.(message, "warn");
      },
      onText: (text: string, processing: ReceiverProcessing | undefined, meta: ChatMessageMeta = {}) => {
        const chatId = meta?.chatId || telegram.chatId;
        const messageId = Number(meta?.messageId);
        const source = {
          channel: "telegram",
          instanceId,
          chatId,
          ...(Number.isInteger(messageId) && messageId > 0 ? { messageId } : {}),
        };
        const routeTarget = {
          chatId,
          ...(Number.isInteger(messageId) && messageId > 0 ? { replyToMessageId: messageId } : {}),
        };
        const telegramProcessing = processing ? { ...processing, progressRouteTarget: routeTarget } : undefined;
        if (
          handleChatConversationCommand({
            channel: "telegram",
            instanceId,
            chatId,
            text,
            send: (message: string, extra = {}) => telegram.sendMessage(message, extra, { target: { chatId } }),
            fallbackConversationId: telegramConversationIdRef.current,
          })
        ) {
          return true;
        }
        const conversationId = conversationIdForChat("telegram", instanceId, chatId, telegramConversationIdRef.current);
        const result = handleChatText({
          channel: `telegram:${instanceId}`,
          conversationId,
          text,
          label: "sent from Telegram",
          processing: telegramProcessing,
          replyOptions: { routeTarget, source },
          route: { target: routeTarget },
        });
        return result !== "queued";
      },
      onEdit: (text: string, meta: ChatMessageMeta = {}) => {
        const chatId = String(meta.chatId || "");
        const messageId = Number(meta.messageId);
        if (!chatId || !Number.isInteger(messageId) || messageId <= 0) {
          return false;
        }
        return updateQueuedTelegramReply(chatId, messageId, text);
      },
      onAction: (action: TelegramAction) => {
        const { type, id, decision } = action;
        if (type === "cwd") {
          return handleCwdPickerAction(action);
        }
        if (type === "history") {
          return handleHistoryAction(action);
        }
        if (type === "conversation") {
          return handleChatConversationAction({
            channel: "telegram",
            instanceId,
            chatId: action.chatId,
            conversationId: action.conversationId,
            fallbackConversationId: telegramConversationIdRef.current,
          });
        }
        if (type === "session") {
          return handleChatSessionAction(action);
        }
        if (type === "attachment") {
          const attachment = attachmentForAction(action);
          if (!attachment) {
            return { sent: false, message: "附件不存在或已失效" };
          }
          return telegram
            .sendAttachment(attachment, { target: { chatId: action.chatId } })
            .then(() => ({ sent: true, message: `已发送 ${attachment.name}` }))
            .catch((error: unknown) => ({ sent: false, message: error instanceof Error ? error.message : String(error) }));
        }
        if (type === "active_cancel") {
          return handleActiveCancelAction(action);
        }
        if (type !== "approval") {
          return false;
        }
        return replyApproval(id, decision, `telegram ${decision}`);
      },
    });
    telegramBridges.push(telegram);
    chatBridgesRef.current.set(`telegram:${instanceId}`, telegram);
    if (instanceId === "default") {
      chatBridgesRef.current.set("telegram", telegram);
    }
  }
  syncTelegram();

  const wechatBridges = [];
  for (const [instanceId, tool] of Object.entries(chatToolStateRef.current.chatTools.wechat) as [string, ChatToolConfig][]) {
    const wechat = new WechatBridge({
      token: tool.token,
      baseUrl: tool.baseUrl,
      chatId: tool.defaultChatId,
      contextToken: String(
        chatToolStateRef.current.chatBindings.wechat?.[instanceId]?.[tool.defaultChatId]?.contextToken ||
          tool.contextToken ||
          "",
      ) || undefined,
      updatesBuf: tool.updatesBuf,
      multiChat: true,
      onChange: ({ token, baseUrl, chatId, contextToken, updatesBuf }: ChatToolConfig) => {
        chatToolStateRef.current.chatTools.wechat[instanceId] = {
          ...chatToolStateRef.current.chatTools.wechat[instanceId],
          token,
          baseUrl,
          updatesBuf,
          defaultChatId: chatId,
          enabled: Boolean(token),
        };
        if (chatId) {
          bindChatToConversation(
            chatToolStateRef.current,
            "wechat",
            instanceId,
            chatId,
            wechatConversationIdRef.current,
            { contextToken },
          );
        }
        persistChatToolState();
        syncWechat();
      },
      onLog: (message: string) => {
        addLog(message);
        syncWechat();
      },
      onText: (text: string, meta: ChatMessageMeta = {}) => {
        const chatId = meta?.chatId || wechat.chatId;
        if (
          handleChatConversationCommand({
            channel: "wechat",
            instanceId,
            chatId,
            text,
            send: (message: string) => wechat.send(message, { target: { chatId, contextToken: meta?.contextToken } }),
            extra: meta?.contextToken ? { contextToken: meta.contextToken } : {},
            fallbackConversationId: wechatConversationIdRef.current,
          })
        ) {
          return;
        }
        const extra = meta?.contextToken ? { contextToken: meta.contextToken } : {};
        const conversationId = conversationIdForChat("wechat", instanceId, chatId, wechatConversationIdRef.current, extra);
        handleChatText({
          channel: `wechat:${instanceId}`,
          conversationId,
          text,
          label: "sent from Wechat",
          replyOptions: { includeApproval: true },
          route: { target: { chatId, contextToken: meta?.contextToken } },
        });
      },
    });
    wechatBridges.push(wechat);
    chatBridgesRef.current.set(`wechat:${instanceId}`, wechat);
    if (instanceId === "default") {
      chatBridgesRef.current.set("wechat", wechat);
    }
  }
  syncWechat();

  const dingdingBridges = [];
  const dingdingToolEntries = Object.entries(chatToolStateRef.current.chatTools.dingding) as [string, ChatToolConfig][];
  const dingdingEntries: [string, ChatToolConfig][] =
    dingdingToolEntries.length > 0 ? dingdingToolEntries : [["default", {}]];
  for (const [instanceId, tool] of dingdingEntries) {
    chatToolStateRef.current.chatTools.dingding[instanceId] ||= {};
    const dingding = new DingdingBridge({
      clientId: tool.clientId,
      clientSecret: tool.clientSecret,
      corpId: tool.corpId,
      robotCode: tool.robotCode,
      cardTemplateId: tool.cardTemplateId,
      cardCallbackRouteKey: tool.cardCallbackRouteKey,
      cardUserIdType: Number(tool.cardUserIdType) || undefined,
      chatId: tool.defaultChatId,
      allowedUserIds: tool.allowedUserIds,
      multiChat: true,
      onChange: ({ clientId, clientSecret, corpId, robotCode, cardTemplateId, cardCallbackRouteKey, cardUserIdType, chatId, allowedUserIds }: ChatToolConfig) => {
        chatToolStateRef.current.chatTools.dingding[instanceId] = {
          ...chatToolStateRef.current.chatTools.dingding[instanceId],
          clientId,
          clientSecret,
          corpId,
          robotCode,
          cardTemplateId,
          cardCallbackRouteKey,
          cardUserIdType,
          allowedUserIds,
          defaultChatId: chatId,
          enabled: Boolean(clientId && clientSecret),
        };
        if (chatId) {
          bindChatToConversation(
            chatToolStateRef.current,
            "dingding",
            instanceId,
            chatId,
            dingdingConversationIdRef.current,
          );
        }
        persistChatToolState();
        addLog(`dingding ${instanceId} settings saved to ${CONFIG_PATH}`, "success");
        syncDingding();
      },
      onLog: (message: string) => {
        addLog(message);
        syncDingding();
      },
      onText: (text: string, meta: ChatMessageMeta = {}) => {
        const chatId = meta?.chatId || dingding.chatId;
        const extra = {
          ...(meta?.sessionWebhook ? { sessionWebhook: meta.sessionWebhook } : {}),
          ...(meta?.senderId ? { senderId: meta.senderId } : {}),
        };
        const route = { target: { chatId, sessionWebhook: meta?.sessionWebhook, senderId: meta?.senderId } };
        if (
          handleChatConversationCommand({
            channel: "dingding",
            instanceId,
            chatId,
            text,
            send: (message: string, extraOptions = {}) => dingding.sendMessage(message, extraOptions as Record<string, unknown>, route),
            extra,
            fallbackConversationId: dingdingConversationIdRef.current,
          })
        ) {
          return;
        }
        const conversationId = conversationIdForChat("dingding", instanceId, chatId, dingdingConversationIdRef.current, extra);
        handleChatText({
          channel: `dingding:${instanceId}`,
          conversationId,
          text,
          label: "sent from DingDing",
          replyOptions: { includeApproval: true },
          route,
        });
      },
      onAction: (action: TelegramAction) => {
        const { type, id, decision } = action;
        if (type === "cwd") {
          return handleCwdPickerAction(action);
        }
        if (type === "history") {
          return handleHistoryAction(action);
        }
        if (type === "conversation") {
          return handleChatConversationAction({
            channel: "dingding",
            instanceId,
            chatId: action.chatId,
            conversationId: action.conversationId,
            fallbackConversationId: dingdingConversationIdRef.current,
            extra: {
              ...(action.senderId ? { senderId: action.senderId } : {}),
              ...(action.sessionWebhook ? { sessionWebhook: action.sessionWebhook } : {}),
            },
          });
        }
        if (type === "session") {
          return handleChatSessionAction(action);
        }
        if (type === "attachment") {
          const attachment = attachmentForAction(action);
          return {
            sent: false,
            message: attachment ? "钉钉附件点击已收到，但当前通道暂不支持文件直传" : "附件不存在或已失效",
          };
        }
        if (type === "active_cancel") {
          return handleActiveCancelAction(action);
        }
        if (type !== "approval") {
          return false;
        }
        return replyApproval(id, decision, `dingding ${decision}`);
      },
    });
    dingdingBridges.push(dingding);
    chatBridgesRef.current.set(`dingding:${instanceId}`, dingding);
    if (instanceId === "default") {
      chatBridgesRef.current.set("dingding", dingding);
    }
  }
  syncDingding();

  return { telegramBridges, wechatBridges, dingdingBridges };
}

export { createReceiverChatBridgeBootstrap };
