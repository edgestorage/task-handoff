import * as Network from 'expo-network';

import { subscribeToNetworkState } from '../src/platform/network';
import { subscribeToAppLifecycle, type MobileAppPhase } from '../src/platform/lifecycle';

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(),
  getNetworkStateAsync: jest.fn(),
}));

jest.mock('../src/platform/lifecycle', () => ({
  subscribeToAppLifecycle: jest.fn(),
}));

test('rechecks the current network state when the app returns to the foreground', async () => {
  let emitLifecycle: (phase: MobileAppPhase) => void = () => undefined;
  const removeLifecycle = jest.fn();
  const removeNetwork = jest.fn();
  jest.mocked(subscribeToAppLifecycle).mockImplementation((listener) => {
    emitLifecycle = listener;
    listener('active');
    return removeLifecycle;
  });
  jest.mocked(Network.addNetworkStateListener).mockReturnValue({ remove: removeNetwork });
  jest.mocked(Network.getNetworkStateAsync)
    .mockResolvedValueOnce({ isConnected: false, isInternetReachable: false, type: 'WIFI' } as never)
    .mockResolvedValueOnce({ isConnected: true, isInternetReachable: true, type: 'WIFI' } as never);
  const listener = jest.fn();

  const unsubscribe = subscribeToNetworkState(listener);
  await Promise.resolve();
  await Promise.resolve();
  expect(listener).toHaveBeenLastCalledWith({ connected: false, internetReachable: false, type: 'WIFI' });

  emitLifecycle('background');
  expect(Network.getNetworkStateAsync).toHaveBeenCalledTimes(1);
  emitLifecycle('active');
  await Promise.resolve();
  await Promise.resolve();

  expect(Network.getNetworkStateAsync).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenLastCalledWith({ connected: true, internetReachable: true, type: 'WIFI' });

  unsubscribe();
  expect(removeLifecycle).toHaveBeenCalledTimes(1);
  expect(removeNetwork).toHaveBeenCalledTimes(1);
});
