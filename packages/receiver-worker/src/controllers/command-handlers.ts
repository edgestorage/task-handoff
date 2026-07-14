import { patchSettings } from "@task-handoff/core/core/persistence";
import { bindChatToConversation, listChatToolInstances } from "../state/chat-tools";
import type { ChatToolState } from "../state/chat-tools";
import { parseConversationId, parseConversationMode } from "../domain/conversations";
import { conversationAgent, conversationAgentSessionId, conversationWithMode } from "../domain/conversation-actions";
import type { ReceiverConversation, ReceiverLogFn, ReceiverRef } from "../types";

type ChatBridgeLike = {
  chatId?: string;
  statusLines?: () => string[];
  bind?: (...args: unknown[]) => unknown;
  setChat?: (chatId: string) => unknown;
  start?: () => unknown;
  stop?: () => unknown;
  unbind?: () => unknown;
  send?: (value: string) => unknown;
  login?: () => Promise<unknown>;
  setContext?: (value: string) => unknown;
};

type ReceiverCommandHandlersOptions = {
  addLog: ReceiverLogFn;
  activeConversationIdRef: ReceiverRef<number>;
  defaultConversationIdRef: ReceiverRef<number>;
  telegramConversationIdRef: ReceiverRef<number>;
  wechatConversationIdRef: ReceiverRef<number>;
  dingdingConversationIdRef: ReceiverRef<number>;
  conversationsRef: ReceiverRef<ReceiverConversation[]>;
  chatBridgesRef: ReceiverRef<{ get: (key: string) => unknown }>;
  chatToolStateRef: ReceiverRef<ChatToolState>;
  findConversation: (id: number) => ReceiverConversation | undefined;
  createNextConversation: (mode?: string) => ReceiverConversation;
  setActiveConversationId: (id: number) => void;
  setDefaultConversationId: (id: number) => void;
  ensureConversation: (id: number) => ReceiverConversation;
  syncConversations: (conversations: ReceiverConversation[]) => void;
  persistConversations: () => void;
  setConversationCwd: (id: number | undefined, cwdValue: string) => { ok: boolean; message: string };
  deleteConversation: (id: number) => boolean;
  syncTelegram: () => void;
  syncWechat: () => void;
  syncDingding: () => void;
};

function createReceiverCommandHandlers({
  addLog,
  activeConversationIdRef,
  defaultConversationIdRef,
  telegramConversationIdRef,
  wechatConversationIdRef,
  dingdingConversationIdRef,
  conversationsRef,
  chatBridgesRef,
  chatToolStateRef,
  findConversation,
  createNextConversation,
  setActiveConversationId,
  setDefaultConversationId,
  ensureConversation,
  syncConversations,
  persistConversations,
  setConversationCwd,
  deleteConversation,
  syncTelegram,
  syncWechat,
  syncDingding,
}: ReceiverCommandHandlersOptions) {
  const handleConversationCommand = (rest: string) => {
    const [subCommand, ...parts] = rest.split(/\s+/);
    const id = parseConversationId(parts[0]);

    if (!subCommand || subCommand === "status") {
      addLog(
        [
          `active=${activeConversationIdRef.current}`,
          `default=${defaultConversationIdRef.current}`,
          `telegram=${telegramConversationIdRef.current}`,
          `wechat=${wechatConversationIdRef.current}`,
          `dingding=${dingdingConversationIdRef.current}`,
          `total=${conversationsRef.current.length}`,
        ].join(" | "),
      );
    } else if (subCommand === "list") {
      conversationsRef.current.forEach((conversation) => {
        const cwdLabel = conversation.cwd ? ` cwd=${conversation.cwd}` : "";
        const agent = conversationAgent(conversation);
        const agentLabel = agent ? ` agent=${agent}` : "";
        const sessionId = conversationAgentSessionId(conversation);
        const sessionLabel = sessionId ? ` session=${sessionId}` : "";
        addLog(
          `c${conversation.id} ${conversation.mode} ${conversation.status}${
            conversation.id === activeConversationIdRef.current ? " active" : ""
          }${conversation.id === defaultConversationIdRef.current ? " default" : ""}${agentLabel}${sessionLabel}${cwdLabel}`,
        );
      });
    } else if (subCommand === "new") {
      const mode = parseConversationMode(parts[0]) || "passive";
      const conversation = createNextConversation(mode);
      activeConversationIdRef.current = conversation.id;
      setActiveConversationId(conversation.id);
      addLog(`conversation ${conversation.id} ${conversation.mode} created and selected`, "success");
    } else if (subCommand === "mode") {
      const mode = parseConversationMode(parts[1]);
      if (!id || !mode) {
        addLog("Usage: /conversation mode <id> <passive|codex|claude>", "warn");
      } else {
        ensureConversation(id);
        const now = new Date().toISOString();
        syncConversations(
          conversationsRef.current.map((conversation) =>
            conversation.id === id ? conversationWithMode(conversation, mode, now) : conversation,
          ),
        );
        addLog(`conversation ${id} mode set to ${mode}`, "success");
      }
    } else if (subCommand === "cwd") {
      const targetConversationId = id || activeConversationIdRef.current;
      const cwdValue = (id ? parts.slice(1) : parts).join(" ").trim();
      const result = setConversationCwd(targetConversationId, cwdValue);
      addLog(result.message, result.ok ? "success" : "warn");
    } else if (subCommand === "use") {
      if (!id) {
        addLog("Usage: /conversation use <id>", "warn");
      } else if (findConversation(id)?.status === "closed") {
        addLog(`conversation ${id} is closed. Use /conversation open ${id} first.`, "warn");
      } else {
        ensureConversation(id);
        activeConversationIdRef.current = id;
        setActiveConversationId(id);
        addLog(`terminal conversation set to ${id}`, "success");
      }
    } else if (subCommand === "default") {
      if (!id) {
        addLog("Usage: /conversation default <id>", "warn");
      } else if (findConversation(id)?.status === "closed") {
        addLog(`conversation ${id} is closed. Use /conversation open ${id} first.`, "warn");
      } else {
        ensureConversation(id);
        defaultConversationIdRef.current = id;
        setDefaultConversationId(id);
        persistConversations();
        addLog(`default conversation set to ${id}`, "success");
      }
    } else if (subCommand === "close") {
      if (!id) {
        addLog("Usage: /conversation close <id>", "warn");
      } else if (id === defaultConversationIdRef.current) {
        addLog("Cannot close the default conversation. Set another default first.", "warn");
      } else {
        const existing = ensureConversation(id);
        const now = new Date().toISOString();
        syncConversations(
          conversationsRef.current.map((conversation) =>
            conversation.id === existing.id
              ? { ...conversation, status: "closed", updatedAt: now, closedAt: now }
              : conversation,
          ),
        );
        if (activeConversationIdRef.current === id) {
          activeConversationIdRef.current = defaultConversationIdRef.current;
          setActiveConversationId(defaultConversationIdRef.current);
        }
        addLog(`conversation ${id} closed but kept in config`, "success");
      }
    } else if (subCommand === "delete" || subCommand === "remove" || subCommand === "rm") {
      deleteConversation(id || activeConversationIdRef.current);
    } else if (subCommand === "open") {
      if (!id) {
        addLog("Usage: /conversation open <id>", "warn");
      } else {
        ensureConversation(id);
        const now = new Date().toISOString();
        syncConversations(
          conversationsRef.current.map((conversation) =>
            conversation.id === id ? { ...conversation, status: "open", updatedAt: now, closedAt: undefined } : conversation,
          ),
        );
        addLog(`conversation ${id} reopened`, "success");
      }
    } else {
      addLog(`Unknown conversation command: ${subCommand}. Try /conversation status.`, "warn");
    }
  };

  const handleChatCommand = (rest: string) => {
    const [subCommand] = rest.split(/\s+/);
    if (subCommand && subCommand !== "status" && subCommand !== "list") {
      addLog(`Unknown chat command: ${subCommand}. Try /chat status.`, "warn");
      return;
    }

    const rows = listChatToolInstances(chatToolStateRef.current);
    const counts = (["telegram", "wechat", "dingding"] as const).map((channel) => {
      const channelRows = rows.filter((row) => row.channel === channel);
      const enabled = channelRows.filter((row) => row.enabled).length;
      return `${channel}=${channelRows.length}${enabled ? ` on=${enabled}` : ""}`;
    });
    const lines = [`chat tools: ${counts.join(" | ")}`];
    for (const row of rows) {
      lines.push(`${row.channel}:${row.instanceId} ${row.enabled ? "on" : "off"} defaultChat=${row.defaultChatId || "unset"}`);
    }
    addLog(lines.join("\n"));
  };

  const handleTelegramCommand = (rest: string) => {
    const telegram = chatBridgesRef.current.get("telegram") as ChatBridgeLike | undefined;
    const [subCommand, ...parts] = rest.split(/\s+/);
    const value = rest.slice((subCommand || "").length).trim();

    if (!telegram) {
      addLog("Telegram bridge is not ready yet.", "warn");
    } else if (!subCommand || subCommand === "status") {
      addLog(telegram.statusLines?.().join(" | ") || "");
    } else if (subCommand === "bind") {
      const token = parts[0];
      const chatId = parts[1];
      if (!token) {
        addLog("Usage: /telegram bind <bot-token> [chat-id]", "warn");
      } else {
        telegram.bind?.(token, chatId);
      }
    } else if (subCommand === "chat") {
      const chatId = parts[0];
      if (!chatId) {
        addLog("Usage: /telegram chat <chat-id>", "warn");
      } else {
        telegram.setChat?.(chatId);
      }
    } else if (subCommand === "conversation") {
      const id = parseConversationId(parts[0]);
      if (!id) {
        addLog("Usage: /telegram conversation <id>", "warn");
      } else if (findConversation(id)?.status === "closed") {
        addLog(`conversation ${id} is closed. Use /conversation open ${id} first.`, "warn");
      } else {
        ensureConversation(id);
        telegramConversationIdRef.current = id;
        if (telegram.chatId) {
          bindChatToConversation(chatToolStateRef.current, "telegram", "default", telegram.chatId, id);
          patchSettings({
            chatTools: chatToolStateRef.current.chatTools,
            chatBindings: chatToolStateRef.current.chatBindings,
          });
        }
        addLog(`Telegram bound to conversation ${id}`, "success");
      }
    } else if (subCommand === "on") {
      telegram.start?.();
    } else if (subCommand === "off") {
      telegram.stop?.();
      addLog("Telegram polling disabled", "success");
    } else if (subCommand === "unbind") {
      telegram.unbind?.();
    } else if (subCommand === "send") {
      if (!value) {
        addLog("Usage: /telegram send <message>", "warn");
      } else {
        telegram.send?.(value);
      }
    } else {
      addLog(`Unknown telegram command: ${subCommand}. Try /telegram status.`, "warn");
    }
    syncTelegram();
  };

  const handleWechatCommand = (rest: string) => {
    const wechat = chatBridgesRef.current.get("wechat") as ChatBridgeLike | undefined;
    const [subCommand, ...parts] = rest.split(/\s+/);
    const value = rest.slice((subCommand || "").length).trim();

    if (!wechat) {
      addLog("Wechat bridge is not ready yet.", "warn");
    } else if (!subCommand || subCommand === "status") {
      addLog(wechat.statusLines?.().join(" | ") || "");
    } else if (subCommand === "login") {
      wechat.login?.().catch((error: Error) => addLog(`Wechat login failed: ${error.message}`, "error"));
    } else if (subCommand === "bind") {
      const token = parts[0];
      if (!token) {
        addLog("Usage: /wechat bind <token>", "warn");
      } else {
        wechat.bind?.({ token });
      }
    } else if (subCommand === "chat") {
      const chatId = parts[0];
      if (!chatId) {
        addLog("Usage: /wechat chat <chat-id>", "warn");
      } else {
        wechat.setChat?.(chatId);
      }
    } else if (subCommand === "conversation") {
      const id = parseConversationId(parts[0]);
      if (!id) {
        addLog("Usage: /wechat conversation <id>", "warn");
      } else if (findConversation(id)?.status === "closed") {
        addLog(`conversation ${id} is closed. Use /conversation open ${id} first.`, "warn");
      } else {
        ensureConversation(id);
        wechatConversationIdRef.current = id;
        patchSettings({ wechat: { conversationId: id } });
        addLog(`Wechat bound to conversation ${id}`, "success");
      }
    } else if (subCommand === "context") {
      if (!value) {
        addLog("Usage: /wechat context <context-token>", "warn");
      } else {
        wechat.setContext?.(value);
      }
    } else if (subCommand === "on") {
      wechat.start?.();
    } else if (subCommand === "off") {
      wechat.stop?.();
      addLog("Wechat polling disabled", "success");
    } else if (subCommand === "unbind") {
      wechat.unbind?.();
    } else if (subCommand === "send") {
      if (!value) {
        addLog("Usage: /wechat send <message>", "warn");
      } else {
        wechat.send?.(value);
      }
    } else {
      addLog(`Unknown wechat command: ${subCommand}. Try /wechat status.`, "warn");
    }
    syncWechat();
  };

  const handleDingdingCommand = (rest: string) => {
    const dingding = chatBridgesRef.current.get("dingding") as ChatBridgeLike | undefined;
    const [subCommand, ...parts] = rest.split(/\s+/);
    const value = rest.slice((subCommand || "").length).trim();

    if (!dingding) {
      addLog("DingDing bridge is not ready yet.", "warn");
    } else if (!subCommand || subCommand === "status") {
      addLog(dingding.statusLines?.().join(" | ") || "");
    } else if (subCommand === "bind") {
      const [clientId, clientSecret, corpId, robotCode, chatId] = parts;
      if (!clientId || !clientSecret) {
        addLog("Usage: /dingding bind <client-id> <client-secret> [corp-id] [robot-code] [chat-id]", "warn");
      } else {
        dingding.bind?.(clientId, clientSecret, corpId, robotCode, chatId);
      }
    } else if (subCommand === "chat") {
      const chatId = parts[0];
      if (!chatId) {
        addLog("Usage: /dingding chat <conversation-id>", "warn");
      } else {
        dingding.setChat?.(chatId);
      }
    } else if (subCommand === "conversation") {
      const id = parseConversationId(parts[0]);
      if (!id) {
        addLog("Usage: /dingding conversation <id>", "warn");
      } else if (findConversation(id)?.status === "closed") {
        addLog(`conversation ${id} is closed. Use /conversation open ${id} first.`, "warn");
      } else {
        ensureConversation(id);
        dingdingConversationIdRef.current = id;
        if (dingding.chatId) {
          bindChatToConversation(chatToolStateRef.current, "dingding", "default", dingding.chatId, id);
          patchSettings({
            chatTools: chatToolStateRef.current.chatTools,
            chatBindings: chatToolStateRef.current.chatBindings,
          });
        }
        addLog(`DingDing bound to conversation ${id}`, "success");
      }
    } else if (subCommand === "on") {
      dingding.start?.();
    } else if (subCommand === "off") {
      dingding.stop?.();
      addLog("DingDing stream disabled", "success");
    } else if (subCommand === "unbind") {
      dingding.unbind?.();
    } else if (subCommand === "send") {
      if (!value) {
        addLog("Usage: /dingding send <message>", "warn");
      } else {
        dingding.send?.(value);
      }
    } else {
      addLog(`Unknown dingding command: ${subCommand}. Try /dingding status.`, "warn");
    }
    syncDingding();
  };

  return { handleConversationCommand, handleChatCommand, handleTelegramCommand, handleWechatCommand, handleDingdingCommand };
}

export { createReceiverCommandHandlers };
