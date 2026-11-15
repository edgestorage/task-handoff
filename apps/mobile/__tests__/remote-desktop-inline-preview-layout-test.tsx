import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  INLINE_PREVIEW_MAX_HEIGHT,
  inlinePreviewHeight,
  SessionRemoteDesktopInlinePreview,
} from '../src/remote-desktop/SessionRemoteDesktopInlinePreview';

jest.mock('../src/components/Icon', () => {
  const { View } = require('react-native');
  return { Icon: ({ name }: { name: string }) => <View testID={`icon-${name}`} /> };
});

jest.mock('../src/components/theme', () => ({
  useMobileTheme: () => ({ colors: { error: '#ff3b30' } }),
}));

jest.mock('../src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('../src/remote-desktop/RemoteDesktopVideoSurface', () => ({
  RemoteDesktopVideoSurface: () => null,
}));

let mockRemoteDesktopPhase: 'connecting' | 'connected' | 'error' = 'connecting';
let mockRemoteDesktopError: { code: string; message: string } | undefined;
jest.mock('../src/remote-desktop/use-remote-desktop', () => ({
  useRemoteDesktop: () => ({
    controller: undefined,
    ready: true,
    snapshot: {
      error: mockRemoteDesktopError,
      path: null,
      phase: mockRemoteDesktopPhase,
      target: { height: 720, kind: 'window', sourceRef: 'window-1', width: 1280 },
      videoHeight: 0,
      videoWidth: 0,
    },
  }),
}));

test('inline preview fills the card width and expands without its own top gap or duplicate icon', async () => {
  const screen = await render(<SessionRemoteDesktopInlinePreview
    instanceId="instance-1"
    onOpenDetail={jest.fn()}
    sessionId="session-1"
  />);

  const host = screen.getByTestId('session-remote-desktop-inline-preview');
  expect(StyleSheet.flatten(host.props.style)).toEqual(expect.objectContaining({
    alignSelf: 'stretch',
    width: '100%',
  }));
  expect(StyleSheet.flatten(host.props.style).marginTop).toBeUndefined();
  expect(screen.queryByTestId('icon-expand-outline')).toBeNull();
  expect(screen.getByTestId('session-remote-desktop-inline-status')).toBeTruthy();
});

test('connected inline previews omit the redundant connection badge', async () => {
  mockRemoteDesktopPhase = 'connected';
  const screen = await render(<SessionRemoteDesktopInlinePreview
    instanceId="instance-1"
    onOpenDetail={jest.fn()}
    sessionId="session-1"
  />);

  expect(screen.queryByTestId('session-remote-desktop-inline-status')).toBeNull();
  mockRemoteDesktopPhase = 'connecting';
});

test('source-ended inline previews identify the unavailable source instead of reporting a connection error', async () => {
  mockRemoteDesktopPhase = 'error';
  mockRemoteDesktopError = { code: 'REMOTE_DESKTOP_WINDOW_UNAVAILABLE', message: 'window closed' };
  const screen = await render(<SessionRemoteDesktopInlinePreview
    instanceId="instance-1"
    onOpenDetail={jest.fn()}
    sessionId="session-1"
  />);

  expect(screen.getByText('remoteDesktop.windowClosed')).toBeTruthy();
  expect(screen.queryByText('remoteDesktop.error')).toBeNull();
  mockRemoteDesktopPhase = 'connecting';
  mockRemoteDesktopError = undefined;
});

test('caps tall inline previews while keeping the card full width', async () => {
  expect(inlinePreviewHeight(370, 9 / 16)).toBe(208);
  expect(inlinePreviewHeight(370, 2)).toBe(INLINE_PREVIEW_MAX_HEIGHT);
});
