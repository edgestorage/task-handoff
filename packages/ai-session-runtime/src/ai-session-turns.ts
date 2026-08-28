import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AiSessionConversationAttachmentSchema } from "@task-handoff/protocol/ai-sessions";
import type {
  AiSessionPhase,
  AiSessionSnapshotInput,
  AiSessionSource,
  AiSessionStatus,
  AiSessionUserMessageDetail,
} from "@task-handoff/protocol/ai-sessions";

export function compact(value: unknown, max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function messageText(value: unknown) {
  return String(value ?? "").trim();
}

const SOURCE_PRIORITY: Record<AiSessionSource, number> = {
  control: 90,
  realtime: 80,
  "adapter-snapshot": 60,
  "transcript-tail": 50,
  "app-session": 40,
  "process-scan": 30,
  "transcript-scan": 20,
};

export function sourcePriority(source?: AiSessionSource, override?: number) {
  return Math.max(0, Math.min(100, Number.isInteger(override) ? Number(override) : source ? SOURCE_PRIORITY[source] : 0));
}

export function turnMeta(input: {
  source?: AiSessionSource;
  sourcePriority?: number;
  providerTurnId?: string;
  snapshotVersion?: number;
  observedAt?: string;
}) {
  const meta: Partial<Pick<NonNullable<AiSessionStatus["turns"]>[number], "source" | "sourcePriority" | "providerTurnId" | "snapshotVersion" | "observedAt">> = {};
  if (input.source) {
    meta.source = input.source;
    meta.sourcePriority = sourcePriority(input.source, input.sourcePriority);
  }
  if (input.providerTurnId) {
    meta.providerTurnId = compact(input.providerTurnId, 240);
  }
  if (Number.isInteger(input.snapshotVersion)) {
    meta.snapshotVersion = Number(input.snapshotVersion);
  }
  if (input.observedAt) {
    meta.observedAt = input.observedAt;
  }
  return meta;
}

export type TurnMeta = Partial<ReturnType<typeof turnMeta>>;

function normalizeContextCompactions(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map<string, NonNullable<NonNullable<AiSessionStatus["turns"]>[number]["contextCompactions"]>[number]>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim() || (record.status !== "running" && record.status !== "completed")) continue;
    const id = compact(record.id, 240);
    const previous = byId.get(id);
    const status = previous?.status === "completed" || record.status === "completed" ? "completed" : "running";
    const startedAt = normalizeIsoTimestamp(record.startedAt) || previous?.startedAt;
    const completedAt = normalizeIsoTimestamp(record.completedAt) || previous?.completedAt;
    byId.set(id, {
      id,
      status,
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    });
  }
  const values = [...byId.values()].slice(-20);
  return values.length ? values : undefined;
}

function normalizeIsoTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeUserMessages(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const messages = new Map<string, AiSessionUserMessageDetail>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<AiSessionUserMessageDetail>;
    if (!record.id || typeof record.id !== "string" || typeof record.text !== "string") continue;
    const attachments = Array.isArray(record.attachments)
      ? record.attachments.flatMap((attachment) => {
        if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return [];
        const candidate = attachment as Record<string, unknown>;
        const parsed = AiSessionConversationAttachmentSchema.safeParse({
          id: candidate.id,
          kind: candidate.kind,
          name: candidate.name,
          mime: candidate.mime,
          size: candidate.size,
          ...(candidate.contentState !== undefined ? { contentState: candidate.contentState } : {}),
        });
        return parsed.success ? [parsed.data] : [];
      }).slice(0, 6)
      : [];
    const message = { id: compact(record.id, 240), text: messageText(record.text), attachments };
    const existing = messages.get(message.id);
    // Attachment-bearing controlled events are higher fidelity than transcript
    // events that only know the message text.
    messages.set(message.id, existing && existing.attachments.length > message.attachments.length ? existing : message);
  }
  const normalized = [...messages.values()].slice(-100);
  return normalized.length ? normalized : undefined;
}

function mergeUserMessages(
  current: NonNullable<AiSessionStatus["turns"]>[number]["userMessages"],
  incoming: NonNullable<AiSessionStatus["turns"]>[number]["userMessages"],
) {
  return normalizeUserMessages([...(current || []), ...(incoming || [])]);
}

function mergeContextCompactions(
  current: NonNullable<AiSessionStatus["turns"]>[number]["contextCompactions"],
  incoming: NonNullable<AiSessionStatus["turns"]>[number]["contextCompactions"],
) {
  return normalizeContextCompactions([...(current || []), ...(incoming || [])]);
}

function hasContextCompactionProgress(
  existing: NonNullable<AiSessionStatus["turns"]>[number] | undefined,
  incoming: NonNullable<AiSessionStatus["turns"]>[number],
) {
  const currentById = new Map((existing?.contextCompactions || []).map((item) => [item.id, item.status]));
  return (incoming.contextCompactions || []).some((item) => !currentById.has(item.id) || currentById.get(item.id) === "running" && item.status === "completed");
}

function stableTurnPart(value: unknown) {
  const text = compact(value, 120);
  const slug = text.replace(/[^a-zA-Z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 10);
  return slug ? `${slug}_${hash}` : hash;
}

function generatedTurnId() {
  return `turn_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function stableGeneratedTurnId(prompt: string, seed: string) {
  return `turn_${stableTurnPart(prompt)}_${stableTurnPart(seed)}`;
}

export function transcriptTurnId(prompt: string, seed?: string, occurrence = 1) {
  return stableGeneratedTurnId(prompt, seed || `${prompt}:${occurrence}`);
}

function legacyTurnId(record: Partial<NonNullable<AiSessionStatus["turns"]>[number]>, index: number) {
  return `turn_legacy_${index}_${stableTurnPart(record.userPrompt || record.updatedAt || record.lastMessage || record.summary)}`;
}

export function normalizeTurns(values?: unknown[], meta: TurnMeta = {}) {
  const turns: NonNullable<AiSessionStatus["turns"]> = [];
  for (const [index, value] of (values || []).entries()) {
    const record = value && typeof value === "object" ? value as Partial<NonNullable<AiSessionStatus["turns"]>[number]> : undefined;
    if (!record) {
      continue;
    }
    const turn = {
      id: record.id ? compact(record.id, 240) : legacyTurnId(record, index),
      providerTurnId: record.providerTurnId ? compact(record.providerTurnId, 240) : meta.providerTurnId,
      source: record.source || meta.source,
      userPrompt: record.userPrompt ? messageText(record.userPrompt) : undefined,
      userMessages: normalizeUserMessages(record.userMessages),
      status: record.status || "completed",
      phase: record.phase,
      summary: record.summary ? compact(record.summary, 1000) : undefined,
      lastMessage: record.lastMessage ? messageText(record.lastMessage) : undefined,
      lastMessageItemId: record.lastMessageItemId ? compact(record.lastMessageItemId, 240) : undefined,
      contextCompactions: normalizeContextCompactions(record.contextCompactions),
      revision: Math.max(0, Number(record.revision) || 0),
      sourcePriority: Number.isInteger(record.sourcePriority) ? Number(record.sourcePriority) : meta.sourcePriority,
      snapshotVersion: Number.isInteger(record.snapshotVersion) ? Number(record.snapshotVersion) : meta.snapshotVersion,
      observedAt: record.observedAt || meta.observedAt,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
    };
    if (turn.userPrompt || turn.userMessages?.length || turn.summary || turn.lastMessage || turn.contextCompactions?.length) {
      turns.push(turn);
    }
  }
  return turns.slice(-50);
}

function shouldAcceptIncomingTurn(existing: NonNullable<AiSessionStatus["turns"]>[number] | undefined, incoming: NonNullable<AiSessionStatus["turns"]>[number]) {
  if (!existing) {
    return true;
  }
  if (hasContextCompactionProgress(existing, incoming)) {
    return true;
  }
  const existingPriority = sourcePriority(existing.source, existing.sourcePriority);
  const incomingPriority = sourcePriority(incoming.source, incoming.sourcePriority);
  if (incomingPriority !== existingPriority) {
    return incomingPriority > existingPriority || Boolean(incoming.lastMessage || incoming.summary) && !existing.lastMessage && !existing.summary;
  }
  const existingSnapshot = Number(existing.snapshotVersion) || 0;
  const incomingSnapshot = Number(incoming.snapshotVersion) || 0;
  if (incomingSnapshot !== existingSnapshot) {
    return incomingSnapshot > existingSnapshot;
  }
  return (incoming.revision || 0) >= (existing.revision || 0) || Date.parse(incoming.observedAt || incoming.updatedAt || "") >= Date.parse(existing.observedAt || existing.updatedAt || "");
}

function definedTurnPatch(turn: NonNullable<AiSessionStatus["turns"]>[number]) {
  return Object.fromEntries(Object.entries(turn).filter(([, value]) => value !== undefined)) as Partial<NonNullable<AiSessionStatus["turns"]>[number]>;
}

function mergeTurnPatch(
  existing: NonNullable<AiSessionStatus["turns"]>[number] | undefined,
  turn: NonNullable<AiSessionStatus["turns"]>[number],
) {
  const patch = definedTurnPatch(turn);
  patch.contextCompactions = mergeContextCompactions(existing?.contextCompactions, turn.contextCompactions);
  patch.userMessages = mergeUserMessages(existing?.userMessages, turn.userMessages);
  if (!existing) {
    return patch;
  }
  const sameResponse = existing.userPrompt === (turn.userPrompt ?? existing.userPrompt) &&
    existing.summary === (turn.summary ?? existing.summary) &&
    existing.lastMessage === (turn.lastMessage ?? existing.lastMessage) &&
    existing.lastMessageItemId === (turn.lastMessageItemId ?? existing.lastMessageItemId) &&
    JSON.stringify(existing.userMessages || []) === JSON.stringify(patch.userMessages || []) &&
    JSON.stringify(existing.contextCompactions || []) === JSON.stringify(patch.contextCompactions || []);
  const sameState = existing.status === (turn.status ?? existing.status) &&
    existing.phase === (turn.phase ?? existing.phase);
  if (sameResponse && sameState) {
    delete patch.observedAt;
    delete patch.updatedAt;
    delete patch.completedAt;
  }
  return patch;
}

function mergeTurns(current?: AiSessionStatus["turns"], next?: AiSessionStatus["turns"], meta: TurnMeta = {}) {
  const baseline = normalizeTurns(current);
  // Merge into detached turn records. If the normalized result is unchanged,
  // updateTurns returns the caller's original array to preserve structural
  // sharing without allowing this reducer to mutate it.
  const merged = baseline.map((turn) => ({ ...turn }));
  const incomingTurns = normalizeTurns(next, meta);
  function insertTurn(turn: NonNullable<AiSessionStatus["turns"]>[number], incomingIndex: number) {
    const previousKnown = incomingTurns.slice(0, incomingIndex).reverse().find((entry) => merged.some((turn) => turn.id === entry.id));
    if (previousKnown) {
      const previousIndex = merged.findIndex((entry) => entry.id === previousKnown.id);
      merged.splice(previousIndex + 1, 0, turn);
      return;
    }
    const nextKnown = incomingTurns.slice(incomingIndex + 1).find((entry) => merged.some((turn) => turn.id === entry.id));
    if (nextKnown) {
      const nextIndex = merged.findIndex((entry) => entry.id === nextKnown.id);
      merged.splice(nextIndex, 0, turn);
      return;
    }
    merged.push(turn);
  }
  for (const [incomingIndex, turn] of incomingTurns.entries()) {
    let mergedIntoPending = false;
    for (const [index, existing] of merged.entries()) {
      if (
        existing.id !== turn.id &&
        existing.userPrompt &&
        existing.userPrompt === turn.userPrompt &&
        !existing.lastMessage &&
        !existing.summary &&
        (turn.lastMessage || turn.summary)
      ) {
        const updated = {
          ...existing,
          ...mergeTurnPatch(existing, turn),
          id: existing.id,
          providerTurnId: turn.providerTurnId || turn.id,
          revision: Math.max(existing.revision || 0, turn.revision || 0),
        };
        if (shouldAcceptIncomingTurn(existing, updated)) {
          merged[index] = updated;
        }
        mergedIntoPending = true;
        break;
      }
    }
    if (mergedIntoPending) {
      continue;
    }
    const existingIndex = merged.findIndex((entry) => entry.id === turn.id);
    const existing = existingIndex >= 0 ? merged[existingIndex] : undefined;
    if (shouldAcceptIncomingTurn(existing, turn)) {
      const updated = { ...existing, ...mergeTurnPatch(existing, turn), revision: Math.max(existing?.revision || 0, turn.revision || 0) };
      if (existingIndex >= 0) {
        merged[existingIndex] = updated;
      } else {
        insertTurn(updated, incomingIndex);
      }
    }
  }
  return { turns: merged.slice(-50), baseline };
}

export function turnHasResponse(turn?: NonNullable<AiSessionStatus["turns"]>[number]) {
  return Boolean(turn?.lastMessage || turn?.summary);
}

export function currentActiveTurnIsPending(session: AiSessionStatus) {
  if (!session.activeTurnId || session.status !== "running") {
    return false;
  }
  const turn = normalizeTurns(session.turns).find((entry) => entry.id === session.activeTurnId);
  return Boolean(!turn || !turnHasResponse(turn));
}

export function snapshotMissingPendingActiveTurn(session: AiSessionStatus, incomingTurns: AiSessionStatus["turns"]) {
  if (!currentActiveTurnIsPending(session)) {
    return false;
  }
  const activeTurn = normalizeTurns(session.turns).find((turn) => turn.id === session.activeTurnId);
  return !normalizeTurns(incomingTurns).some((turn) =>
    turn.id === session.activeTurnId ||
    Boolean(
      activeTurn?.userPrompt &&
      turn.userPrompt === activeTurn.userPrompt &&
      turnHasResponse(turn) &&
      !turnHasResponse(activeTurn),
    )
  );
}

export function nextActiveTurnId(current: AiSessionStatus, event: Pick<AiSessionSnapshotInput, "activeTurnId" | "status">, staleActivitySnapshot: boolean) {
  if (staleActivitySnapshot) {
    return current.activeTurnId;
  }
  if (event.status === "idle" || event.status === "failed") {
    return undefined;
  }
  return event.activeTurnId ? compact(event.activeTurnId, 240) : current.activeTurnId;
}

export type TurnUpdatePatch = {
  activeTurnId?: AiSessionStatus["activeTurnId"];
  userPrompt?: AiSessionStatus["userPrompt"];
  turns?: AiSessionStatus["turns"];
  status?: AiSessionStatus["status"];
  phase?: AiSessionStatus["phase"];
  summary?: AiSessionStatus["summary"];
  lastMessage?: AiSessionStatus["lastMessage"];
  lastMessageItemId?: AiSessionStatus["lastMessageItemId"];
  completedAt?: AiSessionStatus["completedAt"];
  userMessage?: AiSessionUserMessageDetail;
};

function turnStatusFromSessionStatus(
  status: AiSessionStatus["status"] | undefined,
  fallback: NonNullable<AiSessionStatus["turns"]>[number]["status"] = "running",
) {
  if (status === "idle") return "completed";
  if (status === "waiting" || status === "failed" || status === "running") return status;
  return fallback;
}

export function updateTurns(
  current: AiSessionStatus["turns"],
  patch: TurnUpdatePatch,
  updatedAt: string,
  meta: TurnMeta = {},
) {
  const merged = mergeTurns(current, patch.turns, meta);
  const turns = merged.turns;
  const activeTurnId = patch.activeTurnId ? compact(patch.activeTurnId, 240) : "";
  const activeTurnPrompt = activeTurnId
    ? patch.turns?.find((turn) => turn.id === activeTurnId)?.userPrompt
    : undefined;
  const prompt = messageText(activeTurnPrompt || patch.userPrompt);
  if (prompt) {
    const last = turns.at(-1);
    const activeTurn = activeTurnId ? turns.find((turn) => turn.id === activeTurnId) : undefined;
    const promptTurn = activeTurn || [...turns].reverse().find((turn) => turn.userPrompt === prompt && !turn.lastMessage && !turn.summary);
    const promptAlreadyRepresented = Boolean(patch.turns?.some((turn) => turn.userPrompt && messageText(turn.userPrompt) === prompt));
    if (promptTurn) {
      if (activeTurnId && promptTurn.id !== activeTurnId) {
        promptTurn.id = activeTurnId;
      }
      promptTurn.userPrompt = prompt;
      promptTurn.updatedAt = updatedAt;
      promptTurn.status = turnStatusFromSessionStatus(patch.status);
      promptTurn.phase = (patch.phase as AiSessionPhase | undefined) || promptTurn.phase || "thinking";
      Object.assign(promptTurn, meta);
      promptTurn.revision += 1;
    } else if (last && !last.lastMessage && !last.summary && last.userPrompt === prompt) {
      last.updatedAt = updatedAt;
      last.status = turnStatusFromSessionStatus(patch.status);
      last.phase = (patch.phase as AiSessionPhase | undefined) || last.phase || "thinking";
      Object.assign(last, meta);
      last.revision += 1;
    } else if (!promptAlreadyRepresented) {
      turns.push({
        id: activeTurnId || stableGeneratedTurnId(prompt, updatedAt),
        ...meta,
        userPrompt: prompt,
        status: turnStatusFromSessionStatus(patch.status),
        phase: (patch.phase as AiSessionPhase | undefined) || "thinking",
        revision: 0,
        startedAt: updatedAt,
        updatedAt,
      });
    }
  }
  if (patch.userMessage) {
    let messageTurn = activeTurnId ? turns.find((turn) => turn.id === activeTurnId) : turns.at(-1);
    if (!messageTurn) {
      messageTurn = {
        id: activeTurnId || stableGeneratedTurnId(patch.userMessage.text, updatedAt),
        ...meta,
        userPrompt: messageText(patch.userMessage.text) || undefined,
        status: patch.status === "waiting" ? "waiting" : "running",
        phase: (patch.phase as AiSessionPhase | undefined) || "thinking",
        revision: 0,
        startedAt: updatedAt,
        updatedAt,
      };
      turns.push(messageTurn);
    }
    const mergedMessages = mergeUserMessages(messageTurn.userMessages, [patch.userMessage]);
    if (JSON.stringify(messageTurn.userMessages || []) !== JSON.stringify(mergedMessages || [])) {
      messageTurn.userMessages = mergedMessages;
      messageTurn.revision += 1;
      messageTurn.updatedAt = updatedAt;
    }
  }
  if (patch.lastMessage || patch.summary) {
    let last = activeTurnId ? turns.find((turn) => turn.id === activeTurnId) : turns.at(-1);
    if (!last && activeTurnId) {
      const latestPromptTurn = [...turns].reverse().find((turn) => turn.userPrompt && !turn.lastMessage && !turn.summary);
      if (latestPromptTurn) {
        latestPromptTurn.id = activeTurnId;
        last = latestPromptTurn;
      }
    }
    if (!last && activeTurnId) {
      last = {
        id: activeTurnId,
        ...meta,
        status: patch.status === "waiting" ? "waiting" : patch.status === "failed" ? "failed" : "running",
        phase: (patch.phase as AiSessionPhase | undefined) || "unknown",
        revision: 0,
        startedAt: updatedAt,
        updatedAt,
      };
      turns.push(last);
    }
    const response = {
      summary: patch.summary ? compact(patch.summary, 1000) : last?.summary,
      lastMessage: patch.lastMessage ? messageText(patch.lastMessage) : last?.lastMessage,
      lastMessageItemId: patch.lastMessageItemId ? compact(patch.lastMessageItemId, 240) : last?.lastMessageItemId,
      status: patch.status === "idle" ? "completed" : patch.status === "waiting" ? "waiting" : patch.status === "failed" ? "failed" : last?.status || "running",
      phase: (patch.phase as AiSessionPhase | undefined) || last?.phase,
      updatedAt,
      completedAt: patch.completedAt || (patch.status === "idle" || patch.status === "failed" ? updatedAt : last?.completedAt),
      ...meta,
    };
    if (last) {
      const isSameResponse = last.summary === response.summary &&
        last.lastMessage === response.lastMessage &&
        last.lastMessageItemId === response.lastMessageItemId;
      const isSameState = last.status === response.status && last.phase === response.phase;
      const stableResponse = isSameResponse && isSameState;
      Object.assign(last, {
        ...response,
        observedAt: stableResponse ? last.observedAt : response.observedAt,
        updatedAt: stableResponse || isSameResponse ? last.updatedAt : response.updatedAt,
        completedAt: stableResponse ? last.completedAt : response.completedAt,
      });
      if (!isSameResponse || !isSameState) {
        last.revision += 1;
      }
    } else {
      turns.push({
        id: generatedTurnId(),
        ...response,
        status: response.status || "running",
        revision: 0,
        startedAt: updatedAt,
      });
    }
  } else if (patch.status || patch.phase) {
    const last = activeTurnId
      ? turns.find((turn) => turn.id === activeTurnId)
      : patch.status === "idle" || patch.status === "failed"
        ? turns.at(-1)
        : undefined;
    if (last) {
      const status = turnStatusFromSessionStatus(patch.status, last.status);
      const phase = (patch.phase as AiSessionPhase | undefined) || last.phase;
      const completedAt = patch.status === "idle" || patch.status === "failed" ? updatedAt : last.completedAt;
      const changed = last.status !== status || last.phase !== phase || last.completedAt !== completedAt;
      Object.assign(last, { status, phase, completedAt, updatedAt: changed ? updatedAt : last.updatedAt, ...meta });
      if (changed) {
        last.revision += 1;
      }
    }
  }
  if ((patch.status === "running" || patch.status === "waiting") && activeTurnId) {
    const activeIndex = turns.findIndex((turn) => turn.id === activeTurnId);
    if (activeIndex >= 0 && activeIndex !== turns.length - 1) {
      const [activeTurn] = turns.splice(activeIndex, 1);
      turns.push(activeTurn);
    }
  }
  const normalized = normalizeTurns(turns);
  return isDeepStrictEqual(normalized, merged.baseline)
    ? current ?? merged.baseline
    : normalized;
}
