import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { createDirectControlPlaneClient } from '../control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../control-plane/runtime';
import { subscribeToNetworkState } from '../platform/network';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { MobileAiSessionController } from './controller';
import { mobileAiSessionStore } from './store';
import type { MobileControlPlaneProfile } from '../control-plane/profile';

type ActiveAiSessions = {
  controlPlaneId?: string;
  state: ReturnType<typeof mobileAiSessionStore.profile>;
};

const ActiveAiSessionsContext = createContext<ActiveAiSessions | undefined>(undefined);

export type ActiveAiSessionsDependencies = {
  activeProfile(): Promise<MobileControlPlaneProfile | undefined>;
  subscribeProfiles(listener: () => void): () => void;
  createClient(profile: MobileControlPlaneProfile): ReturnType<typeof createDirectControlPlaneClient>;
  subscribeLifecycle: typeof subscribeToAppLifecycle;
  subscribeNetwork: typeof subscribeToNetworkState;
};

const defaultDependencies: ActiveAiSessionsDependencies = {
  activeProfile: () => mobileProfileStore.active(),
  subscribeProfiles: (listener) => mobileProfileStore.subscribe(listener),
  createClient: (profile) => createDirectControlPlaneClient(profile, mobileSecureStore),
  subscribeLifecycle: subscribeToAppLifecycle,
  subscribeNetwork: subscribeToNetworkState,
};

export function ActiveAiSessionsProvider({
  children,
  dependencies = defaultDependencies,
}: {
  children: ReactNode;
  dependencies?: ActiveAiSessionsDependencies;
}) {
  const value = useActiveAiSessionsRuntime(dependencies);
  return createElement(ActiveAiSessionsContext.Provider, { value }, children);
}

export function useActiveAiSessions() {
  const value = useContext(ActiveAiSessionsContext);
  if (!value) throw new Error('useActiveAiSessions must be used inside ActiveAiSessionsProvider.');
  return value;
}

function useActiveAiSessionsRuntime(dependencies: ActiveAiSessionsDependencies): ActiveAiSessions {
  const [controlPlaneId, setControlPlaneId] = useState<string>();
  useEffect(() => {
    let live = true;
    let activation = 0;
    let controller: MobileAiSessionController | undefined;
    let unsubscribeNetwork: (() => void) | undefined;
    let unsubscribeLifecycle: (() => void) | undefined;

    const stopRuntime = () => {
      unsubscribeNetwork?.();
      unsubscribeLifecycle?.();
      unsubscribeNetwork = undefined;
      unsubscribeLifecycle = undefined;
      controller?.stop();
      controller = undefined;
    };
    const activate = async () => {
      const currentActivation = ++activation;
      const profile = await dependencies.activeProfile();
      if (!live || currentActivation !== activation) return;
      stopRuntime();
      if (!profile) {
        setControlPlaneId(undefined);
        return;
      }
      const id = profile.identity.controlPlaneId;
      setControlPlaneId(id);
      const { api, transport } = dependencies.createClient(profile);
      controller = new MobileAiSessionController(id, api, transport, mobileAiSessionStore);
      const storeGeneration = mobileAiSessionStore.generation(id);
      let active = false;
      let connected = true;
      let running = false;
      const reconcile = () => {
        const shouldRun = active && connected;
        if (shouldRun === running) return;
        running = shouldRun;
        if (shouldRun) void controller?.start().catch(() => undefined);
        else controller?.stop();
      };
      unsubscribeLifecycle = dependencies.subscribeLifecycle((phase) => { active = phase === 'active'; reconcile(); });
      unsubscribeNetwork = dependencies.subscribeNetwork((network) => {
        connected = network.connected;
        if (!connected && mobileAiSessionStore.isGeneration(id, storeGeneration)) {
          mobileAiSessionStore.setSyncState(id, {
            phase: 'offline',
            lastSyncedAt: mobileAiSessionStore.profile(id).sync.lastSyncedAt,
          });
        }
        reconcile();
      });
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
  const empty = mobileAiSessionStore.profile(controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => controlPlaneId ? mobileAiSessionStore.subscribe(controlPlaneId, listener) : () => undefined,
    () => controlPlaneId ? mobileAiSessionStore.profile(controlPlaneId) : empty,
    () => empty,
  );
  return { controlPlaneId, state };
}
