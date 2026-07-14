import { spawn } from "node:child_process";
import type net from "node:net";
import { PassThrough, Writable } from "node:stream";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { render, useApp, type RenderOptions } from "ink";
import { CONFIG_PATH, DEFAULT_CONVERSATION_ID, DEFAULT_TIMEOUT_MS } from "@task-handoff/core/core/config";
import { appendJsonl, defaultDiagnosticLogPath } from "@task-handoff/core/core/diagnostics";
import {
  createChatBridgeRegistry,
  createChatProgressController,
} from "@task-handoff/core/core/chat";
import { unlinkSocket } from "@task-handoff/core/core/socket";
import { startTranscriptProgress } from "@task-handoff/core/core/progress";
import { formatDuration } from "@task-handoff/terminal-ui";
import { listChatBindings } from "./state/chat-tools";
import { createResultHistoryStore, resultHistoryPayload } from "./state/result-history";
import { createReceiverCommandHandlers } from "./controllers/command-handlers";
import { createActiveConversationController } from "./controllers/active-conversation-controller";
import { createAiSessionPickerSource, createReceiverChatRouter } from "./controllers/chat-command-router";
import { ReceiverView } from "./view/view";
import { createReceiverTerminalCommandRouter } from "./controllers/terminal-command-router";
import { useReceiverInputController } from "./controllers/input-controller";
import { useReceiverViewModel } from "./view/view-model";
import { useReceiverReplyController } from "./controllers/reply-controller";
import { useReceiverServer } from "./runtime/receiver-server";
import { createInitialReceiverState } from "./initial-state";
import { useReceiverConversationController } from "./controllers/conversation-controller";
import { conversationWithAiSession, conversationWithHistoricalSession, conversationWithNewAgentSession } from "./domain/conversation-actions";
import { isActiveConversationMode } from "./domain/active-agents";
import { createAiSessionRegistry, listHistoricalSessions, type HistoricalSession } from "@task-handoff/ai-session-runtime";
import { moveCursorLine, renderInputLines, stripAnsi } from "./view/input";
import { guardRawModeEio, restartShellCommand } from "./runtime/raw-mode";
import type { ActiveChatRoute } from "@task-handoff/core/core/chat";
import type { CwdPicker } from "./domain/cwd-picker";
import type {
  ChatStatus,
  PendingItem,
  PendingViewItem,
  QueuedReply,
  QueuedReplyViewItem,
  ReceiverConversation,
  ReceiverLogLevel,
  ReceiverProcessing,
} from "./types";

type LogEntry = {
  id: number;
  message: string;
  level: ReceiverLogLevel;
};

type ActiveQueuedPrompt = {
  id: number;
  conversationId: number;
  value: string;
  label: string;
};

type RunReceiverInkOptions = React.ComponentProps<typeof ReceiverApp> & {
  headless?: boolean;
};

const RECEIVER_LOG_PATH =
  process.env.TASK_HANDOFF_RECEIVER_LOG ||
  (process.env.TASK_HANDOFF_LOG_DIR ? `${process.env.TASK_HANDOFF_LOG_DIR}/receiver.log` : undefined) ||
  defaultDiagnosticLogPath(CONFIG_PATH, "receiver.log");

function createHeadlessInput() {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (enabled: boolean) => PassThrough;
    ref: () => PassThrough;
    unref: () => PassThrough;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled: boolean) => {
    input.isRaw = enabled;
    return input;
  };
  input.ref = () => input;
  input.unref = () => input;
  input.resume();
  return input;
}

function createNullOutput() {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as Writable & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  output.columns = 120;
  output.rows = 40;
  output.isTTY = false;
  return output;
}

function trimLogs(logs) {
  return logs.slice(-9);
}

function cursorPositionAtEnd(value: string): [number, number] {
  const lines = String(value).split("\n");
  return [lines.length - 1, lines[lines.length - 1].length];
}

function resetRawMode(stream = process.stdin) {
  if (!stream?.setRawMode || !stream.isTTY) {
    return;
  }
  try {
    stream.setRawMode(false);
  } catch (error) {
    if (error?.code !== "EIO") {
      throw error;
    }
  }
}

function ReceiverApp({
  socketPath,
  telegramToken,
  telegramChatId,
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
  dingdingConversationId = DEFAULT_CONVERSATION_ID,
}: {
  socketPath: string;
  telegramToken?: string;
  telegramChatId?: string;
  telegramConversationId?: number;
  wechatToken?: string;
  wechatBaseUrl?: string;
  wechatChatId?: string;
  wechatConversationId?: number;
  wechatContextToken?: string;
  wechatUpdatesBuf?: string;
  dingdingClientId?: string;
  dingdingClientSecret?: string;
  dingdingCorpId?: string;
  dingdingRobotCode?: string;
  dingdingCardTemplateId?: string;
  dingdingCardCallbackRouteKey?: string;
  dingdingCardUserIdType?: number;
  dingdingChatId?: string;
  dingdingConversationId?: number;
}) {
  const initialReceiverStateRef = useRef(
    createInitialReceiverState({
      telegramToken,
      telegramChatId,
      telegramConversationId,
      wechatToken,
      wechatBaseUrl,
      wechatChatId,
      wechatConversationId,
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
      dingdingConversationId,
    }),
  );
  const initialReceiverState = initialReceiverStateRef.current;
  const initialConversationState = initialReceiverState.conversationState;
  const { exit } = useApp();
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [editorCursor, setEditorCursor] = useState<[number, number]>([0, 0]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingViewItem[]>([]);
  const [queuedReplies, setQueuedReplies] = useState<QueuedReplyViewItem[]>([]);
  const [focusedId, setFocusedId] = useState<number | undefined>();
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dismissedCompletionInput, setDismissedCompletionInput] = useState<string | undefined>();
  const [conversations, setConversations] = useState<ReceiverConversation[]>(initialConversationState.conversations);
  const [activeConversationId, setActiveConversationId] = useState(initialConversationState.defaultConversationId);
  const [defaultConversationId, setDefaultConversationId] = useState(initialConversationState.defaultConversationId);
  const [defaultTimeoutMs, setDefaultTimeoutMs] = useState(initialReceiverState.timeoutMs);
  const [timeoutTarget, setTimeoutTarget] = useState<string | undefined>();
  const [telegramStatus, setTelegramStatus] = useState<ChatStatus>(initialReceiverState.telegramStatus);
  const [wechatStatus, setWechatStatus] = useState<ChatStatus>(initialReceiverState.wechatStatus);
  const [dingdingStatus, setDingdingStatus] = useState<ChatStatus>(initialReceiverState.dingdingStatus);
  const [latestResult, setLatestResult] = useState<PendingViewItem | undefined>();

  const serverRef = useRef<net.Server | undefined>(undefined);
  const socketsRef = useRef(new Set<net.Socket>());
  const chatBridgesRef = useRef(createChatBridgeRegistry());
  const pendingRef = useRef<PendingItem[]>([]);
  const queuedRepliesRef = useRef<Array<QueuedReply & { label?: string }>>([]);
  const activeQueuedPromptsRef = useRef<ActiveQueuedPrompt[]>([]);
  const activeProcessingRef = useRef(new Map<number, ReceiverProcessing>());
  const chatConversationCwdPromptsRef = useRef(new Map<string, CwdPicker>());
  const chatProgressRef = useRef(new Map());
  const chatToolStateRef = useRef(initialReceiverState.chatToolState);
  const conversationActivityRef = useRef(initialReceiverState.conversationActivity);
  const nextIdRef = useRef(1);
  const nextQueuedReplyIdRef = useRef(1);
  const conversationsRef = useRef(initialConversationState.conversations);
  const nextConversationIdRef = useRef(initialConversationState.nextConversationId);
  const timeoutTargetRef = useRef<string | undefined>(undefined);
  const defaultTimeoutMsRef = useRef(DEFAULT_TIMEOUT_MS);
  const activeConversationIdRef = useRef(initialConversationState.defaultConversationId);
  const defaultConversationIdRef = useRef(initialConversationState.defaultConversationId);
  const telegramConversationIdRef = useRef(telegramConversationId);
  const wechatConversationIdRef = useRef(wechatConversationId);
  const dingdingConversationIdRef = useRef(dingdingConversationId);
  const focusedIdRef = useRef<number | undefined>(undefined);
  const commandCaptureRef = useRef<string[] | undefined>(undefined);
  const resultHistoryRef = useRef(createResultHistoryStore());
  const aiSessionsRef = useRef(createAiSessionRegistry());

  const addLog = useCallback((message: string, level: ReceiverLogLevel = "info") => {
    const cleanMessage = stripAnsi(message);
    try {
      appendJsonl(RECEIVER_LOG_PATH, { event: "receiver_log", level, message: cleanMessage });
    } catch {
      // Receiver UI logging should keep working even if diagnostics cannot be written.
    }
    commandCaptureRef.current?.push(cleanMessage);
    setLogs((current) => trimLogs([...current, { id: Date.now() + Math.random(), message: cleanMessage, level }]));
  }, []);

  const addDiagnosticLog = useCallback((message: string, level: ReceiverLogLevel = "info") => {
    const cleanMessage = stripAnsi(message);
    try {
      appendJsonl(RECEIVER_LOG_PATH, { event: "receiver_diagnostic", level, message: cleanMessage });
    } catch {
      // Diagnostics are best-effort.
    }
  }, []);

  const {
    bindingConversationIdForApproval,
    createCwdPicker,
    createNextConversation,
    deleteConversation,
    ensureConversation,
    findConversation,
    handleCwdPickerAction,
    persistConversations,
    pruneInactiveConversations,
    setConversationCwd,
    syncConversations,
    visibleConversationIdsForApproval,
  } = useReceiverConversationController({
    activeConversationIdRef,
    addLog,
    chatConversationCwdPromptsRef,
    chatToolStateRef,
    conversationActivityRef,
    conversationsRef,
    defaultConversationIdRef,
    nextConversationIdRef,
    pendingRef,
    queuedRepliesRef,
    setActiveConversationId,
    setConversations,
  });

  const getConversationTimeoutMs = useCallback((conversationId: number) => {
    const timeoutMs = Number(conversationsRef.current.find((conversation) => conversation.id === conversationId)?.timeoutMs);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }, []);

  const setConversationTimeoutMs = useCallback(
    (conversationId: number, timeoutMs?: number) => {
      ensureConversation(conversationId);
      const now = new Date().toISOString();
      syncConversations(
        conversationsRef.current.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined, updatedAt: now }
            : conversation,
        ),
      );
    },
    [ensureConversation, syncConversations],
  );

  const syncTelegram = useCallback(() => {
    const telegram = chatBridgesRef.current.get("telegram") as { enabled?: boolean; polling?: boolean; token?: string; chatId?: string } | undefined;
    setTelegramStatus({
      enabled: Boolean(telegram?.enabled),
      polling: Boolean(telegram?.polling),
      tokenSet: Boolean(telegram?.token),
      chatId: telegram?.chatId,
      conversationId: telegramConversationIdRef.current,
    });
  }, []);

  const syncWechat = useCallback(() => {
    const wechat = chatBridgesRef.current.get("wechat") as { enabled?: boolean; polling?: boolean; token?: string; chatId?: string; contextToken?: string } | undefined;
    setWechatStatus({
      enabled: Boolean(wechat?.enabled),
      polling: Boolean(wechat?.polling),
      tokenSet: Boolean(wechat?.token),
      chatId: wechat?.chatId,
      conversationId: wechatConversationIdRef.current,
      contextSet: Boolean(wechat?.contextToken),
    });
  }, []);

  const syncDingding = useCallback(() => {
    const dingding = chatBridgesRef.current.get("dingding") as { enabled?: boolean; polling?: boolean; clientId?: string; clientSecret?: string; chatId?: string } | undefined;
    setDingdingStatus({
      enabled: Boolean(dingding?.enabled),
      polling: Boolean(dingding?.polling),
      tokenSet: Boolean(dingding?.clientId && dingding?.clientSecret),
      chatId: dingding?.chatId,
      conversationId: dingdingConversationIdRef.current,
    });
  }, []);

  const chatRoutes = useCallback((): ActiveChatRoute[] => {
    return listChatBindings(chatToolStateRef.current)
      .map((binding) => {
        const registryKey = `${binding.channel}:${binding.instanceId}`;
        const entry = chatBridgesRef.current.getEntry(registryKey);
        if (!entry?.bridge) {
          return undefined;
        }
        return {
          channel: binding.channel,
          instanceId: binding.instanceId,
          routeKey: `${registryKey}:${binding.chatId}`,
          bridge: entry.bridge,
          capabilities: entry.capabilities,
          conversationId: binding.conversationId,
          requiresTarget: binding.channel === "telegram" || binding.channel === "dingding",
          hasTarget: () => Boolean(binding.chatId || binding.sessionWebhook),
          target: { chatId: binding.chatId, contextToken: binding.contextToken, sessionWebhook: binding.sessionWebhook, senderId: binding.senderId },
        } as ActiveChatRoute;
      })
      .filter((route): route is ActiveChatRoute => Boolean(route));
  }, []);

  const chatProgress = useMemo(
    () =>
      createChatProgressController({
        routes: chatRoutes,
        progressMap: chatProgressRef.current,
        onLog: addLog,
        watch: ({ item, onUpdate }) =>
          startTranscriptProgress({
            heading: `TaskHandoff c${item.conversationId} 执行中`,
            transcriptPath: item.transcriptPath,
            codexId: item.codexId,
            claudeId: item.claudeId,
            cwd: item.cwd,
            onUpdate,
          }),
      }),
    [addLog, chatRoutes],
  );

  const {
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
  } = useReceiverReplyController({
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
  });

  const { cancelActiveConversation, replyDefault, runActiveConversation } = useMemo(
    () =>
      createActiveConversationController({
        aiSessions: aiSessionsRef.current,
        addLog,
        activeConversationIdRef,
        activeProcessingRef,
        activeQueuedPromptsRef,
        chatBridgesRef,
        chatProgress,
        chatRoutes,
        completeProcessing,
        currentReplyTarget,
        findConversation,
        nextQueuedReplyIdRef,
        queuedRepliesRef,
        replyToItem,
        setLatestResult,
        resultHistoryRef,
        startChatProgress,
        startProcessing,
        syncConversations,
        syncQueuedReplies,
        conversationsRef,
      }),
    [
      addLog,
      chatProgress,
      chatRoutes,
      completeProcessing,
      currentReplyTarget,
      findConversation,
      replyToItem,
      resultHistoryRef,
      startChatProgress,
      startProcessing,
      syncConversations,
      syncQueuedReplies,
    ],
  );

  const stopAll = useCallback((afterStop?: () => void) => {
    chatProgress.stopAll();
    chatBridgesRef.current.stopAll();
    socketsRef.current.forEach((socket) => socket.destroy());
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      resetRawMode();
      unlinkSocket(socketPath);
      serverRef.current = undefined;
      afterStop?.();
      exit();
    };
    if (serverRef.current) {
      serverRef.current.close(finish);
      setTimeout(finish, 500).unref?.();
    } else {
      finish();
    }
  }, [exit, socketPath]);

  const restartSelf = useCallback(() => {
    addLog("restarting receiver...", "warn");
    stopAll(() => {
      const child = spawn("/bin/sh", ["-c", restartShellCommand()], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      });
      child.on("exit", (code) => {
        process.exitCode = code ?? 0;
      });
    });
  }, [addLog, stopAll]);

  const resetConversationSession = useCallback(
    (conversationId: number) => {
      if (activeProcessingRef.current.has(conversationId)) {
        return {
          ok: false,
          message: `conversation ${conversationId} is running. Use /cancel ${conversationId} first.`,
        };
      }
      const conversation = findConversation(conversationId);
      if (!conversation) {
        return { ok: false, message: `conversation ${conversationId} not found` };
      }
      if (!isActiveConversationMode(conversation.mode)) {
        return { ok: false, message: `conversation ${conversationId} is ${conversation.mode || "passive"}; only codex or claude sessions can be reset` };
      }
      const now = new Date().toISOString();
      syncConversations(
        conversationsRef.current.map((entry) =>
          entry.id === conversationId ? conversationWithNewAgentSession(entry, now) : entry,
        ),
      );
      return { ok: true, message: `conversation ${conversationId} ${conversation.mode} session reset; next prompt starts a new session` };
    },
    [activeProcessingRef, conversationsRef, findConversation, syncConversations],
  );

  const selectHistoricalSession = useCallback(
    (conversationId: number, session: HistoricalSession & { aiSessionId?: string; providerSessionId?: string }) => {
      if (activeProcessingRef.current.has(conversationId)) {
        return {
          ok: false,
          message: `conversation ${conversationId} is running. Use /cancel ${conversationId} first.`,
        };
      }
      const conversation = findConversation(conversationId);
      if (!conversation) {
        return { ok: false, message: `conversation ${conversationId} not found` };
      }
      const now = new Date().toISOString();
      syncConversations(
        conversationsRef.current.map((entry) =>
          entry.id === conversationId
            ? session.aiSessionId
              ? conversationWithAiSession(entry, {
                  id: session.aiSessionId,
                  agent: session.agent,
                  providerSessionId: session.providerSessionId || session.sessionId,
                  cwd: session.cwd,
                }, now)
              : conversationWithHistoricalSession(entry, session.agent, session.sessionId, session.cwd, now)
            : entry,
        ),
      );
      return {
        ok: true,
        message: `conversation ${conversationId} now uses ${session.agent} session ${session.sessionId}`,
      };
    },
    [activeProcessingRef, conversationsRef, findConversation, syncConversations],
  );

  const formatSessionHistory = useCallback(
    (conversationId: number, agent?: string) => {
      const conversation = findConversation(conversationId);
      const cwd = String(conversation?.cwd || process.cwd());
      const parsedAgent = agent === "codex" || agent === "claude" ? agent : undefined;
      const sessions = listHistoricalSessions({ cwd, agent: parsedAgent, limit: 20 });
      const label = parsedAgent ? parsedAgent : "codex/claude";
      if (sessions.length === 0) {
        return `No ${label} sessions found for ${cwd}`;
      }
      return [
        `${label} sessions for ${cwd}:`,
        ...sessions.map((session, index) => {
          const title = session.title ? ` ${session.title}` : "";
          return `${index + 1}. ${session.agent} ${session.sessionId} ${session.updatedAt}${title}`;
        }),
      ].join("\n");
    },
    [findConversation],
  );

  const { handleConversationCommand, handleChatCommand, handleTelegramCommand, handleWechatCommand, handleDingdingCommand } = useMemo(
    () =>
      createReceiverCommandHandlers({
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
      }),
    [
      addLog,
      createNextConversation,
      deleteConversation,
      ensureConversation,
      findConversation,
      persistConversations,
      setConversationCwd,
      syncConversations,
      syncTelegram,
      syncWechat,
      syncDingding,
    ],
  );

  const handleCommand = useMemo(
    () =>
      createReceiverTerminalCommandRouter({
        activeConversationIdRef,
        addLog,
        chatBridgesRef,
        defaultConversationIdRef,
        defaultTimeoutMsRef,
        findPendingById,
        focusedIdRef,
        handleConversationCommand,
        handleChatCommand,
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
      }),
    [
      addLog,
      findPendingById,
      handleConversationCommand,
      handleChatCommand,
      handleTelegramCommand,
      handleWechatCommand,
      handleDingdingCommand,
      cancelActiveConversation,
      resetConversationSession,
      formatSessionHistory,
      getConversationTimeoutMs,
      replyApproval,
      replyDefault,
      replyToItem,
      restartSelf,
      stopAll,
      setConversationTimeoutMs,
    ],
  );

  const { bindConversationToChat, handleChatConversationAction, handleChatConversationCommand, handleChatSessionAction, handleChatText, runChatCommand } = useMemo(
    () =>
      createReceiverChatRouter({
        addLog,
        chatBridgesRef,
        chatToolStateRef,
        commandCaptureRef,
        createNextConversation,
        createCwdPicker,
        deleteConversation,
        ensureConversation,
        findConversation,
        listConversations: () => conversationsRef.current,
        listAiSessionsForCwd: createAiSessionPickerSource(() => aiSessionsRef.current.snapshot(200)),
        handleCommand,
        replyDefault,
        resultHistoryRef,
        selectHistoricalSession,
        setConversationCwd,
      }),
    [addLog, createCwdPicker, createNextConversation, deleteConversation, ensureConversation, findConversation, handleCommand, replyDefault, selectHistoricalSession, setConversationCwd],
  );

  const handleHistoryAction = useCallback((action: { conversationId?: number; index?: number }) => {
    const conversationId = Number(action.conversationId) || activeConversationIdRef.current;
    const payload = resultHistoryPayload(resultHistoryRef.current, conversationId, action.index);
    return {
      ...payload,
      message: payload.found ? "updated" : "history not found",
    };
  }, []);

  const setEditorText = useCallback((value: string, cursorPosition: [number, number] = cursorPositionAtEnd(value)) => {
    setInput(value);
    setEditorCursor(cursorPosition);
  }, []);

  const { submitInput } = useReceiverInputController({
    activeConversationIdRef,
    addLog,
    dismissedCompletionInput,
    handleCommand,
    input,
    queuedRepliesRef,
    replyDefault,
    selectedSuggestion,
    setDismissedCompletionInput,
    setEditorText,
    setSelectedSuggestion,
    stopAll,
    syncQueuedReplies,
  });

  useReceiverServer({
    addLog,
    addDiagnosticLog,
    aiSessions: aiSessionsRef.current,
    bindingConversationIdForApproval,
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
    cancelActiveConversation,
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
  });

  const {
    completeSelectedCommand,
    conversationItems,
    inputPlaceholder,
    showCommandPanel,
    statusItems,
    suggestionWindow,
    suggestions,
    textAreaKeybindings,
  } = useReceiverViewModel({
    activeConversationId,
    conversations,
    defaultConversationId,
    defaultTimeoutMs: getConversationTimeoutMs(activeConversationId),
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
  });

  return React.createElement(ReceiverView, {
    activeConversationId,
    completeSelectedCommand,
    conversationItems,
    editorCursor,
    focusedId,
    input,
    inputPlaceholder,
    latestResult,
    logs,
    pending,
    queuedReplies,
    ready,
    selectedSuggestion,
    setEditorCursor,
    setInput,
    showCommandPanel,
    statusItems,
    submitInput,
    suggestionWindow,
    suggestions,
    textAreaKeybindings,
  });
}

export async function runReceiverInk(options: RunReceiverInkOptions) {
  const { headless, ...receiverOptions } = options;
  const shouldRunHeadless = Boolean(headless || process.env.TASK_HANDOFF_RECEIVER_HEADLESS === "1" || !process.stdin.isTTY);
  guardRawModeEio();
  const renderOptions = shouldRunHeadless
    ? headlessRenderOptions()
    : undefined;
  const app = render(React.createElement(ReceiverApp, receiverOptions), renderOptions);
  await app.waitUntilExit();
}

function headlessRenderOptions(): RenderOptions {
  return {
    stdin: headlessInputStream(),
    stdout: headlessOutputStream(),
    stderr: process.stderr,
    debug: false,
    patchConsole: false,
  };
}

function headlessInputStream(): NodeJS.ReadStream {
  return createHeadlessInput() as unknown as NodeJS.ReadStream;
}

function headlessOutputStream(): NodeJS.WriteStream {
  return createNullOutput() as unknown as NodeJS.WriteStream;
}
