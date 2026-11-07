import { requireOptionalNativeModule } from 'expo';

import type {
  BrowserDiagnosticEvent,
  BrowserNativeCapabilities,
  BrowserNativeDiagnostics,
  PrepareBrowserContextInput,
  PreparedBrowserContext,
} from './TaskHandoffBrowser.types';

type NativeBrowserModule = {
  addListener?(name: 'onBrowserDiagnostic', listener: (event: BrowserDiagnosticEvent) => void): { remove(): void };
  browserCapabilities(): Promise<BrowserNativeCapabilities>;
  browserDiagnostics(): Promise<BrowserNativeDiagnostics>;
  prepareBrowserContext(input: PrepareBrowserContextInput): Promise<PreparedBrowserContext>;
  activateBrowserContext(contextId: string): Promise<void>;
  releaseBrowserContext(contextId: string): Promise<void>;
  releaseAllBrowserContexts(): Promise<void>;
};

const native = requireOptionalNativeModule<NativeBrowserModule>('TaskHandoffBrowser');

// Compatibility for mobile-v0.0.12: native diagnostics are optional when JS is
// running on an older binary; registration must not block browser access.
export function subscribeBrowserDiagnostics(listener: (event: BrowserDiagnosticEvent) => void) {
  try { return native?.addListener?.('onBrowserDiagnostic', listener); }
  catch { return undefined; }
}

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
