import { createChatTextRouter } from "@task-handoff/core/core/chat";
import { createSingleColumnKeyboard } from "@task-handoff/core/core/chat-interactions";
import { patchSettings } from "@task-handoff/core/core/persistence";
import { parseConversationId, parseConversationMode } from "../domain/conversations";
import { conversationAgent, conversationAgentSessionId } from "../domain/conversation-actions";
import { listHistoricalSessions, type HistoricalSession, type HistoricalSessionAgent } from "@task-handoff/ai-session-runtime";
import type { AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import { bindChatToConversation } from "../state/chat-tools";
import { resultHistoryPayload } from "../state/result-history";
import type { Channel, ChatToolState } from "../state/chat-tools";
import type { ResultHistoryStore } from "../state/result-history";
import type { ReceiverConversation, ReceiverLogFn, ReceiverRef } from "../types";

type ChatBridgeRegistryLike = {
  get: (channel: string) => { send?: (text: string, route?: unknown) => unknown } | undefined;
};

type CwdPickerPrompt = {
  text: string;
  replyMarkup: unknown;
};

type SetConversationCwdResult = {
  ok: boolean;
  message: string;
};

type ConversationPickerPayload = {
  text: string;
  replyMarkup?: unknown;
};

type BindConversationToChatOptions = {
  channel: Channel;
  instanceId: string;
  chatId?: string;
  conversationId?: number;
  extra?: Record<string, unknown>;
};

type ChatConversationCommandOptions = {
  channel: Channel;
  instanceId: string;
  chatId?: string;
  text: string;
  send?: (message: string, extra?: unknown) => unknown;
  extra?: Record<string, unknown>;
  fallbackConversationId: number;
};

type ChatConversationActionOptions = {
  channel: Channel;
  instanceId: string;
  chatId?: string;
  conversationId?: number;
  fallbackConversationId: number;
  extra?: Record<string, unknown>;
};

type ChatSessionActionOptions = {
  conversationId?: number;
  agent?: string;
  sessionId?: string;
};

type ReceiverSelectableSession = HistoricalSession & {
  aiSessionId?: string;
  providerSessionId?: string;
  status?: string;
};

type ReceiverChatRouterOptions = {
  addLog: ReceiverLogFn;
  chatBridgesRef: ReceiverRef<ChatBridgeRegistryLike>;
  chatToolStateRef: ReceiverRef<ChatToolState>;
  commandCaptureRef: ReceiverRef<string[] | undefined>;
  createNextConversation: (mode?: string) => ReceiverConversation;
  createCwdPicker: (conversationId: number) => CwdPickerPrompt;
  deleteConversation: (conversationId: number) => boolean;
  ensureConversation: (conversationId: number) => ReceiverConversation;
  findConversation: (conversationId: number) => ReceiverConversation | undefined;
  listConversations: () => ReceiverConversation[];
  listHistoricalSessionsForCwd?: typeof listHistoricalSessions;
  listAiSessionsForCwd?: (options: { cwd: string; agent?: HistoricalSessionAgent; limit?: number }) => ReceiverSelectableSession[];
  handleCommand: (line: string, context?: { conversationId?: number }) => void;
  replyDefault: (text: string, label: string, conversationId?: number, processing?: unknown, options?: unknown) => unknown;
  resultHistoryRef: ReceiverRef<ResultHistoryStore>;
  selectHistoricalSession: (conversationId: number, session: ReceiverSelectableSession) => { ok: boolean; message: string };
  setConversationCwd: (conversationId: number, cwdValue: string) => SetConversationCwdResult;
};

function modeLabel(mode: unknown) {
  if (mode === "codex") {
    return "Codex";
  }
  if (mode === "claude") {
    return "Claude";
  }
  return "被动";
}

function compactPath(value: unknown) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= 42) {
    return text;
  }
  const normalized = text.replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return text.slice(0, 39) + "...";
  }
  return `.../${parts.slice(-2).join("/")}`;
}

function compactSessionId(value: unknown) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.length > 12 ? `${text.slice(0, 8)}...` : text;
}

function conversationPickerLine(conversation: ReceiverConversation, currentConversationId: number) {
  const current = conversation.id === currentConversationId;
  const parts = [`${current ? "*" : " "} c${conversation.id}`, modeLabel(conversation.mode)];
  if (current) {
    parts.push("当前");
  }
  const cwd = compactPath(conversation.cwd);
  if (cwd) {
    parts.push(cwd);
  }
  const sessionId = compactSessionId(conversationAgentSessionId(conversation));
  if (sessionId) {
    parts.push(`session ${sessionId}`);
  }
  return parts.join(" · ");
}

function conversationButtonLabel(conversation: ReceiverConversation, currentConversationId: number) {
  return `${conversation.id === currentConversationId ? "✓ " : ""}c${conversation.id} · ${modeLabel(conversation.mode)}`;
}

function sessionLine(session: ReceiverSelectableSession, index: number) {
  const date = session.updatedAt ? session.updatedAt.slice(0, 16).replace("T", " ") : "";
  const title = session.title ? ` · ${session.title}` : "";
  const status = session.status ? ` · ${session.status}` : "";
  return `${index + 1}. ${modeLabel(session.agent)} · ${compactSessionId(session.sessionId)}${status} · ${date}${title}`;
}

function sessionButtonLabel(session: ReceiverSelectableSession) {
  return `${modeLabel(session.agent)} · ${compactSessionId(session.sessionId)}`;
}

function parseSessionAgent(value: unknown): HistoricalSessionAgent | undefined {
  return value === "codex" || value === "claude" ? value : undefined;
}

function selectableSessionFromAiSession(session: AiSessionSummary): ReceiverSelectableSession | undefined {
  const agent = parseSessionAgent(session.agent);
  if (!agent) {
    return undefined;
  }
  const sessionId = String(session.providerSessionId || session.id || "").trim();
  if (!sessionId) {
    return undefined;
  }
  return {
    agent,
    sessionId,
    providerSessionId: session.providerSessionId,
    aiSessionId: session.id,
    cwd: String(session.cwd || process.cwd()),
    updatedAt: session.updatedAt,
    transcriptPath: "",
    title: session.userPrompt || session.summary || session.lastMessage,
    status: session.status,
  };
}

function createAiSessionPickerSource(snapshot: () => { sessions?: AiSessionSummary[] }) {
  return ({ cwd, agent, limit = 20 }: { cwd: string; agent?: HistoricalSessionAgent; limit?: number }) => {
    const resolvedCwd = String(cwd || "").trim();
    return (snapshot().sessions || [])
      .map(selectableSessionFromAiSession)
      .filter((session): session is ReceiverSelectableSession => Boolean(session))
      .filter((session) => (!resolvedCwd || session.cwd === resolvedCwd) && (!agent || session.agent === agent))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
  };
}

function createReceiverChatRouter({
  addLog,
  chatBridgesRef,
  chatToolStateRef,
  commandCaptureRef,
  createNextConversation,
  createCwdPicker,
  deleteConversation,
  ensureConversation,
  findConversation,
  listConversations,
  listAiSessionsForCwd,
  listHistoricalSessionsForCwd = listHistoricalSessions,
  handleCommand,
  replyDefault,
  resultHistoryRef,
  selectHistoricalSession,
  setConversationCwd,
}: ReceiverChatRouterOptions) {
  const runChatCommand = (line: string, context?: { conversationId?: number }) => {
    const captured: string[] = [];
    commandCaptureRef.current = captured;
    try {
      handleCommand(line, context);
    } finally {
      commandCaptureRef.current = undefined;
    }
    return captured.join("\n");
  };

  const bindConversationToChat = ({ channel, instanceId, chatId, conversationId, extra = {} }: BindConversationToChatOptions) => {
    if (!chatId || !conversationId) {
      return false;
    }
    if (findConversation(conversationId)?.status === "closed") {
      return false;
    }
    ensureConversation(conversationId);
    bindChatToConversation(chatToolStateRef.current, channel, instanceId, chatId, conversationId, extra);
    patchSettings({
      chatTools: chatToolStateRef.current.chatTools,
      chatBindings: chatToolStateRef.current.chatBindings,
    });
    addLog(`${channel}:${instanceId}:${chatId} bound to c${conversationId}`, "success");
    return true;
  };

  const latestConversationResultText = (conversationId: number) => {
    const payload = resultHistoryPayload(resultHistoryRef.current, conversationId);
    return payload.found ? ["最近完成任务：", payload.text].join("\n") : `最近完成任务：会话 c${conversationId} 暂无历史结果`;
  };

  const conversationPickerPayload = (
    channel: Channel,
    instanceId: string,
    chatId: string | undefined,
    fallbackConversationId: number,
  ): ConversationPickerPayload => {
    const binding = chatId ? chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId] : undefined;
    const currentConversationId = binding?.conversationId || fallbackConversationId;
    const conversations = listConversations().filter((conversation) => conversation.status !== "closed");
    if (conversations.length === 0) {
      return { text: "当前没有可选择的会话" };
    }
    const text = [
      `选择会话（当前 c${currentConversationId}，共 ${conversations.length} 个）：`,
      ...conversations.map((conversation) => conversationPickerLine(conversation, currentConversationId)),
    ].join("\n");
    return {
      text,
      replyMarkup: createSingleColumnKeyboard(conversations.map((conversation) => ({
        text: conversationButtonLabel(conversation, currentConversationId),
        callbackData: `task_handoff:conversation:${conversation.id}`,
      }))),
    };
  };

  const sessionPickerPayload = (conversationId: number, requestedAgent?: HistoricalSessionAgent): ConversationPickerPayload => {
    const conversation = findConversation(conversationId);
    const cwd = String(conversation?.cwd || process.cwd());
    const agent = requestedAgent || parseSessionAgent(conversationAgent(conversation));
    const sessions = listAiSessionsForCwd?.({ cwd, agent, limit: 20 }) || listHistoricalSessionsForCwd({ cwd, agent, limit: 20 });
    const agentLabel = agent ? modeLabel(agent) : "Codex/Claude";
    if (sessions.length === 0) {
      return { text: `当前目录没有可选择的 ${agentLabel} 历史 session\n目录：${cwd}` };
    }
    return {
      text: [
        `选择 ${agentLabel} 历史 session（c${conversationId}，共 ${sessions.length} 个）：`,
        `目录：${compactPath(cwd)}`,
        ...sessions.map(sessionLine),
      ].join("\n"),
      replyMarkup: createSingleColumnKeyboard(sessions.map((session, index) => ({
        text: sessionButtonLabel(session),
        callbackData: `task_handoff:session:${conversationId}:${session.agent}:i${index}`,
      }))),
    };
  };

  const handleConversationAction = ({
    channel,
    instanceId,
    chatId,
    conversationId,
    fallbackConversationId,
    extra = {},
  }: ChatConversationActionOptions) => {
    const ok = bindConversationToChat({ channel, instanceId, chatId, conversationId, extra });
    if (!ok || !conversationId) {
      return {
        text: `无法绑定到会话 c${conversationId || ""}`.trim(),
        message: "conversation not found",
        found: false,
      };
    }
    const picker = conversationPickerPayload(channel, instanceId, chatId, fallbackConversationId);
    return {
      text: [`已将当前聊天绑定到会话 c${conversationId}`, "", latestConversationResultText(conversationId), "", picker.text].join("\n"),
      replyMarkup: picker.replyMarkup,
      message: `bound to c${conversationId}`,
      found: true,
    };
  };

  const handleSessionAction = ({ conversationId, agent, sessionId }: ChatSessionActionOptions) => {
    const targetConversationId = parseConversationId(conversationId);
    const parsedAgent = parseSessionAgent(agent);
    const sessionKey = String(sessionId || "").trim();
    if (!targetConversationId || !parsedAgent || !sessionKey) {
      return { found: false, message: "session not found" };
    }
    const conversation = findConversation(targetConversationId);
    const cwd = String(conversation?.cwd || process.cwd());
    const sessions = listAiSessionsForCwd?.({ cwd, agent: parsedAgent, limit: 200 }) || listHistoricalSessionsForCwd({ cwd, agent: parsedAgent, limit: 200 });
    const indexMatch = sessionKey.match(/^i(\d+)$/);
    const session = indexMatch ? sessions[Number(indexMatch[1])] : sessions.find((entry) => entry.sessionId === sessionKey);
    if (!session) {
      return { found: false, message: "session not found" };
    }
    const result = selectHistoricalSession(targetConversationId, session);
    return {
      found: result.ok,
      message: result.message,
      text: result.message,
    };
  };

  const handleChatConversationCommand = ({ channel, instanceId, chatId, text, send, extra, fallbackConversationId }: ChatConversationCommandOptions) => {
    const line = String(text || "").trim();
    const sessionMatch = line.match(/^\/?session(?:\s+(codex|claude))?\s*$/i);
    if (sessionMatch) {
      const binding = chatId ? chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId] : undefined;
      const conversationId = binding?.conversationId || fallbackConversationId;
      const picker = sessionPickerPayload(conversationId, parseSessionAgent(sessionMatch[1]));
      Promise.resolve(send?.(picker.text, picker.replyMarkup ? { reply_markup: picker.replyMarkup } : undefined)).catch((error) =>
        addLog(`${channel}:${instanceId} session picker response failed: ${error.message}`),
      );
      return true;
    }
    const historyMatch = line.match(/^\/(?:history|h)(?:\s+(\d+))?(?:\s+(\d+))?\s*$/i);
    if (historyMatch) {
      const binding = chatId ? chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId] : undefined;
      const conversationId = parseConversationId(historyMatch[1]) || binding?.conversationId || fallbackConversationId;
      const index = historyMatch[2] ? Number(historyMatch[2]) - 1 : undefined;
      const payload = resultHistoryPayload(resultHistoryRef.current, conversationId, index);
      Promise.resolve(send?.(payload.text, payload.replyMarkup ? { reply_markup: payload.replyMarkup } : undefined)).catch((error) =>
        addLog(`${channel}:${instanceId} history response failed: ${error.message}`),
      );
      return true;
    }
    if (/^\/?(?:conversation|c)\s*$/i.test(line)) {
      const picker = conversationPickerPayload(channel, instanceId, chatId, fallbackConversationId);
      Promise.resolve(send?.(picker.text, picker.replyMarkup ? { reply_markup: picker.replyMarkup } : undefined)).catch((error) =>
        addLog(`${channel}:${instanceId} conversation picker response failed: ${error.message}`),
      );
      return true;
    }
    if (/^\/(?:conversation|c)\s+status\s*$/i.test(line)) {
      const binding = chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId];
      const response = binding?.conversationId
        ? `当前聊天绑定到会话 c${binding.conversationId}`
        : `当前聊天尚未单独绑定，将使用默认会话 c${fallbackConversationId}`;
      Promise.resolve(send?.(response)).catch((error) =>
        addLog(`${channel}:${instanceId} status response failed: ${error.message}`),
      );
      return true;
    }
    const newMatch = line.match(/^\/(?:conversation|c)\s+new(?:\s+(\S+))?\s*$/i);
    if (newMatch) {
      const mode = parseConversationMode(newMatch[1]) || "passive";
      if (!chatId) {
        Promise.resolve(send?.("无法创建会话绑定：当前聊天缺少 chatId")).catch((error) =>
          addLog(`${channel}:${instanceId} new response failed: ${error.message}`),
        );
        return true;
      }
      const conversation = createNextConversation(mode);
      bindConversationToChat({ channel, instanceId, chatId, conversationId: conversation.id, extra });
      Promise.resolve(send?.(`已创建会话 c${conversation.id}（${conversation.mode}）并绑定到当前聊天`)).catch((error) =>
        addLog(`${channel}:${instanceId} new response failed: ${error.message}`),
      );
      return true;
    }
    const cwdMatch = line.match(/^\/(?:conversation|c)\s+cwd(?:\s+(.+))?$/i);
    if (cwdMatch) {
      const binding = chatId ? chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId] : undefined;
      const cwdRest = String(cwdMatch[1] || "").trim();
      const [firstPart, ...restParts] = cwdRest.split(/\s+/).filter(Boolean);
      const explicitConversationId = parseConversationId(firstPart);
      const conversationId = explicitConversationId || binding?.conversationId || fallbackConversationId;
      const cwdValue = (explicitConversationId ? restParts.join(" ") : cwdRest).trim();
      if (!conversationId) {
        Promise.resolve(send?.("Usage: /conversation cwd [id] <path>")).catch((error) =>
          addLog(`${channel}:${instanceId} cwd usage response failed: ${error.message}`),
        );
        return true;
      }
      if (!cwdValue) {
        const picker = createCwdPicker(conversationId);
        Promise.resolve(send?.(picker.text, { reply_markup: picker.replyMarkup })).catch((error) =>
          addLog(`${channel}:${instanceId} cwd prompt failed: ${error.message}`),
        );
        return true;
      }
      const result = setConversationCwd(conversationId, cwdValue);
      Promise.resolve(send?.(result.ok ? `已设置 c${conversationId} 工作目录：${result.message.replace(/^conversation \d+ cwd set to /, "")}` : result.message)).catch((error) =>
        addLog(`${channel}:${instanceId} cwd response failed: ${error.message}`),
      );
      return true;
    }
    const deleteMatch = line.match(/^\/(?:conversation|c)\s+(?:delete|remove|rm)(?:\s+(\d+))?\s*$/i);
    if (deleteMatch) {
      const binding = chatId ? chatToolStateRef.current.chatBindings[channel]?.[instanceId]?.[chatId] : undefined;
      const conversationId = parseConversationId(deleteMatch[1]) || binding?.conversationId || fallbackConversationId;
      const ok = deleteConversation(conversationId);
      Promise.resolve(send?.(ok ? `已删除会话 c${conversationId}` : `无法删除会话 c${conversationId}`)).catch((error) =>
        addLog(`${channel}:${instanceId} delete response failed: ${error.message}`),
      );
      return true;
    }
    const match = line.match(/^\/(?:conversation|c)\s+(?:use\s+)?(\d+)\s*$/i);
    if (!match) {
      return false;
    }
    const conversationId = parseConversationId(match[1]);
    const ok = bindConversationToChat({ channel, instanceId, chatId, conversationId, extra });
    const response =
      ok && conversationId
        ? [`已将当前聊天绑定到会话 c${conversationId}`, "", latestConversationResultText(conversationId)].join("\n")
        : `无法绑定到会话 c${conversationId}`;
    Promise.resolve(send?.(response)).catch((error) => addLog(`${channel}:${instanceId} bind response failed: ${error.message}`));
    return true;
  };

  const handleChatText = createChatTextRouter({
    addLog,
    handleCommand,
    replyDefault,
    runCommand: runChatCommand,
    sendCommandResponse: ({ channel, text, route }) => chatBridgesRef.current.get(channel)?.send?.(text, route),
  });

  return {
    bindConversationToChat,
    handleChatConversationAction: handleConversationAction,
    handleChatConversationCommand,
    handleChatSessionAction: handleSessionAction,
    handleChatText,
    runChatCommand,
  };
}

export { createReceiverChatRouter };
export { createAiSessionPickerSource, selectableSessionFromAiSession };
