import { MobileControlPlaneProfileStore } from './profile-store';
import { ExpoSecureValueStore } from '../platform/secure-storage';
import { ExpoFileValueStore } from '../platform/file-storage';
import { MobileAiSessionDraftStore } from '../ai-sessions/actions';
import { MobileAiSessionCreateRequestStore } from '../ai-sessions/session-lifecycle';
import { MobileAiSessionPermissionStore } from '../ai-sessions/permission-store';
import { mobileAiSessionStore } from '../ai-sessions/store';
import { mobileDirectoryStore } from '../directories/store';
import { mobileMetrics } from '../observability/mobile-metrics';
import type { MobileControlPlaneProfile } from './profile';

export const mobileSecureStore = new ExpoSecureValueStore();
export const mobileFileStore = new ExpoFileValueStore();
export const mobileProfileStore = new MobileControlPlaneProfileStore(mobileFileStore, (warning) => {
  mobileMetrics.record('profile.warning', { reason: warning.code === 'PROFILE_UNKNOWN_FIELDS' ? 'unknown-fields' : 'invalid-profile' });
}, mobileSecureStore);
export const mobileDraftStore = new MobileAiSessionDraftStore(mobileFileStore);
export const mobileCreateRequestStore = new MobileAiSessionCreateRequestStore(mobileFileStore);
export const mobilePermissionStore = new MobileAiSessionPermissionStore(mobileFileStore);

export async function deleteMobileControlPlaneProfile(profile: MobileControlPlaneProfile) {
  const controlPlaneId = profile.identity.controlPlaneId;
  await mobileDraftStore.clearProfile(controlPlaneId);
  await mobileCreateRequestStore.clearProfile(controlPlaneId);
  await mobilePermissionStore.clearProfile(controlPlaneId);
  const remaining = await mobileProfileStore.remove(profile);
  mobileAiSessionStore.clearProfile(controlPlaneId);
  mobileDirectoryStore.clearProfile(controlPlaneId);
  return remaining;
}
