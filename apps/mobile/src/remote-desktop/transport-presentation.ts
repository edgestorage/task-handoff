import { Cable, Radio, Waypoints, type LucideIcon } from 'lucide-react-native';

import type { useI18n } from '../i18n';
import type { RemoteDesktopTransportKey } from './preferences';
import type { RemoteDesktopSnapshot } from './types';

type Translate = ReturnType<typeof useI18n>['t'];

export function transportIcon(key: RemoteDesktopTransportKey): LucideIcon {
  return key === 'p2p' ? Cable : key === 'turn' ? Waypoints : Radio;
}

export function transportLabel(key: RemoteDesktopTransportKey, t: Translate) {
  return key === 'p2p' ? t('remoteDesktop.transportP2P') : key === 'turn' ? t('remoteDesktop.transportTurn') : t('remoteDesktop.transportWebSocket');
}

export function transportStateLabel(key: RemoteDesktopTransportKey, snapshot: RemoteDesktopSnapshot, t: Translate) {
  if (!snapshot.transportAvailability[key]) return t('remoteDesktop.transportUnavailable');
  const state = snapshot.transportStates[key];
  if (state === 'active' || snapshot.path === key) return t('remoteDesktop.transportActive');
  if (state === 'failed') return t('remoteDesktop.transportFailed');
  return t('remoteDesktop.transportStandby');
}

export function candidateTypeLabel(value: string | undefined, t: Translate) {
  if (value === 'host') return t('remoteDesktop.candidateHost');
  if (value === 'srflx') return t('remoteDesktop.candidateSrflx');
  if (value === 'prflx') return t('remoteDesktop.candidatePrflx');
  if (value === 'relay') return t('remoteDesktop.candidateRelay');
  return t('remoteDesktop.candidateUnknown');
}
