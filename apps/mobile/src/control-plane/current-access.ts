import type { ControlPlaneCurrentAuthorization } from '@task-handoff/protocol/control-plane-access';

import {
  isDirectMobileControlPlaneProfile,
  type MobileControlPlaneProfile,
  type MobileDirectControlPlaneProfile,
} from './profile';

export async function loadMobileCurrentAccess(
  profile: MobileControlPlaneProfile,
  loadDirect: (profile: MobileDirectControlPlaneProfile) => Promise<ControlPlaneCurrentAuthorization>,
) {
  if (!isDirectMobileControlPlaneProfile(profile)) return undefined;
  return loadDirect(profile);
}

export function controlPlaneRoleMessageKey(roleId: string) {
  switch (roleId) {
    case 'role_admin': return 'controlPlane.roleAdmin' as const;
    case 'role_operator': return 'controlPlane.roleOperator' as const;
    case 'role_viewer': return 'controlPlane.roleViewer' as const;
    default: return undefined;
  }
}
