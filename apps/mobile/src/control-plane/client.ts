import { createControlPlaneClient } from '@task-handoff/control-plane-client';

import type { SecureValueStore } from '../platform/secure-storage';
import { isMobileTestMode } from '../platform/build-variant';
import { DirectControlPlaneTransport } from './direct-transport';
import type { MobileControlPlaneProfile } from './profile';

const clientsByStore = new WeakMap<SecureValueStore, Map<string, ReturnType<typeof directClient>>>();

export function createDirectControlPlaneClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore) {
  const key = JSON.stringify({ identity: profile.identity, access: profile.access });
  const clients = clientsByStore.get(secureStore) ?? new Map<string, ReturnType<typeof directClient>>();
  clientsByStore.set(secureStore, clients);
  const existing = clients.get(key);
  if (existing) return existing;
  const created = directClient(profile, secureStore);
  clients.set(key, created);
  return created;
}

function directClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore) {
  const transport = new DirectControlPlaneTransport(profile, secureStore, { allowInsecureHttp: isMobileTestMode });
  return {
    transport,
    api: createControlPlaneClient(transport),
  };
}
