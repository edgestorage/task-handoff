import type {
  AiSessionTimeline,
  AiSessionTimelineActivity,
  AiSessionTimelineActivityStatus,
  AiSessionTimelineItem,
} from "@task-handoff/protocol/ai-sessions";
import { mergeAiSessionTimelineItems } from "@task-handoff/protocol/ai-sessions";
import { isSyntheticUserTranscriptText } from "@task-handoff/core/core/transcript";
import { codexToolDescriptor } from "./items";
import type { CodexThread, CodexThreadItemEntry, JsonValue } from "./types";
import { asRecord, stringField } from "./values";

export function codexThreadTimeline(
  sessionId: string,
  providerSessionId: string,
  thread: CodexThread,
  generatedAt = new Date().toISOString(),
  realtimeItems: CodexRealtimeTimelineItem[] = [],
): AiSessionTimeline {
  const items: AiSessionTimelineItem[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const [turnIndex, rawTurn] of turns.entries()) {
    const turn = asRecord(rawTurn);
    const turnId = stringField(turn, "id") || `turn_${turnIndex}`;
    const turnItems = Array.isArray(turn.items) ? turn.items : [];
    for (const [itemIndex, rawItem] of turnItems.entries()) {
      const item = asRecord(rawItem);
      const id = stringField(item, "id") || `${turnId}:item_${itemIndex}`;
      const projected = projectCodexTimelineItem(id, turnId, item);
      if (projected) items.push(projected);
    }
  }
  const projectedRealtimeItems = realtimeItems.flatMap((entry) => {
    const id = stringField(entry.item, "id");
    if (!id) return [];
    const projected = projectCodexTimelineItem(id, entry.turnId, entry.item);
    return projected ? [projected] : [];
  });
  return { sessionId, providerSessionId, items: mergeCodexTimelineItems(items, projectedRealtimeItems), generatedAt };
}

export function codexItemTimeline(
  sessionId: string,
  providerSessionId: string,
  entries: readonly CodexThreadItemEntry[],
  generatedAt = new Date().toISOString(),
  realtimeItems: CodexRealtimeTimelineItem[] = [],
): AiSessionTimeline {
  const persistedItems = entries.flatMap((entry) => {
    const id = stringField(entry.item, "id");
    if (!id) return [];
    const projected = projectCodexTimelineItem(id, entry.turnId, entry.item);
    return projected ? [projected] : [];
  });
  const projectedRealtimeItems = realtimeItems.flatMap((entry) => {
    const id = stringField(entry.item, "id");
    if (!id) return [];
    const projected = projectCodexTimelineItem(id, entry.turnId, entry.item);
    return projected ? [projected] : [];
  });
  return {
    sessionId,
    providerSessionId,
    items: mergeCodexTimelineItems(persistedItems, projectedRealtimeItems),
    generatedAt,
  };
}

/**
 * Compatibility for v0.0.21: thread/read synthesizes different ids for the
 * same messages later delivered by Codex's authoritative single-item events.
 * Align equivalent occurrences before the normal id-based ordered merge.
 */
export function mergeCodexTimelineItems(
  snapshot: readonly AiSessionTimelineItem[],
  itemEvents: readonly AiSessionTimelineItem[],
) {
  if (!itemEvents.length) return [...snapshot];
  const eventIndexesByIdentity = new Map<string, number[]>();
  const eventIndexById = new Map<string, number>();
  for (const [index, item] of itemEvents.entries()) {
    eventIndexById.set(item.id, index);
    const identity = codexTimelineSemanticIdentity(item);
    const indexes = eventIndexesByIdentity.get(identity);
    if (indexes) indexes.push(index);
    else eventIndexesByIdentity.set(identity, [index]);
  }
  const consumedEventIndexes = new Set<number>();
  const alignedSnapshot = snapshot.map((item) => {
    const exactIndex = eventIndexById.get(item.id);
    if (exactIndex !== undefined) {
      consumedEventIndexes.add(exactIndex);
      return itemEvents[exactIndex];
    }
    const identity = codexTimelineSemanticIdentity(item);
    const eventIndex = eventIndexesByIdentity.get(identity)?.find((index) => !consumedEventIndexes.has(index));
    if (eventIndex === undefined) return item;
    consumedEventIndexes.add(eventIndex);
    return itemEvents[eventIndex];
  });
  return mergeAiSessionTimelineItems(alignedSnapshot, itemEvents);
}

function codexTimelineSemanticIdentity(item: AiSessionTimelineItem) {
  if (item.type !== "activity") return JSON.stringify([item.turnId, item.type, item.text]);
  return JSON.stringify([
    item.turnId,
    item.type,
    item.activityKind,
    item.title,
    item.summary,
    item.input,
    item.output,
    item.paths,
    item.exitCode,
  ]);
}

export function projectCodexTimelineItem(id: string, turnId: string, item: JsonValue): AiSessionTimelineItem | undefined {
  if (item.type === "userMessage") {
    const text = textFromUserMessage(item);
    return text && !isSyntheticUserTranscriptText(text) ? { id, turnId, type: "user-message", text } : undefined;
  }
  if (item.type === "agentMessage") {
    return typeof item.text === "string" && item.text.trim() ? { id, turnId, type: "ai-message", text: item.text.trim() } : undefined;
  }
  if (item.type === "reasoning") return undefined;
  return projectCodexTimelineActivity(id, turnId, item);
}

export type CodexRealtimeTimelineItem = {
  turnId: string;
  item: JsonValue;
};

export function projectCodexTimelineActivity(id: string, turnId: string, item: JsonValue): AiSessionTimelineActivity {
  const activityKind = stringField(item, "type") || "unknown";
  const tool = activityKind === "codexRetry" ? undefined : codexToolDescriptor(item);
  const base = {
    id,
    turnId,
    type: "activity" as const,
    activityKind,
    title: tool?.name || activityTitle(activityKind),
    status: activityStatus(item.status),
    durationMs: nonnegativeInteger(item.durationMs),
  };
  switch (activityKind) {
    case "plan":
      return compactActivity({ ...base, summary: stringField(item, "text") });
    case "codexRetry":
      return compactActivity({ ...base, summary: stringField(item, "message") });
    case "hookPrompt":
      return compactActivity({ ...base, summary: hookPromptText(item) });
    case "commandExecution":
      return compactActivity({
        ...base,
        input: stringField(item, "command"),
        output: stringField(item, "aggregatedOutput"),
        exitCode: integer(item.exitCode),
      });
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
      const paths = [...new Set(changes.map((change) => stringField(change, "path")).filter((path): path is string => Boolean(path)))];
      return compactActivity({ ...base, summary: paths.join(", ") || undefined, paths, output: safeJson(changes) });
    }
    case "mcpToolCall":
      return compactActivity({
        ...base,
        input: safeJson(item.arguments),
        output: safeJson(item.error || item.result),
      });
    case "dynamicToolCall":
      return compactActivity({
        ...base,
        input: safeJson(item.arguments),
        output: safeJson(item.contentItems),
      });
    case "collabAgentToolCall":
      return compactActivity({
        ...base,
        input: stringField(item, "prompt"),
        output: safeJson(item.agentsStates),
      });
    case "subAgentActivity":
      return compactActivity({
        ...base,
        summary: [stringField(item, "kind"), stringField(item, "agentPath")].filter(Boolean).join(" · ") || undefined,
      });
    case "webSearch":
      return compactActivity({ ...base, input: stringField(item, "query") });
    case "imageView":
      return compactActivity({ ...base, paths: stringField(item, "path") ? [stringField(item, "path") as string] : undefined });
    case "sleep":
      return compactActivity({ ...base, summary: nonnegativeInteger(item.durationMs) === undefined ? undefined : `${item.durationMs} ms` });
    case "imageGeneration":
      return compactActivity({ ...base, input: stringField(item, "revisedPrompt"), output: safeJson(item.result) });
    case "enteredReviewMode":
    case "exitedReviewMode":
      return compactActivity({ ...base, summary: stringField(item, "review") });
    case "contextCompaction":
      return compactActivity({ ...base, status: "completed" });
    default:
      return compactActivity(base);
  }
}

function activityTitle(kind: string) {
  const titles: Record<string, string> = {
    reasoning: "Reasoning",
    plan: "Plan",
    hookPrompt: "Hook prompt",
    subAgentActivity: "Sub-agent activity",
    enteredReviewMode: "Entered review mode",
    exitedReviewMode: "Exited review mode",
    contextCompaction: "Context compaction",
    codexRetry: "Codex retry",
  };
  return titles[kind] || kind;
}

function activityStatus(value: unknown): AiSessionTimelineActivityStatus | undefined {
  switch (value) {
    case "inProgress": return "running";
    case "failed":
    case "declined": return "failed";
    case "pending": return "waiting";
    case "completed": return "completed";
    default: return undefined;
  }
}

function textFromUserMessage(item: JsonValue) {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((value) => {
    const input = asRecord(value);
    return input.type === "text" && typeof input.text === "string" ? input.text.trim() : "";
  }).filter(Boolean).join("\n").trim();
}

function hookPromptText(item: JsonValue) {
  const fragments = Array.isArray(item.fragments) ? item.fragments : [];
  return fragments.map((value) => stringField(asRecord(value), "text")).filter(Boolean).join("\n").trim() || undefined;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown) {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function safeJson(value: unknown) {
  if (value === undefined || value === null) return undefined;
  try { return JSON.stringify(value, null, 2); } catch { return undefined; }
}

function compactActivity(activity: AiSessionTimelineActivity): AiSessionTimelineActivity {
  return {
    ...activity,
    summary: bounded(activity.summary, 4_000),
    input: bounded(activity.input, 100_000),
    output: bounded(activity.output, 1_000_000),
    paths: activity.paths?.slice(0, 500),
  };
}

function bounded(value: string | undefined, limit: number) {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
