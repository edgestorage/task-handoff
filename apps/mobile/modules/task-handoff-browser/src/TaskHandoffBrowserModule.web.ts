import type {
  BrowserNativeCapabilities,
  BrowserNativeDiagnostics,
  PrepareBrowserContextInput,
  PreparedBrowserContext,
} from './TaskHandoffBrowser.types';

const unsupported = (): BrowserNativeCapabilities => ({
  supported: false,
  platform: 'unsupported',
  proxyOverride: false,
  isolatedProfile: false,
  reason: 'NATIVE_BROWSER_REQUIRED',
});

export default {
  async browserCapabilities() { return unsupported(); },
  async browserDiagnostics(): Promise<BrowserNativeDiagnostics> { return { activeContexts: 0, preparedContexts: 0, releasedContexts: 0 }; },
  async prepareBrowserContext(_input: PrepareBrowserContextInput): Promise<PreparedBrowserContext> {
    throw new Error('The native Browser module is unavailable on this platform.');
  },
  async activateBrowserContext(_contextId: string) {},
  async releaseBrowserContext(_contextId: string) {},
  async releaseAllBrowserContexts() {},
};
