import type {
  ControlPlaneAiSessionSummary,
  ControlPlaneAiSessions,
} from '@task-handoff/control-plane-client';
import {
  aiSessionAuthoritativeMessageStatus,
  aiSessionMessageKey,
  appendAiSessionMessageDelta,
  applyAiSessionUnreadState,
  applyControlPlaneAiSessionStreamEvent,
} from '@task-handoff/control-plane-client';
import {
  type AiSessionMessageDeltaEvent,
  type AiSessionStreamApplyResult,
  type AiSessionStreamEvent,
  type AiSessionUnreadState,
} from '@task-handoff/protocol/ai-sessions';

export const mobileControlPlaneQueryKeys = {
  profile(controlPlaneId: string) {
    return ['control-plane', controlPlaneId] as const;
  },
  aiSessions(controlPlaneId: string) {
    return [...this.profile(controlPlaneId), 'ai-sessions'] as const;
  },
  aiSession(controlPlaneId: string, instanceId: string, sessionId: string) {
    return [...this.aiSessions(controlPlaneId), instanceId, sessionId] as const;
  },
};

export type MobileAiSessionProfileState = {
  controlPlaneId: string;
  snapshot?: ControlPlaneAiSessions;
  messages: Readonly<Record<string, MobileStreamingMessage>>;
  scope?: AiSessionScope;
  sync: {
    phase: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error';
    lastSyncedAt?: string;
    error?: string;
  };
};

export type AiSessionScope =
  | { kind: 'all' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'instance'; instanceId: string };

export type MobileStreamingMessage = {
  instanceId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  receivedText: string;
  status: 'streaming' | 'complete' | 'waiting' | 'failed' | 'interrupted';
  updatedAt: string;
  receivedAt?: string;
  settledAt?: string;
};

export type MobileAiSessionViewState = {
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  syncPhase: MobileAiSessionProfileState['sync']['phase'];
};

export const MOBILE_MESSAGE_TURN_LIMIT = 50;

export function activeMobileStreamingMessage(
  messages: readonly MobileStreamingMessage[],
  turnId: string,
) {
  // Message entries retain their creation order in the profile projection. Like
  // the Web active-message ref, a delta for an older item must not reactivate it.
  return messages.filter((message) => message.turnId === turnId).at(-1);
}

type Listener = () => void;

export class MobileAiSessionStore {
  private readonly profiles = new Map<string, MobileAiSessionProfileState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly snapshotListeners = new Map<string, Set<Listener>>();
  private readonly sessionListeners = new Map<string, Set<Listener>>();
  private readonly sessionKeysByControlPlane = new Map<string, Set<string>>();
  private readonly sessionViewCache = new Map<string, MobileAiSessionViewState>();
  private readonly sessionViewKeysByControlPlane = new Map<string, Set<string>>();
  private readonly messageTurnsByControlPlane = new Map<string, Set<string>>();
  private readonly generations = new Map<string, number>();

  generation(controlPlaneId: string) { return this.generations.get(controlPlaneId) ?? 0; }
  isGeneration(controlPlaneId: string, generation: number) { return this.generation(controlPlaneId) === generation; }
  hasProfile(controlPlaneId: string) { return this.profiles.has(controlPlaneId); }

  profile(controlPlaneId: string): MobileAiSessionProfileState {
    const existing = this.profiles.get(controlPlaneId);
    if (existing) return existing;
    const initial: MobileAiSessionProfileState = { controlPlaneId, messages: {}, sync: { phase: 'idle' } };
    this.profiles.set(controlPlaneId, initial);
    return initial;
  }

  snapshot(controlPlaneId: string) {
    return this.profile(controlPlaneId).snapshot;
  }

  session(controlPlaneId: string, instanceId: string, sessionId: string): ControlPlaneAiSessionSummary | undefined {
    return this.profile(controlPlaneId).snapshot?.instances
      .find((instance) => instance.instanceId === instanceId)
      ?.aiSessions.sessions.find((session) => session.id === sessionId);
  }

  sessionView(controlPlaneId: string, instanceId: string, sessionId: string): MobileAiSessionViewState {
    const key = mobileSessionSubscriptionKey(controlPlaneId, instanceId, sessionId);
    const cached = this.sessionViewCache.get(key);
    if (cached) return cached;
    const profile = this.profiles.get(controlPlaneId);
    const view: MobileAiSessionViewState = {
      session: profile?.snapshot?.instances
        .find((instance) => instance.instanceId === instanceId)
        ?.aiSessions.sessions.find((session) => session.id === sessionId),
      messages: Object.values(profile?.messages ?? {}).filter((message) => (
        message.instanceId === instanceId && message.sessionId === sessionId
      )),
      syncPhase: profile?.sync.phase ?? 'idle',
    };
    this.sessionViewCache.set(key, view);
    addIndex(this.sessionViewKeysByControlPlane, controlPlaneId, key);
    return view;
  }

  replaceSnapshot(controlPlaneId: string, snapshot: ControlPlaneAiSessions, affectedSessionKeys?: ReadonlySet<string>) {
    const current = this.profile(controlPlaneId);
    const next = {
      ...current,
      controlPlaneId,
      snapshot,
      messages: reconcileStreamingMessages(current.messages, snapshot),
      sync: { phase: 'ready' as const, lastSyncedAt: snapshot.updatedAt },
    };
    this.profiles.set(controlPlaneId, next);
    this.messageTurnsByControlPlane.set(controlPlaneId, indexMessageTurns(next.messages));
    if (affectedSessionKeys) this.invalidateSessions(affectedSessionKeys);
    else this.invalidateControlPlaneSessions(controlPlaneId);
    this.emit(controlPlaneId);
    this.emitSnapshot(controlPlaneId);
    if (affectedSessionKeys) this.emitSessions(affectedSessionKeys);
    else this.emitControlPlaneSessions(controlPlaneId);
    return next;
  }

  setSyncState(controlPlaneId: string, sync: MobileAiSessionProfileState['sync']) {
    const current = this.profile(controlPlaneId);
    this.profiles.set(controlPlaneId, { ...current, sync });
    this.invalidateControlPlaneSessions(controlPlaneId);
    this.emit(controlPlaneId);
    this.emitControlPlaneSessions(controlPlaneId);
  }

  setScope(controlPlaneId: string, scope: AiSessionScope = { kind: 'all' }) {
    const current = this.profile(controlPlaneId);
    this.profiles.set(controlPlaneId, { ...current, scope });
    this.emit(controlPlaneId);
  }

  applyStreamEvent(controlPlaneId: string, event: AiSessionStreamEvent): AiSessionStreamApplyResult {
    const current = this.profile(controlPlaneId);
    const instanceId = event.payload.meta.instanceId;
    const entry = current.snapshot?.instances.find((candidate) => candidate.instanceId === instanceId);
    const { result, entry: replacement } = applyControlPlaneAiSessionStreamEvent(entry, event);
    if (result.kind !== 'applied') return result;
    const instances = current.snapshot?.instances ?? [];
    const index = instances.findIndex((candidate) => candidate.instanceId === instanceId);
    const nextInstances = index < 0 ? [...instances, replacement!] : instances.map((candidate, candidateIndex) => (
      candidateIndex === index ? replacement! : candidate
    ));
    const affectedSessionKeys = new Set([
      ...(entry?.aiSessions.sessions ?? []),
      ...(replacement?.aiSessions.sessions ?? []),
    ].map((session) => mobileSessionSubscriptionKey(controlPlaneId, instanceId, session.id)));
    this.replaceSnapshot(controlPlaneId, {
      updatedAt: result.projection.lastEventAt,
      instances: nextInstances,
    }, affectedSessionKeys);
    return result;
  }

  applyUnread(controlPlaneId: string, state: AiSessionUnreadState) {
    const current = this.profile(controlPlaneId);
    if (!current.snapshot) return false;
    let applied = false;
    const instances = current.snapshot.instances.map((entry) => {
      if (entry.instanceId !== state.instanceId) return entry;
      const sessions = entry.aiSessions.sessions.map((session) => {
        const next = applyAiSessionUnreadState(session, state);
        if (next !== session) applied = true;
        return next;
      });
      return applied ? { ...entry, aiSessions: { ...entry.aiSessions, sessions } } : entry;
    });
    if (applied) this.replaceSnapshot(controlPlaneId, { updatedAt: state.updatedAt, instances }, new Set([
      mobileSessionSubscriptionKey(controlPlaneId, state.instanceId, state.sessionId),
    ]));
    return applied;
  }

  appendMessageDelta(controlPlaneId: string, event: AiSessionMessageDeltaEvent) {
    const current = this.profile(controlPlaneId);
    const identity = {
      instanceId: event.instanceId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      itemId: event.itemId,
    };
    const key = aiSessionMessageKey(identity);
    const existingMessage = current.messages[key];
    const existing = existingMessage ?? {
      ...identity,
      receivedText: '',
      status: 'streaming' as const,
      updatedAt: event.generatedAt,
    };
    const updated = appendAiSessionMessageDelta(existing, event.delta, event.generatedAt);
    const candidateMessages = {
      ...current.messages,
      [key]: { ...updated, receivedText: updated.receivedText.slice(0, 200_000) },
    };
    const turnKey = mobileMessageTurnKey(identity);
    const indexedTurns = this.messageTurnsByControlPlane.get(controlPlaneId) ?? indexMessageTurns(current.messages);
    const addsTurn = !indexedTurns.has(turnKey);
    const messages = addsTurn ? trimMobileStreamingMessages(candidateMessages) : candidateMessages;
    if (!this.messageTurnsByControlPlane.has(controlPlaneId) || addsTurn) {
      this.messageTurnsByControlPlane.set(controlPlaneId, indexMessageTurns(messages));
    }
    this.profiles.set(controlPlaneId, { ...current, messages });
    const affectedSessions = new Set([mobileSessionSubscriptionKey(controlPlaneId, event.instanceId, event.sessionId)]);
    if (addsTurn) {
      for (const [previousKey, previous] of Object.entries(current.messages)) {
        if (!messages[previousKey]) {
          affectedSessions.add(mobileSessionSubscriptionKey(controlPlaneId, previous.instanceId, previous.sessionId));
        }
      }
    }
    for (const sessionKey of affectedSessions) this.sessionViewCache.delete(sessionKey);
    this.emit(controlPlaneId);
    for (const sessionKey of affectedSessions) {
      for (const listener of this.sessionListeners.get(sessionKey) ?? []) listener();
    }
    return messages[key];
  }

  clearProfile(controlPlaneId: string) {
    const deleted = this.profiles.delete(controlPlaneId);
    this.messageTurnsByControlPlane.delete(controlPlaneId);
    this.generations.set(controlPlaneId, this.generation(controlPlaneId) + 1);
    if (deleted) {
      this.invalidateControlPlaneSessions(controlPlaneId);
      this.emit(controlPlaneId);
      this.emitSnapshot(controlPlaneId);
      this.emitControlPlaneSessions(controlPlaneId);
    }
    return deleted;
  }

  subscribe(controlPlaneId: string, listener: Listener) {
    const listeners = this.listeners.get(controlPlaneId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(controlPlaneId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(controlPlaneId);
    };
  }

  subscribeSnapshot(controlPlaneId: string, listener: Listener) {
    const listeners = this.snapshotListeners.get(controlPlaneId) ?? new Set<Listener>();
    listeners.add(listener);
    this.snapshotListeners.set(controlPlaneId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.snapshotListeners.delete(controlPlaneId);
    };
  }

  subscribeSession(controlPlaneId: string, instanceId: string, sessionId: string, listener: Listener) {
    const key = mobileSessionSubscriptionKey(controlPlaneId, instanceId, sessionId);
    const listeners = this.sessionListeners.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    this.sessionListeners.set(key, listeners);
    addIndex(this.sessionKeysByControlPlane, controlPlaneId, key);
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      this.sessionListeners.delete(key);
      removeIndex(this.sessionKeysByControlPlane, controlPlaneId, key);
    };
  }

  private emit(controlPlaneId: string) {
    for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
  }

  private emitSnapshot(controlPlaneId: string) {
    for (const listener of this.snapshotListeners.get(controlPlaneId) ?? []) listener();
  }

  private emitControlPlaneSessions(controlPlaneId: string) {
    for (const key of this.sessionKeysByControlPlane.get(controlPlaneId) ?? []) {
      for (const listener of this.sessionListeners.get(key) ?? []) listener();
    }
  }

  private emitSessions(keys: ReadonlySet<string>) {
    for (const key of keys) {
      for (const listener of this.sessionListeners.get(key) ?? []) listener();
    }
  }

  private invalidateSessions(keys: ReadonlySet<string>) {
    for (const key of keys) this.sessionViewCache.delete(key);
  }

  private invalidateControlPlaneSessions(controlPlaneId: string) {
    for (const key of this.sessionViewKeysByControlPlane.get(controlPlaneId) ?? []) {
      this.sessionViewCache.delete(key);
    }
    this.sessionViewKeysByControlPlane.delete(controlPlaneId);
  }
}

export const mobileAiSessionStore = new MobileAiSessionStore();

function reconcileStreamingMessages(
  messages: Readonly<Record<string, MobileStreamingMessage>>,
  snapshot: ControlPlaneAiSessions,
) {
  const next: Record<string, MobileStreamingMessage> = {};
  for (const [key, message] of Object.entries(messages)) {
    const session = snapshot.instances.find((entry) => entry.instanceId === message.instanceId)
      ?.aiSessions.sessions.find((candidate) => candidate.id === message.sessionId);
    if (!session) continue;
    const turn = session.turns?.find((candidate) => candidate.id === message.turnId);
    const authoritativeText = turn?.lastMessageItemId === message.itemId ? turn.lastMessage : undefined;
    const status = aiSessionAuthoritativeMessageStatus(session, turn?.status);
    if (status !== 'streaming') continue;
    next[key] = {
      ...message,
      receivedText: authoritativeText ?? message.receivedText,
      status,
      settledAt: undefined,
      updatedAt: snapshot.updatedAt,
    };
  }
  for (const instance of snapshot.instances) {
    for (const session of instance.aiSessions.sessions) {
      const turn = session.turns?.find((candidate) => candidate.id === session.activeTurnId) ?? session.turns?.at(-1);
      const itemId = turn?.lastMessageItemId ?? session.lastMessageItemId;
      const text = turn?.lastMessage ?? (turn ? undefined : session.lastMessage);
      if (!turn?.id || !itemId || text === undefined) continue;
      const identity = { instanceId: instance.instanceId, sessionId: session.id, turnId: turn.id, itemId };
      const key = aiSessionMessageKey(identity);
      if (next[key]) continue;
      const status = aiSessionAuthoritativeMessageStatus(session, turn.status);
      if (status !== 'streaming') continue;
      next[key] = {
        ...identity,
        receivedText: text,
        status,
        receivedAt: snapshot.updatedAt,
        settledAt: status === 'streaming' ? undefined : snapshot.updatedAt,
        updatedAt: snapshot.updatedAt,
      };
    }
  }
  return trimMobileStreamingMessages(next);
}

export function trimMobileStreamingMessages(messages: Readonly<Record<string, MobileStreamingMessage>>) {
  const newestFirst = Object.entries(messages).sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt));
  const retainedTurns = new Set<string>();
  for (const [, message] of newestFirst) {
    const turnKey = mobileMessageTurnKey(message);
    if (retainedTurns.has(turnKey)) continue;
    if (retainedTurns.size >= MOBILE_MESSAGE_TURN_LIMIT) break;
    retainedTurns.add(turnKey);
  }
  return Object.fromEntries(Object.entries(messages).filter(([, message]) => (
    retainedTurns.has(mobileMessageTurnKey(message))
  )));
}

function indexMessageTurns(messages: Readonly<Record<string, MobileStreamingMessage>>) {
  return new Set(Object.values(messages).map(mobileMessageTurnKey));
}

function mobileMessageTurnKey(message: Pick<MobileStreamingMessage, 'instanceId' | 'sessionId' | 'turnId'>) {
  return JSON.stringify([message.instanceId, message.sessionId, message.turnId]);
}

function mobileSessionSubscriptionKey(controlPlaneId: string, instanceId: string, sessionId: string) {
  return JSON.stringify([controlPlaneId, instanceId, sessionId]);
}

function addIndex(index: Map<string, Set<string>>, owner: string, key: string) {
  const keys = index.get(owner) ?? new Set<string>();
  keys.add(key);
  index.set(owner, keys);
}

function removeIndex(index: Map<string, Set<string>>, owner: string, key: string) {
  const keys = index.get(owner);
  if (!keys) return;
  keys.delete(key);
  if (!keys.size) index.delete(owner);
}
