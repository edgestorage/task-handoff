export const REMOTE_DESKTOP_FALLBACK_RETRY_MS = 3_000;
export const REMOTE_DESKTOP_FALLBACK_RECONNECT_WINDOW_MS = 15_000;

export type RemoteDesktopWebRTCProgress = 'connected' | 'recoverable' | 'unavailable';

/** Keep one reconnect window for the whole fallback episode. Replacing the
 * deadline on every retry turns the bounded retry policy into an endless loop. */
export function nextRemoteDesktopFallbackDeadline(now: number, current: number) {
  return current > 0 ? current : now + REMOTE_DESKTOP_FALLBACK_RECONNECT_WINDOW_MS;
}

/** A fallback retry is proactive while WebRTC can still establish. If WebRTC is
 * already connected the fallback must stop instead of competing with it. */
export function remoteDesktopWebRTCProgress(hasPeer: boolean, iceConnectionState: string | undefined): RemoteDesktopWebRTCProgress {
  if (!hasPeer) return 'unavailable';
  if (iceConnectionState === 'connected' || iceConnectionState === 'completed') return 'connected';
  if (iceConnectionState === 'failed' || iceConnectionState === 'closed' || iceConnectionState === 'disconnected') return 'unavailable';
  return 'recoverable';
}
