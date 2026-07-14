import { DEFAULT_CONVERSATION_ID, DEFAULT_TIMEOUT_MS } from "@task-handoff/core/core/config";
import { loadSettings } from "@task-handoff/core/core/persistence";
import { normalizeConversationActivity } from "./state/activity";
import { normalizeChatToolState } from "./state/chat-tools";
import { normalizeConversations } from "./domain/conversations";
import type { ReceiverInitialOptions } from "./types";

function createInitialReceiverState({
  telegramToken,
  telegramChatId,
  telegramAllowedUserIds,
  telegramConversationId = DEFAULT_CONVERSATION_ID,
  wechatToken,
  wechatBaseUrl,
  wechatChatId,
  wechatConversationId = DEFAULT_CONVERSATION_ID,
  wechatContextToken,
  wechatUpdatesBuf,
  dingdingClientId,
  dingdingClientSecret,
  dingdingCorpId,
  dingdingRobotCode,
  dingdingCardTemplateId,
  dingdingCardCallbackRouteKey,
  dingdingCardUserIdType,
  dingdingChatId,
  dingdingAllowedUserIds,
  dingdingConversationId = DEFAULT_CONVERSATION_ID,
}: ReceiverInitialOptions) {
  const settings = loadSettings();
  const conversationState = normalizeConversations(settings);
  const conversationActivity = normalizeConversationActivity(settings);
  const initialTelegramTool = settings.chatTools?.telegram?.default || {};
  const initialTelegramChatId = telegramChatId || initialTelegramTool.defaultChatId;
  const initialTelegramToken = telegramToken || initialTelegramTool.token;
  const initialTelegramAllowedUserIds = telegramAllowedUserIds || initialTelegramTool.allowedUserIds;
  const initialDingdingTool = settings.chatTools?.dingding?.default || {};
  const initialDingdingChatId = dingdingChatId || initialDingdingTool.defaultChatId;
  const initialDingdingClientId = dingdingClientId || initialDingdingTool.clientId;
  const initialDingdingClientSecret = dingdingClientSecret || initialDingdingTool.clientSecret;
  const initialDingdingAllowedUserIds = dingdingAllowedUserIds || initialDingdingTool.allowedUserIds;
  const chatTools = {
    ...(settings.chatTools || {}),
    telegram:
      initialTelegramToken || initialTelegramChatId
        ? {
            ...(settings.chatTools?.telegram || {}),
            default: {
              ...(settings.chatTools?.telegram?.default || {}),
              token: initialTelegramToken,
              allowedUserIds: initialTelegramAllowedUserIds,
              enabled: Boolean(initialTelegramToken),
              defaultChatId: initialTelegramChatId,
            },
          }
        : settings.chatTools?.telegram,
    dingding:
      initialDingdingClientId || initialDingdingClientSecret || initialDingdingChatId
        ? {
            ...(settings.chatTools?.dingding || {}),
            default: {
              ...(settings.chatTools?.dingding?.default || {}),
              clientId: initialDingdingClientId,
              clientSecret: initialDingdingClientSecret,
              corpId: dingdingCorpId || initialDingdingTool.corpId,
              robotCode: dingdingRobotCode || initialDingdingTool.robotCode,
              cardTemplateId: dingdingCardTemplateId || initialDingdingTool.cardTemplateId,
              cardCallbackRouteKey: dingdingCardCallbackRouteKey || initialDingdingTool.cardCallbackRouteKey,
              cardUserIdType: dingdingCardUserIdType || initialDingdingTool.cardUserIdType,
              allowedUserIds: initialDingdingAllowedUserIds,
              enabled: Boolean(initialDingdingClientId && initialDingdingClientSecret),
              defaultChatId: initialDingdingChatId,
            },
          }
        : settings.chatTools?.dingding,
  };
  const chatBindings = {
    ...(settings.chatBindings || {}),
    telegram:
      initialTelegramChatId && telegramConversationId
        ? {
            ...(settings.chatBindings?.telegram || {}),
            default: {
              ...(settings.chatBindings?.telegram?.default || {}),
              [initialTelegramChatId]: {
                ...(settings.chatBindings?.telegram?.default?.[initialTelegramChatId] || {}),
                conversationId: telegramConversationId,
              },
            },
          }
        : settings.chatBindings?.telegram,
    dingding:
      initialDingdingChatId && dingdingConversationId
        ? {
            ...(settings.chatBindings?.dingding || {}),
            default: {
              ...(settings.chatBindings?.dingding?.default || {}),
              [initialDingdingChatId]: {
                ...(settings.chatBindings?.dingding?.default?.[initialDingdingChatId] || {}),
                conversationId: dingdingConversationId,
              },
            },
          }
        : settings.chatBindings?.dingding,
  };
  const chatToolState = normalizeChatToolState({
    ...settings,
    chatTools,
    chatBindings,
    wechat: {
      ...(settings.wechat || {}),
      token: wechatToken || settings.wechat?.token,
      baseUrl: wechatBaseUrl || settings.wechat?.baseUrl,
      chatId: wechatChatId || settings.wechat?.chatId,
      contextToken: wechatContextToken || settings.wechat?.contextToken,
      updatesBuf: wechatUpdatesBuf || settings.wechat?.updatesBuf,
      conversationId: wechatConversationId,
    },
  });

  return {
    chatToolState,
    conversationActivity,
    conversationState,
    telegramStatus: {
      enabled: Boolean(telegramToken),
      polling: false,
      tokenSet: Boolean(telegramToken),
      chatId: telegramChatId,
      conversationId: telegramConversationId,
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dingdingStatus: {
      enabled: Boolean(initialDingdingClientId && initialDingdingClientSecret),
      polling: false,
      tokenSet: Boolean(initialDingdingClientId && initialDingdingClientSecret),
      chatId: initialDingdingChatId,
      conversationId: dingdingConversationId,
    },
    wechatStatus: {
      enabled: Boolean(wechatToken),
      polling: false,
      tokenSet: Boolean(wechatToken),
      chatId: wechatChatId,
      conversationId: wechatConversationId,
      contextSet: Boolean(wechatContextToken),
    },
  };
}

export { createInitialReceiverState };
