import { shallowRef } from "vue";
import { mergeAiSessionTimelineItems, type AiSessionTimeline, type AiSessionTimelineItem, type AiSessionTimelineItemDeltaEvent, type AiSessionTimelineItemEvent, type AiSessionTimelineItemRevision, type AiSessionTimelineSyncRead, type AiSessionTimelineVersionedItem, type AiSessionTurn } from "@task-handoff/protocol/ai-sessions";

export type AiSessionTurnTimelineStatus = "idle" | "loading" | "ready" | "stale" | "error";
export type AiSessionTurnTimelineState = {
  status: AiSessionTurnTimelineStatus;
  items: AiSessionTimelineItem[];
  error?: string;
  revision?: string;
};

type TurnIdentity = Pick<AiSessionTurn, "id" | "providerTurnId"> & Partial<Pick<AiSessionTurn, "revision" | "status">>;
type StoredTurnTimelineState = AiSessionTurnTimelineState & {
  instanceId: string;
  sessionId: string;
  identities: string[];
  turnRevision?: number;
};
type SessionTimelineState = { status: AiSessionTurnTimelineStatus; error?: string; revision?: string };
type TimelineSyncDelta = Extract<AiSessionTimelineSyncRead, { kind: "delta" }>;
type LiveTurnTimeline = {
  instanceId: string;
  sessionId: string;
  turnId: string;
  events: Map<string, AiSessionTimelineItemEvent>;
  evictedItemIds: Set<string>;
};

const liveTurns = new Map<string, LiveTurnTimeline>();
const liveTurnKeysBySession = new Map<string, Set<string>>();
const turnStates = new Map<string, StoredTurnTimelineState>();
const sessionStates = new Map<string, SessionTimelineState>();
const sessionTimelineOrder = new Map<string, string[]>();
const timelineItemRevisions = new Map<string, Map<string, string>>();
const pendingDeltas = new Map<string, AiSessionTimelineItemDeltaEvent>();
const revision = shallowRef(0);
const recoveryRevision = shallowRef(0);
const sessionKey = (instanceId: string, sessionId: string) => JSON.stringify([instanceId, sessionId]);
const turnKey = (instanceId: string, sessionId: string, turnId: string) => `${sessionKey(instanceId, sessionId)}\u0000${turnId}`;
const MAX_CACHED_TURNS = 500;
const MAX_CACHED_SESSIONS = 250;
const MAX_LIVE_ITEMS_PER_TURN = 500;
const MAX_PENDING_DELTAS = 500;
const MAX_ACTIVITY_OUTPUT_LENGTH = 1_000_000;

function itemKey(instanceId: string, sessionId: string, turnId: string, itemId: string) {
  return `${turnKey(instanceId, sessionId, turnId)}\u0000${itemId}`;
}

function turnIdentities(turn: TurnIdentity) {
  return [...new Set([turn.id, turn.providerTurnId].filter((value): value is string => Boolean(value)))];
}

function revisionMap(instanceId: string, sessionId: string) {
  const key = sessionKey(instanceId, sessionId);
  let revisions = timelineItemRevisions.get(key);
  if (!revisions) {
    revisions = new Map();
    timelineItemRevisions.set(key, revisions);
  }
  return revisions;
}

function applyVersionedItemRevisions(instanceId: string, sessionId: string, items: readonly AiSessionTimelineVersionedItem[], removedIds: readonly string[] = []) {
  const revisions = revisionMap(instanceId, sessionId);
  for (const entry of items) revisions.set(entry.item.id, entry.revision);
  for (const id of removedIds) revisions.delete(id);
}

function replaceVersionedItemRevisions(instanceId: string, sessionId: string, items: readonly AiSessionTimelineVersionedItem[]) {
  const revisions = revisionMap(instanceId, sessionId);
  revisions.clear();
  for (const entry of items) revisions.set(entry.item.id, entry.revision);
}

function sessionStoredItems(instanceId: string, sessionId: string) {
  const byId = new Map<string, AiSessionTimelineItem>();
  for (const state of turnStates.values()) {
    if (state.instanceId !== instanceId || state.sessionId !== sessionId) continue;
    for (const item of state.items) byId.set(item.id, item);
  }
  return byId;
}

function knownSessionTimelineItems(instanceId: string, sessionId: string, turns: readonly AiSessionTurn[]): AiSessionTimelineItemRevision[] {
  const revisions = revisionMap(instanceId, sessionId);
  const available = sessionStoredItems(instanceId, sessionId);
  const storedOrder = sessionTimelineOrder.get(sessionKey(instanceId, sessionId));
  const ids = storedOrder || turns.flatMap((turn) => {
    const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
    return state?.items.map((item) => item.id) || [];
  });
  const known: AiSessionTimelineItemRevision[] = [];
  for (const id of ids) {
    const revision = revisions.get(id);
    if (!revision || !available.has(id)) continue;
    known.push({ id, revision });
  }
  // The sync request is intentionally bounded. A Timeline too large for the
  // cursor gets one snapshot rather than an unbounded request body.
  return known.length > 10_000 ? [] : known;
}

function knownTurnTimelineItems(instanceId: string, sessionId: string, turn: TurnIdentity): AiSessionTimelineItemRevision[] {
  const revisions = revisionMap(instanceId, sessionId);
  const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  if (!state) return [];
  const known: AiSessionTimelineItemRevision[] = [];
  for (const item of state.items) {
    const revision = revisions.get(item.id);
    if (revision) known.push({ id: item.id, revision });
  }
  return known.length > 10_000 ? [] : known;
}

function timelineOrderAfterDelta(previousOrder: readonly string[], delta: TimelineSyncDelta) {
  if (delta.order) return delta.order;
  const removed = new Set(delta.removed);
  const order = previousOrder.filter((id) => !removed.has(id));
  const seen = new Set(order);
  for (const entry of delta.upserted) {
    if (seen.has(entry.item.id)) continue;
    seen.add(entry.item.id);
    order.push(entry.item.id);
  }
  return order;
}

function storedSessionOrder(instanceId: string, sessionId: string, turns: readonly AiSessionTurn[]) {
  return sessionTimelineOrder.get(sessionKey(instanceId, sessionId)) || turns.flatMap((turn) => (
    turnStates.get(turnKey(instanceId, sessionId, turn.id))?.items.map((item) => item.id) || []
  ));
}

function removeLiveTurn(key: string) {
  const bucket = liveTurns.get(key);
  if (!bucket) return;
  liveTurns.delete(key);
  const keySet = liveTurnKeysBySession.get(sessionKey(bucket.instanceId, bucket.sessionId));
  keySet?.delete(key);
  if (!keySet?.size) liveTurnKeysBySession.delete(sessionKey(bucket.instanceId, bucket.sessionId));
}

function liveItemsForTurn(instanceId: string, sessionId: string, identities: readonly string[]) {
  const result: AiSessionTimelineItem[] = [];
  for (const identity of identities) {
    const bucket = liveTurns.get(turnKey(instanceId, sessionId, identity));
    if (bucket) result.push(...[...bucket.events.values()].map((event) => event.item));
  }
  return result;
}

function clearLiveTurn(instanceId: string, sessionId: string, identities: readonly string[]) {
  for (const identity of identities) removeLiveTurn(turnKey(instanceId, sessionId, identity));
}

function apply(event: AiSessionTimelineItemEvent) {
  const key = turnKey(event.instanceId, event.sessionId, event.item.turnId);
  let bucket = liveTurns.get(key);
  if (!bucket) {
    bucket = {
      instanceId: event.instanceId,
      sessionId: event.sessionId,
      turnId: event.item.turnId,
      events: new Map(),
      evictedItemIds: new Set(),
    };
    liveTurnKeysBySession.set(
      sessionKey(event.instanceId, event.sessionId),
      (liveTurnKeysBySession.get(sessionKey(event.instanceId, event.sessionId)) || new Set()).add(key),
    );
  }
  if (bucket.evictedItemIds.has(event.item.id)) return;
  const pendingKey = itemKey(event.instanceId, event.sessionId, event.item.turnId, event.item.id);
  const pending = pendingDeltas.get(pendingKey);
  const combinedOutput = pending && event.item.type === "activity" && pending.field === "output"
    ? `${event.item.output || ""}${pending.delta}`
    : undefined;
  const item = combinedOutput !== undefined && combinedOutput.length <= MAX_ACTIVITY_OUTPUT_LENGTH
    ? { ...event.item, output: combinedOutput }
    : event.item;
  pendingDeltas.delete(pendingKey);
  bucket.events.set(event.item.id, { ...event, item });
  while (bucket.events.size > MAX_LIVE_ITEMS_PER_TURN) {
    const oldestItemId = bucket.events.keys().next().value as string;
    bucket.events.delete(oldestItemId);
    bucket.evictedItemIds.add(oldestItemId);
    while (bucket.evictedItemIds.size > MAX_LIVE_ITEMS_PER_TURN) {
      bucket.evictedItemIds.delete(bucket.evictedItemIds.keys().next().value as string);
    }
  }
  liveTurns.delete(key);
  liveTurns.set(key, bucket);
  while (liveTurns.size > MAX_CACHED_TURNS) removeLiveTurn(liveTurns.keys().next().value as string);
  revision.value += 1;
}

function applyDelta(event: AiSessionTimelineItemDeltaEvent) {
  const key = turnKey(event.instanceId, event.sessionId, event.turnId);
  const current = liveTurns.get(key)?.events.get(event.itemId);
  const stored = [...turnStates.values()]
    .filter((state) => state.instanceId === event.instanceId && state.sessionId === event.sessionId && state.identities.includes(event.turnId))
    .flatMap((state) => state.items)
    .find((item) => item.id === event.itemId);
  const activity = current?.item.type === "activity"
    ? current.item
    : stored?.type === "activity"
      ? stored
      : undefined;
  if (activity) {
    const output = `${activity.output || ""}${event.delta}`;
    if (output.length > MAX_ACTIVITY_OUTPUT_LENGTH) return false;
    pendingDeltas.delete(itemKey(event.instanceId, event.sessionId, event.turnId, event.itemId));
    apply({
      instanceId: event.instanceId,
      sessionId: event.sessionId,
      providerSessionId: event.providerSessionId || "",
      generatedAt: event.generatedAt,
      item: { ...activity, output },
    });
    return true;
  }
  const pendingKey = itemKey(event.instanceId, event.sessionId, event.turnId, event.itemId);
  const pending = pendingDeltas.get(pendingKey);
  const delta = `${pending?.delta || ""}${event.delta}`;
  if (delta.length > MAX_ACTIVITY_OUTPUT_LENGTH) return false;
  pendingDeltas.set(pendingKey, { ...event, delta });
  while (pendingDeltas.size > MAX_PENDING_DELTAS) pendingDeltas.delete(pendingDeltas.keys().next().value as string);
  return true;
}

function items(instanceId: string, sessionId: string) {
  void revision.value;
  const result: AiSessionTimelineItem[] = [];
  for (const key of liveTurnKeysBySession.get(sessionKey(instanceId, sessionId)) || []) {
    const bucket = liveTurns.get(key);
    if (bucket) result.push(...[...bucket.events.values()].map((event) => event.item));
  }
  return result;
}

function turnState(instanceId: string, sessionId: string, turn: TurnIdentity): AiSessionTurnTimelineState {
  void revision.value;
  const stored = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  const liveItems = liveItemsForTurn(instanceId, sessionId, turnIdentities(turn));
  // Active turns receive live timeline item events and can advance their
  // revision for every item. Their cached history must not be reloaded on each
  // event; the final completed/failed revision is reconciled once the turn is
  // no longer active.
  const active = turn.status === "queued" || turn.status === "running" || turn.status === "waiting";
  const stale = !active && stored?.turnRevision !== undefined && turn.revision !== undefined && stored.turnRevision !== turn.revision;
  return {
    status: stale ? "stale" : stored?.status || "idle",
    items: mergeAiSessionTimelineItems(stored?.items || [], liveItems),
    ...(stored?.error ? { error: stored.error } : {}),
    ...(stored?.revision ? { revision: stored.revision } : {}),
  };
}

function realtimeTurnState(instanceId: string, sessionId: string, turn: TurnIdentity): AiSessionTurnTimelineState {
  void revision.value;
  return {
    status: "ready",
    items: liveItemsForTurn(instanceId, sessionId, turnIdentities(turn)),
  };
}

function setTurnState(instanceId: string, sessionId: string, turn: TurnIdentity, state: AiSessionTurnTimelineState) {
  const key = turnKey(instanceId, sessionId, turn.id);
  const existing = turnStates.get(key);
  if (storedTurnRevisionIsNewer(existing, turn)) return false;
  turnStates.delete(key);
  turnStates.set(key, {
    ...state,
    instanceId,
    sessionId,
    identities: turnIdentities(turn),
    ...(turn.revision !== undefined ? { turnRevision: turn.revision } : {}),
  });
  while (turnStates.size > MAX_CACHED_TURNS) {
    const oldestKey = turnStates.keys().next().value as string;
    turnStates.delete(oldestKey);
  }
  revision.value += 1;
  return true;
}

function storedTurnRevisionIsNewer(existing: StoredTurnTimelineState | undefined, turn: TurnIdentity) {
  return existing?.turnRevision !== undefined && turn.revision !== undefined && existing.turnRevision > turn.revision;
}

function beginTurnLoad(instanceId: string, sessionId: string, turn: TurnIdentity) {
  const existing = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  setTurnState(instanceId, sessionId, turn, {
    status: "loading",
    items: existing?.items || [],
    ...(existing?.revision ? { revision: existing.revision } : {}),
  });
}

function resolveTurn(instanceId: string, sessionId: string, turn: TurnIdentity, turnItems: readonly AiSessionTimelineItem[], timelineRevision?: string) {
  if (storedTurnRevisionIsNewer(turnStates.get(turnKey(instanceId, sessionId, turn.id)), turn)) return false;
  const identities = turnIdentities(turn);
  const merged = mergeAiSessionTimelineItems(turnItems, liveItemsForTurn(instanceId, sessionId, identities));
  clearLiveTurn(instanceId, sessionId, identities);
  const resolved = setTurnState(instanceId, sessionId, turn, {
    status: "ready",
    items: merged,
    ...(timelineRevision ? { revision: timelineRevision } : {}),
  });
  if (resolved) {
    for (const delta of [...pendingDeltas.values()]) {
      if (delta.instanceId === instanceId && delta.sessionId === sessionId && identities.includes(delta.turnId)) applyDelta(delta);
    }
  }
  return resolved;
}

function resolveTurnNotModified(instanceId: string, sessionId: string, turn: TurnIdentity, timelineRevision: string) {
  const existing = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  return setTurnState(instanceId, sessionId, turn, {
    status: "ready",
    items: existing?.items || [],
    revision: timelineRevision,
  });
}

function rejectTurn(instanceId: string, sessionId: string, turn: TurnIdentity, error: string) {
  const existing = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  setTurnState(instanceId, sessionId, turn, {
    status: "error",
    items: existing?.items || [],
    error,
    ...(existing?.revision ? { revision: existing.revision } : {}),
  });
}

function sessionState(instanceId: string, sessionId: string): SessionTimelineState {
  void revision.value;
  return sessionStates.get(sessionKey(instanceId, sessionId)) || { status: "idle" };
}

function setSessionState(instanceId: string, sessionId: string, state: SessionTimelineState) {
  const key = sessionKey(instanceId, sessionId);
  sessionStates.delete(key);
  sessionStates.set(key, state);
  while (sessionStates.size > MAX_CACHED_SESSIONS) sessionStates.delete(sessionStates.keys().next().value as string);
  revision.value += 1;
}

function beginSessionLoad(instanceId: string, sessionId: string) {
  const existing = sessionStates.get(sessionKey(instanceId, sessionId));
  setSessionState(instanceId, sessionId, {
    status: "loading",
    ...(existing?.revision ? { revision: existing.revision } : {}),
  });
}

function resolveSession(instanceId: string, sessionId: string, turns: readonly AiSessionTurn[], timeline: AiSessionTimeline, timelineRevision?: string) {
  for (const turn of turns) {
    const identities = new Set(turnIdentities(turn));
    resolveTurn(instanceId, sessionId, turn, timeline.items.filter((item) => identities.has(item.turnId)), timelineRevision);
  }
  setSessionState(instanceId, sessionId, {
    status: "ready",
    ...(timelineRevision ? { revision: timelineRevision } : {}),
  });
}

function resolveSessionNotModified(instanceId: string, sessionId: string, turns: readonly AiSessionTurn[], timelineRevision: string) {
  setSessionState(instanceId, sessionId, { status: "ready", revision: timelineRevision });
  for (const turn of turns) {
    const key = turnKey(instanceId, sessionId, turn.id);
    const state = turnStates.get(key);
    if (!state) continue;
    turnStates.set(key, {
      ...state,
      status: "ready",
      revision: timelineRevision,
      error: undefined,
      ...(turn.revision !== undefined ? { turnRevision: turn.revision } : {}),
    });
  }
  revision.value += 1;
}

function resolveSessionSyncSnapshot(
  instanceId: string,
  sessionId: string,
  turns: readonly AiSessionTurn[],
  items: readonly AiSessionTimelineVersionedItem[],
  timelineRevision: string,
) {
  replaceVersionedItemRevisions(instanceId, sessionId, items);
  sessionTimelineOrder.set(sessionKey(instanceId, sessionId), items.map((entry) => entry.item.id));
  for (const turn of turns) {
    const identities = new Set(turnIdentities(turn));
    resolveTurn(instanceId, sessionId, turn, items.filter((entry) => identities.has(entry.item.turnId)).map((entry) => entry.item), timelineRevision);
  }
  setSessionState(instanceId, sessionId, { status: "ready", revision: timelineRevision });
}

function applySessionSyncDelta(
  instanceId: string,
  sessionId: string,
  turns: readonly AiSessionTurn[],
  delta: TimelineSyncDelta,
) {
  applyVersionedItemRevisions(instanceId, sessionId, delta.upserted, delta.removed);
  const order = timelineOrderAfterDelta(storedSessionOrder(instanceId, sessionId, turns), delta);
  sessionTimelineOrder.set(sessionKey(instanceId, sessionId), order);

  const ownerById = new Map<string, AiSessionTurn>();
  for (const turn of turns) {
    const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
    for (const item of state?.items || []) ownerById.set(item.id, turn);
  }
  const upsertedById = new Map<string, AiSessionTimelineItem>();
  const upsertedByTurn = new Map<string, Map<string, AiSessionTimelineItem>>();
  for (const entry of delta.upserted) {
    const turn = turns.find((candidate) => turnIdentities(candidate).includes(entry.item.turnId));
    upsertedById.set(entry.item.id, entry.item);
    if (!turn) continue;
    ownerById.set(entry.item.id, turn);
    const bucket = upsertedByTurn.get(turn.id) || new Map<string, AiSessionTimelineItem>();
    bucket.set(entry.item.id, entry.item);
    upsertedByTurn.set(turn.id, bucket);
  }

  const affected = new Set<string>();
  for (const id of delta.removed) {
    const owner = ownerById.get(id);
    if (owner) affected.add(owner.id);
  }
  for (const entry of delta.upserted) {
    const owner = ownerById.get(entry.item.id);
    if (owner) affected.add(owner.id);
  }

  const ownerKeyById = new Map<string, string>();
  for (const [id, turn] of ownerById) ownerKeyById.set(id, turn.id);
  for (const turn of turns) {
    const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
    const expectedIds = order.filter((id) => ownerKeyById.get(id) === turn.id);
    const currentIds = state?.items.map((item) => item.id) || [];
    if (expectedIds.length !== currentIds.length || expectedIds.some((id, index) => id !== currentIds[index])) {
      affected.add(turn.id);
    }
  }

  for (const turn of turns) {
    if (!affected.has(turn.id)) continue;
    const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
    const existingById = new Map((state?.items || []).map((item) => [item.id, item]));
    const upserted = upsertedByTurn.get(turn.id);
    const expectedIds = order.filter((id) => ownerKeyById.get(id) === turn.id);
    const nextItems = expectedIds
      .map((id) => upserted?.get(id) || upsertedById.get(id) || existingById.get(id))
      .filter((item): item is AiSessionTimelineItem => Boolean(item));
    resolveTurn(instanceId, sessionId, turn, nextItems, delta.revision);
  }
  // The session delta is authoritative for every item, including Turns whose
  // item set did not change. Reconcile their Turn metadata without replacing
  // cached items or forcing another body read on the next render.
  for (const turn of turns) {
    if (affected.has(turn.id)) continue;
    const key = turnKey(instanceId, sessionId, turn.id);
    const state = turnStates.get(key);
    if (!state) continue;
    const identities = turnIdentities(turn);
    const turnRevision = turn.revision;
    if (
      state.status === "ready"
      && state.revision === delta.revision
      && state.error === undefined
      && sameStrings(state.identities, identities)
      && (turnRevision === undefined || state.turnRevision === turnRevision)
    ) continue;
    turnStates.delete(key);
    turnStates.set(key, {
      ...state,
      status: "ready",
      revision: delta.revision,
      error: undefined,
      identities,
      ...(turnRevision !== undefined ? { turnRevision } : {}),
    });
  }
  setSessionState(instanceId, sessionId, { status: "ready", revision: delta.revision });
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveTurnSyncSnapshot(
  instanceId: string,
  sessionId: string,
  turn: TurnIdentity,
  items: readonly AiSessionTimelineVersionedItem[],
  timelineRevision: string,
) {
  const revisions = revisionMap(instanceId, sessionId);
  const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  for (const item of state?.items || []) revisions.delete(item.id);
  for (const entry of items) revisions.set(entry.item.id, entry.revision);
  resolveTurn(instanceId, sessionId, turn, items.map((entry) => entry.item), timelineRevision);
}

function applyTurnSyncDelta(instanceId: string, sessionId: string, turn: TurnIdentity, delta: TimelineSyncDelta) {
  applyVersionedItemRevisions(instanceId, sessionId, delta.upserted, delta.removed);
  const state = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  const existingById = new Map((state?.items || []).map((item) => [item.id, item]));
  const upsertedById = new Map(delta.upserted.map((entry) => [entry.item.id, entry.item]));
  const nextItems = timelineOrderAfterDelta(state?.items.map((item) => item.id) || [], delta)
    .map((id) => upsertedById.get(id) || existingById.get(id))
    .filter((item): item is AiSessionTimelineItem => Boolean(item));
  resolveTurn(instanceId, sessionId, turn, nextItems, delta.revision);
}

function rejectSession(instanceId: string, sessionId: string, error: string) {
  const existing = sessionStates.get(sessionKey(instanceId, sessionId));
  setSessionState(instanceId, sessionId, {
    status: "error",
    error,
    ...(existing?.revision ? { revision: existing.revision } : {}),
  });
}

function cleanupInstance(instanceId: string) {
  for (const [key, bucket] of liveTurns) if (bucket.instanceId === instanceId) removeLiveTurn(key);
  for (const [key, state] of turnStates) if (state.instanceId === instanceId) turnStates.delete(key);
  for (const key of sessionStates.keys()) {
    const [storedInstanceId] = JSON.parse(key) as [string, string];
    if (storedInstanceId !== instanceId) continue;
    sessionStates.delete(key);
    sessionTimelineOrder.delete(key);
    timelineItemRevisions.delete(key);
  }
  for (const [key, event] of pendingDeltas) if (event.instanceId === instanceId) pendingDeltas.delete(key);
  revision.value += 1;
}

function recoverConnection() {
  liveTurns.clear();
  liveTurnKeysBySession.clear();
  pendingDeltas.clear();
  for (const [key, state] of turnStates) {
    if (state.status === "ready" || state.status === "loading") turnStates.set(key, { ...state, status: "stale" });
  }
  for (const [key, state] of sessionStates) {
    if (state.status === "ready" || state.status === "loading") sessionStates.set(key, { ...state, status: "stale" });
  }
  revision.value += 1;
  recoveryRevision.value += 1;
}

export function useAiSessionTimelineStore() {
  return {
    apply,
    applyDelta,
    applySessionSyncDelta,
    applyTurnSyncDelta,
    beginSessionLoad,
    beginTurnLoad,
    cleanupInstance,
    items,
    knownSessionTimelineItems,
    knownTurnTimelineItems,
    recoverConnection,
    recoveryRevision,
    rejectSession,
    rejectTurn,
    resolveSessionSyncSnapshot,
    resolveSessionNotModified,
    realtimeTurnState,
    resolveSession,
    resolveTurn,
    resolveTurnSyncSnapshot,
    resolveTurnNotModified,
    revision,
    sessionState,
    turnState,
  };
}
