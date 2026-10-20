import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { translate, type Translate } from '../i18n';

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
