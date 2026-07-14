export type Channel = "telegram" | "wechat" | "dingding";

type ChatTool = Record<string, unknown> & {
  enabled?: boolean;
  token?: string;
  allowedUserIds?: string | string[];
  baseUrl?: string;
  contextToken?: string;
  sessionWebhook?: string;
  clientId?: string;
  clientSecret?: string;
  corpId?: string;
  robotCode?: string;
  cardTemplateId?: string;
  cardCallbackRouteKey?: string;
  cardUserIdType?: number | string;
  updatesBuf?: string;
  defaultChatId?: string;
};

type ChatBinding = Record<string, unknown> & {
  conversationId: number;
  contextToken?: string;
  sessionWebhook?: string;
  senderId?: string;
};

type ChatBindingInput = Record<string, unknown> & {
  conversationId?: number | string;
  contextToken?: string;
  sessionWebhook?: string;
  senderId?: string;
};

type LegacyWechatSettings = {
  token?: string;
  baseUrl?: string;
  chatId?: string;
  contextToken?: string;
  updatesBuf?: string;
  conversationId?: number | string;
};

type ChatToolSettings = {
  chatTools?: Partial<Record<Channel, Record<string, ChatTool>>>;
  chatBindings?: Partial<Record<Channel, Record<string, Record<string, ChatBindingInput>>>>;
  wechat?: LegacyWechatSettings;
};

export type ChatToolState = {
  chatTools: Record<Channel, Record<string, ChatTool>>;
  chatBindings: Record<Channel, Record<string, Record<string, ChatBinding>>>;
};

function cleanId(value: unknown) {
  const id = String(value || "").trim();
  return id || undefined;
}

function parseCid(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function nextGeneratedKey(existing: Record<string, unknown>, prefix: string) {
  let index = 1;
  while (existing[`${prefix}-${index}`]) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

function normalizeToolMap(value: unknown): Record<string, ChatTool> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, ChatTool> = {};
  for (const [key, tool] of Object.entries(value as Record<string, unknown>)) {
    if (tool && typeof tool === "object" && !Array.isArray(tool)) {
      result[key] = { ...(tool as ChatTool) };
    }
  }
  return result;
}

function normalizeBindingMap(value: unknown): Record<string, Record<string, ChatBinding>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, Record<string, ChatBinding>> = {};
  for (const [instanceId, chats] of Object.entries(value as Record<string, unknown>)) {
    if (!chats || typeof chats !== "object" || Array.isArray(chats)) {
      continue;
    }
    const normalizedChats: Record<string, ChatBinding> = {};
    for (const [chatId, binding] of Object.entries(chats as Record<string, unknown>)) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        continue;
      }
      const conversationId = parseCid((binding as Record<string, unknown>).conversationId);
      if (conversationId) {
        normalizedChats[chatId] = { ...(binding as ChatBinding), conversationId };
      }
    }
    if (Object.keys(normalizedChats).length > 0) {
      result[instanceId] = normalizedChats;
    }
  }
  return result;
}

function findMatchingLegacyTool(tools: Record<string, ChatTool>, token?: string, chatId?: string) {
  return Object.entries(tools).find(([, tool]) => {
    const toolToken = cleanId(tool.token);
    const toolChatId = cleanId(tool.defaultChatId);
    return token ? toolToken === token : Boolean(chatId && toolChatId === chatId);
  });
}

function addLegacyWechat(state: ChatToolState, settings: ChatToolSettings) {
  const wechat = settings.wechat || {};
  const token = cleanId(wechat.token);
  const chatId = cleanId(wechat.chatId);
  if (!token && !chatId) {
    return;
  }
  const existing = findMatchingLegacyTool(state.chatTools.wechat, token, chatId);
  const instanceId = existing?.[0] || (state.chatTools.wechat.default ? nextGeneratedKey(state.chatTools.wechat, "wechat") : "default");
  if (!existing) {
    state.chatTools.wechat[instanceId] = {
      token,
      baseUrl: cleanId(wechat.baseUrl),
      updatesBuf: wechat.updatesBuf,
      enabled: Boolean(token),
      defaultChatId: chatId,
    };
  }
  const conversationId = parseCid(wechat.conversationId);
  if (chatId && conversationId) {
    state.chatBindings.wechat[instanceId] = {
      ...(state.chatBindings.wechat[instanceId] || {}),
      [chatId]: { conversationId, contextToken: cleanId(wechat.contextToken) },
    };
  }
}

export function normalizeChatToolState(settings: ChatToolSettings = {}): ChatToolState {
  const chatTools = settings.chatTools || {};
  const chatBindings = settings.chatBindings || {};
  const state: ChatToolState = {
    chatTools: {
      telegram: normalizeToolMap(chatTools.telegram),
      wechat: normalizeToolMap(chatTools.wechat),
      dingding: normalizeToolMap(chatTools.dingding),
    },
    chatBindings: {
      telegram: normalizeBindingMap(chatBindings.telegram),
      wechat: normalizeBindingMap(chatBindings.wechat),
      dingding: normalizeBindingMap(chatBindings.dingding),
    },
  };

  addLegacyWechat(state, settings);
  return state;
}

export function generateChatToolInstanceId(state: ChatToolState, channel: Channel) {
  return nextGeneratedKey(state.chatTools[channel], channel);
}

export function bindChatToConversation(
  state: ChatToolState,
  channel: Channel,
  instanceId: string,
  chatId: string,
  conversationId: number,
  extra: Record<string, unknown> = {},
) {
  const cid = parseCid(conversationId);
  if (!cid) {
    throw new Error("conversationId must be a positive integer");
  }
  state.chatBindings[channel][instanceId] = {
    ...(state.chatBindings[channel][instanceId] || {}),
    [chatId]: { ...extra, conversationId: cid },
  };
  return state;
}

export function listChatBindings(state: ChatToolState) {
  const rows: Array<{ channel: Channel; instanceId: string; chatId: string; conversationId: number } & ChatBinding> = [];
  for (const channel of ["telegram", "wechat", "dingding"] as Channel[]) {
    for (const [instanceId, chats] of Object.entries(state.chatBindings[channel])) {
      for (const [chatId, binding] of Object.entries(chats)) {
        rows.push({ ...binding, channel, instanceId, chatId, conversationId: binding.conversationId });
      }
    }
  }
  return rows;
}

export function listChatToolInstances(state: ChatToolState) {
  const rows: Array<{ channel: Channel; instanceId: string; enabled: boolean; defaultChatId?: string }> = [];
  for (const channel of ["telegram", "wechat", "dingding"] as Channel[]) {
    for (const [instanceId, tool] of Object.entries(state.chatTools[channel])) {
      rows.push({
        channel,
        instanceId,
        enabled: Boolean(tool.enabled),
        defaultChatId: cleanId(tool.defaultChatId),
      });
    }
  }
  return rows;
}
