import { unavailableDesktopConnectionOptions, type DesktopConnectionOptions } from '@task-handoff/protocol/control-plane-desktop';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useIsFocused } from 'expo-router/react-navigation';
import {
  directoryRemoteDesktopCapabilities,
  type ControlPlaneInstanceDirectoryEntry,
} from '@task-handoff/protocol/control-plane-directory';

import { useActiveDirectories } from '../directories/use-directories';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { subscribeToAppLifecycle, type MobileAppPhase } from '../platform/lifecycle';
import {
  acquireRemoteDesktopController,
  releaseRemoteDesktopControllerConsumer,
  updateRemoteDesktopControllerConsumer,
} from './controller-registry';
import type { RemoteDesktopController } from './controller';
import {
  canDisableTransport,
  defaultRemoteDesktopPreferences,
  remoteDesktopPreferenceStore,
  remoteDesktopPreferencesFor,
  updateRemoteDesktopPreferences,
  type PersistedCaptureTarget,
  type RemoteDesktopCapturePrecision,
  type RemoteDesktopFrameRate,
  type RemoteDesktopMouseMode,
  type RemoteDesktopResolution,
  type RemoteDesktopTransportAvailability,
  type RemoteDesktopTransportKey,
} from './preferences';
import {
  rememberSessionRemoteDesktopLink,
  sessionRemoteDesktopLinkFor,
  sessionRemoteDesktopLinkStore,
  useSessionRemoteDesktopLink,
} from './session-links';
import { emptyRemoteDesktopSnapshot, type RemoteDesktopSnapshot } from './types';
import { useLatestRef } from './use-latest-ref';

const noSubscribe = () => () => undefined;

export type UseRemoteDesktopOptions = {
  sessionId?: string;
  interactive?: boolean;
  resolutionOverride?: RemoteDesktopResolution;
};

export function useRemoteDesktop(instanceId: string, options: UseRemoteDesktopOptions = {}) {
  const { interactive = true, resolutionOverride, sessionId } = options;
  const runtime = useMobileControlPlaneRuntime();
  const { controlPlaneId, state } = useActiveDirectories();
  const focused = useIsFocused();
  const [appPhase, setAppPhase] = useState<MobileAppPhase>('active');
  const active = focused && appPhase === 'active';
  const activeRef = useLatestRef(active);
  const interactiveRef = useLatestRef(interactive);
  const resolutionOverrideRef = useLatestRef(resolutionOverride);
  const controllerConsumerRef = useRef({});
  const optionsConsumerId = useId();
  const [acquired, setAcquired] = useState<{ key: string; controller: RemoteDesktopController }>();
  const runtimeKey = runtime.api && runtime.transport && controlPlaneId
    ? JSON.stringify([controlPlaneId, instanceId, sessionId || 'direct'])
    : undefined;
  const controller = acquired && acquired.key === runtimeKey ? acquired.controller : undefined;
  const instance = state.instances.find((candidate) => candidate.id === instanceId);
  const capability = directoryRemoteDesktopCapabilities(instance?.capabilities);
  const videoCodecKey = capability?.video.codecs.join(',') ?? '';
  const videoCodecs = useMemo(
    () => videoCodecKey ? videoCodecKey.split(',') : [],
    [videoCodecKey],
  );
  const sessionLink = useSessionRemoteDesktopLink(controlPlaneId, instanceId, sessionId || '__direct__');

  const storedPreferences = useSyncExternalStore(
    remoteDesktopPreferenceStore.subscribe,
    () => remoteDesktopPreferencesFor(controlPlaneId, instanceId),
    () => remoteDesktopPreferencesFor(controlPlaneId, instanceId),
  );
  const [optionState, setOptionState] = useState<{ key: string; value: DesktopConnectionOptions | null }>();
  const connectionOptions = optionState && optionState.key === runtimeKey ? optionState.value ?? unavailableDesktopConnectionOptions : unavailableDesktopConnectionOptions;
  const customConfigured = connectionOptions.customTurn.configured;
  const effectiveAvailability = useMemo(() => ({ ...storedPreferences.transportAvailability, turn: storedPreferences.transportAvailability.turn && customConfigured }), [storedPreferences.transportAvailability, customConfigured]);
  const effectiveAvailabilityRef = useLatestRef(effectiveAvailability);
  const optionsReady = Boolean(optionState && optionState.key === runtimeKey);
  const optionsReadyRef = useLatestRef(optionsReady);
  useEffect(() => {
    if (!runtime.api || !runtime.coordinator || !runtimeKey) return;
    let live = true;
    let generation = 0;
    const refresh = async (signal?: AbortSignal) => {
      const current = ++generation;
      const value = await runtime.api!.remoteDesktop.connectionOptions(instanceId, signal);
      if (live && current === generation) setOptionState(previous => previous?.key === runtimeKey && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { key: runtimeKey, value });
    };
    const unregister = runtime.coordinator.register({
      key: `desktop-connection-options:${instanceId}:${optionsConsumerId}`,
      topics: ['desktop-connection-options'], snapshotTopics: ['desktop-connection-options'],
      start: refresh,
      stop: () => { generation++; },
      onEvent: event => { if (event.type === 'desktop-connection-options.changed') void refresh().catch(() => undefined); },
    });
    return () => { live = false; unregister(); };
  }, [runtime.api, runtime.coordinator, runtimeKey, instanceId, optionsConsumerId]);
  const controllerSnapshot = controller?.getSnapshot();
  // Stopping a session removes its link. Keep the controller's target after an
  // explicit stop so that removal alone cannot look like a source change and
  // restart the just-stopped controller.
  const target = sessionId
    ? sessionLink?.target
      ?? (controllerSnapshot?.phase === 'stopped' ? controllerSnapshot.target : undefined)
      ?? defaultRemoteDesktopPreferences.target
    : storedPreferences.target;
  const resolution = resolutionOverride ?? storedPreferences.resolution;
  const preferences = useMemo(() => ({ ...storedPreferences, resolution, target }), [resolution, storedPreferences, target]);

  useEffect(() => subscribeToAppLifecycle(setAppPhase), []);

  useEffect(() => {
    let live = true;
    if (!runtime.api || !runtime.transport || !controlPlaneId || !runtimeKey) return () => { live = false; };
    void Promise.all([remoteDesktopPreferenceStore.ready(), sessionRemoteDesktopLinkStore.ready()]).then(() => {
      if (!live || !runtime.api || !runtime.transport || !controlPlaneId) return;
      const current = remoteDesktopPreferencesFor(controlPlaneId, instanceId);
      const nextTarget = sessionId
        ? sessionRemoteDesktopLinkFor(controlPlaneId, instanceId, sessionId)?.target ?? defaultRemoteDesktopPreferences.target
        : current.target;
      const next = acquireRemoteDesktopController({
        controlPlaneId,
        api: runtime.api.remoteDesktop,
        transport: runtime.transport,
        instanceId,
        sessionId,
        active: activeRef.current && optionsReadyRef.current,
        interactive: interactiveRef.current,
        target: nextTarget,
        resolution: resolutionOverrideRef.current ?? current.resolution,
        frameRate: current.frameRate,
        capturePrecision: current.capturePrecision,
        transportAvailability: effectiveAvailabilityRef.current,
        videoCodecs,
      });
      setAcquired({ key: runtimeKey, controller: next });
    });
    return () => { live = false; };
  }, [activeRef, controlPlaneId, instanceId, interactiveRef, resolutionOverrideRef, runtime.api, runtime.transport, runtimeKey, sessionId, videoCodecs]);

  useEffect(() => {
    if (!controller) return;
    const scope = { controlPlaneId, instanceId, sessionId };
    const consumer = controllerConsumerRef.current;
    controller.setConnectionOptions(optionState && optionState.key === runtimeKey ? optionState.value : null);
    controller.setTransportAvailability(effectiveAvailability);
    updateRemoteDesktopControllerConsumer(scope, consumer, { active: active && optionsReady, interactive, resolution });
    if (active && optionState && optionState.key === runtimeKey) void controller.start();
    return () => {
      releaseRemoteDesktopControllerConsumer(scope, consumer);
    };
  }, [active, controlPlaneId, controller, instanceId, interactive, resolution, sessionId, optionState, runtimeKey, optionsReady, effectiveAvailability]);

  useEffect(() => {
    void controller?.switchTarget(target);
  }, [controller, target]);

  useEffect(() => {
    controller?.setFrameRate(storedPreferences.frameRate);
  }, [controller, storedPreferences.frameRate]);

  useEffect(() => {
    controller?.setCapturePrecision(storedPreferences.capturePrecision);
  }, [controller, storedPreferences.capturePrecision]);

  useEffect(() => {
    controller?.setVideoCodecs?.(videoCodecs);
  }, [controller, videoCodecs]);

  const controllerState: RemoteDesktopSnapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? (() => emptyRemoteDesktopSnapshot),
    controller?.getSnapshot ?? (() => emptyRemoteDesktopSnapshot),
  );

  const snapshot: RemoteDesktopSnapshot = { ...controllerState, connectionOptions, transportAvailability: effectiveAvailability };

  const setTarget = useCallback((nextTarget: PersistedCaptureTarget) => {
    if (sessionId) {
      rememberSessionRemoteDesktopLink({ controlPlaneId, instanceId, sessionId, target: nextTarget });
    } else {
      updateRemoteDesktopPreferences(controlPlaneId, instanceId, { target: nextTarget });
    }
  }, [controlPlaneId, instanceId, sessionId]);

  const setResolution = useCallback((resolution: RemoteDesktopResolution) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { resolution });
  }, [controlPlaneId, instanceId]);

  const setFrameRate = useCallback((frameRate: RemoteDesktopFrameRate) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { frameRate });
    controller?.setFrameRate(frameRate);
  }, [controlPlaneId, controller, instanceId]);

  const setCapturePrecision = useCallback((capturePrecision: RemoteDesktopCapturePrecision) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { capturePrecision });
    controller?.setCapturePrecision(capturePrecision);
  }, [controlPlaneId, controller, instanceId]);

  const setMouseMode = useCallback((mouseMode: RemoteDesktopMouseMode) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { mouseMode });
  }, [controlPlaneId, instanceId]);

  const setInputEnabled = useCallback((enabled: boolean) => {
    if (enabled) controller?.enableInput();
    else controller?.disableInput();
  }, [controller]);

  const setTransportAvailability = useCallback((availability: RemoteDesktopTransportAvailability) => {
    updateRemoteDesktopPreferences(controlPlaneId, instanceId, { transportAvailability: { ...availability } });
    controller?.setTransportAvailability({ ...availability, turn: availability.turn && customConfigured });
  }, [controlPlaneId, controller, instanceId, customConfigured]);

  const toggleTransport = useCallback((key: RemoteDesktopTransportKey) => {
    const current = remoteDesktopPreferencesFor(controlPlaneId, instanceId).transportAvailability;
    const next = { ...current, [key]: !current[key] };
    const enabling = next[key];
    if (key === 'turn' && !customConfigured) return;
    if (!enabling && !canDisableTransport(effectiveAvailability, key)) return;
    if (!next.p2p && !next.turn && !next.websocket) return;
    setTransportAvailability(next);
  }, [controlPlaneId, instanceId, setTransportAvailability, effectiveAvailability, customConfigured]);

  const disconnect = useCallback(async () => {
    await controller?.disconnect();
  }, [controller]);

  const reconnect = useCallback(async () => {
    await controller?.start();
  }, [controller]);

  const loadSources = useCallback(async (signal?: AbortSignal) => {
    if (!runtime.api) throw new Error('The active Control Plane client is unavailable.');
    return (await runtime.api.remoteDesktop.sources(instanceId, signal)).sources;
  }, [instanceId, runtime.api]);

  return {
    active,
    capability,
    controlPlaneId,
    controller,
    instance: instance as ControlPlaneInstanceDirectoryEntry | undefined,
    loadSources,
    preferences,
    ready: Boolean(runtime.api && runtime.transport && controller),
    reconnect,
    disconnect,
    setCapturePrecision,
    setFrameRate,
    setInputEnabled,
    setMouseMode,
    setResolution,
    setTarget,
    setTransportAvailability,
    snapshot,
    toggleTransport,
  };
}
