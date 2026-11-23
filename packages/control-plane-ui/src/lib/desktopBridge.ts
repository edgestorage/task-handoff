type OpenLocalPathResult = {
  ok: boolean;
  code?: string;
  error?: string;
};

export type DesktopBrowserAgentControl = { ok: boolean; code?: string; sourceRef?: string; ready?: boolean };

export type DesktopBrowserContextResult = { ok: boolean; code?: string; message?: string; contextId?: string; partition?: string; agentControl?: DesktopBrowserAgentControl };

export type DesktopBrowserLoadFailure = { instanceId?: string; host?: string; port?: number; code?: string; message?: string };

type DesktopClipboardResult = { ok: boolean; code?: string; text?: string };

type DesktopClipboardBridge = {
  readText?: () => Promise<DesktopClipboardResult>;
  writeText?: (text: string) => Promise<DesktopClipboardResult>;
  onChanged?: (listener: (input: { text?: string }) => void) => () => void;
};

export type DesktopBrowserPageHost = "renderer-webview" | "main-page-pool";

export type DesktopBrowserPageHostCapabilities = {
  backgroundCreation: boolean;
  surviveHostWindowClose: boolean;
  crossWindowAdopt: boolean;
};

export type DesktopBrowserControlInfo = {
  ok: boolean;
  code?: string;
  pageHost?: DesktopBrowserPageHost;
  pageHostCapabilities?: DesktopBrowserPageHostCapabilities;
  requestedPageHost?: DesktopBrowserPageHost;
  degraded?: boolean;
  degradedReason?: string;
  sourceRef?: string;
  generation?: number;
  ready?: boolean;
};

export type DesktopBrowserTab = {
  tabRef: string;
  instanceId: string;
  sessionKey?: string;
  pageHost: DesktopBrowserPageHost;
  pageHostCapabilities: DesktopBrowserPageHostCapabilities;
  url: string;
  title: string;
  state: string;
};

export type DesktopBrowserDeviceMetrics = {
  tabRef: string;
  instanceId: string;
  source: "agent";
  active: boolean;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  screenOrientation?: { type?: string; angle?: number };
};

export type DesktopBrowserTabResult = { ok: boolean; code?: string; message?: string; tab?: DesktopBrowserTab };

export type DesktopBrowserCaptureSurface = {
  requestId: string;
  instanceId: string;
  pageKey: string;
  width: number;
  height: number;
};

type DesktopBridge = {
  openLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
  revealLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
  openExternalUrl?: (url: string) => Promise<OpenLocalPathResult>;
  prepareBrowserContext?: (instanceId: string) => Promise<DesktopBrowserContextResult>;
  releaseBrowserContext?: (contextId: string) => Promise<{ ok: boolean }>;
  touchBrowserContext?: (contextId: string) => Promise<{ ok: boolean }>;
  getBrowserControlInfo?: (instanceId?: string) => Promise<DesktopBrowserControlInfo>;
  ensureBrowserAgentControl?: (instanceId: string) => Promise<DesktopBrowserAgentControl>;
  registerBrowserTab?: (input: { webContentsId: number; instanceId: string; sessionKey: string; creationRef?: string; title?: string; url?: string; state?: string }) => Promise<DesktopBrowserTabResult>;
  updateBrowserTab?: (input: { tabRef: string; title?: string; url?: string; state?: string }) => Promise<DesktopBrowserTabResult>;
  unregisterBrowserTab?: (webContentsId: number) => Promise<{ ok: boolean }>;
  listBrowserTabs?: (instanceId?: string) => Promise<{ ok: boolean; code?: string; tabs?: DesktopBrowserTab[] }>;
  closeBrowserTab?: (tabRef: string) => Promise<{ ok: boolean; code?: string }>;
  attachBrowserTarget?: (tabRef: string) => Promise<DesktopBrowserTabResult>;
  detachBrowserTarget?: (tabRef: string) => Promise<{ ok: boolean; code?: string }>;
  sendBrowserCdpCommand?: (input: { tabRef: string; method: string; params?: unknown }) => Promise<{ ok: boolean; code?: string; message?: string; result?: unknown }>;
  setBrowserTabThrottled?: (webContentsId: number, throttled: boolean) => Promise<{ ok: boolean }>;
  ackBrowserCaptureSurface?: (requestId: string) => void;
  onBrowserCaptureSurface?: (listener: (input: DesktopBrowserCaptureSurface) => void) => () => void;
  onBrowserCaptureSurfaceRelease?: (listener: (input: { requestId: string }) => void) => () => void;
  onBrowserNewTab?: (listener: (input: { instanceId?: string; url?: string; title?: string; creationRef?: string; requesterSessionRef?: string }) => void) => () => void;
  onBrowserFocusAddress?: (listener: (input: { webContentsId?: number }) => void) => () => void;
  onBrowserLoadFailure?: (listener: (input: DesktopBrowserLoadFailure) => void) => () => void;
  onBrowserTabClosed?: (listener: (input: { tabRef: string; instanceId?: string }) => void) => () => void;
  onBrowserTabsChanged?: (listener: (input: { instanceId: string }) => void) => () => void;
  onBrowserDeviceMetricsChanged?: (listener: (input: DesktopBrowserDeviceMetrics) => void) => () => void;
  logBrowserDiagnostic?: (input: { message: string; instanceId?: string }) => void;
  clipboard?: DesktopClipboardBridge;
};

function desktopBridge() {
  return (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
}

export function canOpenDesktopLocalPath() {
  return typeof desktopBridge()?.openLocalPath === "function";
}

export function canRevealDesktopLocalPath() {
  return typeof desktopBridge()?.revealLocalPath === "function";
}

export async function openDesktopLocalPath(path: string) {
  const openLocalPath = desktopBridge()?.openLocalPath;
  if (!openLocalPath) return { ok: false, code: "desktop-bridge-unavailable" } satisfies OpenLocalPathResult;
  return openLocalPath(path);
}

export async function revealDesktopLocalPath(path: string) {
  const reveal = desktopBridge()?.revealLocalPath;
  if (!reveal) return { ok: false, code: "desktop-bridge-unavailable" } satisfies OpenLocalPathResult;
  return reveal(path);
}

export async function openDesktopExternalUrl(url: string) {
  const openExternalUrl = desktopBridge()?.openExternalUrl;
  if (!openExternalUrl) return { ok: false, code: "desktop-bridge-unavailable" } satisfies OpenLocalPathResult;
  return openExternalUrl(url);
}

export function canUseDesktopBrowserContext() {
  const bridge = desktopBridge();
  return typeof bridge?.prepareBrowserContext === "function" && typeof bridge.releaseBrowserContext === "function";
}

export function prepareDesktopBrowserContext(instanceId: string): Promise<DesktopBrowserContextResult> {
  const prepare = desktopBridge()?.prepareBrowserContext;
  return prepare ? prepare(instanceId) : Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function releaseDesktopBrowserContext(contextId: string) {
  return desktopBridge()?.releaseBrowserContext?.(contextId) ?? Promise.resolve({ ok: false });
}

export function touchDesktopBrowserContext(contextId: string) {
  return desktopBridge()?.touchBrowserContext?.(contextId) ?? Promise.resolve({ ok: false });
}

export function canUseDesktopBrowserControl() {
  const bridge = desktopBridge();
  return typeof bridge?.registerBrowserTab === "function"
    && typeof bridge.updateBrowserTab === "function"
    && typeof bridge.unregisterBrowserTab === "function";
}

export function getDesktopBrowserControlInfo(instanceId?: string): Promise<DesktopBrowserControlInfo> {
  return desktopBridge()?.getBrowserControlInfo?.(instanceId) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function ensureDesktopBrowserAgentControl(instanceId: string): Promise<DesktopBrowserAgentControl> {
  return desktopBridge()?.ensureBrowserAgentControl?.(instanceId) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function registerDesktopBrowserTab(input: { webContentsId: number; instanceId: string; sessionKey: string; creationRef?: string; title?: string; url?: string; state?: string }): Promise<DesktopBrowserTabResult> {
  return desktopBridge()?.registerBrowserTab?.(input) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function updateDesktopBrowserTab(input: { tabRef: string; title?: string; url?: string; state?: string }): Promise<DesktopBrowserTabResult> {
  return desktopBridge()?.updateBrowserTab?.(input) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function unregisterDesktopBrowserTab(webContentsId: number) {
  return desktopBridge()?.unregisterBrowserTab?.(webContentsId) ?? Promise.resolve({ ok: false });
}

export function listDesktopBrowserTabs(instanceId?: string) {
  return desktopBridge()?.listBrowserTabs?.(instanceId) ?? Promise.resolve({ ok: false, tabs: [] });
}

export function closeDesktopBrowserTab(tabRef: string) {
  return desktopBridge()?.closeBrowserTab?.(tabRef) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function attachDesktopBrowserTarget(tabRef: string) {
  return desktopBridge()?.attachBrowserTarget?.(tabRef) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function detachDesktopBrowserTarget(tabRef: string) {
  return desktopBridge()?.detachBrowserTarget?.(tabRef) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function sendDesktopBrowserCdpCommand(input: { tabRef: string; method: string; params?: unknown }) {
  return desktopBridge()?.sendBrowserCdpCommand?.(input) ?? Promise.resolve({ ok: false, code: "desktop-bridge-unavailable" });
}

export function setDesktopBrowserTabThrottled(webContentsId: number, throttled: boolean) {
  return desktopBridge()?.setBrowserTabThrottled?.(webContentsId, throttled) ?? Promise.resolve({ ok: false });
}

export function ackDesktopBrowserCaptureSurface(requestId: string) {
  desktopBridge()?.ackBrowserCaptureSurface?.(requestId);
}

export function onDesktopBrowserCaptureSurface(listener: (input: DesktopBrowserCaptureSurface) => void) {
  return desktopBridge()?.onBrowserCaptureSurface?.(listener);
}

export function onDesktopBrowserCaptureSurfaceRelease(listener: (input: { requestId: string }) => void) {
  return desktopBridge()?.onBrowserCaptureSurfaceRelease?.(listener);
}

export function canRenewDesktopBrowserContext() {
  return typeof desktopBridge()?.touchBrowserContext === "function";
}

export function onDesktopBrowserFocusAddress(listener: (input: { webContentsId?: number }) => void) {
  return desktopBridge()?.onBrowserFocusAddress?.(listener);
}

export function onDesktopBrowserLoadFailure(listener: (input: DesktopBrowserLoadFailure) => void) {
  return desktopBridge()?.onBrowserLoadFailure?.(listener);
}

export function onDesktopBrowserTabClosed(listener: (input: { tabRef: string; instanceId?: string }) => void) {
  return desktopBridge()?.onBrowserTabClosed?.(listener);
}

export function onDesktopBrowserTabsChanged(listener: (input: { instanceId: string }) => void) {
  return desktopBridge()?.onBrowserTabsChanged?.(listener);
}

export function onDesktopBrowserDeviceMetricsChanged(listener: (input: DesktopBrowserDeviceMetrics) => void) {
  return desktopBridge()?.onBrowserDeviceMetricsChanged?.(listener);
}

export function logDesktopBrowserDiagnostic(message: string, instanceId?: string) {
  desktopBridge()?.logBrowserDiagnostic?.({ message, ...(instanceId ? { instanceId } : {}) });
}

export function canUseDesktopClipboard() {
  const bridge = desktopBridge()?.clipboard;
  return typeof bridge?.readText === "function"
    && typeof bridge.writeText === "function"
    && typeof bridge.onChanged === "function";
}

export async function readDesktopClipboardText() {
  const bridge = desktopBridge()?.clipboard;
  if (!bridge?.readText) return { ok: false, code: "desktop-bridge-unavailable" } satisfies DesktopClipboardResult;
  return bridge.readText();
}

export async function writeDesktopClipboardText(text: string) {
  const bridge = desktopBridge()?.clipboard;
  if (!bridge?.writeText) return { ok: false, code: "desktop-bridge-unavailable" } satisfies DesktopClipboardResult;
  return bridge.writeText(text);
}

export function onDesktopClipboardChanged(listener: (text: string) => void) {
  return desktopBridge()?.clipboard?.onChanged?.(input => {
    if (typeof input?.text === "string") listener(input.text);
  });
}
