import { shallowRef } from "vue";
import { mergeAiSessionTimelineItems, type AiSessionTimeline, type AiSessionTimelineItem, type AiSessionTimelineItemEvent, type AiSessionTurn } from "@task-handoff/protocol/ai-sessions";

export type AiSessionTurnTimelineStatus = "idle" | "loading" | "ready" | "stale" | "error";
export type AiSessionTurnTimelineState = {
  status: AiSessionTurnTimelineStatus;
  items: AiSessionTimelineItem[];
  error?: string;
};

type TurnIdentity = Pick<AiSessionTurn, "id" | "providerTurnId"> & Partial<Pick<AiSessionTurn, "revision" | "status">>;
type StoredTurnTimelineState = AiSessionTurnTimelineState & {
  instanceId: string;
  sessionId: string;
  identities: string[];
  turnRevision?: number;
};
type SessionTimelineState = { status: AiSessionTurnTimelineStatus; error?: string };
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
const revision = shallowRef(0);
const recoveryRevision = shallowRef(0);
const sessionKey = (instanceId: string, sessionId: string) => JSON.stringify([instanceId, sessionId]);
const turnKey = (instanceId: string, sessionId: string, turnId: string) => `${sessionKey(instanceId, sessionId)}\u0000${turnId}`;
const MAX_CACHED_TURNS = 500;
const MAX_CACHED_SESSIONS = 250;
const MAX_LIVE_ITEMS_PER_TURN = 500;

function turnIdentities(turn: TurnIdentity) {
  return [...new Set([turn.id, turn.providerTurnId].filter((value): value is string => Boolean(value)))];
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
  bucket.events.set(event.item.id, event);
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
  });
}

function resolveTurn(instanceId: string, sessionId: string, turn: TurnIdentity, turnItems: readonly AiSessionTimelineItem[]) {
  if (storedTurnRevisionIsNewer(turnStates.get(turnKey(instanceId, sessionId, turn.id)), turn)) return false;
  const identities = turnIdentities(turn);
  const merged = mergeAiSessionTimelineItems(turnItems, liveItemsForTurn(instanceId, sessionId, identities));
  clearLiveTurn(instanceId, sessionId, identities);
  return setTurnState(instanceId, sessionId, turn, { status: "ready", items: merged });
}

function rejectTurn(instanceId: string, sessionId: string, turn: TurnIdentity, error: string) {
  const existing = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  setTurnState(instanceId, sessionId, turn, {
    status: "error",
    items: existing?.items || [],
    error,
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
  setSessionState(instanceId, sessionId, { status: "loading" });
}

function resolveSession(instanceId: string, sessionId: string, turns: readonly AiSessionTurn[], timeline: AiSessionTimeline) {
  for (const turn of turns) {
    const identities = new Set(turnIdentities(turn));
    resolveTurn(instanceId, sessionId, turn, timeline.items.filter((item) => identities.has(item.turnId)));
  }
  setSessionState(instanceId, sessionId, { status: "ready" });
}

function rejectSession(instanceId: string, sessionId: string, error: string) {
  setSessionState(instanceId, sessionId, { status: "error", error });
}

function cleanupInstance(instanceId: string) {
  for (const [key, bucket] of liveTurns) if (bucket.instanceId === instanceId) removeLiveTurn(key);
  for (const [key, state] of turnStates) if (state.instanceId === instanceId) turnStates.delete(key);
  for (const key of sessionStates.keys()) {
    const [storedInstanceId] = JSON.parse(key) as [string, string];
    if (storedInstanceId === instanceId) sessionStates.delete(key);
  }
  revision.value += 1;
}

function recoverConnection() {
  liveTurns.clear();
  liveTurnKeysBySession.clear();
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
    beginSessionLoad,
    beginTurnLoad,
    cleanupInstance,
    items,
    recoverConnection,
    recoveryRevision,
    rejectSession,
    rejectTurn,
    realtimeTurnState,
    resolveSession,
    resolveTurn,
    revision,
    sessionState,
    turnState,
  };
}
