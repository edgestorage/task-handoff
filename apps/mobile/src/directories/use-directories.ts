import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { createDirectControlPlaneClient } from '../control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../control-plane/runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { MobileDirectoryController } from './controller';
import { mobileDirectoryStore } from './store';
import type { MobileControlPlaneProfile } from '../control-plane/profile';

type ActiveDirectories = {
  controlPlaneId?: string;
  controlPlaneOrigin?: string;
  state: ReturnType<typeof mobileDirectoryStore.profile>;
  updateInstanceName(instanceId: string, name: string): Promise<void>;
  updateNodeName(nodeId: string, name: string): Promise<void>;
};
const Context = createContext<ActiveDirectories | undefined>(undefined);

export type ActiveDirectoriesDependencies = {
  activeProfile(): Promise<MobileControlPlaneProfile | undefined>;
  subscribeProfiles(listener: () => void): () => void;
  createClient(profile: MobileControlPlaneProfile): ReturnType<typeof createDirectControlPlaneClient>;
  subscribeLifecycle: typeof subscribeToAppLifecycle;
  subscribeNetwork: typeof subscribeToNetworkState;
};

const defaultDependencies: ActiveDirectoriesDependencies = {
  activeProfile: () => mobileProfileStore.active(),
  subscribeProfiles: (listener) => mobileProfileStore.subscribe(listener),
  createClient: (profile) => createDirectControlPlaneClient(profile, mobileSecureStore),
  subscribeLifecycle: subscribeToAppLifecycle,
  subscribeNetwork: subscribeToNetworkState,
};

export function ActiveDirectoriesProvider({
  children,
  dependencies = defaultDependencies,
}: {
  children: ReactNode;
  dependencies?: ActiveDirectoriesDependencies;
}) {
  const value = useActiveDirectoriesRuntime(dependencies);
  return createElement(Context.Provider, { value }, children);
}

export function useActiveDirectories() {
  const value = useContext(Context);
  if (!value) throw new Error('useActiveDirectories must be used inside ActiveDirectoriesProvider.');
  return value;
}

function useActiveDirectoriesRuntime(dependencies: ActiveDirectoriesDependencies): ActiveDirectories {
  const [controlPlaneId, setControlPlaneId] = useState<string>();
  const [controlPlaneOrigin, setControlPlaneOrigin] = useState<string>();
  const controllerRef = useRef<MobileDirectoryController | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let activation = 0;
    let controller: MobileDirectoryController | undefined;
    let unsubscribeNetwork: (() => void) | undefined;
    let unsubscribeLifecycle: (() => void) | undefined;

    const stopRuntime = () => {
      unsubscribeNetwork?.();
      unsubscribeLifecycle?.();
      unsubscribeNetwork = undefined;
      unsubscribeLifecycle = undefined;
      controller?.stop();
      if (controllerRef.current === controller) controllerRef.current = undefined;
      controller = undefined;
    };
    const activate = async () => {
      const currentActivation = ++activation;
      const profile = await dependencies.activeProfile();
      if (!live || currentActivation !== activation) return;
      stopRuntime();
      if (!profile) {
        setControlPlaneId(undefined);
        setControlPlaneOrigin(undefined);
        return;
      }
      const id = profile.identity.controlPlaneId;
      setControlPlaneId(id);
      setControlPlaneOrigin(profile.access.origin);
      const direct = dependencies.createClient(profile);
      controller = new MobileDirectoryController(id, direct.api, mobileDirectoryStore, direct.transport);
      controllerRef.current = controller;
      let active = false;
      let connected = true;
      let running = false;
      const reconcile = () => {
        const shouldRun = active && connected;
        if (shouldRun === running) return;
        running = shouldRun;
        if (shouldRun) void controller?.start().catch(() => undefined);
        else if (!connected) controller?.offline();
        else controller?.stop();
      };
      unsubscribeLifecycle = dependencies.subscribeLifecycle((phase) => { active = phase === 'active'; reconcile(); });
      unsubscribeNetwork = dependencies.subscribeNetwork((network) => { connected = network.connected; reconcile(); });
    };
    const unsubscribeProfiles = dependencies.subscribeProfiles(() => { void activate(); });
    void activate();
    return () => {
      live = false;
      activation += 1;
      unsubscribeProfiles();
      stopRuntime();
    };
  }, [dependencies]);
  const empty = mobileDirectoryStore.profile(controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => controlPlaneId ? mobileDirectoryStore.subscribe(controlPlaneId, listener) : () => undefined,
    () => controlPlaneId ? mobileDirectoryStore.profile(controlPlaneId) : empty,
    () => empty,
  );
  const updateInstanceName = useCallback(async (instanceId: string, name: string) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('The active Control Plane directory is unavailable.');
    await controller.updateInstanceName(instanceId, name);
  }, []);
  const updateNodeName = useCallback(async (nodeId: string, name: string) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('The active Control Plane directory is unavailable.');
    await controller.updateNodeName(nodeId, name);
  }, []);
  return { controlPlaneId, controlPlaneOrigin, state, updateInstanceName, updateNodeName };
}
