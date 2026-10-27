import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { translate, type Translate } from '../i18n';
import { controlPlaneRoleMessageKey } from './current-access';
import type { MobileControlPlaneProfile } from './profile';

const english: Translate = (key, params) => translate('en-US', key, params);

export function connectionModeLabel(mode: ControlPlaneNodeDirectoryEntry['connectionMode'], t: Translate = english) {
  return ({
    'local-ipc': t('directories.connectionLocal'),
    'local-loopback': t('directories.connectionLocal'),
    'direct-http': t('directories.connectionDirect'),
    'reverse-wss': t('directories.connectionRemote'),
    'control-plane-proxy': t('directories.connectionProxy'),
    'cloud-relay': t('directories.connectionCloudRelay'),
  } as const)[mode];
}

export function mobileControlPlaneCloudAccessLabel(profile: MobileControlPlaneProfile, t: Translate = english) {
  if (profile.access.kind !== 'cloud-relay') return undefined;
  const sharedAccess = profile.access.resourceAccess?.kind === 'shared' ? profile.access.resourceAccess : undefined;
  if (!sharedAccess) return t('cloudControlPlanes.owner');
  const roleKey = controlPlaneRoleMessageKey(sharedAccess.role);
  return t('cloudControlPlanes.sharedRole', { role: roleKey ? t(roleKey) : sharedAccess.role });
}

/** The service origin is a transport detail for cloud profiles, not their Control Plane address. */
export function mobileControlPlaneProfileConnectionLabel(profile: MobileControlPlaneProfile, t: Translate = english) {
  if (profile.access.kind === 'direct') return profile.access.origin;
  const accessLabel = mobileControlPlaneCloudAccessLabel(profile, t) ?? t('cloudControlPlanes.owner');
  return `${t('directories.connectionCloudRelay')} · ${accessLabel}`;
}
