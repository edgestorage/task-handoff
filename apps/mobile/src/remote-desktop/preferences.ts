import type { DesktopCaptureTarget } from '@task-handoff/protocol/remote-desktop';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export type RemoteDesktopResolution = 'auto' | '1080p' | '720p' | '540p' | '360p';
export type RemoteDesktopFrameRate = 'auto' | '60' | '30' | '24' | '15';
export type RemoteDesktopMouseMode = 'direct' | 'trackpad';
export type RemoteDesktopTransportKey = 'p2p' | 'turn' | 'websocket';
export type RemoteDesktopTransportAvailability = Record<RemoteDesktopTransportKey, boolean>;

export type PersistedCaptureTarget =
  | { kind: 'display' }
  | { kind: 'window'; windowRef: string; title?: string; applicationName?: string };

export type RemoteDesktopInstancePreferences = {
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  mouseMode: RemoteDesktopMouseMode;
  transportAvailability: RemoteDesktopTransportAvailability;
};

type RemoteDesktopPreferences = { byInstance: Record<string, RemoteDesktopInstancePreferences> };

export const REMOTE_DESKTOP_RESOLUTIONS: readonly RemoteDesktopResolution[] = ['auto', '1080p', '720p', '540p', '360p'];
export const REMOTE_DESKTOP_FRAME_RATES: readonly RemoteDesktopFrameRate[] = ['auto', '60', '30', '24', '15'];
export const REMOTE_DESKTOP_TRANSPORTS: readonly RemoteDesktopTransportKey[] = ['p2p', 'turn', 'websocket'];
export const REMOTE_DESKTOP_RESOLUTION_PRESETS: Record<Exclude<RemoteDesktopResolution, 'auto'>, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '540p': { width: 960, height: 540 },
  '360p': { width: 640, height: 360 },
};

export const defaultRemoteDesktopPreferences: RemoteDesktopInstancePreferences = {
  target: { kind: 'display' },
  resolution: 'auto',
  frameRate: 'auto',
  mouseMode: 'direct',
  transportAvailability: { p2p: true, turn: true, websocket: true },
};

export const remoteDesktopPreferenceStore = createPersistedPreferenceStore<RemoteDesktopPreferences>({
  storageKey: 'task-handoff.mobile.remote-desktop-preferences',
  version: 1,
  defaults: { byInstance: {} },
  parse: (raw) => {
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as { version?: unknown; byInstance?: unknown };
      if (value.version !== 1 || !value.byInstance || typeof value.byInstance !== 'object') return undefined;
      const byInstance: Record<string, RemoteDesktopInstancePreferences> = {};
      for (const [key, candidate] of Object.entries(value.byInstance as Record<string, unknown>)) {
        if (!key || !candidate || typeof candidate !== 'object') continue;
        byInstance[key] = sanitizeInstancePreferences(candidate as Record<string, unknown>);
      }
      return { byInstance };
    } catch {
      return undefined;
    }
  },
});

export function remoteDesktopPreferencesKey(controlPlaneId: string | undefined, instanceId: string) {
  return `${controlPlaneId || 'direct'}:${instanceId}`;
}

export function remoteDesktopPreferencesFor(controlPlaneId: string | undefined, instanceId: string) {
  return remoteDesktopPreferenceStore.get().byInstance[remoteDesktopPreferencesKey(controlPlaneId, instanceId)] ?? defaultRemoteDesktopPreferences;
}

export function updateRemoteDesktopPreferences(controlPlaneId: string | undefined, instanceId: string, patch: Partial<RemoteDesktopInstancePreferences>) {
  const key = remoteDesktopPreferencesKey(controlPlaneId, instanceId);
  const all = remoteDesktopPreferenceStore.get();
  const current = all.byInstance[key] ?? defaultRemoteDesktopPreferences;
  remoteDesktopPreferenceStore.update({ byInstance: { ...all.byInstance, [key]: { ...current, ...patch } } });
}

export function captureTargetForProtocol(target: PersistedCaptureTarget): DesktopCaptureTarget {
  return target.kind === 'window' ? { kind: 'window', windowRef: target.windowRef } : { kind: 'display' };
}

export function transportEnabledCount(availability: RemoteDesktopTransportAvailability) {
  return REMOTE_DESKTOP_TRANSPORTS.filter((key) => availability[key]).length;
}

export function canDisableTransport(availability: RemoteDesktopTransportAvailability, key: RemoteDesktopTransportKey) {
  if (!availability[key]) return true;
  return transportEnabledCount(availability) > 1;
}

function sanitizeInstancePreferences(value: Record<string, unknown>): RemoteDesktopInstancePreferences {
  const target = sanitizeTarget(value.target);
  const resolution = REMOTE_DESKTOP_RESOLUTIONS.includes(value.resolution as RemoteDesktopResolution)
    ? value.resolution as RemoteDesktopResolution
    : 'auto';
  const frameRate = REMOTE_DESKTOP_FRAME_RATES.includes(value.frameRate as RemoteDesktopFrameRate)
    ? value.frameRate as RemoteDesktopFrameRate
    : 'auto';
  const mouseMode = value.mouseMode === 'trackpad' ? 'trackpad' : 'direct';
  const raw = value.transportAvailability as Partial<RemoteDesktopTransportAvailability> | undefined;
  const transportAvailability: RemoteDesktopTransportAvailability = {
    p2p: raw?.p2p !== false,
    turn: raw?.turn !== false,
    websocket: raw?.websocket !== false,
  };
  if (transportEnabledCount(transportAvailability) === 0) {
    transportAvailability.p2p = true;
    transportAvailability.turn = true;
    transportAvailability.websocket = true;
  }
  return { target, resolution, frameRate, mouseMode, transportAvailability };
}

function sanitizeTarget(value: unknown): PersistedCaptureTarget {
  if (!value || typeof value !== 'object') return { kind: 'display' };
  const record = value as Record<string, unknown>;
  if (record.kind !== 'window' || typeof record.windowRef !== 'string' || !record.windowRef.trim()) return { kind: 'display' };
  return {
    kind: 'window',
    windowRef: record.windowRef.trim(),
    ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
    ...(typeof record.applicationName === 'string' && record.applicationName.trim() ? { applicationName: record.applicationName.trim() } : {}),
  };
}
