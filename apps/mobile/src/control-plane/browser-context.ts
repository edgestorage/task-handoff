import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { supportsDirectoryBrowserTunnel, type ControlPlaneInstanceDirectoryCapabilities } from '@task-handoff/protocol/control-plane-directory';
import { browserChannelError } from '@task-handoff/protocol/relay-browser-channel';

import {
  browserCapabilities as nativeBrowserCapabilities,
  activateBrowserContext as nativeActivateBrowserContext,
  prepareBrowserContext as nativePrepareBrowserContext,
  releaseAllBrowserContexts as nativeReleaseAllBrowserContexts,
  releaseBrowserContext as nativeReleaseBrowserContext,
  type BrowserNativeCapabilities,
  createBridgedBrowserTransport,
  isBridgedBrowserTransportAvailable,
  subscribeBrowserDiagnostics,
} from '../../modules/task-handoff-browser/src';
import { browserErrorDiagnostic, traceBrowserTask } from '../browser/diagnostics';
import { diagnosticLog } from '../observability/diagnostic-logs';
import { isDirectMobileControlPlaneProfile, type MobileControlPlaneProfile } from './profile';

export type MobileBrowserCapability = BrowserNativeCapabilities & {
  supported: boolean;
  directory: boolean;
  directTransport: boolean;
};

export async function mobileBrowserCapability(
  profile: MobileControlPlaneProfile,
  capabilities: ControlPlaneInstanceDirectoryCapabilities | undefined,
  api?: ControlPlaneClient,
): Promise<MobileBrowserCapability> {
  const native = await nativeBrowserCapabilities();
  const directory = supportsDirectoryBrowserTunnel(capabilities);
  const directTransport = isDirectMobileControlPlaneProfile(profile);
  const channelTransport = !directTransport && isBridgedBrowserTransportAvailable?.() && !!api?.browser.supportsChannel
    ? await api.browser.supportsChannel() : false;
  const supportedTransport = directTransport || channelTransport;
  return {
    ...native,
    directory,
    directTransport,
    supported: native.supported && directory && supportedTransport,
    ...(!directory ? { reason: 'INSTANCE_BROWSER_TUNNEL_UNAVAILABLE' }
      : !supportedTransport ? { reason: 'TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE' }
        : {}),
  };
}

export async function prepareMobileBrowserContext(input: {
  api: ControlPlaneClient;
  profile: MobileControlPlaneProfile;
  instanceId: string;
  onClose?: (error?: Error) => void;
}) {
  const data = { controlPlaneId: input.profile.identity.controlPlaneId, instanceId: input.instanceId, transport: input.profile.access.kind };
  return traceBrowserTask('browser.context.prepare', data, async (connectionId) => {
    const context = { ...data, connectionId };
    let contextId: string | undefined;
    let bridge: { transportId: string; close(error?: Error): void; isClosed(): boolean } | undefined;
    let closed: Error | undefined;
    let disposed = false;
    const onClose = (error: Error) => {
      if (disposed || closed) return;
      closed = error;
      diagnosticLog.warn('browser.channel.closed', { ...context, contextId, ...browserErrorDiagnostic(error) });
      input.onClose?.(error);
    };
    // Keep this subscription for the context lifetime: receive/protocol failures
    // happen after prepare resolves, including on Direct native WebSockets.
    const subscription = subscribeBrowserDiagnostics((event) => {
      if (event.controlPlaneId !== data.controlPlaneId || event.instanceId !== data.instanceId || disposed) return;
      if (contextId && event.contextId && event.contextId !== contextId) return;
      diagnosticLog.info('browser.native.stage', { ...context, ...event });
      if (event.stage === 'tunnel.closed') onClose(Object.assign(browserChannelError('BROWSER_NATIVE_TUNNEL_CLOSED'), {
        closeSource: `native.${event.closeSource ?? 'unknown'}`,
        nativeErrorDomain: event.errorDomain,
        nativeErrorCode: event.errorCode,
      }));
    });
    const cleanup = () => {
      disposed = true;
      subscription?.remove();
      bridge?.close();
    };
    try {
      let nativeInput: Parameters<typeof nativePrepareBrowserContext>[0];
      if (!isDirectMobileControlPlaneProfile(input.profile)) {
        bridge = await traceBrowserTask('browser.channel.open', context, () => createBridgedBrowserTransport(
          (handlers, signal) => input.api.browser.openChannel(input.instanceId, handlers, signal),
          (error) => onClose(error ?? browserChannelError('BROWSER_CHANNEL_CLOSED')),
          (stage, details) => diagnosticLog.info(`browser.bridge.${stage}`, { ...context, ...details }),
        ));
        nativeInput = { controlPlaneId: data.controlPlaneId, instanceId: data.instanceId, transportId: bridge.transportId };
      } else {
        const access = await traceBrowserTask('browser.access.request', context, () => input.api.browser.access(input.instanceId));
        diagnosticLog.info('browser.access.received', { ...context, accessId: access.accessId, expiresAt: access.expiresAt });
        const relay = new URL(access.relayPath, input.profile.access.origin);
        relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
        nativeInput = { controlPlaneId: data.controlPlaneId, instanceId: data.instanceId, relayUrl: relay.toString(), token: access.token };
      }
      const prepared = await traceBrowserTask('browser.native.prepare', context, () => nativePrepareBrowserContext(nativeInput));
      contextId = prepared.contextId;
      if (closed || bridge?.isClosed()) {
        await nativeReleaseBrowserContext(contextId);
        throw closed ?? browserChannelError('BROWSER_CHANNEL_CLOSED');
      }
      contextLifetimes.set(contextId, cleanup);
      diagnosticLog.info('browser.context.ready', { ...context, contextId, transportId: bridge?.transportId });
      return prepared;
    } catch (error) { cleanup(); throw error; }
  });
}

const contextLifetimes = new Map<string, () => void>();
export async function releaseBrowserContext(contextId: string) {
  return traceBrowserTask('browser.context.release', { contextId }, async () => {
    const cleanup = contextLifetimes.get(contextId);
    contextLifetimes.delete(contextId);
    cleanup?.();
    await nativeReleaseBrowserContext(contextId);
  });
}
export async function releaseAllBrowserContexts() {
  for (const cleanup of contextLifetimes.values()) cleanup();
  contextLifetimes.clear();
  await nativeReleaseAllBrowserContexts();
}

export function activateMobileBrowserContext(contextId: string) {
  return traceBrowserTask('browser.context.activate', { contextId }, () => nativeActivateBrowserContext(contextId));
}
