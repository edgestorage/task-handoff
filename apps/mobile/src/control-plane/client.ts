import { createControlPlaneClient } from '@task-handoff/control-plane-client';

import type { SecureValueStore } from '../platform/secure-storage';
import { isMobileTestMode } from '../platform/build-variant';
import { DirectControlPlaneTransport } from './direct-transport';
import { isDirectMobileControlPlaneProfile, type MobileControlPlaneProfile, type MobileDirectControlPlaneProfile, type MobileCloudRelayControlPlaneProfile } from './profile';
import { MobileCloudAccountSession, CLOUD_PRODUCTION_ORIGIN } from './cloud-account';
import { allowCloudRelayUrlForService, createMobileRelayChannelFactory } from './relay-channel';
import { RelayControlPlaneTransport, type RelayChannelFactory } from './relay-transport';

const clientsByStore = new WeakMap<SecureValueStore, Map<string, ReturnType<typeof directClient>>>();

export function createDirectControlPlaneClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore) {
  if (!isDirectMobileControlPlaneProfile(profile)) throw new Error('Direct Control Plane client requires a direct profile.');
  const key = JSON.stringify({ identity: profile.identity, access: profile.access });
  const clients = clientsByStore.get(secureStore) ?? new Map<string, ReturnType<typeof directClient>>();
  clientsByStore.set(secureStore, clients);
  const existing = clients.get(key);
  if (existing) return existing;
  const created = directClient(profile, secureStore);
  clients.set(key, created);
  return created;
}

export function createMobileControlPlaneClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore, options: { relayChannelFactory?: RelayChannelFactory; cloudRequest?: typeof fetch; allowNonProductionOrigin?: boolean } = {}) {
  if (isDirectMobileControlPlaneProfile(profile)) return createDirectControlPlaneClient(profile, secureStore);
  const cloud = profile as MobileCloudRelayControlPlaneProfile;
  const account = new MobileCloudAccountSession(secureStore, { origin: cloud.access.serviceOrigin, request: options.cloudRequest, allowNonProductionOrigin: options.allowNonProductionOrigin, reference: cloud.access.accountSession });
  const allowIsolatedEnvironment = account.origin !== CLOUD_PRODUCTION_ORIGIN;
  const transport = new RelayControlPlaneTransport(cloud, account.client, options.relayChannelFactory ?? createMobileRelayChannelFactory({ allowRelayUrl: (url) => allowCloudRelayUrlForService(url, cloud.access.serviceOrigin, allowIsolatedEnvironment) }));
  return { transport, api: createControlPlaneClient(transport), account };
}

function directClient(profile: MobileDirectControlPlaneProfile, secureStore: SecureValueStore) {
  const transport = new DirectControlPlaneTransport(profile, secureStore, { allowInsecureHttp: isMobileTestMode });
  return {
    transport,
    api: createControlPlaneClient(transport),
  };
}
