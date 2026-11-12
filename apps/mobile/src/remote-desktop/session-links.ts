import { useCallback, useSyncExternalStore } from 'react';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';
import { sanitizePersistedCaptureTarget, type PersistedCaptureTarget } from './preferences';

export type SessionRemoteDesktopLink = {
  target: PersistedCaptureTarget;
  openedAt: number;
  lastUsedAt: number;
};

type SessionRemoteDesktopLinks = {
  bySession: Record<string, SessionRemoteDesktopLink>;
};

const STORAGE_VERSION = 1;

export const sessionRemoteDesktopLinkStore = createPersistedPreferenceStore<SessionRemoteDesktopLinks>({
  defaults: { bySession: {} },
  parse: parseSessionRemoteDesktopLinks,
  storageKey: 'task-handoff.mobile.remote-desktop-session-links',
  version: STORAGE_VERSION,
});

export function parseSessionRemoteDesktopLinks(raw: string | null | undefined): SessionRemoteDesktopLinks | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { version?: unknown; bySession?: unknown };
    if (value.version !== STORAGE_VERSION || !value.bySession || typeof value.bySession !== 'object') return undefined;
    const bySession: Record<string, SessionRemoteDesktopLink> = {};
    for (const [key, candidate] of Object.entries(value.bySession as Record<string, unknown>)) {
      if (!key || !candidate || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      if (!record.target || typeof record.target !== 'object') continue;
      const openedAt = timestamp(record.openedAt);
      const lastUsedAt = timestamp(record.lastUsedAt) ?? openedAt;
      if (openedAt === undefined) continue;
      bySession[key] = {
        target: sanitizePersistedCaptureTarget(record.target),
        openedAt,
        lastUsedAt: lastUsedAt ?? openedAt,
      };
    }
    return { bySession };
  } catch {
    return undefined;
  }
}

export function sessionRemoteDesktopLinkKey(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  return JSON.stringify([controlPlaneId || 'direct', instanceId, sessionId]);
}

export function sessionRemoteDesktopLinkFor(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  return sessionRemoteDesktopLinkStore.get().bySession[sessionRemoteDesktopLinkKey(controlPlaneId, instanceId, sessionId)];
}

export function rememberSessionRemoteDesktopLink(input: {
  controlPlaneId?: string;
  instanceId: string;
  sessionId: string;
  target: PersistedCaptureTarget;
  at?: number;
}) {
  const key = sessionRemoteDesktopLinkKey(input.controlPlaneId, input.instanceId, input.sessionId);
  const all = sessionRemoteDesktopLinkStore.get();
  const current = all.bySession[key];
  const at = input.at ?? Date.now();
  sessionRemoteDesktopLinkStore.update({
    bySession: {
      ...all.bySession,
      [key]: {
        target: sanitizePersistedCaptureTarget(input.target),
        openedAt: current?.openedAt ?? at,
        lastUsedAt: at,
      },
    },
  });
}

export function touchSessionRemoteDesktopLink(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
  at = Date.now(),
) {
  const key = sessionRemoteDesktopLinkKey(controlPlaneId, instanceId, sessionId);
  const all = sessionRemoteDesktopLinkStore.get();
  const current = all.bySession[key];
  if (!current) return;
  sessionRemoteDesktopLinkStore.update({
    bySession: { ...all.bySession, [key]: { ...current, lastUsedAt: at } },
  });
}

export function removeSessionRemoteDesktopLink(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  const key = sessionRemoteDesktopLinkKey(controlPlaneId, instanceId, sessionId);
  const all = sessionRemoteDesktopLinkStore.get();
  if (!(key in all.bySession)) return;
  const bySession = { ...all.bySession };
  delete bySession[key];
  sessionRemoteDesktopLinkStore.update({ bySession });
}

export function useSessionRemoteDesktopLink(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  const getSnapshot = useCallback(
    () => sessionRemoteDesktopLinkFor(controlPlaneId, instanceId, sessionId),
    [controlPlaneId, instanceId, sessionId],
  );
  return useSyncExternalStore(
    sessionRemoteDesktopLinkStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}

function timestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
