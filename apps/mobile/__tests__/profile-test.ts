import {
  MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  MobileControlPlaneProfileSchema,
  parseStoredMobileControlPlaneProfile,
} from '../src/control-plane/profile';
import { MobileControlPlaneProfileStore } from '../src/control-plane/profile-store';
import type { SecureValueStore } from '../src/platform/secure-storage';

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
  },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

describe('MobileControlPlaneProfile', () => {
  test('uses a stable signed identity instead of the origin as its id', () => {
    const profile = MobileControlPlaneProfileSchema.parse(baseProfile);

    expect(profile.identity.controlPlaneId).toBe('cp_01');
    expect(profile.access.origin).toBe('https://control.example.com');
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
    expect(profile.access.origin).toBe('https://control.example.com');
    expect(profile).not.toHaveProperty('future');
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
    const first = MobileControlPlaneProfileSchema.parse(baseProfile);
    const second = MobileControlPlaneProfileSchema.parse({
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
