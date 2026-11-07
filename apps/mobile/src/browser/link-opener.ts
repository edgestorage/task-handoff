import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { ControlPlaneInstanceDirectoryCapabilities } from '@task-handoff/protocol/control-plane-directory';
import * as WebBrowser from 'expo-web-browser';

import { diagnosticErrorDetails, diagnosticLog } from '../observability/diagnostic-logs';
import type { MobileControlPlaneProfile } from '../control-plane/profile';
import { mobileBrowserCapability, type MobileBrowserCapability } from '../control-plane/browser-context';
import { mobileBrowserController } from './controller';
import { normalizeBrowserAddress } from './url';

export type EmbeddedWebBrowserTarget =
  | { kind: 'tab'; tabId: string }
  | { kind: 'app-browser' };

type EmbeddedWebBrowserDependencies = {
  browserCapability(
    profile: MobileControlPlaneProfile,
    capabilities: ControlPlaneInstanceDirectoryCapabilities | undefined,
    api?: ControlPlaneClient,
  ): Promise<MobileBrowserCapability>;
  createTab(input: {
    api: ControlPlaneClient;
    profile: MobileControlPlaneProfile;
    instanceId: string;
    initialUrl: string;
  }): Promise<{ id: string }>;
  openAppBrowser(url: string): Promise<unknown>;
  diagnostic(level: 'info' | 'warn', event: string, data?: Record<string, unknown>): void;
};

const defaultDependencies: EmbeddedWebBrowserDependencies = {
  browserCapability: mobileBrowserCapability,
  createTab: (input) => mobileBrowserController.create(input),
  openAppBrowser: (url) => WebBrowser.openBrowserAsync(url, {
    enableBarCollapsing: true,
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    showTitle: true,
  }),
  diagnostic: (level, event, data) => diagnosticLog[level](event, data),
};

/**
 * Opens a web link inside the app. Instance-tunneled Browser tabs are preferred
 * because they resolve instance-local addresses; transports that cannot carry
 * the Browser tunnel use the native in-app browser.
 */
export async function openEmbeddedWebBrowserLink(input: {
  api?: ControlPlaneClient;
  capabilities?: ControlPlaneInstanceDirectoryCapabilities;
  instanceId: string;
  profile?: MobileControlPlaneProfile;
  url: string;
}, dependencies: EmbeddedWebBrowserDependencies = defaultDependencies): Promise<EmbeddedWebBrowserTarget> {
  const url = normalizedWebPageUrl(input.url);
  let capability: MobileBrowserCapability | undefined;
  if (input.api && input.profile) {
    capability = await dependencies.browserCapability(input.profile, input.capabilities, input.api).catch((error) => {
      dependencies.diagnostic('warn', 'browser.link.capability_failed', diagnosticErrorDetails(error));
      return undefined;
    });
    if (capability?.supported) {
      const tab = await dependencies.createTab({
        api: input.api,
        profile: input.profile,
        instanceId: input.instanceId,
        initialUrl: url,
      });
      return { kind: 'tab', tabId: tab.id };
    }
    dependencies.diagnostic('info', 'browser.link.native_fallback', {
      ...(capability?.reason ? { reason: capability.reason } : {}),
    });
  }
  await dependencies.openAppBrowser(url);
  return { kind: 'app-browser' };
}

function normalizedWebPageUrl(raw: string) {
  return normalizeBrowserAddress(raw);
}
