import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
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

  constructor(private readonly options: ProjectorOptions) {}

  clearThread(threadId: string) {
    this.toolActivityByThread.delete(threadId);
    this.subAgentsByThread.delete(threadId);
  }

  resetConnection() {
    this.toolActivityByThread.clear();
    this.subAgentsByThread.clear();
  }

  apply(event: CodexAppServerEvent) {
    if (event.type === "thread" || event.type === "approval-request") {
      return false;
    }
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
      this.options.registry.applyRealtimeEvent(session.id, { kind: "turn-started", activeTurnId: event.turnId, providerTurnId: event.turnId, source: "realtime" });
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
      this.options.clearApprovalSession(session.id);
      this.applyToolActivity(session.id, this.toolTracker(event.threadId).clearActiveTools());
      this.options.registry.applyRealtimeEvent(session.id, {
        kind: "turn-completed",
        activeTurnId: event.turnId,
        providerTurnId: event.turnId,
        status: event.status === "failed" ? "failed" : "idle",
        error: event.status === "failed" ? event.error : undefined,
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

  applyThreadSnapshot(thread: CodexThread, context: { appSessionId?: string } = {}) {
    const threadId = typeof thread.id === "string" ? thread.id : undefined;
    if (!threadId || thread.ephemeral === true) {
      return;
    }
    const existing = this.options.findSession(threadId);
    const lifecycle = this.options.attachApprovalLifecycle(existing?.id, lifecycleForStatus(thread.status || {}));
    const history = summarizeThreadTurns(thread);
    const activity = Array.isArray(thread.turns)
      ? this.replaceThreadActivity(threadId, history.toolActivity, history.subAgents)
      : this.snapshotThreadActivity(threadId);
    return this.options.registry.applyAdapterSnapshot({
      source: "adapter-snapshot",
      agent: "codex",
      appId: context.appSessionId ? "codex" : "codex-app-server",
      appSessionId: context.appSessionId,
      providerSessionId: threadId,
      appBindingKeys: context.appSessionId ? [`app:${context.appSessionId}`] : undefined,
      actions: {
        send: true,
        interrupt: lifecycle.status === "running" || lifecycle.status === "waiting",
        approval: lifecycle.status === "waiting" && lifecycle.phase === "approval",
      },
      title: typeof thread.name === "string" ? thread.name : undefined,
      cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
      activeTurnId: history.activeTurnId,
      userPrompt: history.userPrompt,
      turns: history.turns,
      summary: existing ? this.options.latestApprovalSummary(existing.id) || history.summary : history.summary,
      lastMessage: history.lastMessage,
      lastMessageItemId: history.lastMessageItemId,
      currentTool: activity.toolActivity.currentTool,
      toolCallsSinceLastMessage: activity.toolActivity.toolCallsSinceLastMessage,
      subAgents: activity.subAgents,
      status: lifecycle.status,
      phase: lifecycle.phase,
      replaceActivity: true,
    });
  }

  replaceThreadActivity(threadId: string, toolActivity: CodexToolActivityState, subAgents: Parameters<CodexSubAgentTracker["replace"]>[0]) {
    return {
      toolActivity: this.toolTracker(threadId).replace(toolActivity),
      subAgents: this.subAgentTracker(threadId).replace(subAgents),
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
    const subAgents = this.subAgentTracker(threadId).apply(updates, new Date().toISOString());
    this.options.registry.applyRealtimeEvent(sessionId, {
      kind: "sub-agent-activity",
      subAgents,
      source: "realtime",
    });
  }
}
