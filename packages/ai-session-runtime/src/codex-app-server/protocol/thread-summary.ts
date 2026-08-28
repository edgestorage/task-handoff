import type {
  AiSessionStatus,
  AiSessionSubAgent,
} from "@task-handoff/protocol/ai-sessions";
import { isSyntheticUserTranscriptText } from "@task-handoff/core/core/transcript";
import {
  rebuildCodexSubAgents,
  rebuildCodexToolActivity,
} from "./activity";
import { compact } from "../../ai-session-turns";
import type {
  CodexThread,
  CodexToolActivityState,
  JsonValue,
} from "./types";
import { asRecord } from "./values";
import { codexTurnErrorMessage } from "./events";
import { isoTimestampFromSeconds } from "./items";

export function summarizeThreadTurns(thread: CodexThread): {
  activeTurnId?: string;
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  summary?: string;
  lastMessage?: string;
  lastMessageItemId?: string;
  error?: string;
  latestTurnStatus?: string;
  toolActivity: CodexToolActivityState;
  subAgents: AiSessionSubAgent[];
} {
  let activeTurnId: string | undefined;
  let userPrompt: string | undefined;
  let lastMessage: string | undefined;
  let lastMessageItemId: string | undefined;
  let error: string | undefined;
  const historyTurns: NonNullable<AiSessionStatus["turns"]> = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const [index, turn] of turns.entries()) {
    const record = asRecord(turn);
    const turnId = typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `turn_${index}`;
    const providerStatus = typeof record.status === "string" ? record.status : "completed";
    const startedAt = isoTimestampFromSeconds(record.startedAt);
    const completedAt = isoTimestampFromSeconds(record.completedAt)
      || completedAtFromDuration(startedAt, record.durationMs);
    const historyTurn: NonNullable<AiSessionStatus["turns"]>[number] = {
      id: turnId,
      status: providerStatus === "inProgress"
        ? "running"
        : providerStatus === "failed"
          ? "failed"
          : "completed",
      revision: 0,
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt, updatedAt: completedAt } : startedAt ? { updatedAt: startedAt } : {}),
    };
    const turnError = providerStatus === "failed" ? codexTurnErrorMessage(record.error) : undefined;
    if (index === turns.length - 1) error = turnError;
    if (providerStatus === "inProgress") {
      activeTurnId = turnId;
    }
    const items = Array.isArray(record.items) ? record.items as unknown[] : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (item.type === "userMessage") {
        const text = textFromUserMessageItem(item);
        if (text && !isSyntheticUserTranscriptText(text)) {
          userPrompt = text;
          historyTurn.userPrompt = text;
        }
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        lastMessage = item.text.trim();
        lastMessageItemId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined;
        historyTurn.lastMessage = lastMessage;
        historyTurn.lastMessageItemId = lastMessageItemId;
        historyTurn.summary = compact(lastMessage, 1000);
      } else if (item.type === "contextCompaction" && typeof item.id === "string" && item.id.trim()) {
        historyTurn.contextCompactions = [
          ...(historyTurn.contextCompactions || []),
          { id: `context_compaction:${turnId}`, status: "completed" },
        ];
      }
    }
    if (historyTurn.userPrompt || historyTurn.lastMessage || historyTurn.summary || historyTurn.contextCompactions?.length) {
      historyTurns.push(historyTurn);
    }
  }
  const updatedAt = new Date().toISOString();
  return {
    activeTurnId,
    userPrompt,
    turns: historyTurns,
    summary: lastMessage,
    lastMessage,
    lastMessageItemId,
    error,
    latestTurnStatus: turns.length ? String(asRecord(turns.at(-1)).status || "completed") : undefined,
    toolActivity: rebuildCodexToolActivity(thread),
    subAgents: rebuildCodexSubAgents(thread, updatedAt),
  };
}

function completedAtFromDuration(startedAt: string | undefined, durationMs: unknown) {
  if (!startedAt || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return new Date(Date.parse(startedAt) + durationMs).toISOString();
}

function textFromUserMessageItem(item: JsonValue) {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map(textFromUserInput).filter(Boolean).join("\n").trim();
}

function textFromUserInput(value: unknown) {
  const input = asRecord(value);
  return input.type === "text" && typeof input.text === "string"
    ? input.text.trim()
    : "";
}
