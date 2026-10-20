import { createControlPlaneClient } from '@task-handoff/control-plane-client';

import type { SecureValueStore } from '../platform/secure-storage';
import { isMobileFeatureEnabled, isMobileTestMode, mobileCloudEnvironment } from '../platform/build-variant';
import { DirectControlPlaneTransport } from './direct-transport';
import { isDirectMobileControlPlaneProfile, type MobileControlPlaneProfile, type MobileDirectControlPlaneProfile, type MobileCloudRelayControlPlaneProfile } from './profile';
import { MobileCloudAccountSession } from './cloud-account';
import { allowCloudRelayUrlForService, createMobileRelayChannelFactory } from './relay-channel';
import { RelayControlPlaneTransport, type RelayChannelFactory } from './relay-transport';
import { RelayWinnerCache } from './relay-winner-cache';
import { MobileRelayProofKeyProvider } from './relay-proof-key';
import { MobileRelaySessionStore } from './relay-session-store';
import { mobileCloudDiscovery } from '../cloud-discovery';

type MobileClientOptions = { relayChannelFactory?: RelayChannelFactory; cloudRequest?: typeof fetch; allowNonProductionOrigin?: boolean; relayWinnerCache?: RelayWinnerCache };

const clientsByStore = new WeakMap<SecureValueStore, Map<string, ReturnType<typeof directClient>>>();
const cloudClientsByStore = new WeakMap<SecureValueStore, Map<string, ReturnType<typeof cloudClient>>>();

export function createDirectControlPlaneClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore) {
  if (!isDirectMobileControlPlaneProfile(profile)) throw new Error('Direct Control Plane client requires a direct profile.');
  return cachedClient(clientsByStore, secureStore, clientCacheKey(profile), () => directClient(profile, secureStore));
}

export function createMobileControlPlaneClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore, options: MobileClientOptions = {}) {
  if (isDirectMobileControlPlaneProfile(profile)) return createDirectControlPlaneClient(profile, secureStore);
  if (!isMobileFeatureEnabled('officialAccount')) {
    throw Object.assign(new Error('Cloud Relay is disabled in this mobile build.'), { code: 'CLOUD_RELAY_FEATURE_DISABLED' });
  }
  const cloud = profile as MobileCloudRelayControlPlaneProfile;
  // Screens call this helper per action; without a cache every call would open its own account
  // session and Relay transport for the same binding. Requests flow through the shared transport,
  // so the account session must be shared with it. Calls that inject transport dependencies stay
  // uncached: those are tests that need their own transport instance.
  if (options.relayChannelFactory || options.cloudRequest || options.allowNonProductionOrigin !== undefined || options.relayWinnerCache) return cloudClient(cloud, secureStore, options);
  return cachedClient(cloudClientsByStore, secureStore, clientCacheKey(cloud), () => cloudClient(cloud, secureStore, {}));
}

function cachedClient<T>(stores: WeakMap<SecureValueStore, Map<string, T>>, secureStore: SecureValueStore, key: string, create: () => T): T {
  const clients = stores.get(secureStore) ?? new Map<string, T>();
  stores.set(secureStore, clients);
  const existing = clients.get(key);
  if (existing) return existing;
  const created = create();
  clients.set(key, created);
  return created;
}

function clientCacheKey(profile: MobileControlPlaneProfile) {
  return JSON.stringify({ identity: profile.identity, access: profile.access });
}

function cloudClient(profile: MobileCloudRelayControlPlaneProfile, secureStore: SecureValueStore, options: MobileClientOptions) {
  const account = new MobileCloudAccountSession(secureStore, {
    origin: profile.access.serviceOrigin,
    request: options.cloudRequest,
    allowNonProductionOrigin: options.allowNonProductionOrigin ?? isMobileTestMode,
    endpointResolver: mobileCloudDiscovery,
    reference: profile.access.accountSession,
  });
  const allowIsolatedEnvironment = () => account.origin !== mobileCloudEnvironment.serviceOrigin;
  // The remembered winner is what turns the second connection into a single
  // validation sample, so the cache lives with the client and shares its store.
  const winnerCache = options.relayWinnerCache ?? new RelayWinnerCache({ store: secureStore });
  const proofKey = new MobileRelayProofKeyProvider(secureStore, profile.access.accountSession.id);
  const sessionStore = new MobileRelaySessionStore(secureStore, profile.access.accountSession.id, profile.identity.controlPlaneId);
  const allowRelayUrl = (url: URL) => allowCloudRelayUrlForService(url, account.origin, allowIsolatedEnvironment());
  const transport = new RelayControlPlaneTransport(profile, account.client, options.relayChannelFactory ?? createMobileRelayChannelFactory({ allowRelayUrl }), { winnerCache, allowRelayUrl, proofKey, sessionStore });
  return { transport, api: createControlPlaneClient(transport), account };
}

function directClient(profile: MobileDirectControlPlaneProfile, secureStore: SecureValueStore) {
  const transport = new DirectControlPlaneTransport(profile, secureStore, { allowInsecureHttp: isMobileTestMode });
  return {
    transport,
    api: createControlPlaneClient(transport),
  };
}
