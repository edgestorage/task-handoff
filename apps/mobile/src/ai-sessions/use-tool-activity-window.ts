import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import {
  AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS,
  type AiSessionTimelineActivity,
  type AiSessionTimelineItem,
  type AiSessionToolActivityWindow,
  type AiSessionTurn,
} from '@task-handoff/protocol/ai-sessions';

import { mobileAiSessionStore } from './store';

export type MobileToolActivityWindow = {
  status: 'loading' | 'ready' | 'error';
  items: readonly AiSessionTimelineActivity[];
  total: number;
  truncated: boolean;
  revision?: string;
  boundaryItemId?: string;
  error?: string;
};

// This projection belongs to the activity disclosure, never to full timeline
// history. Read only authoritative live items when extending the HTTP window.
export function mergeMobileToolActivityWindow(window: MobileToolActivityWindow, live: readonly AiSessionTimelineItem[]): MobileToolActivityWindow {
  if (window.status !== 'ready') return window;
  const boundary = live.findLastIndex((item) => item.type === 'ai-message');
  const message = boundary >= 0 ? live[boundary] : undefined;
  const changed = Boolean(message && message.id !== window.boundaryItemId);
  const activities = live.slice(boundary + 1).filter((item): item is AiSessionTimelineActivity => item.type === 'activity');
  const base = changed ? [] : window.items;
  const byId = new Map(base.map((item) => [item.id, item]));
  let added = 0;
  for (const item of activities) {
    if (!byId.has(item.id)) added += 1;
    byId.set(item.id, item);
  }
  const total = (changed ? 0 : window.total) + added;
  const items = [...byId.values()].slice(-AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS);
  return { ...window, items, total, truncated: items.length < total, boundaryItemId: message?.id ?? window.boundaryItemId };
}

type ActivityTurn = Pick<AiSessionTurn, 'id' | 'providerTurnId'>;
type WindowEntry = { window: MobileToolActivityWindow; seen: Map<string, AiSessionTimelineItem> };

class ActivityWindowCache {
  active = true;
  readonly windows = new Map<string, WindowEntry>();
  readonly requests = new Map<string, symbol>();
  private snapshot: Readonly<Record<string, MobileToolActivityWindow>> = {};
  private readonly listeners = new Set<() => void>();
  constructor(readonly scope: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  publish() {
    this.snapshot = Object.fromEntries([...this.windows].map(([id, entry]) => [id, entry.window]));
    for (const listener of this.listeners) listener();
  }
  activate() { this.active = true; }
  deactivate() { this.active = false; }
}

export function useToolActivityWindow({ controlPlaneId, instanceId, sessionId, turns, client, enabled, recoveryRevision }: {
  controlPlaneId: string;
  instanceId: string;
  sessionId?: string;
  turns: readonly Pick<AiSessionTurn, 'id' | 'providerTurnId'>[];
  client?: ControlPlaneClient;
  enabled: boolean;
  recoveryRevision: number;
}) {
  const sessionScope = JSON.stringify([controlPlaneId, instanceId, sessionId]);
  const recoveryScope = JSON.stringify([sessionScope, recoveryRevision, enabled]);
  const requested = useMemo(() => ({ scope: sessionScope, turns: new Map<string, ActivityTurn>() }), [sessionScope]);
  const cache = useMemo(() => new ActivityWindowCache(recoveryScope), [recoveryScope]);
  const windows = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => {
    cache.activate();
    return () => { cache.deactivate(); };
  }, [cache]);
  const load = useCallback((turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>) => {
    if (!enabled || !client || !sessionId) return;
    requested.turns.set(turn.id, turn);
    const state = cache;
    if (state.requests.has(turn.id) || state.windows.get(turn.id)?.window.status === 'ready') return;
    const token = Symbol(turn.id);
    state.requests.set(turn.id, token);
    const seen = new Map(mobileAiSessionStore.realtimeTurnTimelineItems(controlPlaneId, instanceId, sessionId, turn).map((item) => [item.id, item]));
    state.windows.set(turn.id, { window: { status: 'loading', items: [], total: 0, truncated: false }, seen });
    cache.publish();
    void client.aiSessions.toolActivity(instanceId, sessionId, turn.id).then((snapshot: AiSessionToolActivityWindow) => {
      if (!state.active || state.requests.get(turn.id) !== token) return;
      const live = mobileAiSessionStore.realtimeTurnTimelineItems(controlPlaneId, instanceId, sessionId, turn);
      const snapshotIds = new Set(snapshot.items.map((item) => item.id));
      const coveredThrough = live.findLastIndex((item) => snapshotIds.has(item.id) || item.id === snapshot.boundaryItemId);
      // Events can accumulate while HTTP is in flight. An overlap proves the
      // preceding evicted activities are already counted by this snapshot.
      for (const item of live.slice(0, coveredThrough + 1)) {
        if (!snapshotIds.has(item.id)) seen.set(item.id, item);
      }
      state.windows.set(turn.id, { window: { ...snapshot, status: 'ready' }, seen });
    }).catch((cause: unknown) => {
      if (!state.active || state.requests.get(turn.id) !== token) return;
      state.windows.set(turn.id, { window: { status: 'error', items: [], total: 0, truncated: false, error: cause instanceof Error ? cause.message : String(cause) }, seen });
    }).finally(() => {
      state.requests.delete(turn.id);
      if (state.active) cache.publish();
    });
  }, [cache, client, controlPlaneId, enabled, instanceId, requested, sessionId]);

  // Reconnect invalidates the window; only previously opened disclosures need
  // a new HTTP snapshot. Normal updates arrive via the session's WebSocket.
  useEffect(() => {
    for (const turn of requested.turns.values()) load(turn);
  }, [load, requested]);
  useEffect(() => {
    let changed = false;
    for (const turn of turns) {
      const entry = cache.windows.get(turn.id);
      if (!entry || !sessionId || entry.window.status !== 'ready') continue;
      const live = mobileAiSessionStore.realtimeTurnTimelineItems(controlPlaneId, instanceId, sessionId, turn);
      const latestMessage = live.findLastIndex((item) => item.type === 'ai-message');
      const message = live[latestMessage];
      const newMessage = message && entry.seen.get(message.id) !== message;
      const retainedIds = new Set(entry.window.items.map((item) => item.id));
      const changes = live.slice(latestMessage + 1).filter((item) => entry.seen.get(item.id) !== item
        && (!entry.seen.has(item.id) || retainedIds.has(item.id)));
      // HTTP already includes events observed before the request. Avoid replaying
      // those over a newer snapshot, and remember applied items so eviction from
      // the 50-item window cannot make a repeated event inflate its total.
      if (newMessage || changes.length) {
        entry.window = mergeMobileToolActivityWindow(entry.window, [...(newMessage ? [message] : []), ...changes]);
        changed = true;
      }
      entry.seen = new Map(live.map((item) => [item.id, item]));
    }
    if (changed) cache.publish();
  });
  return { windows, load };
}
