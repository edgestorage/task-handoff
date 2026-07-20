import type { AiSessionSubAgent } from "@task-handoff/protocol/ai-sessions";
import {
  codexToolDescriptor,
  codexSubAgentUpdates,
} from "./items";
import type { CodexSubAgentUpdate, CodexThread, CodexToolActivityState, CodexToolDescriptor, JsonValue } from "./types";

export class CodexSubAgentTracker {
  private readonly subAgents = new Map<string, AiSessionSubAgent>();
  private readonly observations = new Map<string, {
    stateAt?: string;
    activityAt?: string;
    activityOrigin?: "snapshot" | "realtime";
  }>();

  replace(subAgents: AiSessionSubAgent[]) {
    for (const subAgent of subAgents) {
      const current = this.subAgents.get(subAgent.threadId);
      const observation = this.observations.get(subAgent.threadId) || {};
      const preserveNewerState = Boolean(current && isSnapshotStateRegression(current.status, subAgent.status));
      const preserveRealtimeActivity = observation.activityOrigin === "realtime";
      const merged: AiSessionSubAgent = current ? {
        ...current,
        status: preserveNewerState ? current.status : subAgent.status,
        message: preserveNewerState ? current.message : subAgent.message,
        path: subAgent.path || current.path,
        activity: preserveRealtimeActivity ? current.activity : subAgent.activity || current.activity,
        updatedAt: current.updatedAt,
      } : subAgent;
      const changed = !current ||
        current.path !== merged.path ||
        current.status !== merged.status ||
        current.activity !== merged.activity ||
        current.message !== merged.message;
      this.subAgents.set(
        subAgent.threadId,
        changed ? { ...merged, updatedAt: maxTimestamp(current?.updatedAt, subAgent.updatedAt) } : current,
      );
      this.observations.set(subAgent.threadId, {
        ...observation,
        stateAt: preserveNewerState ? observation.stateAt : maxTimestamp(observation.stateAt, subAgent.updatedAt),
        activityAt: subAgent.activity && !preserveRealtimeActivity
          ? maxTimestamp(observation.activityAt, subAgent.updatedAt)
          : observation.activityAt,
        activityOrigin: preserveRealtimeActivity
          ? "realtime"
          : subAgent.activity
            ? "snapshot"
            : observation.activityOrigin,
      });
    }
    this.prune();
    return this.snapshot();
  }

  apply(updates: CodexSubAgentUpdate[], updatedAt: string) {
    for (const update of updates) {
      const current = this.subAgents.get(update.threadId);
      const observation = this.observations.get(update.threadId) || {};
      const { observation: kind, observedAt, ...fields } = update;
      const observationAt = observedAt || updatedAt;
      const stateStale = kind === "state" && timestampBefore(observationAt, observation.stateAt);
      const activityStale = kind === "activity" && timestampBefore(observationAt, observation.activityAt);
      const next: AiSessionSubAgent = kind === "state"
        ? {
            ...(current || fields),
            status: stateStale && current ? current.status : fields.status,
            message: stateStale && current ? current.message : fields.message,
            updatedAt: current?.updatedAt || observationAt,
          }
        : {
            ...(current || fields),
            status: current && observation.stateAt
              ? current.status
              : activityStale && current
                ? current.status
                : fields.status,
            path: fields.path && (!activityStale || !current?.path) ? fields.path : current?.path,
            activity: activityStale && current ? current.activity : fields.activity || current?.activity,
            message: current?.message,
            updatedAt: current?.updatedAt || observationAt,
          };
      const changed = !current ||
        current.path !== next.path ||
        current.status !== next.status ||
        current.activity !== next.activity ||
        current.message !== next.message;
      this.subAgents.set(
        update.threadId,
        changed ? { ...next, updatedAt: maxTimestamp(current?.updatedAt, observationAt) } : current,
      );
      this.observations.set(update.threadId, kind === "state"
        ? {
            ...observation,
            stateAt: stateStale ? observation.stateAt : observationAt,
          }
        : {
            ...observation,
            activityAt: activityStale ? observation.activityAt : observationAt,
            activityOrigin: activityStale ? observation.activityOrigin : "realtime",
          });
    }
    this.prune();
    return this.snapshot();
  }

  clear() {
    this.subAgents.clear();
    this.observations.clear();
    return this.snapshot();
  }

  snapshot() {
    return [...this.subAgents.values()].sort((left, right) => left.threadId.localeCompare(right.threadId));
  }

  private prune() {
    if (this.subAgents.size <= 50) return;
    const active = new Set(["pending-init", "running", "interrupted", "errored"]);
    const retained = [...this.subAgents.values()]
      .sort((left, right) =>
        Number(active.has(right.status)) - Number(active.has(left.status)) ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.threadId.localeCompare(right.threadId))
      .slice(0, 50);
    const retainedIds = new Set(retained.map((subAgent) => subAgent.threadId));
    for (const threadId of this.subAgents.keys()) {
      if (!retainedIds.has(threadId)) {
        this.subAgents.delete(threadId);
        this.observations.delete(threadId);
      }
    }
  }
}

export class CodexToolActivityTracker {
  private readonly seenToolIds = new Set<string>();
  private readonly activeTools = new Map<string, CodexToolDescriptor>();
  private contextCompaction?: CodexToolDescriptor;

  replace(state: CodexToolActivityState) {
    this.seenToolIds.clear();
    this.activeTools.clear();
    this.contextCompaction = state.currentTool?.kind === "context-compaction" ? state.currentTool : undefined;
    for (const id of state.seenToolIds) this.seenToolIds.add(id);
    for (const tool of state.activeTools) this.activeTools.set(tool.id, tool);
    return this.snapshot();
  }

  started(tool: CodexToolDescriptor) {
    this.contextCompaction = undefined;
    if (this.seenToolIds.has(tool.id)) return this.snapshot();
    this.seenToolIds.add(tool.id);
    this.activeTools.set(tool.id, tool);
    return this.snapshot();
  }

  completed(tool: CodexToolDescriptor) {
    this.seenToolIds.add(tool.id);
    this.activeTools.delete(tool.id);
    return this.snapshot();
  }

  compacting(turnId: string, status: "running" | "completed", observedAt?: string) {
    this.contextCompaction = {
      id: `context_compaction:${turnId}`,
      kind: "context-compaction",
      name: status === "completed" ? "Context compacted" : "Compacting context…",
      ...(status === "running" && observedAt ? { startedAt: observedAt } : {}),
    };
    return this.snapshot();
  }

  restoreActive(tool: CodexToolDescriptor) {
    this.seenToolIds.add(tool.id);
    this.activeTools.delete(tool.id);
    this.activeTools.set(tool.id, tool);
    return this.snapshot();
  }

  resetForAgentMessage() {
    this.seenToolIds.clear();
    this.activeTools.clear();
    this.contextCompaction = undefined;
    return this.snapshot();
  }

  clearActiveTools() {
    this.activeTools.clear();
    this.contextCompaction = undefined;
    return this.snapshot();
  }

  snapshot(): CodexToolActivityState {
    const activeTools = [...this.activeTools.values()];
    return {
      seenToolIds: [...this.seenToolIds],
      activeTools,
      toolCallsSinceLastMessage: this.seenToolIds.size,
      currentTool: this.contextCompaction || activeTools.at(-1),
    };
  }
}

export function rebuildCodexToolActivity(thread: CodexThread): CodexToolActivityState {
  const tracker = new CodexToolActivityTracker();
  let lastItemAfterBoundary: { item: JsonValue; tool?: CodexToolDescriptor } | undefined;
  let lastTurnActive = false;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn);
    lastTurnActive = turn.status === "inProgress";
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (item.type === "agentMessage") {
        tracker.resetForAgentMessage();
        lastItemAfterBoundary = undefined;
        continue;
      }
      if (item.type === "contextCompaction") {
        tracker.compacting(typeof turn.id === "string" ? turn.id : "unknown", "completed");
        lastItemAfterBoundary = undefined;
        continue;
      }
      const tool = codexToolDescriptor(item);
      lastItemAfterBoundary = { item, tool };
      if (!tool) continue;
      const activity = explicitToolActivity(item);
      if (activity === "active") tracker.started(tool);
      else tracker.completed(tool);
    }
  }
  const threadActive = thread.status?.type === "active";
  if (
    threadActive &&
    lastTurnActive &&
    lastItemAfterBoundary?.tool &&
    explicitToolActivity(lastItemAfterBoundary.item) === "unknown"
  ) {
    tracker.restoreActive(lastItemAfterBoundary.tool);
  }
  return tracker.snapshot();
}

export function rebuildCodexSubAgents(thread: CodexThread, updatedAt: string): AiSessionSubAgent[] {
  const tracker = new CodexSubAgentTracker();
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      tracker.apply(codexSubAgentUpdates(asRecord(rawItem)), updatedAt);
    }
  }
  return tracker.snapshot();
}

function explicitToolActivity(item: JsonValue): "active" | "inactive" | "unknown" {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "imageGeneration":
      return item.status === "inProgress"
        ? "active"
        : typeof item.status === "string"
          ? "inactive"
          : "unknown";
    case "webSearch":
    case "imageView":
    case "sleep":
      return "unknown";
    default:
      return "inactive";
  }
}

function timestampBefore(left: string, right: string | undefined) {
  return Boolean(right && Date.parse(left) < Date.parse(right));
}

function isSnapshotStateRegression(
  current: AiSessionSubAgent["status"],
  incoming: AiSessionSubAgent["status"],
) {
  const rank: Record<AiSessionSubAgent["status"], number> = {
    "pending-init": 0,
    running: 1,
    interrupted: 2,
    completed: 3,
    errored: 3,
    shutdown: 3,
    "not-found": 3,
  };
  return rank[incoming] < rank[current];
}

function maxTimestamp(left: string | undefined, right: string) {
  return left && Date.parse(left) >= Date.parse(right) ? left : right;
}

function asRecord(value: unknown): JsonValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonValue
    : {};
}
