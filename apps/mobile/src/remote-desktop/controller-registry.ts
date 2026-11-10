import type { createControlPlaneRemoteDesktopApi } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneTransport } from '../control-plane/transport';
import { RemoteDesktopController } from './controller';
import type {
  PersistedCaptureTarget,
  RemoteDesktopFrameRate,
  RemoteDesktopResolution,
  RemoteDesktopTransportAvailability,
} from './preferences';

type RemoteDesktopApi = ReturnType<typeof createControlPlaneRemoteDesktopApi>;

type Entry = {
  api: RemoteDesktopApi;
  transport: MobileControlPlaneTransport;
  controller: RemoteDesktopController;
};

const entries = new Map<string, Entry>();

export function remoteDesktopControllerKey(controlPlaneId: string | undefined, instanceId: string) {
  return `${controlPlaneId || 'direct'}:${instanceId}`;
}

export function acquireRemoteDesktopController(input: {
  controlPlaneId?: string;
  api: RemoteDesktopApi;
  transport: MobileControlPlaneTransport;
  instanceId: string;
  active: boolean;
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  transportAvailability: RemoteDesktopTransportAvailability;
}) {
  const key = remoteDesktopControllerKey(input.controlPlaneId, input.instanceId);
  const existing = entries.get(key);
  if (existing && existing.api === input.api && existing.transport === input.transport) return existing.controller;
  if (existing) void existing.controller.close();
  const controller = new RemoteDesktopController({
    api: input.api,
    transport: input.transport,
    instanceId: input.instanceId,
    active: input.active,
    target: input.target,
    resolution: input.resolution,
    frameRate: input.frameRate,
    transportAvailability: input.transportAvailability,
  });
  entries.set(key, { api: input.api, transport: input.transport, controller });
  return controller;
}

export function forgetRemoteDesktopController(controlPlaneId: string | undefined, instanceId: string) {
  const key = remoteDesktopControllerKey(controlPlaneId, instanceId);
  const entry = entries.get(key);
  entries.delete(key);
  return entry?.controller;
}
