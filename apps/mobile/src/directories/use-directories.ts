import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { ControlPlaneInstanceAction } from '@task-handoff/protocol/control-plane-directory';

import { isCarPlayConnected, subscribeToCarPlayConnection } from '../carplay/runtime';
import { createMobileControlPlaneClient } from '../control-plane/client';
import type { MobileControlPlaneProfile } from '../control-plane/profile';
import {
  MobileControlPlaneRuntimeProvider,
  useMobileControlPlaneRuntime,
  useOptionalMobileControlPlaneRuntime,
  type MobileControlPlaneRuntimeDependencies,
} from '../control-plane/use-mobile-control-plane-runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { MobileDirectoryController } from './controller';
import { mobileDirectoryStore } from './store';

type ActiveDirectories = {
  controlPlaneId?: string;
  controlPlaneOrigin?: string;
  refresh(): Promise<void>;
  state: ReturnType<typeof mobileDirectoryStore.profile>;
  updateInstanceName(instanceId: string, name: string): Promise<void>;
  updateNodeName(nodeId: string, name: string): Promise<void>;
  runInstanceAction(instanceId: string, action: ControlPlaneInstanceAction): Promise<void>;
};
const Context = createContext<ActiveDirectories | undefined>(undefined);

export type ActiveDirectoriesDependencies = {
  activeProfile(): Promise<MobileControlPlaneProfile | undefined>;
  subscribeProfiles(listener: () => void): () => void;
  createClient(profile: MobileControlPlaneProfile): ReturnType<typeof createMobileControlPlaneClient>;
  subscribeLifecycle: typeof subscribeToAppLifecycle;
  subscribeNetwork: typeof subscribeToNetworkState;
  subscribeCarPlay?: MobileControlPlaneRuntimeDependencies['subscribeCarPlay'];
  carPlayConnected?: MobileControlPlaneRuntimeDependencies['carPlayConnected'];
};

export function ActiveDirectoriesProvider({ children, dependencies }: { children: ReactNode; dependencies?: ActiveDirectoriesDependencies }): ReactNode {
  const runtime = useOptionalMobileControlPlaneRuntime();
  if (!runtime) {
    const runtimeDependencies = dependencies ? {
      ...dependencies,
      subscribeCarPlay: dependencies.subscribeCarPlay ?? subscribeToCarPlayConnection,
      carPlayConnected: dependencies.carPlayConnected ?? isCarPlayConnected,
    } : undefined;
    return createElement(MobileControlPlaneRuntimeProvider, { dependencies: runtimeDependencies },
      createElement(ActiveDirectoriesProvider, null, children),
    );
  }
  return createElement(ActiveDirectoriesBoundary, null, children);
}

function ActiveDirectoriesBoundary({ children }: { children: ReactNode }) {
  const runtime = useMobileControlPlaneRuntime();
  const controller = useMemo(() => runtime.controlPlaneId && runtime.api
    ? new MobileDirectoryController(runtime.controlPlaneId, runtime.api, mobileDirectoryStore)
    : undefined, [runtime.api, runtime.controlPlaneId]);
  useEffect(() => {
    if (!runtime.coordinator || !controller) return;
    return runtime.coordinator.register({
      key: 'directories',
      topics: ['instances', 'node.state', 'nodes'],
      start: (signal) => controller.start(signal, { managed: true }),
      stop: () => controller.stop(),
      offline: () => controller.offline(),
      onEvent: (event) => { controller.applyEvent(event); },
      onConnectionError: (error) => controller.onConnectionError(error),
    });
  }, [controller, runtime.coordinator]);
  const empty = mobileDirectoryStore.profile(runtime.controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => runtime.controlPlaneId ? mobileDirectoryStore.subscribe(runtime.controlPlaneId, listener) : () => undefined,
    () => runtime.controlPlaneId ? mobileDirectoryStore.profile(runtime.controlPlaneId) : empty,
    () => empty,
  );
  const updateInstanceName = useCallback(async (instanceId: string, name: string) => {
    if (!controller) throw new Error('The active Control Plane directory is unavailable.');
    await controller.updateInstanceName(instanceId, name);
  }, [controller]);
  const updateNodeName = useCallback(async (nodeId: string, name: string) => {
    if (!controller) throw new Error('The active Control Plane directory is unavailable.');
    await controller.updateNodeName(nodeId, name);
  }, [controller]);
  const runInstanceAction = useCallback(async (instanceId: string, action: ControlPlaneInstanceAction) => {
    if (!controller) throw new Error('The active Control Plane directory is unavailable.');
    await controller.runInstanceAction(instanceId, action);
  }, [controller]);
  const refresh = useCallback(async () => {
    if (!controller) throw new Error('The active Control Plane directory is unavailable.');
    await controller.refresh();
  }, [controller]);
  const value = useMemo(() => ({
    controlPlaneId: runtime.controlPlaneId,
    controlPlaneOrigin: runtime.controlPlaneOrigin,
    refresh,
    state,
    updateInstanceName,
    updateNodeName,
    runInstanceAction,
  }), [refresh, runtime.controlPlaneId, runtime.controlPlaneOrigin, runInstanceAction, state, updateInstanceName, updateNodeName]);
  return createElement(Context.Provider, { value }, children);
}

export function useActiveDirectories() {
  const value = useContext(Context);
  if (!value) throw new Error('useActiveDirectories must be used inside ActiveDirectoriesProvider.');
  return value;
}

const emptyInstances: ReturnType<typeof mobileDirectoryStore.profile>['instances'] = [];

export function useActiveDirectoryInstances() {
  const { controlPlaneId } = useMobileControlPlaneRuntime();
  return useSyncExternalStore(
    (listener) => controlPlaneId
      ? mobileDirectoryStore.subscribeInstances(controlPlaneId, listener)
      : () => undefined,
    () => controlPlaneId ? mobileDirectoryStore.profile(controlPlaneId).instances : emptyInstances,
    () => emptyInstances,
  );
}
