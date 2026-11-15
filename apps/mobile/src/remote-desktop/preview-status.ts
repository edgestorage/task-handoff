import { isRemoteDesktopSourceEndedError } from '@task-handoff/control-plane-client';

import type { Translate } from '../i18n';
import { remoteDesktopSourceHeaderLabel } from './source-label';
import type { RemoteDesktopSnapshot } from './types';

export type RemoteDesktopPreviewStatusTone = 'active' | 'pending' | 'warning' | 'danger';

export function remoteDesktopPreviewStatus(snapshot: RemoteDesktopSnapshot, t: Translate) {
  if (isRemoteDesktopSourceEndedError(snapshot.error?.code)) {
    return {
      label: remoteDesktopSourceHeaderLabel(snapshot.target, true, t),
      sourceEnded: true,
      tone: 'warning' as const,
    };
  }
  if (snapshot.phase === 'error') return { label: t('remoteDesktop.error'), sourceEnded: false, tone: 'danger' as const };
  if (snapshot.phase === 'stopped') return { label: t('remoteDesktop.stopped'), sourceEnded: false, tone: 'danger' as const };
  if (snapshot.phase === 'connected') return { label: t('remoteDesktop.connected'), sourceEnded: false, tone: 'active' as const };
  return { label: t('remoteDesktop.connecting'), sourceEnded: false, tone: 'pending' as const };
}

export function remoteDesktopPreviewStatusColor(tone: RemoteDesktopPreviewStatusTone, errorColor: string) {
  if (tone === 'danger') return errorColor;
  if (tone === 'active') return '#34c759';
  return '#ffb340';
}
