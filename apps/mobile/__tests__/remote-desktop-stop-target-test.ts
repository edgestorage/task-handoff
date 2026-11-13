import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';

import { emptyRemoteDesktopSnapshot, type RemoteDesktopSnapshot } from '../src/remote-desktop/types';
import type { PersistedCaptureTarget } from '../src/remote-desktop/preferences';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key); }),
  };
});
jest.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));
jest.mock('../src/platform/lifecycle', () => ({
  subscribeToAppLifecycle: () => () => undefined,
}));
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: jest.fn(),
}));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));

let mockSnapshot: RemoteDesktopSnapshot = { ...emptyRemoteDesktopSnapshot };
let mockListeners = new Set<() => void>();
const mockController = {
  getSnapshot: () => mockSnapshot,
  subscribe: (listener: () => void) => {
    mockListeners.add(listener);
    return () => { mockListeners.delete(listener); };
  },
  setInteractive: jest.fn(),
  setActive: jest.fn(),
  start: jest.fn(async () => undefined),
  switchTarget: jest.fn(async (target: PersistedCaptureTarget) => {
    mockSnapshot = { ...mockSnapshot, target };
    for (const listener of mockListeners) listener();
  }),
  setResolution: jest.fn(),
  setFrameRate: jest.fn(),
  setCapturePrecision: jest.fn(),
  setTransportAvailability: jest.fn(),
  close: jest.fn(async () => undefined),
};

jest.mock('../src/remote-desktop/controller-registry', () => {
  const { emptyRemoteDesktopSnapshot: emptySnapshot } = jest.requireActual('../src/remote-desktop/types') as typeof import('../src/remote-desktop/types');
  return {
    acquireRemoteDesktopController: jest.fn((input: { target: PersistedCaptureTarget }) => {
      mockSnapshot = { ...emptySnapshot, target: input.target };
      return mockController;
    }),
    releaseRemoteDesktopControllerConsumer: jest.fn(),
    updateRemoteDesktopControllerConsumer: jest.fn(),
  };
});

import {
  removeSessionRemoteDesktopLink,
  rememberSessionRemoteDesktopLink,
} from '../src/remote-desktop/session-links';
import { remoteDesktopPreferencesFor, updateRemoteDesktopPreferences } from '../src/remote-desktop/preferences';
import { useRemoteDesktop } from '../src/remote-desktop/use-remote-desktop';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

const controlPlaneId = 'cp_stop_target';
const instanceId = 'instance_stop_target';
const sessionId = 'session_stop_target';
const sessionTarget = { kind: 'window', sourceRef: 'window-help', title: 'Help window' };
const instanceTarget = { kind: 'display', sourceRef: 'display-primary', title: 'Primary display' };
const mockRuntime = { api: { remoteDesktop: {} }, transport: {} };
const mockDirectories = {
  controlPlaneId,
  state: { instances: [{ id: instanceId, capabilities: {} }] },
};

beforeEach(() => {
  (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  (useMobileControlPlaneRuntime as jest.Mock).mockReturnValue(mockRuntime);
  (useActiveDirectories as jest.Mock).mockReturnValue(mockDirectories);
  mockListeners = new Set();
  mockSnapshot = { ...emptyRemoteDesktopSnapshot };
  mockController.switchTarget.mockClear();
  mockController.start.mockClear();
  mockController.setResolution.mockClear();
  mockController.setCapturePrecision.mockClear();
  updateRemoteDesktopPreferences(controlPlaneId, instanceId, { target: instanceTarget });
  rememberSessionRemoteDesktopLink({ controlPlaneId, instanceId, sessionId, target: sessionTarget });
});

test('removing a stopped session link does not fall back and restart the controller', async () => {
  const hook = await renderHook(() => useRemoteDesktop(instanceId, { sessionId }));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.preferences.target.sourceRef).toBe('window-help');

  await act(async () => {
    mockSnapshot = { ...mockSnapshot, phase: 'stopped' };
    for (const listener of mockListeners) listener();
    removeSessionRemoteDesktopLink(controlPlaneId, instanceId, sessionId);
  });

  expect(hook.result.current.preferences.target.sourceRef).toBe('window-help');
  expect(mockController.switchTarget).not.toHaveBeenCalledWith(instanceTarget);
  hook.unmount();
});

test('switching a session target issues one controller transition', async () => {
  const hook = await renderHook(() => useRemoteDesktop(instanceId, { sessionId }));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await waitFor(() => expect(mockController.switchTarget).toHaveBeenCalled());
  mockController.switchTarget.mockClear();

  await act(async () => { hook.result.current.setTarget(instanceTarget); });

  await waitFor(() => expect(mockController.switchTarget).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  expect(mockController.switchTarget).toHaveBeenCalledTimes(1);
  expect(mockController.switchTarget).toHaveBeenCalledWith(instanceTarget);
  expect(hook.result.current.preferences.target).toEqual(instanceTarget);
  hook.unmount();
});

test('applies a preview resolution override without overwriting the instance preference', async () => {
  updateRemoteDesktopPreferences(controlPlaneId, instanceId, { resolution: 'auto' });
  const hook = await renderHook(() => useRemoteDesktop(instanceId, { resolutionOverride: '540p', sessionId }));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await waitFor(() => expect(mockController.setResolution).toHaveBeenLastCalledWith('540p'));
  expect(hook.result.current.preferences.resolution).toBe('540p');
  expect(remoteDesktopPreferencesFor(controlPlaneId, instanceId).resolution).toBe('auto');
  hook.unmount();
});
