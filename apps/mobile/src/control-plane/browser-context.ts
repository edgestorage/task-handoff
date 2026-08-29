import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { supportsDirectoryBrowserTunnel, type ControlPlaneInstanceDirectoryCapabilities } from '@task-handoff/protocol/control-plane-directory';

import {
  browserCapabilities as nativeBrowserCapabilities,
  prepareBrowserContext as nativePrepareBrowserContext,
  releaseAllBrowserContexts,
  releaseBrowserContext,
  type BrowserNativeCapabilities,
} from '../../modules/task-handoff-browser/src';
import { isDirectMobileControlPlaneProfile, type MobileControlPlaneProfile } from './profile';

export type MobileBrowserCapability = BrowserNativeCapabilities & {
  supported: boolean;
  directory: boolean;
  directTransport: boolean;
};

export async function mobileBrowserCapability(
  profile: MobileControlPlaneProfile,
  capabilities: ControlPlaneInstanceDirectoryCapabilities | undefined,
): Promise<MobileBrowserCapability> {
  const native = await nativeBrowserCapabilities();
  const directory = supportsDirectoryBrowserTunnel(capabilities);
  const directTransport = isDirectMobileControlPlaneProfile(profile);
  return {
    ...native,
    directory,
    directTransport,
    supported: native.supported && directory && directTransport,
    ...(!directory ? { reason: 'INSTANCE_BROWSER_TUNNEL_UNAVAILABLE' }
      : !directTransport ? { reason: 'TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE' }
        : {}),
  };
}

export async function prepareMobileBrowserContext(input: {
  api: ControlPlaneClient;
  profile: MobileControlPlaneProfile;
  instanceId: string;
}) {
  if (!isDirectMobileControlPlaneProfile(input.profile)) {
    throw Object.assign(new Error('Browser requires a Direct Control Plane profile.'), { code: 'TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE' });
  }
  const access = await input.api.browser.access(input.instanceId);
  const relay = new URL(access.relayPath, input.profile.access.origin);
  relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
  return nativePrepareBrowserContext({
    controlPlaneId: input.profile.identity.controlPlaneId,
    instanceId: input.instanceId,
    relayUrl: relay.toString(),
    token: access.token,
  });
}

export { releaseAllBrowserContexts, releaseBrowserContext };
