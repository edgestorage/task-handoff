import { requireOptionalNativeModule } from 'expo';

import type {
  BrowserNativeCapabilities,
  BrowserNativeDiagnostics,
  PrepareBrowserContextInput,
  PreparedBrowserContext,
} from './TaskHandoffBrowser.types';

type NativeBrowserModule = {
  browserCapabilities(): Promise<BrowserNativeCapabilities>;
  browserDiagnostics(): Promise<BrowserNativeDiagnostics>;
  prepareBrowserContext(input: PrepareBrowserContextInput): Promise<PreparedBrowserContext>;
  activateBrowserContext(contextId: string): Promise<void>;
  releaseBrowserContext(contextId: string): Promise<void>;
  releaseAllBrowserContexts(): Promise<void>;
};

const native = requireOptionalNativeModule<NativeBrowserModule>('TaskHandoffBrowser');

export default native ?? {
  async browserCapabilities() {
    return {
      supported: false,
      platform: 'unsupported' as const,
      proxyOverride: false,
      isolatedProfile: false,
      reason: 'NATIVE_BROWSER_REQUIRED',
    };
  },
  async browserDiagnostics() { return { activeContexts: 0, preparedContexts: 0, releasedContexts: 0 }; },
  async prepareBrowserContext(_input: PrepareBrowserContextInput): Promise<PreparedBrowserContext> {
    throw new Error('The native Browser module is unavailable on this build.');
  },
  async activateBrowserContext(_contextId: string) {},
  async releaseBrowserContext(_contextId: string) {},
  async releaseAllBrowserContexts() {},
};
