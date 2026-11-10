import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useIsFocused } from 'expo-router/react-navigation';
import {
  directoryRemoteDesktopCapabilities,
  type ControlPlaneInstanceDirectoryEntry,
} from '@task-handoff/protocol/control-plane-directory';

import { useActiveDirectories } from '../directories/use-directories';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { subscribeToAppLifecycle, type MobileAppPhase } from '../platform/lifecycle';
import { acquireRemoteDesktopController } from './controller-registry';
import type { RemoteDesktopController } from './controller';
import {
  canDisableTransport,
  remoteDesktopPreferenceStore,
  remoteDesktopPreferencesFor,
  updateRemoteDesktopPreferences,
  type PersistedCaptureTarget,
  type RemoteDesktopFrameRate,
  type RemoteDesktopMouseMode,
  type RemoteDesktopResolution,
  type RemoteDesktopTransportAvailability,
  type RemoteDesktopTransportKey,
} from './preferences';
import { emptyRemoteDesktopSnapshot, type RemoteDesktopSnapshot } from './types';
import { useLatestRef } from './use-latest-ref';

const noSubscribe = () => () => undefined;

export function useRemoteDesktop(instanceId: string) {
  const runtime = useMobileControlPlaneRuntime();
  const { controlPlaneId, state } = useActiveDirectories();
  const focused = useIsFocused();
  const [appPhase, setAppPhase] = useState<MobileAppPhase>('active');
  const active = focused && appPhase === 'active';
  const activeRef = useLatestRef(active);
  const [acquired, setAcquired] = useState<{ key: string; controller: RemoteDesktopController }>();
  const runtimeKey = runtime.api && runtime.transport && controlPlaneId ? `${controlPlaneId}:${instanceId}` : undefined;
  const controller = acquired && acquired.key === runtimeKey ? acquired.controller : undefined;
  const instance = state.instances.find((candidate) => candidate.id === instanceId);
  const capability = directoryRemoteDesktopCapabilities(instance?.capabilities);

  const preferences = useSyncExternalStore(
    remoteDesktopPreferenceStore.subscribe,
    () => remoteDesktopPreferencesFor(controlPlaneId, instanceId),
    () => remoteDesktopPreferencesFor(controlPlaneId, instanceId),
  );

  useEffect(() => subscribeToAppLifecycle(setAppPhase), []);

  useEffect(() => {
    let live = true;
    if (!runtime.api || !runtime.transport || !controlPlaneId || !runtimeKey) return () => { live = false; };
    void remoteDesktopPreferenceStore.ready().then(() => {
      if (!live || !runtime.api || !runtime.transport || !controlPlaneId) return;
      const current = remoteDesktopPreferencesFor(controlPlaneId, instanceId);
      const next = acquireRemoteDesktopController({
        controlPlaneId,
        api: runtime.api.remoteDesktop,
        transport: runtime.transport,
        instanceId,
        active: activeRef.current,
        target: current.target,
        resolution: current.resolution,
        frameRate: current.frameRate,
        transportAvailability: current.transportAvailability,
      });
      setAcquired({ key: runtimeKey, controller: next });
    });
    return () => { live = false; };
  }, [activeRef, controlPlaneId, instanceId, runtime.api, runtime.transport, runtimeKey]);

  useEffect(() => {
    if (!controller) return;
    controller.setActive(active);
    if (active) void controller.start();
    return () => { controller.setActive(false); };
  }, [active, controller]);

  useEffect(() => {
    void controller?.switchTarget(preferences.target);
  }, [controller, preferences.target]);

  useEffect(() => {
    controller?.setResolution(preferences.resolution);
  }, [controller, preferences.resolution]);

  useEffect(() => {
    controller?.setFrameRate(preferences.frameRate);
  }, [controller, preferences.frameRate]);

  useEffect(() => {
    controller?.setTransportAvailability(preferences.transportAvailability);
  }, [controller, preferences.transportAvailability]);

  const snapshot: RemoteDesktopSnapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? (() => emptyRemoteDesktopSnapshot),
    controller?.getSnapshot ?? (() => emptyRemoteDesktopSnapshot),
  );

  const setTarget = useCallback((target: PersistedCaptureTarget) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { target });
    void controller?.switchTarget(target);
  }, [controlPlaneId, controller, instanceId]);

  const setResolution = useCallback((resolution: RemoteDesktopResolution) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { resolution });
    controller?.setResolution(resolution);
  }, [controlPlaneId, controller, instanceId]);

  const setFrameRate = useCallback((frameRate: RemoteDesktopFrameRate) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { frameRate });
    controller?.setFrameRate(frameRate);
  }, [controlPlaneId, controller, instanceId]);

  const setMouseMode = useCallback((mouseMode: RemoteDesktopMouseMode) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { mouseMode });
  }, [controlPlaneId, instanceId]);

  const setTransportAvailability = useCallback((availability: RemoteDesktopTransportAvailability) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { transportAvailability: { ...availability } });
    controller?.setTransportAvailability(availability);
  }, [controlPlaneId, controller, instanceId]);

  const toggleTransport = useCallback((key: RemoteDesktopTransportKey) => {
    const current = remoteDesktopPreferencesFor(controlPlaneId, instanceId).transportAvailability;
    const next = { ...current, [key]: !current[key] };
    const enabling = next[key];
    if (!enabling && !canDisableTransport(current, key)) return;
    if (!next.p2p && !next.turn && !next.websocket) return;
    setTransportAvailability(next);
  }, [controlPlaneId, instanceId, setTransportAvailability]);

  const disconnect = useCallback(async () => {
    await controller?.disconnect();
  }, [controller]);

  const reconnect = useCallback(async () => {
    await controller?.start();
  }, [controller]);

  const loadWindows = useCallback(async (signal?: AbortSignal) => {
    if (!runtime.api) throw new Error('The active Control Plane client is unavailable.');
    return (await runtime.api.remoteDesktop.windows(instanceId, signal)).windows;
  }, [instanceId, runtime.api]);

  return {
    active,
    capability,
    controller,
    instance: instance as ControlPlaneInstanceDirectoryEntry | undefined,
    loadWindows,
    preferences,
    ready: Boolean(runtime.api && runtime.transport && controller),
    reconnect,
    disconnect,
    setFrameRate,
    setMouseMode,
    setResolution,
    setTarget,
    setTransportAvailability,
    snapshot,
    toggleTransport,
  };
}
