import { useSyncExternalStore } from 'react';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export type SessionPreviewPresentation = 'floating' | 'expanded';

type SessionPreviewPresentationPreferences = {
  presentation: SessionPreviewPresentation;
};

const STORAGE_VERSION = 1;

export const DEFAULT_SESSION_PREVIEW_PRESENTATION: SessionPreviewPresentation = 'floating';

export const sessionPreviewPresentationStore = createPersistedPreferenceStore<SessionPreviewPresentationPreferences>({
  defaults: { presentation: DEFAULT_SESSION_PREVIEW_PRESENTATION },
  parse: parseSessionPreviewPresentationPreferences,
  storageKey: 'task-handoff.mobile.remote-desktop-session-preview-presentation',
  version: STORAGE_VERSION,
});

export function parseSessionPreviewPresentationPreferences(
  raw: string | null | undefined,
): SessionPreviewPresentationPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { version?: unknown; presentation?: unknown };
    if (value.version !== STORAGE_VERSION) return undefined;
    return { presentation: sanitizeSessionPreviewPresentation(value.presentation) };
  } catch {
    return undefined;
  }
}

export function sanitizeSessionPreviewPresentation(value: unknown): SessionPreviewPresentation {
  return value === 'expanded' ? 'expanded' : DEFAULT_SESSION_PREVIEW_PRESENTATION;
}

export function setSessionPreviewPresentation(presentation: SessionPreviewPresentation) {
  sessionPreviewPresentationStore.update({ presentation });
}

export function useSessionPreviewPresentation() {
  return useSyncExternalStore(
    sessionPreviewPresentationStore.subscribe,
    () => sessionPreviewPresentationStore.get().presentation,
    () => sessionPreviewPresentationStore.get().presentation,
  );
}
