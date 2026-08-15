import { shallowRef } from "vue";
import { mergeAiSessionTimelineItems, type AiSessionTimeline, type AiSessionTimelineItem, type AiSessionTimelineItemEvent, type AiSessionTurn } from "@task-handoff/protocol/ai-sessions";

export type AiSessionTurnTimelineStatus = "idle" | "loading" | "ready" | "stale" | "error";
export type AiSessionTurnTimelineState = {
  status: AiSessionTurnTimelineStatus;
  items: AiSessionTimelineItem[];
  error?: string;
};

type StoredTurnTimelineState = AiSessionTurnTimelineState & { updatedAt: number };
type SessionTimelineState = { status: AiSessionTurnTimelineStatus; error?: string };

const events = new Map<string, AiSessionTimelineItemEvent>();
const turnStates = new Map<string, StoredTurnTimelineState>();
const sessionStates = new Map<string, SessionTimelineState>();
const revision = shallowRef(0);
const recoveryRevision = shallowRef(0);
const sessionKey = (instanceId: string, sessionId: string) => JSON.stringify([instanceId, sessionId]);
const turnKey = (instanceId: string, sessionId: string, turnId: string) => `${sessionKey(instanceId, sessionId)}\u0000${turnId}`;
const MAX_CACHED_TURNS = 500;

function apply(event: AiSessionTimelineItemEvent) {
  events.set(`${sessionKey(event.instanceId, event.sessionId)}\u0000${event.item.id}`, event);
  revision.value += 1;
}

function items(instanceId: string, sessionId: string) {
  void revision.value;
  const prefix = `${sessionKey(instanceId, sessionId)}\u0000`;
  return [...events].filter(([key]) => key.startsWith(prefix)).map(([, event]) => event.item);
}

function turnState(instanceId: string, sessionId: string, turn: Pick<AiSessionTurn, "id" | "providerTurnId">): AiSessionTurnTimelineState {
  void revision.value;
  const stored = turnStates.get(turnKey(instanceId, sessionId, turn.id));
  const identities = new Set([turn.id, turn.providerTurnId].filter((value): value is string => Boolean(value)));
  const liveItems = items(instanceId, sessionId).filter((item) => identities.has(item.turnId));
  return {
    status: stored?.status || "idle",
    items: mergeAiSessionTimelineItems(stored?.items || [], liveItems),
    ...(stored?.error ? { error: stored.error } : {}),
  };
}

function setTurnState(instanceId: string, sessionId: string, turnId: string, state: AiSessionTurnTimelineState) {
  const key = turnKey(instanceId, sessionId, turnId);
  turnStates.delete(key);
  turnStates.set(key, { ...state, updatedAt: Date.now() });
  while (turnStates.size > MAX_CACHED_TURNS) turnStates.delete(turnStates.keys().next().value as string);
  revision.value += 1;
}

function beginTurnLoad(instanceId: string, sessionId: string, turnId: string) {
  const existing = turnStates.get(turnKey(instanceId, sessionId, turnId));
  setTurnState(instanceId, sessionId, turnId, {
    status: "loading",
    items: existing?.items || [],
  });
}

function resolveTurn(instanceId: string, sessionId: string, turnId: string, turnItems: readonly AiSessionTimelineItem[]) {
  setTurnState(instanceId, sessionId, turnId, { status: "ready", items: [...turnItems] });
}

function rejectTurn(instanceId: string, sessionId: string, turnId: string, error: string) {
  const existing = turnStates.get(turnKey(instanceId, sessionId, turnId));
  setTurnState(instanceId, sessionId, turnId, {
    status: "error",
    items: existing?.items || [],
    error,
  });
}

function sessionState(instanceId: string, sessionId: string): SessionTimelineState {
  void revision.value;
  return sessionStates.get(sessionKey(instanceId, sessionId)) || { status: "idle" };
}

function beginSessionLoad(instanceId: string, sessionId: string) {
  sessionStates.set(sessionKey(instanceId, sessionId), { status: "loading" });
  revision.value += 1;
}

function resolveSession(instanceId: string, sessionId: string, turns: readonly AiSessionTurn[], timeline: AiSessionTimeline) {
  for (const turn of turns) {
    const identities = new Set([turn.id, turn.providerTurnId].filter((value): value is string => Boolean(value)));
    resolveTurn(instanceId, sessionId, turn.id, timeline.items.filter((item) => identities.has(item.turnId)));
  }
  sessionStates.set(sessionKey(instanceId, sessionId), { status: "ready" });
  revision.value += 1;
}

function rejectSession(instanceId: string, sessionId: string, error: string) {
  sessionStates.set(sessionKey(instanceId, sessionId), { status: "error", error });
  revision.value += 1;
}

function cleanupInstance(instanceId: string) {
  for (const [key, event] of events) if (event.instanceId === instanceId) events.delete(key);
  const prefix = `${JSON.stringify([instanceId]).slice(0, -1)},`;
  for (const key of turnStates.keys()) if (key.startsWith(prefix)) turnStates.delete(key);
  for (const key of sessionStates.keys()) if (key.startsWith(prefix)) sessionStates.delete(key);
  revision.value += 1;
}

function recoverConnection() {
  events.clear();
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
    resolveSession,
    resolveTurn,
    revision,
    sessionState,
    turnState,
  };
}
