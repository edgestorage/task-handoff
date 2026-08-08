import type { SecureValueStore, ValueStore } from '../platform/secure-storage';
import { MobileControlPlaneProfileSchema, parseStoredMobileControlPlaneProfile, storedMobileControlPlaneProfileUnknownFields, type MobileControlPlaneProfile } from './profile';

const PROFILE_INDEX_KEY = 'profiles.index';
const ACTIVE_PROFILE_KEY = 'profiles.active';
type Listener = () => void;

function profileStorageKey(profile: Pick<MobileControlPlaneProfile, 'identity'>) {
  const bytes = new TextEncoder().encode(profile.identity.controlPlaneId);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const id = globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `profile.${profile.identity.publicKeyFingerprint.slice('sha256:'.length)}.${id}`;
}

export class MobileControlPlaneProfileStore {
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: ValueStore,
    private readonly onWarning: (warning: { code: 'PROFILE_UNKNOWN_FIELDS' | 'PROFILE_INVALID'; fields?: readonly string[] }) => void = () => undefined,
    private readonly sessionStorage: SecureValueStore = storage,
  ) {}

  async list() {
    const keys = await this.index();
    const profiles = await Promise.all(keys.map(async (key) => {
      const raw = await this.storage.get(key);
      if (!raw) return undefined;
      try {
        const stored = JSON.parse(raw);
        const fields = storedMobileControlPlaneProfileUnknownFields(stored);
        if (fields.length) this.onWarning({ code: 'PROFILE_UNKNOWN_FIELDS', fields });
        return parseStoredMobileControlPlaneProfile(stored);
      } catch {
        this.onWarning({ code: 'PROFILE_INVALID' });
        return undefined;
      }
    }));
    return profiles.filter((profile): profile is MobileControlPlaneProfile => Boolean(profile));
  }

  async put(profile: MobileControlPlaneProfile) {
    const parsed = MobileControlPlaneProfileSchema.parse(profile);
    const existing = (await this.list()).find((candidate) => candidate.identity.controlPlaneId === parsed.identity.controlPlaneId
      && candidate.identity.publicKeyFingerprint === parsed.identity.publicKeyFingerprint);
    const key = existing ? profileStorageKey(existing) : profileStorageKey(parsed);
    await this.storage.set(key, JSON.stringify(existing ? { ...parsed, createdAt: existing.createdAt } : parsed));
    const index = await this.index();
    if (!index.includes(key)) await this.storage.set(PROFILE_INDEX_KEY, JSON.stringify([...index, key]));
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
    const stored = (await this.list()).find((candidate) => sameIdentity(candidate, parsed));
    if (!stored) throw new Error('Control Plane profile is not stored on this device.');
    await this.storage.set(ACTIVE_PROFILE_KEY, profileStorageKey(stored));
    this.emit();
    return stored;
  }

  async remove(profile: MobileControlPlaneProfile) {
    const parsed = MobileControlPlaneProfileSchema.parse(profile);
    const key = profileStorageKey(parsed);
    const index = await this.index();
    const nextIndex = index.filter((candidate) => candidate !== key);
    const storedProfiles = await this.list();
    if (!storedProfiles.some((candidate) => !sameIdentity(candidate, parsed)
      && candidate.access.secureSessionKey === parsed.access.secureSessionKey)) {
      await this.sessionStorage.remove(parsed.access.secureSessionKey);
    }
    await this.storage.remove(key);
    if (nextIndex.length) await this.storage.set(PROFILE_INDEX_KEY, JSON.stringify(nextIndex));
    else await this.storage.remove(PROFILE_INDEX_KEY);
    const activeKey = await this.storage.get(ACTIVE_PROFILE_KEY);
    if (activeKey === key) {
      if (nextIndex[0]) await this.storage.set(ACTIVE_PROFILE_KEY, nextIndex[0]);
      else await this.storage.remove(ACTIVE_PROFILE_KEY);
    }
    const remaining = await this.list();
    this.emit();
    return remaining;
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
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^profile\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/.test(item)) : [];
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
    && left.identity.publicKeyFingerprint === right.identity.publicKeyFingerprint;
}
