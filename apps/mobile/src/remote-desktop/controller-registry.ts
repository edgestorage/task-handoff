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
  consumers: Map<object, RemoteDesktopControllerConsumerState>;
  lastUsedAt: number;
};

export type RemoteDesktopControllerConsumerState = {
  active: boolean;
  interactive: boolean;
};

export const MAX_RETAINED_REMOTE_DESKTOP_CONTROLLERS = 2;

const entries = new Map<string, Entry>();

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
    consumers: new Map(),
    lastUsedAt: Date.now(),
  });
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
  entry.consumers.set(consumer, state);
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
  while (entries.size > MAX_RETAINED_REMOTE_DESKTOP_CONTROLLERS) {
    const candidate = [...entries.entries()]
      .filter(([key, entry]) => key !== keepKey && !entry.active)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (!candidate) return;
    entries.delete(candidate[0]);
    void candidate[1].controller.close();
  }
}

function syncEntryActivation(entry: Entry) {
  const consumers = [...entry.consumers.values()];
  const active = consumers.some((consumer) => consumer.active);
  const interactive = consumers.some((consumer) => consumer.active && consumer.interactive);
  entry.active = active;
  if (active) entry.lastUsedAt = Date.now();
  entry.controller.setInteractive(interactive);
  entry.controller.setActive(active);
}
