import { useCallback, useSyncExternalStore } from 'react';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';
import {
  clampFloatingPreview,
  DEFAULT_FLOATING_PREVIEW_PREFERENCE,
  FLOATING_PREVIEW_MAX_WIDTH,
  FLOATING_PREVIEW_MIN_WIDTH,
  type FloatingPreviewPreference,
} from './floating-preview-layout';

type SessionFloatingPreviewPreferences = {
  bySession: Record<string, FloatingPreviewPreference>;
};

const STORAGE_VERSION = 1;

export const sessionFloatingPreviewPreferenceStore = createPersistedPreferenceStore<SessionFloatingPreviewPreferences>({
  defaults: { bySession: {} },
  parse: parseSessionFloatingPreviewPreferences,
  storageKey: 'task-handoff.mobile.remote-desktop-session-floating-preview',
  version: STORAGE_VERSION,
});

export function parseSessionFloatingPreviewPreferences(raw: string | null | undefined): SessionFloatingPreviewPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { version?: unknown; bySession?: unknown };
    if (value.version !== STORAGE_VERSION || !value.bySession || typeof value.bySession !== 'object') return undefined;
    const bySession: Record<string, FloatingPreviewPreference> = {};
    for (const [key, candidate] of Object.entries(value.bySession as Record<string, unknown>)) {
      if (!key || !candidate || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      if (!finite(record.width) || !finite(record.xRatio) || !finite(record.yRatio)) continue;
      bySession[key] = {
        collapsed: record.collapsed === true,
        width: clampFloatingPreview(record.width, FLOATING_PREVIEW_MIN_WIDTH, FLOATING_PREVIEW_MAX_WIDTH),
        xRatio: clampFloatingPreview(record.xRatio, 0, 1),
        yRatio: clampFloatingPreview(record.yRatio, 0, 1),
      };
    }
    return { bySession };
  } catch {
    return undefined;
  }
}

export function sessionFloatingPreviewPreferenceKey(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  return JSON.stringify([controlPlaneId || 'direct', instanceId, sessionId]);
}

export function sessionFloatingPreviewPreferenceFor(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  return sessionFloatingPreviewPreferenceStore.get().bySession[
    sessionFloatingPreviewPreferenceKey(controlPlaneId, instanceId, sessionId)
  ] ?? DEFAULT_FLOATING_PREVIEW_PREFERENCE;
}

export function updateSessionFloatingPreviewPreference(input: {
  controlPlaneId?: string;
  instanceId: string;
  preference: FloatingPreviewPreference;
  sessionId: string;
}) {
  const key = sessionFloatingPreviewPreferenceKey(input.controlPlaneId, input.instanceId, input.sessionId);
  const all = sessionFloatingPreviewPreferenceStore.get();
  sessionFloatingPreviewPreferenceStore.update({
    bySession: { ...all.bySession, [key]: input.preference },
  });
}

export function useSessionFloatingPreviewPreference(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  const getSnapshot = useCallback(
    () => sessionFloatingPreviewPreferenceFor(controlPlaneId, instanceId, sessionId),
    [controlPlaneId, instanceId, sessionId],
  );
  return useSyncExternalStore(
    sessionFloatingPreviewPreferenceStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
