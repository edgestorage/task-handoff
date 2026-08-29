import { MobileControlPlaneProfileStore } from './profile-store';
import { ExpoSecureValueStore } from '../platform/secure-storage';
import { ExpoFileValueStore } from '../platform/file-storage';
import { MobileAiSessionDraftStore } from '../ai-sessions/actions';
import { MobileAiSessionCreateRequestStore } from '../ai-sessions/session-lifecycle';
import { MobileAiSessionPermissionStore } from '../ai-sessions/permission-store';
import { mobileAiSessionStore } from '../ai-sessions/store';
import { mobileDirectoryStore } from '../directories/store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { mobileTriggerStore } from '../triggers/store';
import type { MobileControlPlaneProfile } from './profile';
import { createDirectControlPlaneClient } from './client';
import { requireRemoteMobileSessionRevocation } from './profile-removal';
import { MobileCloudAccountSession } from './cloud-account';

export const mobileSecureStore = new ExpoSecureValueStore();
export const mobileFileStore = new ExpoFileValueStore();
export const mobileProfileStore = new MobileControlPlaneProfileStore(mobileFileStore, (warning) => {
  mobileMetrics.record('profile.warning', { reason: warning.code === 'PROFILE_UNKNOWN_FIELDS' ? 'unknown-fields' : 'invalid-profile' });
}, mobileSecureStore);
export const mobileCloudAccountSession = new MobileCloudAccountSession(mobileSecureStore);
const ACTIVE_CLOUD_ACCOUNT_KEY = 'cloud.account.active';
type CloudAccountReference = { id: string; secureCredentialKey: string };
type CloudAccountListener = () => void;
const cloudAccountListeners = new Set<CloudAccountListener>();

export function subscribeCloudAccountState(listener: CloudAccountListener) {
  cloudAccountListeners.add(listener);
  return () => { cloudAccountListeners.delete(listener); };
}

export async function saveActiveCloudAccountReference() {
  const next = mobileCloudAccountSession.reference();
  const current = await activeCloudAccountReference();
  if (current && (current.id !== next.id || current.secureCredentialKey !== next.secureCredentialKey)) {
    // completeLogin has already installed the new device credential. Revoke it
    // before rejecting an implicit account switch and preserve the old owner.
    await mobileCloudAccountSession.logout().catch(() => undefined);
    throw Object.assign(new Error('Sign out of the current Thandoff account before signing in with another Thandoff account.'), {
      code: 'CLOUD_ACCOUNT_SWITCH_REQUIRES_LOGOUT',
    });
  }
  await mobileSecureStore.set(ACTIVE_CLOUD_ACCOUNT_KEY, JSON.stringify(next));
  emitCloudAccountState();
}

export async function hasActiveCloudAccount() {
  const reference = await activeCloudAccountReference();
  if (!reference) return false;
  if (await mobileSecureStore.get(reference.secureCredentialKey)) return true;
  await mobileSecureStore.remove(ACTIVE_CLOUD_ACCOUNT_KEY);
  await mobileProfileStore.removeCloudAccountProfiles();
  emitCloudAccountState();
  return false;
}

export async function restoreActiveCloudAccountSession() {
  const reference = await activeCloudAccountReference();
  if (!reference) throw Object.assign(new Error('Thandoff account sign-in is required.'), { code: 'CLOUD_ACCOUNT_REAUTHENTICATION_REQUIRED' });
  await mobileCloudAccountSession.restore(reference);
  return mobileCloudAccountSession;
}

export async function logoutActiveCloudAccount() {
  const reference = await activeCloudAccountReference();
  try {
    if (reference) await mobileCloudAccountSession.restore(reference);
    if (reference) await mobileCloudAccountSession.logout();
  } finally {
    try {
      await mobileSecureStore.remove(ACTIVE_CLOUD_ACCOUNT_KEY);
      await mobileProfileStore.removeCloudAccountProfiles();
    } finally {
      emitCloudAccountState();
    }
  }
}

async function activeCloudAccountReference(): Promise<CloudAccountReference | undefined> {
  const raw = await mobileSecureStore.get(ACTIVE_CLOUD_ACCOUNT_KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CloudAccountReference>;
    if (typeof value.id !== 'string' || !value.id || typeof value.secureCredentialKey !== 'string' || !value.secureCredentialKey) throw new Error('invalid reference');
    return { id: value.id, secureCredentialKey: value.secureCredentialKey };
  } catch {
    await mobileSecureStore.remove(ACTIVE_CLOUD_ACCOUNT_KEY);
    emitCloudAccountState();
    return undefined;
  }
}

function emitCloudAccountState() {
  for (const listener of cloudAccountListeners) listener();
}
export const mobileDraftStore = new MobileAiSessionDraftStore(mobileFileStore);
export const mobileCreateRequestStore = new MobileAiSessionCreateRequestStore(mobileFileStore);
export const mobilePermissionStore = new MobileAiSessionPermissionStore(mobileFileStore);

export async function deleteMobileControlPlaneProfile(profile: MobileControlPlaneProfile) {
  const controlPlaneId = profile.identity.controlPlaneId;
  if (profile.access.kind === 'direct') await requireRemoteMobileSessionRevocation(() => createDirectControlPlaneClient(profile, mobileSecureStore).api.auth.logoutMobile());
  await mobileDraftStore.clearProfile(controlPlaneId);
  await mobileCreateRequestStore.clearProfile(controlPlaneId);
  await mobilePermissionStore.clearProfile(controlPlaneId);
  const remaining = await mobileProfileStore.remove(profile);
  mobileAiSessionStore.clearProfile(controlPlaneId);
  mobileDirectoryStore.clearProfile(controlPlaneId);
  mobileTriggerStore.clearProfile(controlPlaneId);
  await (await import('../browser/controller')).mobileBrowserController.clearProfile(controlPlaneId);
  return remaining;
}
