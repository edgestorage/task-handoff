import {
  REMOTE_DESKTOP_FALLBACK_RECONNECT_WINDOW_MS,
  nextRemoteDesktopFallbackDeadline,
  remoteDesktopWebRTCProgress,
} from '../src/remote-desktop/fallback-policy';

describe('remote desktop fallback policy', () => {
  test('keeps a bounded reconnect window across retries', () => {
    const first = nextRemoteDesktopFallbackDeadline(1_000, 0);
    expect(first).toBe(1_000 + REMOTE_DESKTOP_FALLBACK_RECONNECT_WINDOW_MS);
    expect(nextRemoteDesktopFallbackDeadline(10_000, first)).toBe(first);
  });

  test('classifies whether another fallback retry is proactive', () => {
    expect(remoteDesktopWebRTCProgress(false, 'checking')).toBe('unavailable');
    expect(remoteDesktopWebRTCProgress(true, 'checking')).toBe('recoverable');
    expect(remoteDesktopWebRTCProgress(true, 'disconnected')).toBe('unavailable');
    expect(remoteDesktopWebRTCProgress(true, 'connected')).toBe('connected');
    expect(remoteDesktopWebRTCProgress(true, 'completed')).toBe('connected');
  });
});
