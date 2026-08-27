import type {
  AiSessionRealtimeInput,
  AiSessionSnapshotInput,
  AiSessionStatus,
  AiSessionUserMessageDetail,
} from "@task-handoff/protocol/ai-sessions";
import {
  compact,
  currentActiveTurnIsPending,
  messageText,
  nextActiveTurnId,
  normalizeTurns,
  snapshotMissingPendingActiveTurn,
  stableGeneratedTurnId,
  turnHasResponse,
  turnMeta,
  updateTurns,
  type TurnMeta,
} from "../ai-session-turns";
import {
  normalizeAiSessionCounters,
  normalizeAiSessionLifecycle,
  normalizeAiSessionPhase,
  normalizeAiSessionQueue,
  normalizeAiSessionSubAgents,
} from "./persistence";

export type AiSessionPatch = Partial<
  Pick<
    AiSessionStatus,
    | "appSessionId"
    | "appId"
    | "providerSessionId"
    | "lineage"
    | "providerMeta"
    | "modelSelection"
    | "reasoningEffort"
    | "appBindingKeys"
    | "actions"
    | "activeTurnId"
    | "title"
    | "cwd"
    | "cwdFolderId"
    | "userPrompt"
    | "turns"
    | "status"
    | "phase"
    | "summary"
    | "lastMessage"
    | "lastMessageItemId"
    | "currentTool"
    | "toolCallsSinceLastMessage"
    | "subAgents"
    | "transcriptPath"
    | "transcriptSize"
    | "completedAt"
    | "error"
    | "queue"
  >
> & {
  counters?: Partial<AiSessionStatus["counters"]>;
  userMessage?: AiSessionUserMessageDetail;
};

export type ApplyAiSessionPatchOptions = {
  updatedAt?: string;
  preserveUpdatedAt?: boolean;
  replaceActivity?: boolean;
  replaceTurns?: boolean;
  clearResponse?: boolean;
  clearError?: boolean;
  suppressPromptTurn?: boolean;
  suppressTurnUpdate?: boolean;
  meta?: TurnMeta;
};

function latestTurnUserPrompt(turns: AiSessionStatus["turns"]) {
  return [...(turns || [])].reverse().find((turn) => turn.userPrompt?.trim())?.userPrompt;
}

/**
 * Applies a state patch without persistence, clock access, id generation, or
 * event emission. Callers must supply updatedAt when they want to advance time.
 */
function buildAiSessionPatch(
  current: AiSessionStatus,
  patch: AiSessionPatch,
  options: ApplyAiSessionPatchOptions = {},
): AiSessionStatus {
  const counterDelta = normalizeAiSessionCounters(patch.counters);
  const counters = {
    toolCalls: current.counters.toolCalls + counterDelta.toolCalls,
    edits: current.counters.edits + counterDelta.edits,
    approvals: current.counters.approvals + counterDelta.approvals,
  };
  const updatedAt = options.preserveUpdatedAt ? current.updatedAt : options.updatedAt ?? current.updatedAt;
  const turnPatch = options.suppressPromptTurn ? { ...patch, userPrompt: undefined } : patch;
  const turns = options.suppressTurnUpdate
    ? options.replaceTurns ? normalizeTurns(undefined) : current.turns
    : updateTurns(options.replaceTurns ? undefined : current.turns, turnPatch, updatedAt, options.meta);
  const prompt = patch.userPrompt ? messageText(patch.userPrompt) : "";
  const latestTurn = turns?.at(-1);
  const derivedUserPrompt = latestTurnUserPrompt(turns);
  const startsEmptyTurn = Boolean(
    prompt &&
    !patch.lastMessage &&
    latestTurn?.userPrompt === prompt &&
    !latestTurn.summary &&
    !latestTurn.lastMessage
  );
  const status = patch.status ? normalizeAiSessionLifecycle(patch.status) : current.status;
  const actions = {
    ...(patch.actions || current.actions),
    // Action availability is part of the lifecycle projection. Adapter snapshots
    // often record interrupt=false while idle; a realtime turn start must not
    // carry that stale value into the running state.
    interrupt: status === "running" || status === "waiting",
  };

  const { userMessage: _userMessage, ...sessionPatch } = patch;
  return {
    ...current,
    ...sessionPatch,
    id: current.id,
    agent: current.agent,
    creationSource: current.creationSource,
    startedAt: current.startedAt,
    updatedAt,
    status,
    phase: patch.phase ? normalizeAiSessionPhase(patch.phase) : current.phase,
    actions,
    summary: options.replaceActivity
      ? patch.summary ? compact(patch.summary, 1000) : undefined
      : options.clearResponse
        ? undefined
        : patch.summary ? compact(patch.summary, 1000) : startsEmptyTurn ? undefined : current.summary,
    lastMessage: options.replaceActivity
      ? patch.lastMessage ? messageText(patch.lastMessage) : undefined
      : options.clearResponse
        ? undefined
        : patch.lastMessage ? messageText(patch.lastMessage) : startsEmptyTurn ? undefined : current.lastMessage,
    userPrompt: derivedUserPrompt || (options.replaceActivity
      ? patch.userPrompt ? messageText(patch.userPrompt) : undefined
      : patch.userPrompt ? messageText(patch.userPrompt) : current.userPrompt),
    turns,
    error: options.clearError ? undefined : patch.error ? compact(patch.error, 4000) : current.error,
    counters,
    queue: patch.queue ? normalizeAiSessionQueue(patch.queue) : current.queue,
    subAgents: patch.subAgents !== undefined ? normalizeAiSessionSubAgents(patch.subAgents) : current.subAgents,
  };
}

export function applyAiSessionPatch(
  current: AiSessionStatus,
  patch: AiSessionPatch,
  options: ApplyAiSessionPatchOptions = {},
): AiSessionStatus {
  return buildAiSessionPatch(current, patch, options);
}

type AiSessionBusinessKey = Exclude<keyof AiSessionStatus, "updatedAt">;

const AI_SESSION_BUSINESS_KEYS = [
  "id",
  "agent",
  "creationSource",
  "appSessionId",
  "appId",
  "providerSessionId",
  "lineage",
  "providerMeta",
  "modelSelection",
  "reasoningEffort",
  "appBindingKeys",
  "actions",
  "activeTurnId",
  "title",
  "cwd",
  "cwdFolderId",
  "userPrompt",
  "turns",
  "status",
  "phase",
  "summary",
  "lastMessage",
  "lastMessageItemId",
  "currentTool",
  "toolCallsSinceLastMessage",
  "subAgents",
  "transcriptPath",
  "transcriptSize",
  "startedAt",
  "completedAt",
  "error",
  "counters",
  "queue",
] as const satisfies readonly AiSessionBusinessKey[];

// Keep this list exhaustive when the persisted session model grows.
const _allAiSessionBusinessKeysCovered: Exclude<AiSessionBusinessKey, typeof AI_SESSION_BUSINESS_KEYS[number]> extends never ? true : never = true;
void _allAiSessionBusinessKeysCovered;

export function sameAiSessionBusinessState(current: AiSessionStatus, next: AiSessionStatus) {
  for (const key of AI_SESSION_BUSINESS_KEYS) {
    const currentValue = current[key];
    const nextValue = next[key];
    if (Object.is(currentValue, nextValue)) continue;
    // Provider discovery may reconstruct an equivalent turn array. Identity is
    // an implementation detail; only the normalized persisted value advances
    // the authoritative session and its updatedAt timestamp.
    if (!samePersistedValue(currentValue, nextValue)) return false;
  }
  return true;
}

function samePersistedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => samePersistedValue(value ?? null, right[index] ?? null));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && samePersistedValue(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function canonicalRealtimeTurnId(
  current: AiSessionStatus,
  event: Pick<AiSessionRealtimeInput, "source" | "activeTurnId">,
  userPrompt?: unknown,
) {
  const incomingTurnId = event.activeTurnId ? compact(event.activeTurnId, 240) : undefined;
  if (event.source !== "transcript-tail" || !incomingTurnId || !current.activeTurnId || incomingTurnId === current.activeTurnId) {
    return incomingTurnId || current.activeTurnId;
  }
  const activeTurn = normalizeTurns(current.turns).find((turn) => turn.id === current.activeTurnId);
  if (!activeTurn || turnHasResponse(activeTurn)) {
    return incomingTurnId;
  }
  const prompt = userPrompt ? messageText(userPrompt) : "";
  if (prompt && activeTurn.userPrompt && activeTurn.userPrompt !== prompt) {
    return incomingTurnId;
  }
  return current.activeTurnId;
}

export function reduceAiSessionRealtime(
  current: AiSessionStatus,
  event: AiSessionRealtimeInput,
): AiSessionStatus | undefined {
  const updatedAt = event.observedAt ?? current.updatedAt;
  const meta = turnMeta(event);
  if (event.kind === "send-ack") {
    const userPrompt = messageText(event.userPrompt);
    return applyAiSessionPatch(current, {
      activeTurnId: event.activeTurnId || stableGeneratedTurnId(userPrompt, updatedAt),
      status: event.status || "running",
      phase: event.phase || "thinking",
      userPrompt,
      userMessage: event.userMessage,
    }, { updatedAt, meta, clearError: true });
  }
  if (event.kind === "model-selection") {
    return applyAiSessionPatch(current, { modelSelection: event.modelSelection }, {
      updatedAt,
      meta,
      suppressTurnUpdate: true,
    });
  }
  if (event.kind === "reasoning-effort") {
    return applyAiSessionPatch(current, { reasoningEffort: event.reasoningEffort }, {
      updatedAt,
      meta,
      suppressTurnUpdate: true,
    });
  }
  if (event.kind === "lifecycle") {
    const status = event.status || current.status;
    if ((status === "idle" || status === "failed") && currentActiveTurnIsPending(current)) {
      return current;
    }
    return applyAiSessionPatch(current, {
      activeTurnId: status === "running" || status === "waiting" ? event.activeTurnId || current.activeTurnId : current.activeTurnId,
      status,
      phase: event.phase || current.phase,
      currentTool: status === "idle" || status === "failed" ? undefined : current.currentTool,
    }, { updatedAt, meta, clearError: status === "running" || status === "waiting" });
  }
  if (event.kind === "turn-started") {
    return applyAiSessionPatch(current, {
      activeTurnId: event.activeTurnId || current.activeTurnId,
      status: event.status || "running",
      phase: event.phase || "thinking",
    }, { updatedAt, meta, clearError: true });
  }
  if (event.kind === "user-message") {
    return applyAiSessionPatch(current, {
      activeTurnId: canonicalRealtimeTurnId(current, event, event.userPrompt),
      status: event.status || "running",
      phase: event.phase || "thinking",
      userPrompt: event.userPrompt,
      userMessage: event.userMessage,
    }, { updatedAt, meta, clearError: true });
  }
  if (event.kind === "assistant-message") {
    const completedFromTranscript = event.source === "transcript-tail";
    return applyAiSessionPatch(current, {
      activeTurnId: canonicalRealtimeTurnId(current, event),
      status: event.status || (completedFromTranscript ? "idle" : "running"),
      phase: event.phase || (completedFromTranscript ? "unknown" : "responding"),
      summary: event.text,
      lastMessage: event.text,
      lastMessageItemId: event.itemId,
      currentTool: undefined,
      toolCallsSinceLastMessage: 0,
    }, { updatedAt, meta });
  }
  if (event.kind === "approval-requested") {
    return applyAiSessionPatch(current, {
      activeTurnId: event.activeTurnId || current.activeTurnId,
      status: event.status || "waiting",
      phase: event.phase || "approval",
      summary: event.summary || event.text,
      actions: { ...current.actions, approval: true },
      counters: event.counters || { approvals: 1 },
    }, { updatedAt, meta });
  }
  if (event.kind === "tool-activity") {
    return applyAiSessionPatch(current, {
      currentTool: event.currentTool || undefined,
      toolCallsSinceLastMessage: event.toolCallsSinceLastMessage,
    }, { updatedAt, meta, suppressTurnUpdate: true });
  }
  if (event.kind === "sub-agent-activity") {
    return applyAiSessionPatch(current, { subAgents: event.subAgents }, { updatedAt, meta, suppressTurnUpdate: true });
  }
  if (event.kind === "session-error") {
    return applyAiSessionPatch(current, { error: event.error }, { updatedAt, meta, suppressTurnUpdate: true });
  }
  if (event.kind === "context-compaction" && event.contextCompaction) {
    const turnId = event.activeTurnId || current.activeTurnId;
    if (!turnId) return current;
    const existing = normalizeTurns(current.turns).find((turn) => turn.id === turnId);
    const existingCompaction = existing?.contextCompactions?.find((item) => item.id === event.contextCompaction?.id);
    if (
      existingCompaction?.status === "completed" ||
      existingCompaction?.status === event.contextCompaction.status &&
        existingCompaction.startedAt === event.contextCompaction.startedAt &&
        existingCompaction.completedAt === event.contextCompaction.completedAt
    ) {
      return current;
    }
    return applyAiSessionPatch(current, {
      turns: [{
        ...existing,
        id: turnId,
        providerTurnId: event.providerTurnId || existing?.providerTurnId || turnId,
        source: event.source,
        status: existing?.status || "running",
        phase: existing?.phase || "thinking",
        contextCompactions: [event.contextCompaction],
        revision: (existing?.revision || 0) + 1,
        updatedAt,
      }],
    }, { updatedAt, meta, suppressPromptTurn: true });
  }
  if (event.kind === "turn-completed") {
    const error = event.error ? compact(event.error, 4000) : undefined;
    const responseText = event.text || event.summary || (event.status === "failed" ? error : undefined);
    return applyAiSessionPatch(current, {
      activeTurnId: !event.activeTurnId || event.activeTurnId === current.activeTurnId ? undefined : current.activeTurnId,
      status: event.status || "idle",
      phase: event.phase || "unknown",
      summary: responseText,
      lastMessage: responseText,
      error,
      currentTool: undefined,
    }, { updatedAt, meta, clearResponse: !responseText, clearError: event.status !== "failed" });
  }
  return undefined;
}

function isAuthoritativeAppBindingSnapshot(event: AiSessionSnapshotInput) {
  return event.source === "app-session" || (
    event.source === "adapter-snapshot" &&
    event.agent === "codex" &&
    event.appId === "codex-app-server"
  );
}

export function reduceAiSessionSnapshot(
  current: AiSessionStatus,
  event: AiSessionSnapshotInput,
): AiSessionStatus {
  const meta = turnMeta(event);
  const incomingTurns = normalizeTurns(event.turns, meta);
  const staleActivitySnapshot = snapshotMissingPendingActiveTurn(current, incomingTurns);
  const snapshotHasActiveTurn = Boolean(current.activeTurnId && incomingTurns.some((turn) => turn.id === current.activeTurnId));
  const incomingActiveTurn = current.activeTurnId
    ? incomingTurns.find((turn) => turn.id === current.activeTurnId)
    : undefined;
  const ignoreSnapshotTopLevelResponse = Boolean(
    event.replaceActivity &&
    current.activeTurnId &&
    snapshotHasActiveTurn &&
    !turnHasResponse(incomingActiveTurn)
  );
  const replaceAppBinding = isAuthoritativeAppBindingSnapshot(event);

  const next = buildAiSessionPatch(current, {
    appSessionId: replaceAppBinding ? event.appSessionId : event.appSessionId || current.appSessionId,
    appId: event.appId || current.appId,
    providerSessionId: event.providerSessionId || current.providerSessionId,
    lineage: current.lineage || event.lineage,
    providerMeta: event.providerMeta || current.providerMeta,
    modelSelection: event.modelSelection || current.modelSelection,
    reasoningEffort: event.reasoningEffort || current.reasoningEffort,
    appBindingKeys: replaceAppBinding ? event.appBindingKeys : event.appBindingKeys || current.appBindingKeys,
    actions: event.actions || current.actions,
    activeTurnId: nextActiveTurnId(current, event, staleActivitySnapshot),
    title: event.title || current.title,
    cwd: event.cwd || current.cwd,
    cwdFolderId: event.cwdFolderId || current.cwdFolderId,
    userPrompt: staleActivitySnapshot ? current.userPrompt : event.userPrompt || current.userPrompt,
    turns: staleActivitySnapshot ? current.turns : event.turns,
    lastMessage: staleActivitySnapshot
      ? current.lastMessage
      : ignoreSnapshotTopLevelResponse ? undefined : event.lastMessage || current.lastMessage,
    transcriptPath: event.transcriptPath || current.transcriptPath,
    transcriptSize: event.transcriptSize ?? current.transcriptSize,
    status: staleActivitySnapshot ? current.status : event.status || current.status,
    phase: staleActivitySnapshot ? current.phase : event.phase || current.phase,
    summary: staleActivitySnapshot
      ? current.summary
      : ignoreSnapshotTopLevelResponse ? undefined : event.replaceActivity ? event.summary : event.summary || current.summary,
    lastMessageItemId: staleActivitySnapshot
      ? current.lastMessageItemId
      : ignoreSnapshotTopLevelResponse ? undefined : event.lastMessageItemId || current.lastMessageItemId,
    error: staleActivitySnapshot ? current.error : event.error,
    currentTool: event.status === "idle" || event.status === "failed"
      ? undefined
      : staleActivitySnapshot
        ? current.currentTool
        : event.replaceActivity ? event.currentTool : event.currentTool || current.currentTool,
    toolCallsSinceLastMessage: staleActivitySnapshot
      ? current.toolCallsSinceLastMessage
      : event.toolCallsSinceLastMessage ?? (event.replaceActivity ? 0 : current.toolCallsSinceLastMessage),
    subAgents: staleActivitySnapshot
      ? current.subAgents
      : event.subAgents !== undefined ? event.subAgents : current.subAgents,
  }, {
    updatedAt: event.observedAt ?? current.updatedAt,
    meta,
    replaceActivity: Boolean(event.replaceActivity),
    clearError: Boolean(!staleActivitySnapshot && event.replaceActivity && event.status !== "failed"),
    suppressPromptTurn: !incomingTurns.length,
    suppressTurnUpdate: !incomingTurns.length,
    replaceTurns: Boolean(
      event.replaceActivity &&
      !staleActivitySnapshot &&
      incomingTurns.length === 0 &&
      !event.userPrompt &&
      !event.summary &&
      !event.lastMessage
    ),
  });
  return sameAiSessionBusinessState(current, next) ? current : next;
}
