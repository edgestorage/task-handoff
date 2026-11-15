import { render } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { SessionRemoteDesktopFloatingPreview } from '../src/remote-desktop/SessionRemoteDesktopFloatingPreview';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
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
      primary: '#0a84ff',
      primarySoft: '#0c3158',
      surface: '#17181c',
      surfaceInset: '#101012',
      text: '#f2f2f7',
      textMuted: '#aeaeb2',
      workbenchSelectionBackground: '#23252a',
    },
  }),
}));

jest.mock('../src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('../src/remote-desktop/RemoteDesktopVideoSurface', () => ({
  RemoteDesktopVideoSurface: () => null,
}));

jest.mock('../src/remote-desktop/use-remote-desktop', () => ({
  useRemoteDesktop: () => ({
    controller: undefined,
    ready: true,
    snapshot: {
      error: { code: 'REMOTE_DESKTOP_WINDOW_UNAVAILABLE', message: 'window closed' },
      path: null,
      phase: 'error',
      target: { height: 720, kind: 'window', sourceRef: 'window-1', subtitle: 'Desktop', title: 'iPhone 17', width: 1280 },
      videoHeight: 0,
      videoWidth: 0,
    },
  }),
}));

beforeEach(() => {
  const animation = () => ({ reset: jest.fn(), start: jest.fn(), stop: jest.fn() });
  jest.spyOn(Animated, 'parallel').mockImplementation(animation as never);
  jest.spyOn(Animated, 'timing').mockImplementation(animation as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('floating session previews identify an unavailable capture source instead of a connection error', async () => {
  const screen = await render(<SessionRemoteDesktopFloatingPreview
    controlPlaneId="control-plane-1"
    instanceId="instance-1"
    onClose={jest.fn()}
    onOpen={jest.fn()}
    sessionId="session-1"
    visible
  />);

  expect(screen.getByText('remoteDesktop.windowClosed')).toBeTruthy();
  expect(screen.queryByText('remoteDesktop.error')).toBeNull();
});
