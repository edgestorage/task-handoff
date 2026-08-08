import { DirectEnrollmentError, assertDirectIdentityCompatible, existingDirectControlPlaneProfile, loginDirectControlPlane, mobileSessionStorageKey, normalizeDirectControlPlaneOrigin, probeDirectControlPlane } from '../src/control-plane/direct-enrollment';

describe('direct Control Plane enrollment', () => {
  test('normalizes a secure origin', () => {
    expect(normalizeDirectControlPlaneOrigin(' https://control.example.com/ ')).toBe('https://control.example.com');
  });

  test.each([
    'http://control.example.com',
    'https://user:password@control.example.com',
    'https://control.example.com/api',
    'https://control.example.com?target=other',
    'javascript:alert(1)',
  ])('rejects unsafe target %s before probing', (input) => {
    expect(() => normalizeDirectControlPlaneOrigin(input)).toThrow(DirectEnrollmentError);
  });

  test('allows HTTP only when the caller explicitly enables test-mode access', () => {
    expect(normalizeDirectControlPlaneOrigin('http://127.0.0.1:8787', { allowInsecureHttp: true })).toBe('http://127.0.0.1:8787');
    expect(normalizeDirectControlPlaneOrigin('http://192.168.1.2:8787', { allowInsecureHttp: true })).toBe('http://192.168.1.2:8787');
    expect(() => normalizeDirectControlPlaneOrigin('http://192.168.1.2:8787')).toThrow('must use HTTPS');
  });

  test('blocks an origin whose saved signing identity changed', () => {
    const target = {
      origin: 'https://control.example.com',
      identity: {
        version: 1 as const,
        kind: 'control-plane' as const,
        controlPlaneId: 'control_plane_one',
        publicKey: { algorithm: 'Ed25519' as const, encoding: 'base64url' as const, value: 'a'.repeat(43), fingerprint: `sha256:${'b'.repeat(43)}` },
        capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true },
        protocolVersion: '2026-08-05',
        issuedAt: '2026-08-05T00:00:00.000Z',
        expiresAt: '2026-08-05T00:05:00.000Z',
      },
    };
    const existing = [{
      version: 1 as const,
      identity: { controlPlaneId: 'control_plane_one', publicKeyFingerprint: `sha256:${'c'.repeat(43)}` },
      access: { kind: 'direct' as const, origin: target.origin, secureSessionKey: 'session.old' },
      capabilities: target.identity.capabilities,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }];

    expect(() => assertDirectIdentityCompatible(target, existing)).toThrow('different signing identity');
  });

  test('recognizes the same signed identity as an address update instead of a duplicate profile', () => {
    const target = {
      origin: 'https://new.example.com',
      identity: {
        version: 1 as const, kind: 'control-plane' as const, controlPlaneId: 'cp',
        publicKey: { algorithm: 'Ed25519' as const, encoding: 'base64url' as const, value: 'a'.repeat(43), fingerprint: `sha256:${'b'.repeat(43)}` },
        capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true },
        protocolVersion: '2026-08-05', issuedAt: '2026-08-05T00:00:00.000Z', expiresAt: '2026-08-05T00:05:00.000Z',
      },
    };
    const profile = {
      version: 1 as const, identity: { controlPlaneId: 'cp', publicKeyFingerprint: target.identity.publicKey.fingerprint },
      access: { kind: 'direct' as const, origin: 'https://old.example.com', secureSessionKey: 'session.cp' }, capabilities: target.identity.capabilities,
      createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
    };
    expect(existingDirectControlPlaneProfile(target, [profile])).toBe(profile);
  });

  test('isolates secure bearer keys by both signing key and Control Plane identity', async () => {
    const publicKey = { algorithm: 'Ed25519' as const, encoding: 'base64url' as const, value: 'a'.repeat(43), fingerprint: `sha256:${'b'.repeat(43)}` };
    await expect(mobileSessionStorageKey({ controlPlaneId: 'cp-a', publicKey })).resolves.not.toBe(
      await mobileSessionStorageKey({ controlPlaneId: 'cp-b', publicKey }),
    );
  });

  test('rejects TLS/network failures and non-Control-Plane targets before credentials', async () => {
    await expect(probeDirectControlPlane('https://control.example.com', { fetchImpl: jest.fn().mockRejectedValue(new Error('TLS failed')) })).rejects.toMatchObject({ code: 'DIRECT_TLS_OR_NETWORK_FAILED' });
    await expect(probeDirectControlPlane('https://control.example.com', { fetchImpl: jest.fn().mockResolvedValue(new Response(JSON.stringify({ data: { service: 'node-agent' } }), { status: 200 })) })).rejects.toMatchObject({ code: 'DIRECT_TARGET_NOT_CONTROL_PLANE' });
  });

  test('refuses auth-disabled public targets without sending a login request', async () => {
    const fetchImpl = jest.fn();
    const storage = { available: async () => true, get: async () => undefined, set: async () => undefined, remove: async () => undefined };
    const target = {
      origin: 'https://control.example.com',
      identity: {
        version: 1 as const, kind: 'control-plane' as const, controlPlaneId: 'cp',
        publicKey: { algorithm: 'Ed25519' as const, encoding: 'base64url' as const, value: 'a'.repeat(43), fingerprint: `sha256:${'b'.repeat(43)}` },
        capabilities: { authentication: 'disabled' as const, aiSessions: true, nodes: true, instanceBoard: true },
        protocolVersion: '2026-08-05', issuedAt: '2026-08-05T00:00:00.000Z', expiresAt: '2026-08-05T00:05:00.000Z',
      },
    };
    await expect(loginDirectControlPlane(target, { username: 'admin', password: 'secret' }, storage, { fetchImpl })).rejects.toMatchObject({ code: 'DIRECT_AUTH_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
