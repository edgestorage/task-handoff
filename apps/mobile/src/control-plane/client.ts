import { createControlPlaneClient } from '@task-handoff/control-plane-client';

import type { SecureValueStore } from '../platform/secure-storage';
import { isMobileTestMode } from '../platform/build-variant';
import { DirectControlPlaneTransport } from './direct-transport';
import type { MobileControlPlaneProfile } from './profile';

export function createDirectControlPlaneClient(profile: MobileControlPlaneProfile, secureStore: SecureValueStore) {
  const transport = new DirectControlPlaneTransport(profile, secureStore, { allowInsecureHttp: isMobileTestMode });
  return {
    transport,
    api: createControlPlaneClient(transport),
  };
}
