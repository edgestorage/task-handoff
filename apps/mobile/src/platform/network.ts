import * as Network from 'expo-network';

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
  void currentNetworkState().then((state) => { if (live) listener(state); }).catch(() => undefined);
  const subscription = Network.addNetworkStateListener((state) => {
    listener(normalizeNetworkState(state));
  });
  return () => { live = false; subscription.remove(); };
}
