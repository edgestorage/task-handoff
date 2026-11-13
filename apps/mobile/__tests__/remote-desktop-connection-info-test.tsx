import { render } from '@testing-library/react-native';

import { RemoteDesktopConnectionInfo } from '../src/remote-desktop/RemoteDesktopConnectionInfo';
import { emptyRemoteDesktopSnapshot } from '../src/remote-desktop/types';

jest.mock('../src/components/theme', () => ({
  useMobileTheme: () => ({
    colors: {
      border: '#ddd',
      primary: '#087f5b',
      primarySoft: '#e6fcf5',
      surface: '#fff',
      surfaceInset: '#f4f4f5',
      text: '#111',
      textMuted: '#666',
    },
  }),
}));

jest.mock('../src/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params && 'count' in params
      ? `${key}:${params.count}`
      : key,
  }),
}));

test('connection info shows the instance viewer total and the source each viewer watches', async () => {
  const screen = await render(<RemoteDesktopConnectionInfo
    onClose={jest.fn()}
    snapshot={{
      ...emptyRemoteDesktopSnapshot,
      phase: 'connected',
      target: { kind: 'window', sourceRef: 'window-a', title: 'Window A' },
      videoHeight: 720,
      videoWidth: 1280,
      viewerCount: 2,
      viewerSources: [
        { sourceRef: 'window-a', viewerCount: 1 },
        { sourceRef: 'window-b', viewerCount: 1 },
      ],
    }}
    sources={[
      { sourceRef: 'window-a', kind: 'window', title: 'Window A', subtitle: 'Editor', width: 1280, height: 720, capturable: true, reason: null },
      { sourceRef: 'window-b', kind: 'window', title: 'Window B', subtitle: 'Browser', width: 1440, height: 900, capturable: true, reason: null },
    ]}
    visible
  />);

  expect(screen.getByTestId('remote-desktop-viewer-sources')).toBeTruthy();
  expect(screen.getByText('Window B')).toBeTruthy();
  expect(screen.getByText('remoteDesktop.viewerSourceCurrent · Editor')).toBeTruthy();
  expect(screen.getAllByText('remoteDesktop.viewers:1')).toHaveLength(2);
});
