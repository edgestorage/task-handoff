import {
  createChatBridgeRegistry,
  createChatResultPayload,
  chatRoutesForConversation,
  deliverChatPayload,
  routeWithTargetContext,
} from "@task-handoff/core/core/chat";
import type { ChatRoute, ProgressItem } from "@task-handoff/core/core/chat";
import { normalizeCliMarkdown } from "@task-handoff/core/core/text";
import { runActiveAgent, isActiveConversationMode } from "../domain/active-agents";
import type { AiSessionRegistry } from "@task-handoff/ai-session-runtime";
import { conversationAgent, conversationAgentSessionId, conversationWithAgentSession } from "../domain/conversation-actions";
import { addResultHistory } from "../state/result-history";
import type { ResultHistoryStore } from "../state/result-history";
import type {
  PendingItem,
  PendingViewItem,
  QueuedReply,
  QueuedReplySource,
  ReceiverConversation,
  ReceiverLogFn,
  ReceiverProcessing,
  ReceiverRef,
} from "../types";

type ActiveQueuedPrompt = {
  id: number;
  conversationId: number;
  value: string;
  label: string;
  options?: ReplyDefaultOptions;
};

type ReplyDefaultOptions = {
  includeApproval?: boolean;
  routeTarget?: Record<string, unknown>;
  source?: QueuedReplySource;
};

type ActiveConversationControllerOptions = {
  aiSessions: AiSessionRegistry;
  addLog: ReceiverLogFn;
  activeConversationIdRef: ReceiverRef<number>;
  activeProcessingRef: ReceiverRef<Map<number, ReceiverProcessing>>;
  activeQueuedPromptsRef: ReceiverRef<ActiveQueuedPrompt[]>;
  chatBridgesRef: ReceiverRef<ReturnType<typeof createChatBridgeRegistry>>;
  chatProgress: { finishRoute: (route: unknown, conversationId: number, payload: unknown) => Promise<boolean> };
  chatRoutes: () => ChatRoute[];
  completeProcessing: (conversationId: number) => void;
  currentReplyTarget: (conversationId?: number, options?: unknown) => PendingItem | undefined;
  findConversation: (conversationId: number) => ReceiverConversation | undefined;
  nextQueuedReplyIdRef: ReceiverRef<number>;
  queuedRepliesRef: ReceiverRef<Array<QueuedReply & { label?: string }>>;
  replyToItem: (item: PendingItem, value: string, label?: string, processing?: ReceiverProcessing) => unknown;
  setLatestResult: (item: PendingViewItem & { result: string; timeoutMs: number; source: string; kind: string }) => void;
  resultHistoryRef: ReceiverRef<ResultHistoryStore>;
  startChatProgress: (item: ProgressItem) => unknown;
  startProcessing: (conversationId: number, processing?: ReceiverProcessing) => void;
  syncConversations: (conversations: ReceiverConversation[]) => void;
  syncQueuedReplies: () => void;
  conversationsRef: ReceiverRef<ReceiverConversation[]>;
};

function createActiveConversationController({
  aiSessions,
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
}: ActiveConversationControllerOptions) {
  const cancelActiveConversation = (conversationId: number) => {
    const processing = activeProcessingRef.current.get(conversationId);
    if (!processing?.cancel) {
      addLog(`active c${conversationId} has no running cancellable task`, "warn");
      return false;
    }
    const cancelled = processing.cancel();
    addLog(cancelled ? `active c${conversationId} cancellation requested` : `active c${conversationId} already finished`, cancelled ? "warn" : "warn");
    return cancelled;
  };

  const runActiveConversation = (conversationId: number, value: string, label = "sent", options: ReplyDefaultOptions = {}) => {
    const conversation = findConversation(conversationId);
    if (!conversation || !isActiveConversationMode(conversation.mode)) {
      return false;
    }

    const prompt = normalizeCliMarkdown(value);
    const cwd = conversation.cwd || process.cwd();
    const agent = conversationAgent(conversation) || conversation.mode;
    const agentSessionId = conversationAgentSessionId(conversation);
    const aiSession = aiSessions.start({
      agent,
      providerSessionId: agentSessionId,
      conversationId,
      title: `c${conversationId}`,
      cwd,
      userPrompt: prompt,
      summary: `Starting ${agent}`,
    });
    if (agentSessionId) {
      aiSessions.attachTranscript(aiSession.id);
    }
    let transcriptProgressStarted = false;
    const startActiveTranscriptProgress = (sessionId: string) => {
      if (transcriptProgressStarted || !sessionId) {
        return;
      }
      aiSessions.bindProviderSession(aiSession.id, sessionId);
      transcriptProgressStarted = true;
      const now = new Date().toISOString();
      syncConversations(
        conversationsRef.current.map((entry) =>
          entry.id === conversationId ? { ...conversationWithAgentSession(entry, sessionId, aiSession.id), cwd, updatedAt: now } : entry,
        ),
      );
      startChatProgress({
        kind: "task",
        conversationId,
        codexId: agent === "codex" ? sessionId : undefined,
        claudeId: agent === "claude" ? sessionId : undefined,
        cwd,
        routeTarget: options.routeTarget,
        progressActions: [
          {
            text: "取消",
            callbackData: `task_handoff:active_cancel:${conversationId}`,
          },
        ],
      });
    };
    const finishActiveResult = async (body: string) => {
      const payload = createChatResultPayload({ conversationId, body });
      const routes = chatRoutesForConversation(chatBridgesRef.current, chatRoutes(), conversationId);
      for (const route of routes) {
        const activeRoute = routeWithTargetContext(route, options.routeTarget);
        if (activeRoute.capabilities.progress) {
          const finished = await chatProgress.finishRoute(activeRoute, conversationId, payload);
          if (finished) {
            continue;
          }
        }
        await deliverChatPayload(activeRoute, payload);
      }
    };
    let cancelled = false;
    const processing = {
      start: () => addLog(`active ${conversation.mode} c${conversationId}: ${prompt.slice(0, 120)}`, "success"),
      done: () => addLog(`active ${conversation.mode} c${conversationId} ${cancelled ? "cancelled" : "finished"}`, cancelled ? "warn" : "success"),
      cancel: undefined as (() => boolean) | undefined,
    };
    startProcessing(conversationId, processing);
    startActiveTranscriptProgress(agentSessionId);

    void runActiveAgent({
      mode: conversation.mode,
      prompt,
      sessionId: agentSessionId,
      cwd,
      onSessionId: startActiveTranscriptProgress,
      onProgress: (text) => {
        aiSessions.applyRealtimeEvent(aiSession.id, { kind: "assistant-message", text, source: "realtime" });
      },
      onCancelReady: (cancel) => {
        processing.cancel = () => {
          const didCancel = cancel();
          cancelled = didCancel;
          if (didCancel) {
            aiSessions.applyRealtimeEvent(aiSession.id, {
              kind: "turn-completed",
              status: "failed",
              phase: "unknown",
              text: `${agent} cancellation requested`,
              source: "control",
            });
          }
          return didCancel;
        };
      },
    })
      .then(async ({ output, sessionId, code, signal }) => {
        aiSessions.applyRealtimeEvent(aiSession.id, {
          kind: "turn-completed",
          status: "idle",
          phase: "responding",
          text: output,
          source: "control",
        });
        if (sessionId && sessionId !== agentSessionId) {
          const now = new Date().toISOString();
          syncConversations(
            conversationsRef.current.map((entry) =>
              entry.id === conversationId ? { ...conversationWithAgentSession(entry, sessionId, aiSession.id), cwd, updatedAt: now } : entry,
            ),
          );
          addLog(`active ${conversation.mode} c${conversationId} session=${sessionId}`, "success");
        }
        const body =
          output.trim() ||
          `${conversation.mode} exited without output${code === null ? "" : ` (code ${code})`}${
            signal ? ` (${signal})` : ""
          }`;
        setLatestResult({
          id: 0,
          conversationId,
          result: body,
          timeoutMs: 0,
          source: conversation.mode,
          kind: "task",
        });
        addResultHistory(resultHistoryRef, {
          conversationId,
          source: conversation.mode,
          kind: "active",
          result: body,
        });
        addLog(`${conversation.mode} c${conversationId} result: ${body.replace(/\s+/g, " ").slice(0, 120)}`, "success");
        await finishActiveResult(body);
      })
      .catch((error) => {
        const body = cancelled ? `${conversation.mode} c${conversationId} cancelled` : `${conversation.mode} failed: ${error.message}`;
        aiSessions.applyRealtimeEvent(aiSession.id, {
          kind: "turn-completed",
          status: "failed",
          phase: "unknown",
          text: `Failed: ${error.message}`,
          source: "control",
        });
        addResultHistory(resultHistoryRef, {
          conversationId,
          source: conversation.mode,
          kind: "active",
          result: body,
        });
        addLog(body, "error");
        void finishActiveResult(body);
      })
      .finally(() => {
        completeProcessing(conversationId);
        const nextQueuedIndex = activeQueuedPromptsRef.current.findIndex((reply) => reply.conversationId === conversationId);
        const nextQueued =
          nextQueuedIndex === -1 ? undefined : activeQueuedPromptsRef.current.splice(nextQueuedIndex, 1)[0];
        if (nextQueued) {
          runActiveConversation(conversationId, nextQueued.value, nextQueued.label, nextQueued.options);
        }
      });

    addLog(`${label}: ${prompt}`, "success");
    return true;
  };

  const replyDefault = (
    value: string,
    label: string,
    conversationId = activeConversationIdRef.current,
    processing?: ReceiverProcessing,
    options: ReplyDefaultOptions = {},
  ) => {
    const replyValue = normalizeCliMarkdown(value);
    const target = currentReplyTarget(conversationId, options);
    if (target && replyToItem(target, replyValue, label, processing)) {
      return "sent";
    }

    const conversation = findConversation(conversationId);
    if (conversation && isActiveConversationMode(conversation.mode)) {
      if (!activeProcessingRef.current.has(conversationId) && runActiveConversation(conversationId, replyValue, label, options)) {
        return "sent";
      }
      activeQueuedPromptsRef.current.push({
        id: nextQueuedReplyIdRef.current,
        conversationId,
        value: replyValue,
        label,
        options,
      });
      nextQueuedReplyIdRef.current += 1;
      addLog(`queued active ${conversation.mode} c${conversationId}: ${replyValue}`, "success");
      return "queued";
    }

    queuedRepliesRef.current.push({
      id: nextQueuedReplyIdRef.current,
      conversationId,
      value: replyValue,
      label,
      processing,
      routeTarget: options.routeTarget,
      source: options.source,
    });
    nextQueuedReplyIdRef.current += 1;
    syncQueuedReplies();
    addLog(`queued for conversation ${conversationId}: ${replyValue}`, "success");
    return "queued";
  };

  return { cancelActiveConversation, replyDefault, runActiveConversation };
}

export { createActiveConversationController };
