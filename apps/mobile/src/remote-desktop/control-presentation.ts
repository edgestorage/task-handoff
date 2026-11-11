import type { RemoteDesktopSnapshot } from './types';

export type RemoteDesktopControlHint = 'another-viewer' | 'control-available';

export function shouldShowControlRequest(snapshot: RemoteDesktopSnapshot) {
  return !snapshot.isController;
}

export function remoteDesktopControlHint(snapshot: RemoteDesktopSnapshot): RemoteDesktopControlHint | undefined {
  if (snapshot.isController || snapshot.paused) return undefined;
  return snapshot.hasController ? 'another-viewer' : 'control-available';
}
