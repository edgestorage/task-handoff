import type { ControlPlaneCurrentAuthorization } from '@task-handoff/protocol/control-plane-access';

import { controlPlaneRoleMessageKey, loadMobileCurrentAccess } from '../src/control-plane/current-access';
import { MobileCloudRelayControlPlaneProfileSchema, MobileDirectControlPlaneProfileSchema } from '../src/control-plane/profile';

const base = {
  version: 1 as const,
  identity: {
    controlPlaneId: 'cp_01',
    publicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
    protocolVersion: '2026-08-22',
  },
  capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

const access: ControlPlaneCurrentAuthorization = {
  userId: 'user_01',
  identityId: 'identity_01',
  roleIds: ['role_operator'],
  permissionIds: ['triggers:read', 'triggers:manage'],
  nodeScope: { kind: 'selected', nodeIds: ['node_a'] },
  authorizationRevision: 3,
};

describe('mobile current access', () => {
  test('loads the member projection only for a Direct profile', async () => {
    const direct = MobileDirectControlPlaneProfileSchema.parse({
      ...base,
      access: { kind: 'direct', origin: 'https://control.example.com', secureSessionKey: 'session.cp_01' },
    });
    const cloud = MobileCloudRelayControlPlaneProfileSchema.parse({
      ...base,
      access: {
        kind: 'cloud-relay', serviceOrigin: 'https://cloud.example.com', bindingId: 'binding_01', bindingRevision: 1,
        accountSession: { id: 'account_01', secureCredentialKey: 'cloud.account.01' },
        transport: { request: true, stream: true, webSocket: true },
      },
    });
    const loadDirect = jest.fn().mockResolvedValue(access);

    await expect(loadMobileCurrentAccess(direct, loadDirect)).resolves.toEqual(access);
    expect(loadDirect).toHaveBeenCalledWith(direct);
    loadDirect.mockClear();
    await expect(loadMobileCurrentAccess(cloud, loadDirect)).resolves.toBeUndefined();
    expect(loadDirect).not.toHaveBeenCalled();
  });

  test('maps every wire role to a stable translated label', () => {
    expect(['role_admin', 'role_operator', 'role_viewer'].map(controlPlaneRoleMessageKey)).toEqual([
      'controlPlane.roleAdmin',
      'controlPlane.roleOperator',
      'controlPlane.roleViewer',
    ]);
  });
});
