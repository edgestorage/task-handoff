import { DEFAULT_TIMEOUT_MS } from "@task-handoff/core/core/config";
import { formatApprovalAutoAllowConversationStatus, setApprovalAutoAllowConversation } from "@task-handoff/core/core/approval-policy";
import { parseDuration } from "@task-handoff/core/core/duration";
import { formatDuration } from "@task-handoff/terminal-ui";
import { formatCommandHelp } from "../domain/commands";
import { formatResultHistory } from "../state/result-history";
import { parseTaskId, splitTaskScopedText } from "../state/pending";
import { parseConversationId } from "../domain/conversations";
import type { ResultHistoryStore } from "../state/result-history";
import type {
  PendingItem,
  QueuedReply,
  ReceiverLogFn,
  ReceiverRef,
} from "../types";

type BridgeRegistryLike = {
  get: (key: string) => { enabled?: boolean; chatId?: string } | undefined;
};

type ReceiverTerminalCommandRouterOptions = {
  activeConversationIdRef: ReceiverRef<number>;
  addLog: ReceiverLogFn;
  chatBridgesRef: ReceiverRef<BridgeRegistryLike>;
  defaultConversationIdRef: ReceiverRef<number>;
  defaultTimeoutMsRef: ReceiverRef<number>;
  findPendingById: (id: number) => PendingItem | undefined;
  focusedIdRef: ReceiverRef<number | undefined>;
  handleChatCommand: (rest: string) => unknown;
  handleConversationCommand: (rest: string) => unknown;
  handleTelegramCommand: (rest: string) => unknown;
  handleWechatCommand: (rest: string) => unknown;
  handleDingdingCommand: (rest: string) => unknown;
  cancelActiveConversation: (conversationId: number) => boolean;
  resetConversationSession: (conversationId: number) => { ok: boolean; message: string };
  formatSessionHistory: (conversationId: number, agent?: string) => string;
  getConversationTimeoutMs: (conversationId: number) => number;
  pendingRef: ReceiverRef<PendingItem[]>;
  queuedRepliesRef: ReceiverRef<QueuedReply[]>;
  resultHistoryRef: ReceiverRef<ResultHistoryStore>;
  replyApproval: (id: number | undefined, decision: string, label?: string) => unknown;
  replyDefault: (value: string, label: string) => unknown;
  replyToItem: (item: PendingItem, value: string, label?: string) => unknown;
  restartSelf: () => void;
  setDefaultTimeoutMs: (value: number) => void;
  setConversationTimeoutMs: (conversationId: number, timeoutMs?: number) => void;
  setFocusedId: (id: number | undefined) => void;
  setTimeoutTarget: (target: string | undefined) => void;
  stopAll: () => void;
  telegramConversationIdRef: ReceiverRef<number>;
  timeoutTargetRef: ReceiverRef<string | undefined>;
  wechatConversationIdRef: ReceiverRef<number>;
  dingdingConversationIdRef: ReceiverRef<number>;
};

function createReceiverTerminalCommandRouter({
  activeConversationIdRef,
  addLog,
  chatBridgesRef,
  defaultConversationIdRef,
  defaultTimeoutMsRef,
  findPendingById,
  focusedIdRef,
  handleChatCommand,
  handleConversationCommand,
  handleTelegramCommand,
  handleWechatCommand,
  handleDingdingCommand,
  cancelActiveConversation,
  resetConversationSession,
  formatSessionHistory,
  getConversationTimeoutMs,
  pendingRef,
  queuedRepliesRef,
  resultHistoryRef,
  replyApproval,
  replyDefault,
  replyToItem,
  restartSelf,
  setDefaultTimeoutMs,
  setConversationTimeoutMs,
  setFocusedId,
  setTimeoutTarget,
  stopAll,
  telegramConversationIdRef,
  timeoutTargetRef,
  wechatConversationIdRef,
  dingdingConversationIdRef,
}: ReceiverTerminalCommandRouterOptions) {
  return (line: string, context: { conversationId?: number } = {}) => {
    const [rawCommand] = line.slice(1).trim().split(/\s+/);
    if (!rawCommand || rawCommand === "help" || rawCommand === "?") {
      addLog(formatCommandHelp());
      return;
    }

    const command = rawCommand.toLowerCase();
    const rest = line.slice(1).trim().slice(rawCommand.length).trim();
    const commandConversationId = parseConversationId(context.conversationId) || activeConversationIdRef.current;

    if (command === "status") {
      addLog(
        [
          "状态：",
          `待处理任务：${pendingRef.current.length}`,
          `排队回复：${queuedRepliesRef.current.length}`,
          `当前会话：${activeConversationIdRef.current}`,
          `默认会话：${defaultConversationIdRef.current}`,
          `默认目标：${focusedIdRef.current ? `#${focusedIdRef.current}` : "最早任务"}`,
          `等待时间：${formatDuration(getConversationTimeoutMs(activeConversationIdRef.current))}`,
          `超时自动回复：${timeoutTargetRef.current ?? "未设置"}`,
          `Telegram：${chatBridgesRef.current.get("telegram")?.enabled ? "开启" : "关闭"}`,
          `Telegram chat：${chatBridgesRef.current.get("telegram")?.chatId || "未设置"}`,
          `Telegram 会话：${telegramConversationIdRef.current}`,
          `Wechat 会话：${wechatConversationIdRef.current}`,
          `DingDing 会话：${dingdingConversationIdRef.current}`,
        ].join("\n"),
      );
    } else if (command === "conversation" || command === "c") {
      handleConversationCommand(rest);
    } else if (command === "chat") {
      handleChatCommand(rest);
    } else if (command === "telegram" || command === "tg") {
      handleTelegramCommand(rest);
    } else if (command === "wechat") {
      handleWechatCommand(rest);
    } else if (command === "dingding" || command === "ding") {
      handleDingdingCommand(rest);
    } else if (command === "list") {
      if (pendingRef.current.length === 0 && queuedRepliesRef.current.length === 0) {
        addLog("No pending tasks or queued replies.");
      }
      if (pendingRef.current.length > 0) {
        pendingRef.current.forEach((item) => {
          addLog(
            `c${item.conversationId} #${item.id} ${item.kind === "approval" ? "approval " : ""}${formatDuration(item.timeoutMs)} ${item.result
              .replace(/\s+/g, " ")
              .slice(0, 120)}`,
          );
        });
      }
      if (queuedRepliesRef.current.length > 0) {
        queuedRepliesRef.current.forEach((item) => {
          addLog(`queued c${item.conversationId} #${item.id} ${item.value.replace(/\s+/g, " ").slice(0, 120)}`);
        });
      }
    } else if (command === "history" || command === "h") {
      const [conversationIdArg, indexArg] = rest.split(/\s+/).filter(Boolean);
      const conversationId = Number(conversationIdArg) || commandConversationId;
      const index = Number(indexArg);
      addLog(formatResultHistory(resultHistoryRef.current, conversationId, Number.isFinite(index) ? index - 1 : undefined));
    } else if (command === "focus") {
      if (rest === "clear") {
        focusedIdRef.current = undefined;
        setFocusedId(undefined);
        addLog("focus cleared", "success");
      } else {
        const id = parseTaskId(rest);
        const item = id ? findPendingById(id) : undefined;
        if (!item) {
          addLog("Usage: /focus #id", "warn");
        } else {
          focusedIdRef.current = item.id;
          setFocusedId(item.id);
          addLog(`focus set to #${item.id}`, "success");
        }
      }
    } else if (command === "drop") {
      const id = parseTaskId(rest);
      const item = id ? findPendingById(id) : undefined;
      if (!item) {
        addLog("Usage: /drop #id", "warn");
      } else {
        replyToItem(item, "continue", `dropped #${item.id}`);
      }
    } else if (command === "approve" || command === "allow") {
      replyApproval(parseTaskId(rest), "allow", "approved");
    } else if (command === "deny" || command === "reject") {
      replyApproval(parseTaskId(rest), "deny", "denied");
    } else if (command === "skip") {
      replyApproval(parseTaskId(rest), "skip", "skipped");
    } else if (command === "auto-approve" || command === "autoallow" || command === "aa") {
      const [action = "status", conversationArg] = rest.split(/\s+/).filter(Boolean);
      if (!["on", "off", "status"].includes(action)) {
        addLog("Usage: /auto-approve <on|off|status> [conversation-id]", "warn");
        return;
      }
      const conversationId = conversationArg ? parseConversationId(conversationArg) : commandConversationId;
      if (!conversationId) {
        addLog("Usage: /auto-approve <on|off|status> [conversation-id]", "warn");
        return;
      }
      if (action === "status") {
        addLog(formatApprovalAutoAllowConversationStatus(conversationId));
        return;
      }
      const enabled = action === "on";
      const result = setApprovalAutoAllowConversation(conversationId, enabled, `conversation:${commandConversationId}`);
      addLog(
        `approval auto-approve ${enabled ? "enabled" : "disabled"} for conversation ${result.key}`,
        "success",
      );
    } else if (command === "cancel") {
      const conversationId = parseConversationId(rest) || commandConversationId;
      const cancelled = cancelActiveConversation(conversationId);
      addLog(
        cancelled ? `cancel requested for active conversation ${conversationId}` : `no running active task in conversation ${conversationId}`,
        "warn",
      );
    } else if (command === "session") {
      const [subCommand, idArg] = rest.split(/\s+/).filter(Boolean);
      if (!subCommand || subCommand === "codex" || subCommand === "claude") {
        addLog(formatSessionHistory(commandConversationId, subCommand));
      } else if (subCommand === "new") {
        const conversationId = parseConversationId(idArg) || commandConversationId;
        const result = resetConversationSession(conversationId);
        addLog(result.message, result.ok ? "success" : "warn");
      } else {
        addLog("Usage: /session [codex|claude] or /session new [conversation-id]", "warn");
      }
    } else if (command === "target") {
      if (rest === "clear") {
        timeoutTargetRef.current = undefined;
        setTimeoutTarget(undefined);
        addLog("timeout target cleared", "success");
      } else if (!rest) {
        addLog(`timeout target: ${timeoutTargetRef.current ?? "not set"}`);
      } else {
        timeoutTargetRef.current = rest;
        setTimeoutTarget(rest);
        addLog("timeout target set", "success");
      }
    } else if (command === "timeout") {
      const conversationId = commandConversationId;
      if (rest === "reset") {
        setConversationTimeoutMs(conversationId, undefined);
        defaultTimeoutMsRef.current = getConversationTimeoutMs(conversationId);
        setDefaultTimeoutMs(DEFAULT_TIMEOUT_MS);
        addLog(`conversation ${conversationId} timeout reset to ${formatDuration(DEFAULT_TIMEOUT_MS)}`, "success");
      } else if (!rest) {
        addLog(`conversation ${conversationId} timeout: ${formatDuration(getConversationTimeoutMs(conversationId))}`);
      } else {
        try {
          const timeoutMs = parseDuration(rest);
          setConversationTimeoutMs(conversationId, timeoutMs);
          defaultTimeoutMsRef.current = timeoutMs;
          setDefaultTimeoutMs(timeoutMs);
          addLog(`conversation ${conversationId} timeout set to ${formatDuration(timeoutMs)}`, "success");
        } catch (error: unknown) {
          addLog(error instanceof Error ? error.message : String(error), "warn");
        }
      }
    } else if (command === "reply") {
      if (!rest) {
        addLog("Usage: /reply <markdown> or /reply #id <markdown>", "warn");
      } else {
        const scoped = splitTaskScopedText(rest);
        if (scoped.id) {
          const item = findPendingById(scoped.id);
          if (!item || !scoped.text) {
            addLog("Usage: /reply #id <markdown>", "warn");
          } else {
            replyToItem(item, scoped.text, `sent #${item.id}`);
          }
        } else {
          replyDefault(scoped.text, "sent");
        }
      }
    } else if (command === "quit" || command === "exit") {
      stopAll();
    } else if (command === "restart") {
      restartSelf();
    } else {
      addLog(`Unknown command: /${command}. Try /help.`, "warn");
    }
  };
}

export { createReceiverTerminalCommandRouter };
