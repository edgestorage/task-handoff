import { remoteDesktopPreviewStatus } from '../src/remote-desktop/preview-status';
import { emptyRemoteDesktopSnapshot } from '../src/remote-desktop/types';

const t = ((key: string) => key) as any;
const windowTarget = { height: 720, kind: 'window' as const, sourceRef: 'window-1', width: 1280 };

test('presents a closed window as an unavailable source instead of a connection error', () => {
  const status = remoteDesktopPreviewStatus({
    ...emptyRemoteDesktopSnapshot,
    error: { code: 'REMOTE_DESKTOP_WINDOW_UNAVAILABLE', message: 'window closed' },
    phase: 'error',
    target: windowTarget,
  }, t);

  expect(status).toEqual({
    label: 'remoteDesktop.windowClosed',
    sourceEnded: true,
    tone: 'warning',
  });
});

test('presents a missing capture source as unavailable and keeps other failures as connection errors', () => {
  expect(remoteDesktopPreviewStatus({
    ...emptyRemoteDesktopSnapshot,
    error: { code: 'REMOTE_DESKTOP_SOURCE_SELECTION_REQUIRED', message: 'missing source' },
    phase: 'error',
    target: { kind: 'display' },
  }, t)).toEqual({
    label: 'remoteDesktop.sourceEnded',
    sourceEnded: true,
    tone: 'warning',
  });

  expect(remoteDesktopPreviewStatus({
    ...emptyRemoteDesktopSnapshot,
    error: { code: 'REMOTE_DESKTOP_SIGNAL_SOCKET_ERROR', message: 'socket failed' },
    phase: 'error',
  }, t)).toEqual({
    label: 'remoteDesktop.error',
    sourceEnded: false,
    tone: 'danger',
  });
});

test('keeps stopped and active phases distinct from terminal capture failures', () => {
  expect(remoteDesktopPreviewStatus({ ...emptyRemoteDesktopSnapshot, phase: 'stopped' }, t).tone).toBe('danger');
  expect(remoteDesktopPreviewStatus({ ...emptyRemoteDesktopSnapshot, phase: 'connected' }, t)).toEqual({
    label: 'remoteDesktop.connected',
    sourceEnded: false,
    tone: 'active',
  });
  expect(remoteDesktopPreviewStatus({ ...emptyRemoteDesktopSnapshot, phase: 'connecting' }, t).tone).toBe('pending');
});
