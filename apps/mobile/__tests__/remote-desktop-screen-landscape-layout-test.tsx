import { act, render, within } from '@testing-library/react-native';
import { Animated, DeviceEventEmitter, Dimensions, StyleSheet } from 'react-native';

import { RemoteDesktopScreen } from '../src/remote-desktop/RemoteDesktopScreen';

const originalScreen = Dimensions.get('screen');
const originalWindow = Dimensions.get('window');
let mockNativeLandscapeSide: 'left' | 'right' | undefined;
let mockNativeOrientationListener: ((side: 'left' | 'right') => void) | undefined;

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
const mockInsets = { bottom: 0, left: 0, right: 0, top: 0 };
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock('../modules/task-handoff-remote-desktop/src', () => ({
  currentRemoteDesktopLandscapeSide: () => mockNativeLandscapeSide,
  startRemoteDesktopTextInputObservation: () => false,
  stopRemoteDesktopTextInputObservation: jest.fn(),
  subscribeRemoteDesktopOrientation: (listener: (side: 'left' | 'right') => void) => {
    mockNativeOrientationListener = listener;
    return { remove: jest.fn() };
  },
  subscribeRemoteDesktopTextInput: () => ({ remove: jest.fn() }),
}));
jest.mock('../src/components/Icon', () => {
  const { View } = require('react-native');
  return { Icon: ({ name }: { name: string }) => <View testID={`icon-${name}`} /> };
});
jest.mock('../src/components/theme', () => ({
  useMobileTheme: () => ({
    colors: {
      border: '#333333',
      error: '#ff3b30',
      errorSoft: '#331111',
      primary: '#0a84ff',
      primarySoft: '#112b49',
      surface: '#17181c',
      text: '#f2f2f7',
      textMuted: '#8e8e93',
    },
  }),
}));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../src/platform/keyboard', () => ({
  subscribeToKeyboardState: () => jest.fn(),
}));
jest.mock('../src/remote-desktop/RemoteDesktopConnectionInfo', () => ({
  RemoteDesktopConnectionInfo: () => null,
}));
jest.mock('../src/remote-desktop/RemoteDesktopSettingsMenu', () => ({
  RemoteDesktopSettingsMenu: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/remote-desktop/RemoteDesktopSourcePicker', () => ({
  RemoteDesktopSourcePicker: () => null,
}));
jest.mock('../src/remote-desktop/RemoteDesktopToolbar', () => ({
  RemoteDesktopToolbar: () => null,
}));
jest.mock('../src/remote-desktop/RemoteDesktopTouchSurface', () => {
  const { View } = require('react-native');
  return { RemoteDesktopTouchSurface: () => <View testID="remote-desktop-touch-surface" /> };
});
jest.mock('../src/remote-desktop/RemoteDesktopVirtualKeyboard', () => ({
  RemoteDesktopKeyboardBar: () => null,
  RemoteDesktopVirtualKeyboard: () => null,
}));
jest.mock('../src/remote-desktop/use-remote-desktop', () => {
  const { emptyRemoteDesktopSnapshot } = require('../src/remote-desktop/types');
  return { useRemoteDesktop: () => ({
    capability: { available: true, capture: { precisionModes: [] }, features: { clipboard: false }, sourceProviders: [] },
    controller: undefined,
    disconnect: jest.fn(),
    instance: { id: 'instance-1' },
    loadSources: jest.fn(async () => []),
    preferences: { mouseMode: 'direct' },
    ready: true,
    reconnect: jest.fn(),
    setCapturePrecision: jest.fn(),
    setClipboardEnabled: jest.fn(),
    setFrameRate: jest.fn(),
    setInputEnabled: jest.fn(),
    setMouseMode: jest.fn(),
    setResolution: jest.fn(),
    setTarget: jest.fn(),
    snapshot: {
      ...emptyRemoteDesktopSnapshot,
      inputEnabled: true,
      isController: true,
      path: 'websocket',
      phase: 'connected',
      target: { height: 1080, kind: 'display', sourceRef: 'display-1', width: 1920 },
      videoHeight: 1080,
      videoWidth: 1920,
      viewerCount: 3,
    },
    toggleTransport: jest.fn(),
  }) };
});

function setWindowSize(width: number, height: number) {
  const metrics = { fontScale: 1, height, scale: 3, width };
  Dimensions.set({ screen: metrics, window: metrics });
}

beforeEach(() => {
  mockInsets.bottom = 0;
  mockInsets.left = 0;
  mockInsets.right = 0;
  mockInsets.top = 0;
  mockNativeLandscapeSide = undefined;
  mockNativeOrientationListener = undefined;
  jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    reset: jest.fn(),
    start: (callback?: (result: { finished: boolean }) => void) => callback?.({ finished: true }),
    stop: jest.fn(),
  }) as never);
});

afterEach(() => {
  Dimensions.set({ screen: originalScreen, window: originalWindow });
  jest.restoreAllMocks();
});

test('landscape moves the title chrome into a left rail without consuming vertical height', async () => {
  setWindowSize(852, 393);
  const screen = await render(<RemoteDesktopScreen instanceId="instance-1" />);

  expect(screen.queryByTestId('remote-desktop-header')).toBeNull();
  const shell = screen.getByTestId('remote-desktop-landscape-shell');
  expect(StyleSheet.flatten(shell.props.style)).toEqual(expect.objectContaining({ flex: 1, flexDirection: 'row' }));

  const rail = screen.getByTestId('remote-desktop-landscape-rail');
  expect(StyleSheet.flatten(rail.props.style)).toEqual(expect.objectContaining({
    flexDirection: 'column',
    width: 52,
  }));
  expect(within(rail).getByTestId('remote-desktop-landscape-back')).toBeTruthy();
  const source = within(rail).getByTestId('remote-desktop-landscape-source');
  expect(StyleSheet.flatten(source.props.style)).toEqual(expect.objectContaining({ gap: 8 }));
  expect(within(source).getByTestId('icon-swap-horizontal-outline')).toBeTruthy();
  expect(StyleSheet.flatten(within(source).getByTestId('remote-desktop-landscape-source-icon').props.style)).toEqual(expect.objectContaining({
    borderRadius: 8,
    height: 30,
    width: 30,
  }));
  expect(within(source).getByTestId('remote-desktop-landscape-status-dot')).toBeTruthy();
  expect(within(source).getByTestId('remote-desktop-landscape-viewers')).toBeTruthy();
  expect(within(source).getByTestId('icon-eye-outline')).toBeTruthy();
  expect(within(source).getByText('3')).toBeTruthy();
  expect(within(source).queryByText('remoteDesktop.connected')).toBeNull();
  expect(within(rail).getByTestId('remote-desktop-landscape-transport')).toBeTruthy();
  expect(within(rail).getByTestId('remote-desktop-landscape-settings')).toBeTruthy();

  const stage = within(shell).getByTestId('remote-desktop-stage');
  expect(StyleSheet.flatten(stage.props.style)).toEqual(expect.objectContaining({ flex: 1 }));
  screen.unmount();
});

test('landscape rail follows the current notch side when the device direction flips', async () => {
  mockInsets.left = 44;
  mockInsets.right = 44;
  setWindowSize(852, 393);
  const screen = await render(<RemoteDesktopScreen instanceId="instance-1" />);

  const rail = screen.getByTestId('remote-desktop-landscape-rail');
  expect(StyleSheet.flatten(screen.getByTestId('remote-desktop-landscape-rail').props.style)).toEqual(expect.objectContaining({ paddingLeft: 4, width: 52 }));

  await act(async () => { DeviceEventEmitter.emit('namedOrientationDidChange', { name: 'landscape-secondary' }); });
  expect(StyleSheet.flatten(rail.props.style)).toEqual(expect.objectContaining({ paddingLeft: 48, width: 96 }));

  await act(async () => { DeviceEventEmitter.emit('namedOrientationDidChange', { name: 'landscape-primary' }); });
  expect(StyleSheet.flatten(rail.props.style)).toEqual(expect.objectContaining({ paddingLeft: 4, width: 52 }));
  screen.unmount();
});

test('landscape rail prefers the native UIKit orientation and follows its changes', async () => {
  mockInsets.left = 44;
  mockInsets.right = 44;
  mockNativeLandscapeSide = 'left';
  setWindowSize(852, 393);
  const screen = await render(<RemoteDesktopScreen instanceId="instance-1" />);

  expect(StyleSheet.flatten(screen.getByTestId('remote-desktop-landscape-rail').props.style)).toEqual(expect.objectContaining({ paddingLeft: 48, width: 96 }));

  await act(async () => { mockNativeOrientationListener?.('right'); });
  expect(StyleSheet.flatten(screen.getByTestId('remote-desktop-landscape-rail').props.style)).toEqual(expect.objectContaining({ paddingLeft: 4, width: 52 }));
  screen.unmount();
});

test('landscape rail re-reads the native orientation after a viewport rotation', async () => {
  mockInsets.left = 44;
  mockInsets.right = 44;
  setWindowSize(393, 852);
  const screen = await render(<RemoteDesktopScreen instanceId="instance-1" />);

  mockNativeLandscapeSide = 'left';
  await act(async () => { setWindowSize(852, 393); });

  const rail = screen.getByTestId('remote-desktop-landscape-rail');
  expect(StyleSheet.flatten(rail.props.style)).toEqual(expect.objectContaining({ paddingLeft: 48, width: 96 }));

  mockNativeLandscapeSide = 'right';
  await act(async () => { setWindowSize(393, 852); });
  await act(async () => { setWindowSize(852, 393); });

  expect(StyleSheet.flatten(screen.getByTestId('remote-desktop-landscape-rail').props.style)).toEqual(expect.objectContaining({ paddingLeft: 4, width: 52 }));
  screen.unmount();
});

test('portrait keeps the existing top header and omits the landscape rail', async () => {
  setWindowSize(393, 852);
  const screen = await render(<RemoteDesktopScreen instanceId="instance-1" />);

  expect(screen.getByTestId('remote-desktop-header')).toBeTruthy();
  expect(screen.getByTestId('remote-desktop-header-back')).toBeTruthy();
  expect(screen.getByTestId('remote-desktop-header-source')).toBeTruthy();
  expect(screen.queryByTestId('remote-desktop-landscape-rail')).toBeNull();
  screen.unmount();
});
