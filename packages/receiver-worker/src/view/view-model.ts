import { useCallback, useMemo } from "react";
import { DEFAULT_CONVERSATION_ID } from "@task-handoff/core/core/config";
import { formatDuration } from "@task-handoff/terminal-ui";
import { getArgumentEntryCommand, getCommandSuggestions, getSuggestionWindow } from "../domain/commands";
import type { ChatStatus, PendingViewItem, QueuedReplyViewItem, ReceiverConversation } from "../types";

type ReceiverViewModelOptions = {
  activeConversationId: number;
  conversations: ReceiverConversation[];
  defaultConversationId: number;
  defaultTimeoutMs: number;
  dismissedCompletionInput?: string;
  focusedId?: number;
  input: string;
  pending: PendingViewItem[];
  queuedReplies: QueuedReplyViewItem[];
  ready: boolean;
  selectedSuggestion: number;
  setEditorText: (value: string) => void;
  setSelectedSuggestion: (value: number) => void;
  socketPath: string;
  telegramStatus: ChatStatus;
  timeoutTarget?: string;
  wechatStatus: ChatStatus;
  dingdingStatus: ChatStatus;
};

function useReceiverViewModel({
  activeConversationId,
  conversations,
  defaultConversationId,
  defaultTimeoutMs,
  dismissedCompletionInput,
  focusedId,
  input,
  pending,
  queuedReplies,
  ready,
  selectedSuggestion,
  setEditorText,
  setSelectedSuggestion,
  socketPath,
  telegramStatus,
  timeoutTarget,
  wechatStatus,
  dingdingStatus,
}: ReceiverViewModelOptions) {
  const statusItems = useMemo<Array<[string, string]>>(
    () => [
      ["socket", socketPath],
      ["receiver", ready ? "listening" : "starting"],
      ["active c", String(activeConversationId)],
      ["default c", String(defaultConversationId)],
      ["sessions", String(conversations.filter((conversation) => conversation.status !== "closed").length)],
      ["pending", String(pending.length)],
      ["queued", String(queuedReplies.length)],
      ["focus", focusedId ? `#${focusedId}` : "oldest"],
      ["timeout", formatDuration(defaultTimeoutMs)],
      ["target", timeoutTarget ?? "not set"],
      ["telegram", telegramStatus.enabled ? "on" : "off"],
      ["tg chat", telegramStatus.chatId || "not set"],
      ["tg c", String(telegramStatus.conversationId || DEFAULT_CONVERSATION_ID)],
      ["wechat", wechatStatus.enabled ? "on" : "off"],
      ["wechat chat", wechatStatus.chatId || "not set"],
      ["wechat c", String(wechatStatus.conversationId || DEFAULT_CONVERSATION_ID)],
      ["ding", dingdingStatus.enabled ? "on" : "off"],
      ["ding chat", dingdingStatus.chatId || "not set"],
      ["ding c", String(dingdingStatus.conversationId || DEFAULT_CONVERSATION_ID)],
    ],
    [
      activeConversationId,
      conversations,
      defaultConversationId,
      defaultTimeoutMs,
      focusedId,
      pending.length,
      queuedReplies.length,
      ready,
      socketPath,
      telegramStatus.chatId,
      telegramStatus.conversationId,
      telegramStatus.enabled,
      timeoutTarget,
      wechatStatus.chatId,
      wechatStatus.conversationId,
      wechatStatus.enabled,
      dingdingStatus.chatId,
      dingdingStatus.conversationId,
      dingdingStatus.enabled,
    ],
  );

  const suggestions = getCommandSuggestions(input);
  const suggestionWindow = getSuggestionWindow(suggestions, selectedSuggestion);
  const showCommandPanel =
    input.startsWith("/") && dismissedCompletionInput !== input && !getArgumentEntryCommand(input);
  const completionActive = showCommandPanel;
  const conversationItems = useMemo(
    () =>
      conversations.map((conversation) => {
        const waiting = pending.filter((item) => item.conversationId === conversation.id).length;
        const queued = queuedReplies.filter((item) => item.conversationId === conversation.id).length;
        const tags = [];
        if (conversation.id === activeConversationId) {
          tags.push("active");
        }
        if (conversation.id === defaultConversationId) {
          tags.push("default");
        }
        if (conversation.id === telegramStatus.conversationId) {
          tags.push("tg");
        }
        if (conversation.id === wechatStatus.conversationId) {
          tags.push("wechat");
        }
        if (conversation.id === dingdingStatus.conversationId) {
          tags.push("ding");
        }
        return { ...conversation, waiting, queued, tags };
      }),
    [
      activeConversationId,
      conversations,
      defaultConversationId,
      pending,
      queuedReplies,
      telegramStatus.conversationId,
      wechatStatus.conversationId,
      dingdingStatus.conversationId,
    ],
  );
  const inputPlaceholder = `c${activeConversationId} Markdown reply or /help`;
  const activeQueuedCount = queuedReplies.filter((item) => item.conversationId === activeConversationId).length;
  const textAreaKeybindings = {
    Up: !completionActive && activeQueuedCount === 0,
    Down: !completionActive,
  };
  const completeSelectedCommand = useCallback(() => {
    const selected = suggestions[selectedSuggestion] ?? suggestions[0];
    if (selected) {
      setEditorText(selected.complete);
      setSelectedSuggestion(0);
    }
  }, [selectedSuggestion, setEditorText, setSelectedSuggestion, suggestions]);

  return {
    completeSelectedCommand,
    conversationItems,
    inputPlaceholder,
    showCommandPanel,
    statusItems,
    suggestionWindow,
    suggestions,
    textAreaKeybindings,
  };
}

export { useReceiverViewModel };
