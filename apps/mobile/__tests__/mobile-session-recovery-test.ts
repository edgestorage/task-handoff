import type { MobileControlPlaneProfile } from '../src/control-plane/profile';
import { mobileSessionRecoveryRoute } from '../src/control-plane/session-recovery';

const profile: MobileControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'control_plane_reauth', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` },
  access: { kind: 'direct', origin: 'https://control.example.com', secureSessionKey: 'session.reauth' },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
};

test('an expired direct session routes to in-place reauthentication', () => {
  expect(mobileSessionRecoveryRoute('session-expired', profile, '/inbox')).toEqual({
    pathname: '/control-planes/add',
    params: { reauthenticate: profile.identity.controlPlaneId },
  });
  expect(mobileSessionRecoveryRoute('connected', profile, '/inbox')).toBeUndefined();
  expect(mobileSessionRecoveryRoute('session-expired', profile, '/control-planes/add')).toBeUndefined();
});
