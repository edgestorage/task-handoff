import type { SecureValueStore, ValueStore } from '../platform/secure-storage';
import { MobileControlPlaneProfileSchema, parseStoredMobileControlPlaneProfile, storedMobileControlPlaneProfileUnknownFields, type MobileControlPlaneProfile } from './profile';

const PROFILE_INDEX_KEY = 'profiles.index';
const ACTIVE_PROFILE_KEY = 'profiles.active';
type Listener = () => void;

function profileStorageKey(profile: Pick<MobileControlPlaneProfile, 'identity' | 'access'>) {
  const bytes = new TextEncoder().encode(profile.identity.controlPlaneId);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const id = globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const access = profile.access.kind;
  return access === 'direct' ? `profile.${profile.identity.publicKeyFingerprint.slice('sha256:'.length)}.${id}` : `profile.cloud-relay.${profile.identity.publicKeyFingerprint.slice('sha256:'.length)}.${id}`;
}

export class MobileControlPlaneProfileStore {
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: ValueStore,
    private readonly onWarning: (warning: { code: 'PROFILE_UNKNOWN_FIELDS' | 'PROFILE_INVALID'; fields?: readonly string[] }) => void = () => undefined,
    private readonly sessionStorage: SecureValueStore = storage,
  ) {}

  async list() {
    return (await this.entries()).map((entry) => entry.profile);
  }

  private async entries() {
    const keys = await this.index();
    const entries = await Promise.all(keys.map(async (key) => {
      const raw = await this.storage.get(key);
      if (!raw) return undefined;
      try {
        const stored = JSON.parse(raw);
        const fields = storedMobileControlPlaneProfileUnknownFields(stored);
        if (fields.length) this.onWarning({ code: 'PROFILE_UNKNOWN_FIELDS', fields });
        return { key, profile: parseStoredMobileControlPlaneProfile(stored) };
      } catch {
        this.onWarning({ code: 'PROFILE_INVALID' });
        return undefined;
      }
    }));
    return entries.filter((entry): entry is { key: string; profile: MobileControlPlaneProfile } => Boolean(entry));
  }

  async put(profile: MobileControlPlaneProfile) {
    const parsed = MobileControlPlaneProfileSchema.parse(profile);
    const entries = await this.entries();
    const storedProfiles = entries.map((entry) => entry.profile);
    if (parsed.access.kind === 'cloud-relay') {
      const sessionId = parsed.access.accountSession.id;
      const conflictingSession = storedProfiles.find((candidate) => candidate.access.kind === 'cloud-relay'
        && candidate.access.accountSession.id !== sessionId);
      if (conflictingSession) {
        throw Object.assign(new Error('Sign out of the current Thandoff account before signing in with another Thandoff account.'), {
          code: 'CLOUD_ACCOUNT_SWITCH_REQUIRES_LOGOUT',
        });
      }
    }
    const existingEntries = entries.filter((entry) => sameIdentity(entry.profile, parsed));
    const existing = existingEntries[0]?.profile;
    const key = profileStorageKey(parsed);
    await this.storage.set(key, JSON.stringify(existing ? { ...parsed, createdAt: existing.createdAt } : parsed));
    const index = await this.index();
    const existingKeys = new Set(existingEntries.map((entry) => entry.key));
    const nextIndex = [...index.filter((candidate) => !existingKeys.has(candidate)), key];
    await this.storage.set(PROFILE_INDEX_KEY, JSON.stringify([...new Set(nextIndex)]));
    // Early Relay builds used the same undifferentiated key shape as Direct.
    for (const entry of existingEntries) if (entry.key !== key) await this.storage.remove(entry.key);
    await this.storage.set(ACTIVE_PROFILE_KEY, key);
    const stored = existing ? { ...parsed, createdAt: existing.createdAt } : parsed;
    this.emit();
    return stored;
  }

  async active() {
    const key = await this.storage.get(ACTIVE_PROFILE_KEY);
    if (!key) return undefined;
    const raw = await this.storage.get(key);
    if (!raw) return undefined;
    try {
      return parseStoredMobileControlPlaneProfile(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async setActive(profile: MobileControlPlaneProfile) {
    const parsed = MobileControlPlaneProfileSchema.parse(profile);
    const stored = (await this.entries()).find((entry) => sameIdentity(entry.profile, parsed));
    if (!stored) throw new Error('Control Plane profile is not stored on this device.');
    await this.storage.set(ACTIVE_PROFILE_KEY, stored.key);
    this.emit();
    return stored.profile;
  }

  async remove(profile: MobileControlPlaneProfile) {
    const parsed = MobileControlPlaneProfileSchema.parse(profile);
    const matchingEntries = (await this.entries()).filter((entry) => sameIdentity(entry.profile, parsed));
    const keys = new Set(matchingEntries.map((entry) => entry.key));
    if (!keys.size) keys.add(profileStorageKey(parsed));
    const index = await this.index();
    const nextIndex = index.filter((candidate) => !keys.has(candidate));
    // Cloud account sessions outlive individual relay profiles and are
    // removed only by an explicit account/device logout. Direct credentials
    // remain profile-owned.
    if (parsed.access.kind === 'direct') await this.sessionStorage.remove(parsed.access.secureSessionKey);
    for (const key of keys) await this.storage.remove(key);
    if (nextIndex.length) await this.storage.set(PROFILE_INDEX_KEY, JSON.stringify(nextIndex));
    else await this.storage.remove(PROFILE_INDEX_KEY);
    const activeKey = await this.storage.get(ACTIVE_PROFILE_KEY);
    if (activeKey && keys.has(activeKey)) {
      if (nextIndex[0]) await this.storage.set(ACTIVE_PROFILE_KEY, nextIndex[0]);
      else await this.storage.remove(ACTIVE_PROFILE_KEY);
    }
    const remaining = await this.list();
    this.emit();
    return remaining;
  }

  async removeCloudAccountProfiles() {
    const cloudProfiles = (await this.list()).filter((profile) => profile.access.kind === 'cloud-relay');
    const credentialKeys = new Set(cloudProfiles.map((profile) => (
      profile.access.kind === 'cloud-relay' ? profile.access.accountSession.secureCredentialKey : undefined
    )).filter((key): key is string => Boolean(key)));
    for (const profile of cloudProfiles) await this.remove(profile);
    for (const key of credentialKeys) await this.sessionStorage.remove(key);
    return this.list();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private async index() {
    const raw = await this.storage.get(PROFILE_INDEX_KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^profile\.(?:cloud-relay\.)?[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/.test(item)) : [];
    } catch {
      return [];
    }
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

function sameIdentity(left: MobileControlPlaneProfile, right: MobileControlPlaneProfile) {
  return left.identity.controlPlaneId === right.identity.controlPlaneId
    && left.identity.publicKeyFingerprint === right.identity.publicKeyFingerprint
    && left.access.kind === right.access.kind;
}
