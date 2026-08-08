import * as Network from 'expo-network';

import { subscribeToAppLifecycle } from './lifecycle';

export type MobileNetworkState = {
  connected: boolean;
  internetReachable: boolean | undefined;
  type: string;
};

function normalizeNetworkState(state: Network.NetworkState): MobileNetworkState {
  return {
    connected: state.isConnected === true && state.isInternetReachable !== false,
    internetReachable: state.isInternetReachable ?? undefined,
    type: state.type ?? 'UNKNOWN',
  };
}

export async function currentNetworkState() {
  return normalizeNetworkState(await Network.getNetworkStateAsync());
}

export function subscribeToNetworkState(listener: (state: MobileNetworkState) => void) {
  let live = true;
  let revision = 0;
  let initializedLifecycle = false;
  const refresh = () => {
    const currentRevision = ++revision;
    void currentNetworkState().then((state) => {
      if (live && currentRevision === revision) listener(state);
    }).catch(() => undefined);
  };
  const unsubscribeLifecycle = subscribeToAppLifecycle((phase) => {
    if (!initializedLifecycle || phase === 'active') refresh();
    initializedLifecycle = true;
  });
  const subscription = Network.addNetworkStateListener((state) => {
    revision += 1;
    listener(normalizeNetworkState(state));
  });
  return () => {
    live = false;
    revision += 1;
    unsubscribeLifecycle();
    subscription.remove();
  };
}
