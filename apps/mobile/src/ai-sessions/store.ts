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

type Listener = () => void;

export class MobileAiSessionStore {
  private readonly profiles = new Map<string, MobileAiSessionProfileState>();
  private readonly listeners = new Map<string, Set<Listener>>();
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

  session(controlPlaneId: string, instanceId: string, sessionId: string): ControlPlaneAiSessionSummary | undefined {
    return this.profile(controlPlaneId).snapshot?.instances
      .find((instance) => instance.instanceId === instanceId)
      ?.aiSessions.sessions.find((session) => session.id === sessionId);
  }

  replaceSnapshot(controlPlaneId: string, snapshot: ControlPlaneAiSessions) {
    const current = this.profile(controlPlaneId);
    const next = {
      ...current,
      controlPlaneId,
      snapshot,
      messages: reconcileStreamingMessages(current.messages, snapshot),
      sync: { phase: 'ready' as const, lastSyncedAt: snapshot.updatedAt },
    };
    this.profiles.set(controlPlaneId, next);
    this.emit(controlPlaneId);
    return next;
  }

  setSyncState(controlPlaneId: string, sync: MobileAiSessionProfileState['sync']) {
    const current = this.profile(controlPlaneId);
    this.profiles.set(controlPlaneId, { ...current, sync });
    this.emit(controlPlaneId);
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
    this.replaceSnapshot(controlPlaneId, {
      updatedAt: result.projection.lastEventAt,
      instances: nextInstances,
    });
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
    if (applied) this.replaceSnapshot(controlPlaneId, { updatedAt: state.updatedAt, instances });
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
    const existing = current.messages[key] ?? {
      ...identity,
      receivedText: '',
      status: 'streaming' as const,
      updatedAt: event.generatedAt,
    };
    const updated = appendAiSessionMessageDelta(existing, event.delta, event.generatedAt);
    const messages = {
      ...current.messages,
      [key]: { ...updated, receivedText: updated.receivedText.slice(0, 200_000) },
    };
    const keys = Object.keys(messages).sort((left, right) => messages[right].updatedAt.localeCompare(messages[left].updatedAt));
    for (const staleKey of keys.slice(200)) delete messages[staleKey];
    this.profiles.set(controlPlaneId, { ...current, messages });
    this.emit(controlPlaneId);
    return messages[key];
  }

  clearProfile(controlPlaneId: string) {
    const deleted = this.profiles.delete(controlPlaneId);
    this.generations.set(controlPlaneId, this.generation(controlPlaneId) + 1);
    if (deleted) this.emit(controlPlaneId);
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

  private emit(controlPlaneId: string) {
    for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
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
    next[key] = {
      ...message,
      receivedText: authoritativeText ?? message.receivedText,
      status: aiSessionAuthoritativeMessageStatus(session, turn?.status),
      settledAt: authoritativeText || ['idle', 'failed'].includes(session.status) ? snapshot.updatedAt : message.settledAt,
      updatedAt: snapshot.updatedAt,
    };
  }
  return next;
}
