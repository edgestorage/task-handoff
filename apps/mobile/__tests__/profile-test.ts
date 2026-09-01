import {
  MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  MobileDirectControlPlaneProfileSchema,
  MobileCloudRelayControlPlaneProfileSchema,
  MobileControlPlaneProfileSchema,
  normalizeMobileControlPlaneCapabilities,
  parseStoredMobileControlPlaneProfile,
} from '../src/control-plane/profile';
import { MobileControlPlaneProfileStore } from '../src/control-plane/profile-store';
import type { SecureValueStore } from '../src/platform/secure-storage';
import { attemptRemoteMobileSessionRevocation } from '../src/control-plane/profile-removal';

const fingerprint = `sha256:${'a'.repeat(43)}`;

const baseProfile = {
  version: MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  identity: {
    controlPlaneId: 'cp_01',
    publicKeyFingerprint: fingerprint,
    protocolVersion: '2026-08-05',
  },
  access: {
    kind: 'direct' as const,
    origin: 'https://control.example.com',
    secureSessionKey: 'session.cp_01',
  },
  capabilities: {
    authentication: 'required' as const,
    aiSessions: true,
    nodes: true,
    instanceBoard: true,
    triggers: true,
  },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

describe('MobileControlPlaneProfile', () => {
  test('treats remote mobile-session revocation as best effort for local profile removal', async () => {
    const unavailable = Object.assign(new Error('offline'), { status: undefined });
    await expect(attemptRemoteMobileSessionRevocation(async () => { throw unavailable; })).resolves.toBe(false);
    await expect(attemptRemoteMobileSessionRevocation(async () => {
      throw Object.assign(new Error('different signing identity'), { code: 'DIRECT_IDENTITY_CHANGED' });
    })).resolves.toBe(false);
    await expect(attemptRemoteMobileSessionRevocation(async () => { throw Object.assign(new Error('expired'), { status: 401 }); })).resolves.toBe(true);
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    await expect(attemptRemoteMobileSessionRevocation(async () => { throw forbidden; })).resolves.toBe(false);
    const logout = jest.fn().mockResolvedValue({ ok: true });
    await expect(attemptRemoteMobileSessionRevocation(logout)).resolves.toBe(true);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  test('uses a stable signed identity instead of the origin as its id', () => {
    const profile = MobileDirectControlPlaneProfileSchema.parse(baseProfile);

    expect(profile.identity.controlPlaneId).toBe('cp_01');
    expect(profile.access.kind).toBe('direct');
    if (profile.access.kind === 'direct') expect(profile.access.origin).toBe('https://control.example.com');
  });

  test('rejects feature names appended to protocol dates', () => {
    const result = MobileControlPlaneProfileSchema.safeParse({
      ...baseProfile,
      identity: { ...baseProfile.identity, protocolVersion: '2026-08-05-mobile' },
    });

    expect(result.success).toBe(false);
  });

  test('sanitizes unknown persisted fields without dropping the profile', () => {
    const profile = parseStoredMobileControlPlaneProfile({
      ...baseProfile,
      future: true,
      identity: { ...baseProfile.identity, futureIdentity: true },
      access: { ...baseProfile.access, futureAccess: true },
    });

    expect(profile.identity.controlPlaneId).toBe('cp_01');
    expect(profile.access.kind).toBe('direct');
    if (profile.access.kind === 'direct') expect(profile.access.origin).toBe('https://control.example.com');
    expect(profile).not.toHaveProperty('future');
  });

  test('normalizes missing additive capabilities without dropping an older Control Plane', () => {
    const { triggers: _triggers, ...legacyCapabilities } = baseProfile.capabilities;

    expect(normalizeMobileControlPlaneCapabilities(legacyCapabilities).triggers).toBe(false);
    expect(normalizeMobileControlPlaneCapabilities(legacyCapabilities).stories).toBe(false);
    expect(parseStoredMobileControlPlaneProfile({
      ...baseProfile,
      capabilities: legacyCapabilities,
    }).capabilities.triggers).toBe(false);
    expect(normalizeMobileControlPlaneCapabilities({ ...legacyCapabilities, stories: true }).stories).toBe(true);
  });

  test('reads a v0.0.19 v1 direct profile through the current discriminated profile', () => {
    const migrated = parseStoredMobileControlPlaneProfile({ ...baseProfile, version: 1 });

    expect(migrated.version).toBe(MOBILE_CONTROL_PLANE_PROFILE_VERSION);
    expect(migrated.access.kind).toBe('direct');
  });

  test('defines a cloud relay profile with an independent account session and transport capabilities', () => {
    const profile = MobileCloudRelayControlPlaneProfileSchema.parse({
      ...baseProfile,
      access: {
        kind: 'cloud-relay',
        serviceOrigin: 'https://cloud.example.com',
        bindingId: 'binding_01',
        bindingRevision: 2,
        accountSession: { id: 'account_session_01', secureCredentialKey: 'cloud.account.session.01' },
        transport: { request: true, stream: true, webSocket: true },
      },
    });

    expect(profile.access.kind).toBe('cloud-relay');
    expect(profile.access.accountSession.id).toBe('account_session_01');
    expect(() => MobileCloudRelayControlPlaneProfileSchema.parse({
      ...profile,
      access: { ...profile.access, nodeId: 'node_must_not_cross_boundary' },
    })).toThrow();
  });

  test('sanitizes future cloud relay fields without losing the profile', () => {
    const profile = parseStoredMobileControlPlaneProfile({
      ...baseProfile,
      access: {
        kind: 'cloud-relay',
        serviceOrigin: 'https://cloud.example.com',
        bindingId: 'binding_01',
        bindingRevision: 2,
        accountSession: { id: 'account_session_01', secureCredentialKey: 'cloud.account.session.01', futureSessionField: true },
        transport: { request: true, stream: true, webSocket: false, datagram: true },
        futureAccessField: true,
      },
    });

    expect(profile.access.kind).toBe('cloud-relay');
    if (profile.access.kind === 'cloud-relay') {
      expect(profile.access.accountSession.id).toBe('account_session_01');
      expect(profile.access.accountSession).not.toHaveProperty('futureSessionField');
      expect(profile.access.transport).not.toHaveProperty('datagram');
    }
  });

  test('profile store switches and removes identities without leaving the device session', async () => {
    const values = new Map<string, string>();
    const secretValues = new Map<string, string>();
    const storage: SecureValueStore = {
      available: async () => true,
      get: async (key) => values.get(key),
      set: async (key, value) => { values.set(key, value); },
      remove: async (key) => { values.delete(key); },
    };
    const sessionStorage: SecureValueStore = {
      available: async () => true,
      get: async (key) => secretValues.get(key),
      set: async (key, value) => { secretValues.set(key, value); },
      remove: async (key) => { secretValues.delete(key); },
    };
    const store = new MobileControlPlaneProfileStore(storage, () => undefined, sessionStorage);
    const onProfileChanged = jest.fn();
    const unsubscribe = store.subscribe(onProfileChanged);
    const first = MobileDirectControlPlaneProfileSchema.parse(baseProfile);
    const second = MobileDirectControlPlaneProfileSchema.parse({
      ...baseProfile,
      identity: { ...baseProfile.identity, controlPlaneId: 'cp_02', publicKeyFingerprint: `sha256:${'b'.repeat(43)}` },
      access: { ...baseProfile.access, origin: 'https://second.example.com', secureSessionKey: 'session.cp_02' },
    });
    await sessionStorage.set(first.access.secureSessionKey, 'first-token');
    await sessionStorage.set(second.access.secureSessionKey, 'second-token');
    await store.put(first);
    await store.put(second);
    await store.setActive(first);
    expect((await store.active())?.identity.controlPlaneId).toBe('cp_01');
    await store.remove(first);
    expect(await sessionStorage.get(first.access.secureSessionKey)).toBeUndefined();
    expect(values.has(first.access.secureSessionKey)).toBe(false);
    expect((await store.active())?.identity.controlPlaneId).toBe('cp_02');
    expect(await sessionStorage.get(second.access.secureSessionKey)).toBe('second-token');
    expect(onProfileChanged).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  test('removing a cloud Relay profile never logs out or deletes the shared cloud account session', async () => {
    const values = new Map<string, string>(); const secrets = new Map<string, string>();
    const storage: SecureValueStore = { available: async () => true, get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); } };
    const secure: SecureValueStore = { available: async () => true, get: async (key) => secrets.get(key), set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } };
    const store = new MobileControlPlaneProfileStore(storage, () => undefined, secure);
    const profile = MobileCloudRelayControlPlaneProfileSchema.parse({ ...baseProfile, access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_a', bindingRevision: 1, accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }, transport: { request: true, stream: true, webSocket: true } } });
    await secure.set(profile.access.accountSession.secureCredentialKey, 'rotating-refresh'); await store.put(profile); await store.remove(profile);
    expect(await secure.get(profile.access.accountSession.secureCredentialKey)).toBe('rotating-refresh');
  });

  test('one app installation accepts multiple Control Planes for one cloud session but rejects a second session', async () => {
    const values = new Map<string, string>();
    const storage: SecureValueStore = { available: async () => true, get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); } };
    const store = new MobileControlPlaneProfileStore(storage);
    const cloud = (controlPlaneId: string, sessionId = 'device_account_a') => MobileCloudRelayControlPlaneProfileSchema.parse({
      ...baseProfile,
      identity: { ...baseProfile.identity, controlPlaneId, publicKeyFingerprint: `sha256:${controlPlaneId === 'cp_02' ? 'b' : controlPlaneId === 'cp_03' ? 'c' : 'a'}`.padEnd(50, controlPlaneId === 'cp_02' ? 'b' : controlPlaneId === 'cp_03' ? 'c' : 'a') },
      access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: `binding_${controlPlaneId}`, bindingRevision: 1, accountSession: { id: sessionId, secureCredentialKey: `cloud.account.${sessionId}` }, transport: { request: true, stream: true, webSocket: true } },
    });

    await store.put(cloud('cp_01'));
    await store.put(cloud('cp_02'));
    expect(await store.list()).toHaveLength(2);
    await expect(store.put(cloud('cp_03', 'device_account_b'))).rejects.toMatchObject({ code: 'CLOUD_ACCOUNT_SWITCH_REQUIRES_LOGOUT' });
    expect(await store.list()).toHaveLength(2);
  });

  test('cloud account logout cleanup removes Relay profiles and credentials but preserves Direct profiles', async () => {
    const values = new Map<string, string>(); const secrets = new Map<string, string>();
    const storage: SecureValueStore = { available: async () => true, get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); } };
    const secure: SecureValueStore = { available: async () => true, get: async (key) => secrets.get(key), set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } };
    const store = new MobileControlPlaneProfileStore(storage, () => undefined, secure);
    const direct = MobileDirectControlPlaneProfileSchema.parse(baseProfile);
    const cloud = MobileCloudRelayControlPlaneProfileSchema.parse({
      ...baseProfile,
      identity: { ...baseProfile.identity, controlPlaneId: 'cp_02', publicKeyFingerprint: `sha256:${'b'.repeat(43)}` },
      access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_cp_02', bindingRevision: 1, accountSession: { id: 'device_account_a', secureCredentialKey: 'cloud.account.device_account_a' }, transport: { request: true, stream: true, webSocket: true } },
    });
    await secure.set(direct.access.secureSessionKey, 'direct-session');
    await secure.set(cloud.access.accountSession.secureCredentialKey, 'cloud-refresh');
    await store.put(direct);
    await store.put(cloud);

    const remaining = await store.removeCloudAccountProfiles();

    expect(remaining).toEqual([direct]);
    expect(await secure.get(direct.access.secureSessionKey)).toBe('direct-session');
    expect(await secure.get(cloud.access.accountSession.secureCredentialKey)).toBeUndefined();
    expect((await store.active())?.access.kind).toBe('direct');
  });

  test('migrates an undifferentiated Relay profile key without duplicating the profile', async () => {
    const values = new Map<string, string>();
    const storage: SecureValueStore = { available: async () => true, get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); } };
    const store = new MobileControlPlaneProfileStore(storage);
    const cloud = MobileCloudRelayControlPlaneProfileSchema.parse({
      ...baseProfile,
      access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_cp_01', bindingRevision: 1, accountSession: { id: 'device_account_a', secureCredentialKey: 'cloud.account.device_account_a' }, transport: { request: true, stream: true, webSocket: true } },
    });
    const encodedId = globalThis.btoa(cloud.identity.controlPlaneId).replace(/=+$/g, '');
    const legacyKey = `profile.${cloud.identity.publicKeyFingerprint.slice('sha256:'.length)}.${encodedId}`;
    values.set(legacyKey, JSON.stringify(cloud));
    values.set('profiles.index', JSON.stringify([legacyKey]));
    values.set('profiles.active', legacyKey);

    await store.put({ ...cloud, updatedAt: '2026-08-10T00:00:00.000Z' });

    const keys = JSON.parse(values.get('profiles.index')!) as string[];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('profile.cloud-relay.');
    expect(values.has(legacyKey)).toBe(false);
    expect(await store.list()).toHaveLength(1);
    expect((await store.active())?.access.kind).toBe('cloud-relay');
  });

  test('profile store reports unknown persisted fields without logging their values', async () => {
    const values = new Map<string, string>();
    const warnings: unknown[] = [];
    const storage: SecureValueStore = {
      available: async () => true,
      get: async (key) => values.get(key),
      set: async (key, value) => { values.set(key, value); },
      remove: async (key) => { values.delete(key); },
    };
    const store = new MobileControlPlaneProfileStore(storage, (warning) => warnings.push(warning));
    await store.put(MobileControlPlaneProfileSchema.parse(baseProfile));
    const profileKey = [...values.keys()].find((key) => key.startsWith('profile.'))!;
    values.set(profileKey, JSON.stringify({ ...baseProfile, futureSecret: 'must-not-be-reported' }));
    expect(await store.list()).toHaveLength(1);
    expect(warnings).toEqual([{ code: 'PROFILE_UNKNOWN_FIELDS', fields: ['futureSecret'] }]);
    expect(JSON.stringify(warnings)).not.toContain('must-not-be-reported');
  });
});
