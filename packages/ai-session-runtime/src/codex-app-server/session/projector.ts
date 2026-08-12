import type { AiSessionLineage, AiSessionStatus, AiSessionSubAgent } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionRegistry } from "../../ai-session-registry";
import { CodexSubAgentTracker, CodexToolActivityTracker } from "../protocol/activity";
import { lifecycleForStatus } from "../protocol/status";
import { summarizeThreadTurns } from "../protocol/thread-summary";
import type { CodexAppServerEvent, CodexSubAgentUpdate, CodexThread, CodexToolActivityState } from "../protocol/types";

type ProjectorOptions = {
  registry: AiSessionRegistry;
  findSession: (threadId: string) => AiSessionStatus | undefined;
  clearApprovalSession: (sessionId: string) => void;
  attachApprovalLifecycle: (sessionId: string | undefined, lifecycle: ReturnType<typeof lifecycleForStatus>) => ReturnType<typeof lifecycleForStatus>;
  latestApprovalSummary: (sessionId: string) => string | undefined;
  threadForkSupported: () => boolean;
  onMessageDelta?: (event: {
    sessionId: string;
    providerSessionId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }) => void;
};

export class CodexAppServerSessionProjector {
  private readonly toolActivityByThread = new Map<string, CodexToolActivityTracker>();
  private readonly subAgentsByThread = new Map<string, CodexSubAgentTracker>();
  private readonly parentThreadsBySubAgent = new Map<string, Set<string>>();
  private readonly lifecycleByThread = new Map<string, CodexSubAgentUpdate>();
  private readonly turnErrorsByThread = new Map<string, { turnId: string; error: string }>();

  constructor(private readonly options: ProjectorOptions) {}

  clearThread(threadId: string) {
    this.toolActivityByThread.delete(threadId);
    this.subAgentsByThread.delete(threadId);
    this.turnErrorsByThread.delete(threadId);
    for (const [subAgentThreadId, parentThreadIds] of this.parentThreadsBySubAgent) {
      parentThreadIds.delete(threadId);
      if (!parentThreadIds.size) this.parentThreadsBySubAgent.delete(subAgentThreadId);
    }
  }

  resetConnection() {
    this.toolActivityByThread.clear();
    this.subAgentsByThread.clear();
    this.parentThreadsBySubAgent.clear();
    this.lifecycleByThread.clear();
    this.turnErrorsByThread.clear();
  }

  apply(event: CodexAppServerEvent) {
    if (event.type === "thread" || event.type === "approval-request") {
      return false;
    }
    this.observeThreadLifecycleEvent(event);
    const session = this.options.findSession(event.threadId);
    if (!session) {
      return false;
    }
    if (event.type === "thread-closed") {
      this.options.clearApprovalSession(session.id);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).clearActiveTools());
      this.options.registry.applyRealtimeEvent(session.id, { kind: "turn-completed", activeTurnId: session.activeTurnId, status: "idle", phase: "unknown", text: "Codex thread closed.", source: "realtime" });
      this.clearThread(event.threadId);
      return true;
    }
    if (event.type === "thread-status") {
      const providerLifecycle = lifecycleForStatus(event.status);
      if (providerLifecycle.phase !== "approval") {
        this.options.clearApprovalSession(session.id);
      }
      const lifecycle = this.options.attachApprovalLifecycle(session.id, providerLifecycle);
      this.options.registry.applyRealtimeEvent(session.id, {
        kind: "lifecycle",
        activeTurnId: session.activeTurnId,
        status: lifecycle.status,
        phase: lifecycle.phase,
        source: "realtime",
      });
      return true;
    }
    if (event.type === "turn-started") {
      this.turnErrorsByThread.delete(event.threadId);
      this.options.registry.applyRealtimeEvent(session.id, { kind: "turn-started", activeTurnId: event.turnId, providerTurnId: event.turnId, source: "realtime" });
      return true;
    }
    if (event.type === "turn-error") {
      this.turnErrorsByThread.set(event.threadId, { turnId: event.turnId, error: event.error });
      return true;
    }
    if (event.type === "thread-error") {
      this.options.registry.applyRealtimeEvent(session.id, {
        kind: "session-error",
        error: event.error,
        source: "realtime",
      });
      return true;
    }
    if (event.type === "context-compaction") {
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).compacting(event.turnId, event.status, event.observedAt));
      this.options.registry.applyRealtimeEvent(session.id, {
        kind: "context-compaction",
        activeTurnId: event.turnId,
        providerTurnId: event.turnId,
        contextCompaction: {
          id: event.itemId,
          status: event.status,
          ...(event.status === "running" && event.observedAt ? { startedAt: event.observedAt } : {}),
          ...(event.status === "completed" && event.observedAt ? { completedAt: event.observedAt } : {}),
        },
        observedAt: event.observedAt,
        source: "realtime",
      });
      return true;
    }
    if (event.type === "tool-item-started") {
      if (event.subAgents?.length) this.applySubAgentUpdates(session.id, event.threadId, event.subAgents);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).started(event.tool));
      return true;
    }
    if (event.type === "tool-item-completed") {
      if (event.subAgents?.length) this.applySubAgentUpdates(session.id, event.threadId, event.subAgents);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).completed(event.tool));
      return true;
    }
    if (event.type === "sub-agent-activity") {
      this.applySubAgentUpdates(session.id, event.threadId, [event.subAgent]);
      return true;
    }
    if (event.type === "user-message") {
      this.options.registry.applyRealtimeEvent(session.id, { kind: "user-message", activeTurnId: event.turnId || session.activeTurnId, providerTurnId: event.turnId || session.activeTurnId, userPrompt: event.text, source: "realtime" });
      return true;
    }
    if (event.type === "turn-completed") {
      const pendingError = this.turnErrorsByThread.get(event.threadId);
      const error = event.error || (pendingError && (!event.turnId || pendingError.turnId === event.turnId) ? pendingError.error : undefined);
      this.turnErrorsByThread.delete(event.threadId);
      this.options.clearApprovalSession(session.id);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).clearActiveTools());
      this.options.registry.applyRealtimeEvent(session.id, {
        kind: "turn-completed",
        activeTurnId: event.turnId,
        providerTurnId: event.turnId,
        status: event.status === "failed" ? "failed" : "idle",
        error: event.status === "failed" ? error : undefined,
        source: "realtime",
      });
      return true;
    }
    if (event.type === "agent-message-delta") {
      this.options.onMessageDelta?.({
        sessionId: session.id,
        providerSessionId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        delta: event.delta,
      });
      return true;
    }
    if (event.type === "agent-message-completed") {
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).resetForAgentMessage());
      this.options.registry.applyRealtimeEvent(session.id, { kind: "assistant-message", activeTurnId: event.turnId || session.activeTurnId, providerTurnId: event.turnId || session.activeTurnId, itemId: event.itemId, text: event.text, status: session.status, source: "realtime" });
      return true;
    }
    return false;
  }

  applyThreadSnapshot(thread: CodexThread, context: { appSessionId?: string; creationSource?: AiSessionStatus["creationSource"]; lineage?: AiSessionLineage } = {}) {
    const threadId = typeof thread.id === "string" ? thread.id : undefined;
    if (!threadId || thread.ephemeral === true) {
      return;
    }
    this.observeThreadSnapshot(threadId, thread);
    const existing = this.options.findSession(threadId);
    const lifecycle = this.options.attachApprovalLifecycle(existing?.id, lifecycleForStatus(thread.status || {}));
    const history = summarizeThreadTurns(thread);
    const sessionStatus = lifecycle.status === "running" || lifecycle.status === "waiting"
      ? lifecycle.status
      : history.latestTurnStatus === "failed" ? "failed" : lifecycle.status;
    const activity = Array.isArray(thread.turns)
      ? this.replaceThreadActivity(threadId, history.toolActivity, history.subAgents)
      : this.snapshotThreadActivity(threadId);
    return this.options.registry.applyAdapterSnapshot({
      source: "adapter-snapshot",
      agent: "codex",
      creationSource: context.creationSource || (context.appSessionId ? "app-session" : existing?.creationSource),
      appId: context.appSessionId ? "codex" : "codex-app-server",
      appSessionId: context.appSessionId,
      providerSessionId: threadId,
      appBindingKeys: context.appSessionId ? [`app:${context.appSessionId}`] : undefined,
      actions: {
        send: true,
        interrupt: sessionStatus === "running" || sessionStatus === "waiting",
        approval: sessionStatus === "waiting" && lifecycle.phase === "approval",
        fork: this.options.threadForkSupported(),
      },
      lineage: context.lineage || existing?.lineage || (typeof thread.forkedFromId === "string" && thread.forkedFromId
        ? { kind: "fork", parentProviderSessionId: thread.forkedFromId }
        : undefined),
      title: typeof thread.name === "string" ? thread.name : undefined,
      cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
      activeTurnId: history.activeTurnId,
      userPrompt: history.userPrompt,
      turns: history.turns,
      summary: existing ? this.options.latestApprovalSummary(existing.id) || history.summary : history.summary,
      lastMessage: history.lastMessage,
      lastMessageItemId: history.lastMessageItemId,
      error: history.error,
      currentTool: activity.toolActivity.currentTool,
      toolCallsSinceLastMessage: activity.toolActivity.toolCallsSinceLastMessage,
      subAgents: activity.subAgents,
      status: sessionStatus,
      phase: lifecycle.phase,
      replaceActivity: true,
    });
  }

  replaceThreadActivity(threadId: string, toolActivity: CodexToolActivityState, subAgents: Parameters<CodexSubAgentTracker["replace"]>[0]) {
    this.recordSubAgentRelationships(threadId, subAgents);
    const tracker = this.subAgentTracker(threadId);
    const replacedSubAgents = tracker.replace(subAgents);
    return {
      toolActivity: this.toolTracker(threadId).replace(toolActivity),
      subAgents: this.replayObservedLifecycles(tracker, replacedSubAgents),
    };
  }

  snapshotThreadActivity(threadId: string) {
    return {
      toolActivity: this.toolTracker(threadId).snapshot(),
      subAgents: this.subAgentTracker(threadId).snapshot(),
    };
  }

  private toolTracker(threadId: string) {
    let tracker = this.toolActivityByThread.get(threadId);
    if (!tracker) {
      tracker = new CodexToolActivityTracker();
      this.toolActivityByThread.set(threadId, tracker);
    }
    return tracker;
  }

  private subAgentTracker(threadId: string) {
    let tracker = this.subAgentsByThread.get(threadId);
    if (!tracker) {
      tracker = new CodexSubAgentTracker();
      this.subAgentsByThread.set(threadId, tracker);
    }
    return tracker;
  }

  private applyToolActivity(sessionId: string, state: CodexToolActivityState) {
    this.options.registry.applyRealtimeEvent(sessionId, {
      kind: "tool-activity",
      currentTool: state.currentTool || null,
      toolCallsSinceLastMessage: state.toolCallsSinceLastMessage,
      source: "realtime",
    });
  }

  private applySubAgentUpdates(sessionId: string, threadId: string, updates: CodexSubAgentUpdate[]) {
    this.recordSubAgentRelationships(threadId, updates);
    const tracker = this.subAgentTracker(threadId);
    const subAgents = this.replayObservedLifecycles(
      tracker,
      tracker.apply(updates, new Date().toISOString()),
    );
    this.options.registry.applyRealtimeEvent(sessionId, {
      kind: "sub-agent-activity",
      subAgents,
      source: "realtime",
    });
  }

  private recordSubAgentRelationships(parentThreadId: string, subAgents: Array<Pick<AiSessionSubAgent, "threadId">>) {
    for (const subAgent of subAgents) {
      let parentThreadIds = this.parentThreadsBySubAgent.get(subAgent.threadId);
      if (!parentThreadIds) {
        parentThreadIds = new Set();
        this.parentThreadsBySubAgent.set(subAgent.threadId, parentThreadIds);
      }
      parentThreadIds.add(parentThreadId);
    }
  }

  private replayObservedLifecycles(tracker: CodexSubAgentTracker, subAgents: AiSessionSubAgent[]) {
    const observedAt = new Date().toISOString();
    const updates = subAgents.flatMap((subAgent) => {
      const lifecycle = this.lifecycleByThread.get(subAgent.threadId);
      const addsState = lifecycle && (
        lifecycle.status !== subAgent.status ||
        Boolean(lifecycle.message && lifecycle.message !== subAgent.message)
      );
      return addsState ? [{ ...lifecycle, observedAt }] : [];
    });
    return updates.length ? tracker.apply(updates, observedAt) : subAgents;
  }

  private observeThreadLifecycleEvent(event: CodexAppServerEvent) {
    if (event.type === "turn-started") {
      this.observeThreadLifecycle(event.threadId, "running");
      return;
    }
    if (event.type === "turn-completed") {
      this.observeThreadLifecycle(
        event.threadId,
        event.status === "failed"
          ? "errored"
          : event.status === "interrupted"
            ? "interrupted"
            : "completed",
        event.error,
      );
      return;
    }
    if (event.type === "thread-closed") {
      this.observeThreadLifecycle(event.threadId, "shutdown");
      return;
    }
    if (event.type !== "thread-status") return;
    const type = String(event.status.type || "");
    if (type === "active") {
      this.observeThreadLifecycle(event.threadId, "running");
    } else if (type === "systemError") {
      this.observeThreadLifecycle(event.threadId, "errored");
    } else if (this.parentThreadsBySubAgent.has(event.threadId) && type === "idle") {
      this.observeThreadLifecycle(event.threadId, "completed");
    } else if (this.parentThreadsBySubAgent.has(event.threadId) && type === "notLoaded") {
      this.observeThreadLifecycle(event.threadId, "shutdown");
    }
  }

  private observeThreadSnapshot(threadId: string, thread: CodexThread) {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const latestTurn = turns.length ? turns[turns.length - 1] : undefined;
    const latestTurnStatus = latestTurn && typeof latestTurn === "object" && !Array.isArray(latestTurn)
      ? String((latestTurn as Record<string, unknown>).status || "")
      : "";
    if (latestTurnStatus === "inProgress") {
      this.observeThreadLifecycle(threadId, "running");
    } else if (latestTurnStatus === "failed") {
      this.observeThreadLifecycle(threadId, "errored");
    } else if (latestTurnStatus === "interrupted") {
      this.observeThreadLifecycle(threadId, "interrupted");
    } else if (latestTurnStatus === "completed") {
      this.observeThreadLifecycle(threadId, "completed");
    } else if (thread.status?.type === "active") {
      this.observeThreadLifecycle(threadId, "running");
    } else if (thread.status?.type === "systemError") {
      this.observeThreadLifecycle(threadId, "errored");
    }
  }

  private observeThreadLifecycle(
    threadId: string,
    status: AiSessionSubAgent["status"],
    message?: string,
  ) {
    const observedAt = new Date().toISOString();
    const update: CodexSubAgentUpdate = {
      threadId,
      status,
      ...(message ? { message } : {}),
      observation: "state",
      observedAt,
    };
    this.lifecycleByThread.set(threadId, update);
    for (const parentThreadId of this.parentThreadsBySubAgent.get(threadId) || []) {
      const parentSession = this.options.findSession(parentThreadId);
      if (parentSession) this.applySubAgentUpdates(parentSession.id, parentThreadId, [update]);
    }
  }
}
