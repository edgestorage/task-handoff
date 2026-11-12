import type { DesktopCaptureSelection, DesktopSource } from '@task-handoff/protocol/remote-desktop';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export type RemoteDesktopResolution = 'auto' | '4k' | '2k' | '1080p' | '540p';
export type RemoteDesktopFrameRate = 'auto' | '60' | '30' | '24' | '15';
export type RemoteDesktopCapturePrecision = 'auto' | 'performance';
export type RemoteDesktopMouseMode = 'direct' | 'trackpad';
export type RemoteDesktopTransportKey = 'p2p' | 'turn' | 'websocket';
export type RemoteDesktopTransportAvailability = Record<RemoteDesktopTransportKey, boolean>;

export type PersistedCaptureTarget = {
  kind: string;
  sourceRef?: string;
  title?: string;
  subtitle?: string;
  width?: number;
  height?: number;
};

export type RemoteDesktopInstancePreferences = {
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  capturePrecision: RemoteDesktopCapturePrecision;
  mouseMode: RemoteDesktopMouseMode;
  transportAvailability: RemoteDesktopTransportAvailability;
};

type RemoteDesktopPreferences = { byInstance: Record<string, RemoteDesktopInstancePreferences> };

export const REMOTE_DESKTOP_RESOLUTIONS: readonly RemoteDesktopResolution[] = ['auto', '4k', '2k', '1080p', '540p'];
export const REMOTE_DESKTOP_FRAME_RATES: readonly RemoteDesktopFrameRate[] = ['auto', '60', '30', '24', '15'];
export const REMOTE_DESKTOP_CAPTURE_PRECISIONS: readonly RemoteDesktopCapturePrecision[] = ['auto', 'performance'];
export const REMOTE_DESKTOP_TRANSPORTS: readonly RemoteDesktopTransportKey[] = ['p2p', 'turn', 'websocket'];
export const REMOTE_DESKTOP_RESOLUTION_PRESETS: Record<Exclude<RemoteDesktopResolution, 'auto'>, { width: number; height: number }> = {
  '4k': { width: 3840, height: 2160 },
  '2k': { width: 2560, height: 1440 },
  '1080p': { width: 1920, height: 1080 },
  '540p': { width: 960, height: 540 },
};

export function remoteDesktopStreamResolution(
  resolution: RemoteDesktopResolution,
  frameRate: RemoteDesktopFrameRate,
  capturePrecision: RemoteDesktopCapturePrecision = 'auto',
) {
  const preset = resolution === 'auto' ? undefined : REMOTE_DESKTOP_RESOLUTION_PRESETS[resolution];
  return {
    maxWidth: preset?.width ?? null,
    maxHeight: preset?.height ?? null,
    maxFrameRate: frameRate === 'auto' ? null : Number(frameRate),
    capturePrecision,
  };
}

export const defaultRemoteDesktopPreferences: RemoteDesktopInstancePreferences = {
  target: { kind: 'display' },
  resolution: 'auto',
  frameRate: 'auto',
  capturePrecision: 'auto',
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

export function updateRemoteDesktopPreferences(
  controlPlaneId: string | undefined,
  instanceId: string,
  patch: Partial<RemoteDesktopInstancePreferences>,
) {
  const key = remoteDesktopPreferencesKey(controlPlaneId, instanceId);
  const all = remoteDesktopPreferenceStore.get();
  const current = all.byInstance[key] ?? defaultRemoteDesktopPreferences;
  remoteDesktopPreferenceStore.update({ byInstance: { ...all.byInstance, [key]: { ...current, ...patch } } });
}

export function persistedCaptureTarget(source: DesktopSource): PersistedCaptureTarget {
  return {
    kind: source.kind,
    sourceRef: source.sourceRef,
    title: source.title,
    ...(source.subtitle !== null ? { subtitle: source.subtitle } : {}),
    width: source.width,
    height: source.height,
  };
}

export function captureSelectionForProtocol(target: PersistedCaptureTarget): DesktopCaptureSelection | undefined {
  return target.sourceRef ? { sourceRef: target.sourceRef } : undefined;
}

export function resolvePersistedCaptureTarget(sources: readonly DesktopSource[], target: PersistedCaptureTarget): PersistedCaptureTarget | undefined {
  const capturable = sources.filter((source) => source.capturable);
  const exact = target.sourceRef ? capturable.find((source) => source.kind === target.kind && source.sourceRef === target.sourceRef) : undefined;
  if (exact) return persistedCaptureTarget(exact);
  if (target.title !== undefined) {
    const scored = capturable
      .filter((source) => source.kind === target.kind)
      .map((source) => ({ source, score: sourceIdentityScore(source, target) }))
      .filter((entry) => entry.score > 0);
    if (!scored.length) return undefined;
    const best = Math.max(...scored.map((entry) => entry.score));
    const matches = scored.filter((entry) => entry.score === best);
    return matches.length === 1 ? persistedCaptureTarget(matches[0].source) : undefined;
  }
  if (target.sourceRef) return undefined;
  const first = capturable.find((source) => source.kind === target.kind);
  return first ? persistedCaptureTarget(first) : undefined;
}

export function transportEnabledCount(availability: RemoteDesktopTransportAvailability) {
  return REMOTE_DESKTOP_TRANSPORTS.filter((key) => availability[key]).length;
}

export function canDisableTransport(availability: RemoteDesktopTransportAvailability, key: RemoteDesktopTransportKey) {
  if (!availability[key]) return true;
  return transportEnabledCount(availability) > 1;
}

function sanitizeInstancePreferences(value: Record<string, unknown>): RemoteDesktopInstancePreferences {
  const target = sanitizePersistedCaptureTarget(value.target);
  const resolution = REMOTE_DESKTOP_RESOLUTIONS.includes(value.resolution as RemoteDesktopResolution)
    ? value.resolution as RemoteDesktopResolution
    : 'auto';
  const frameRate = REMOTE_DESKTOP_FRAME_RATES.includes(value.frameRate as RemoteDesktopFrameRate)
    ? value.frameRate as RemoteDesktopFrameRate
    : 'auto';
  const capturePrecision = REMOTE_DESKTOP_CAPTURE_PRECISIONS.includes(value.capturePrecision as RemoteDesktopCapturePrecision)
    ? value.capturePrecision as RemoteDesktopCapturePrecision
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
  return { target, resolution, frameRate, capturePrecision, mouseMode, transportAvailability };
}

export function sanitizePersistedCaptureTarget(value: unknown): PersistedCaptureTarget {
  if (!value || typeof value !== 'object') return { kind: 'display' };
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' && record.kind.trim() && record.kind.length <= 64 ? record.kind.trim() : 'display';
  const rawSourceRef = typeof record.sourceRef === 'string' ? record.sourceRef : undefined;
  const sourceRef = rawSourceRef?.trim();
  const hasWidth = Number.isSafeInteger(record.width) && Number(record.width) >= 0;
  const hasHeight = Number.isSafeInteger(record.height) && Number(record.height) >= 0;
  return {
    kind,
    ...(sourceRef && sourceRef.length <= 4096 ? { sourceRef } : {}),
    ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
    ...(typeof record.subtitle === 'string' && record.subtitle.trim() ? { subtitle: record.subtitle.trim() } : {}),
    ...(hasWidth && hasHeight ? { width: Number(record.width), height: Number(record.height) } : {}),
  };
}

function sourceIdentityScore(source: DesktopSource, target: PersistedCaptureTarget) {
  if (source.kind !== target.kind) return 0;
  let score = 2;
  if (target.subtitle !== undefined && source.subtitle === target.subtitle) score += 6;
  if (source.title === target.title) score += 4;
  if (source.width === target.width && source.height === target.height) score += 1;
  return score;
}
