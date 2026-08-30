import type { Ref, ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type BrowserPlatform = 'ios' | 'android' | 'unsupported';

export type BrowserNativeCapabilities = {
  supported: boolean;
  platform: BrowserPlatform;
  proxyOverride: boolean;
  isolatedProfile: boolean;
  reason?: string;
};

export type PrepareBrowserContextInput = {
  controlPlaneId: string;
  instanceId: string;
  relayUrl: string;
  token: string;
};

export type PreparedBrowserContext = {
  contextId: string;
};

export type BrowserNativeDiagnostics = {
  activeContexts: number;
  preparedContexts: number;
  releasedContexts: number;
};

export type BrowserNavigationState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserLoadingState = { loading: boolean; progress: number };
export type BrowserErrorState = { code: string; description: string };
export type BrowserNewWindow = { url: string };

export type BrowserViewRef = {
  loadUrl(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stopLoading(): Promise<void>;
};

export type BrowserViewProps = {
  contextId: string;
  initialUrl?: string;
  onNavigationStateChange?: (event: { nativeEvent: BrowserNavigationState }) => void;
  onLoadingChange?: (event: { nativeEvent: BrowserLoadingState }) => void;
  onError?: (event: { nativeEvent: BrowserErrorState }) => void;
  onNewWindow?: (event: { nativeEvent: BrowserNewWindow }) => void;
  ref?: Ref<BrowserViewRef>;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};
