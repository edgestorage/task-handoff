import { useEffect, useState, useSyncExternalStore } from 'react';

import { createDirectControlPlaneClient } from '../control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../control-plane/runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { MobileDirectoryController } from './controller';
import { mobileDirectoryStore } from './store';

export function useActiveDirectories() {
  const [controlPlaneId, setControlPlaneId] = useState<string>();
  useEffect(() => {
    let live = true;
    let controller: MobileDirectoryController | undefined;
    let unsubscribeNetwork: (() => void) | undefined;
    let unsubscribeLifecycle: (() => void) | undefined;
    void mobileProfileStore.active().then((profile) => {
      if (!live || !profile) return;
      const id = profile.identity.controlPlaneId;
      setControlPlaneId(id);
      const direct = createDirectControlPlaneClient(profile, mobileSecureStore);
      controller = new MobileDirectoryController(id, direct.api, mobileDirectoryStore, direct.transport);
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
      unsubscribeLifecycle = subscribeToAppLifecycle((phase) => { active = phase === 'active'; reconcile(); });
      unsubscribeNetwork = subscribeToNetworkState((network) => { connected = network.connected; reconcile(); });
    });
    return () => {
      live = false;
      unsubscribeNetwork?.();
      unsubscribeLifecycle?.();
      controller?.stop();
    };
  }, []);
  const empty = mobileDirectoryStore.profile(controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => controlPlaneId ? mobileDirectoryStore.subscribe(controlPlaneId, listener) : () => undefined,
    () => controlPlaneId ? mobileDirectoryStore.profile(controlPlaneId) : empty,
    () => empty,
  );
  return { controlPlaneId, state };
}
