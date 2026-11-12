import { isRemoteDesktopSourceEndedError, remoteDesktopErrorMessage } from '../src/remote-desktop/errors';

const t = ((key: string) => key) as any;

test('maps source and capture failures without window-specific messages', () => {
  expect(remoteDesktopErrorMessage({ code: 'REMOTE_DESKTOP_SOURCE_SELECTION_REQUIRED', message: '' }, t))
    .toBe('remoteDesktop.sourceSelectionRequired');
  expect(remoteDesktopErrorMessage({ code: 'REMOTE_DESKTOP_SOURCE_UNSUPPORTED', message: '' }, t))
    .toBe('remoteDesktop.sourceCaptureUnavailable');
  expect(remoteDesktopErrorMessage({ code: 'REMOTE_DESKTOP_WINDOW_UNAVAILABLE', message: '' }, t))
    .toBe('remoteDesktop.sourceEndedDetail');
  expect(remoteDesktopErrorMessage({ code: 'REMOTE_DESKTOP_CAPTURE_FAILED', message: '' }, t))
    .toBe('remoteDesktop.sourceCaptureFailed');
});

test('distinguishes a closed window from transient source capture failures', () => {
  expect(isRemoteDesktopSourceEndedError('REMOTE_DESKTOP_WINDOW_UNAVAILABLE')).toBe(true);
  expect(isRemoteDesktopSourceEndedError('REMOTE_DESKTOP_GEOMETRY_CHANGED')).toBe(false);
});
