import { deleteConversationBindingPatch } from "./conversation-bindings";
import type { ChatToolState } from "./chat-tools";
import type { ReceiverConversation } from "../types";
import type { ConversationActivity } from "./activity";

function cloneChatBindings(chatBindings: ChatToolState["chatBindings"]) {
  return {
    telegram: Object.fromEntries(
      Object.entries(chatBindings?.telegram || {}).map(([instanceId, chats]) => [
        instanceId,
        { ...(chats as Record<string, unknown>) },
      ]),
    ),
    wechat: Object.fromEntries(
      Object.entries(chatBindings?.wechat || {}).map(([instanceId, chats]) => [
        instanceId,
        { ...(chats as Record<string, unknown>) },
      ]),
    ),
    dingding: Object.fromEntries(
      Object.entries(chatBindings?.dingding || {}).map(([instanceId, chats]) => [
        instanceId,
        { ...(chats as Record<string, unknown>) },
      ]),
    ),
  };
}

function deleteConversationState({
  settings,
  conversations,
  chatBindings,
  conversationActivity,
  conversationId,
}: {
  settings: Parameters<typeof deleteConversationBindingPatch>[0];
  conversations: ReceiverConversation[];
  chatBindings: ChatToolState["chatBindings"];
  conversationActivity: ConversationActivity;
  conversationId: number;
}) {
  const nextChatBindings = cloneChatBindings(chatBindings);
  const chatBindingPatch = { telegram: {}, wechat: {}, dingding: {} };
  for (const channel of ["telegram", "wechat", "dingding"]) {
    for (const [instanceId, chats] of Object.entries(nextChatBindings[channel] || {})) {
      for (const [chatId, binding] of Object.entries(chats as Record<string, { conversationId?: number }>)) {
        if (binding?.conversationId === conversationId) {
          delete nextChatBindings[channel][instanceId][chatId];
          chatBindingPatch[channel][instanceId] = {
            ...(chatBindingPatch[channel][instanceId] || {}),
            [chatId]: undefined,
          };
        }
      }
    }
  }

  const nextConversationActivity = { ...(conversationActivity || {}) };
  delete nextConversationActivity[String(conversationId)];

  return {
    conversations: conversations.filter((conversation) => conversation.id !== conversationId),
    chatBindings: nextChatBindings,
    conversationActivity: nextConversationActivity,
    patch: {
      ...deleteConversationBindingPatch(settings, conversationId),
      chatBindings: chatBindingPatch,
      conversationActivity: { [conversationId]: undefined },
    },
  };
}

export { deleteConversationState };
