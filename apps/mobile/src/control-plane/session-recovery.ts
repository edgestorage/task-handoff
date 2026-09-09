import type { MobileControlPlaneProfile } from './profile';
import type { MobileControlPlaneRuntimePhase } from './use-mobile-control-plane-runtime';

export function mobileSessionRecoveryRoute(
  phase: MobileControlPlaneRuntimePhase,
  profile: MobileControlPlaneProfile | undefined,
  pathname: string,
) {
  if (phase !== 'session-expired' || profile?.access.kind !== 'direct' || pathname === '/control-planes/add') return undefined;
  return {
    pathname: '/control-planes/add' as const,
    params: { reauthenticate: profile.identity.controlPlaneId },
  };
}
