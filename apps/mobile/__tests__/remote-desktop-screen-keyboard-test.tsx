import { act, fireEvent, render } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';

import type { MobileKeyboardState } from '../src/platform/keyboard';
import { RemoteDesktopScreen } from '../src/remote-desktop/RemoteDesktopScreen';

const mockKeyboardListeners: Array<(state: MobileKeyboardState) => void> = [];

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
jest.mock('../modules/task-handoff-remote-desktop/src', () => ({
  startRemoteDesktopTextInputObservation: () => false,
  stopRemoteDesktopTextInputObservation: jest.fn(),
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
      surface: '#17181c',
      text: '#f2f2f7',
    },
  }),
}));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../src/platform/keyboard', () => ({
  subscribeToKeyboardState: (listener: (state: MobileKeyboardState) => void) => {
    mockKeyboardListeners.push(listener);
    return jest.fn();
  },
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
jest.mock('../src/remote-desktop/RemoteDesktopToolbar', () => {
  const { Pressable } = require('react-native');
  return { RemoteDesktopToolbar: ({ onKeyboard }: { onKeyboard(): void }) => <Pressable onPress={onKeyboard} testID="show-keyboard" /> };
});
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
    capability: { available: true, capture: { precisionModes: [] }, sourceProviders: [] },
    controller: undefined,
    disconnect: jest.fn(),
    instance: { id: 'instance-1' },
    loadSources: jest.fn(async () => []),
    preferences: { mouseMode: 'direct' },
    ready: true,
    reconnect: jest.fn(),
    setCapturePrecision: jest.fn(),
    setFrameRate: jest.fn(),
    setInputEnabled: jest.fn(),
    setMouseMode: jest.fn(),
    setResolution: jest.fn(),
    setTarget: jest.fn(),
    snapshot: {
      ...emptyRemoteDesktopSnapshot,
      inputEnabled: true,
      isController: true,
      phase: 'connected',
      target: { height: 1080, kind: 'display', sourceRef: 'display-1', width: 1920 },
      videoHeight: 1080,
      videoWidth: 1920,
    },
    toggleTransport: jest.fn(),
  }) };
});

beforeEach(() => {
  mockKeyboardListeners.length = 0;
  jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    reset: jest.fn(),
    start: (callback?: (result: { finished: boolean }) => void) => callback?.({ finished: true }),
    stop: jest.fn(),
  }) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('the system keyboard keeps the stage size and pans the capture surface upward', async () => {
  const multiply = jest.spyOn(Animated, 'multiply');
  const screen = await render(<RemoteDesktopScreen instanceId="instance-1" />);
  const stage = screen.getByTestId('remote-desktop-stage');
  const initialStyle = StyleSheet.flatten(stage.props.style);
  expect(initialStyle.marginBottom).toBeUndefined();
  expect(initialStyle.overflow).toBe('hidden');
  expect(multiply).toHaveBeenCalledWith(expect.anything(), -0.5);

  await act(async () => {
    fireEvent.press(screen.getByTestId('show-keyboard'));
    mockKeyboardListeners[0]?.({ duration: 250, easing: 'keyboard', height: 258, visible: true });
  });

  expect(StyleSheet.flatten(screen.getByTestId('remote-desktop-stage').props.style)).toEqual(initialStyle);
  const surfaceHostStyle = StyleSheet.flatten(screen.getByTestId('remote-desktop-touch-surface-host').props.style);
  expect(surfaceHostStyle.transform).toHaveLength(1);
  expect(surfaceHostStyle.transform[0]).toEqual({ translateY: expect.anything() });
  screen.unmount();
});
