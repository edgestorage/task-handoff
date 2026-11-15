import type { createControlPlaneRemoteDesktopApi } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneTransport } from '../control-plane/transport';
import { RemoteDesktopController } from './controller';
import type {
  PersistedCaptureTarget,
  RemoteDesktopCapturePrecision,
  RemoteDesktopFrameRate,
  RemoteDesktopResolution,
  RemoteDesktopTransportAvailability,
} from './preferences';

type RemoteDesktopApi = ReturnType<typeof createControlPlaneRemoteDesktopApi>;

export type RemoteDesktopControllerScope = {
  controlPlaneId?: string;
  instanceId: string;
  sessionId?: string;
};

type Entry = {
  api: RemoteDesktopApi;
  transport: MobileControlPlaneTransport;
  controller: RemoteDesktopController;
  active: boolean;
  consumerRevision: number;
  consumers: Map<object, RemoteDesktopControllerConsumerState & { revision: number }>;
  lastUsedAt: number;
};

export type RemoteDesktopControllerConsumerState = {
  active: boolean;
  interactive: boolean;
  resolution: RemoteDesktopResolution;
};

export const MAX_RETAINED_REMOTE_DESKTOP_CONTROLLERS = 2;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function remoteDesktopControllerKey(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId?: string,
) {
  return JSON.stringify([controlPlaneId || 'direct', instanceId, sessionId || 'direct']);
}

function scopeKey(scope: RemoteDesktopControllerScope) {
  return remoteDesktopControllerKey(scope.controlPlaneId, scope.instanceId, scope.sessionId);
}

export function remoteDesktopControllerFor(scope: RemoteDesktopControllerScope) {
  return entries.get(scopeKey(scope))?.controller;
}

export function subscribeRemoteDesktopControllers(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyRemoteDesktopControllers() {
  for (const listener of listeners) listener();
}

export function acquireRemoteDesktopController(input: {
  controlPlaneId?: string;
  api: RemoteDesktopApi;
  transport: MobileControlPlaneTransport;
  instanceId: string;
  sessionId?: string;
  active: boolean;
  interactive?: boolean;
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  capturePrecision: RemoteDesktopCapturePrecision;
  transportAvailability: RemoteDesktopTransportAvailability;
  videoCodecs?: readonly string[];
}) {
  const key = remoteDesktopControllerKey(input.controlPlaneId, input.instanceId, input.sessionId);
  const existing = entries.get(key);
  if (existing && existing.api === input.api && existing.transport === input.transport) {
    existing.lastUsedAt = Date.now();
    return existing.controller;
  }
  if (existing) {
    entries.delete(key);
    void existing.controller.close();
  }
  const controller = new RemoteDesktopController({
    api: input.api,
    transport: input.transport,
    instanceId: input.instanceId,
    active: input.active,
    interactive: input.interactive,
    target: input.target,
    resolution: input.resolution,
    frameRate: input.frameRate,
    capturePrecision: input.capturePrecision,
    transportAvailability: input.transportAvailability,
    videoCodecs: input.videoCodecs,
  });
  entries.set(key, {
    api: input.api,
    transport: input.transport,
    controller,
    active: input.active,
    consumerRevision: 0,
    consumers: new Map(),
    lastUsedAt: Date.now(),
  });
  notifyRemoteDesktopControllers();
  evictInactiveControllers(key);
  return controller;
}

export function updateRemoteDesktopControllerConsumer(
  scope: RemoteDesktopControllerScope,
  consumer: object,
  state: RemoteDesktopControllerConsumerState,
) {
  const entry = entries.get(scopeKey(scope));
  if (!entry) return;
  entry.consumers.set(consumer, {
    ...state,
    revision: ++entry.consumerRevision,
  });
  syncEntryActivation(entry);
}

export function releaseRemoteDesktopControllerConsumer(scope: RemoteDesktopControllerScope, consumer: object) {
  const entry = entries.get(scopeKey(scope));
  if (!entry || !entry.consumers.delete(consumer)) return;
  syncEntryActivation(entry);
}

export function forgetRemoteDesktopController(scope: RemoteDesktopControllerScope, options: { close?: boolean } = {}) {
  const key = scopeKey(scope);
  const entry = entries.get(key);
  entries.delete(key);
  if (entry) notifyRemoteDesktopControllers();
  if (entry && options.close !== false) void entry.controller.close();
  return entry?.controller;
}

export function closeRemoteDesktopControllersForSession(
  controlPlaneId: string | undefined,
  instanceId: string,
  sessionId: string,
) {
  forgetRemoteDesktopController({ controlPlaneId, instanceId, sessionId }, { close: true });
}

function evictInactiveControllers(keepKey: string) {
  let evicted = false;
  while (entries.size > MAX_RETAINED_REMOTE_DESKTOP_CONTROLLERS) {
    const candidate = [...entries.entries()]
      .filter(([key, entry]) => key !== keepKey && !entry.active)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (!candidate) return;
    entries.delete(candidate[0]);
    evicted = true;
    void candidate[1].controller.close();
  }
  if (evicted) notifyRemoteDesktopControllers();
}

function syncEntryActivation(entry: Entry) {
  const consumers = [...entry.consumers.values()];
  const activeConsumers = consumers.filter((consumer) => consumer.active);
  const active = activeConsumers.length > 0;
  const interactive = activeConsumers.some((consumer) => consumer.interactive);
  const resolution = activeConsumers
    .sort((left, right) => Number(right.interactive) - Number(left.interactive) || right.revision - left.revision)[0]
    ?.resolution;
  entry.active = active;
  if (active) entry.lastUsedAt = Date.now();
  if (resolution) entry.controller.setResolution(resolution);
  entry.controller.setInteractive(interactive);
  entry.controller.setActive(active);
}
