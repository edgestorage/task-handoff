type OpenLocalPathResult = {
  ok: boolean;
  code?: string;
  error?: string;
};

export type DesktopBrowserContextResult = { ok: boolean; code?: string; message?: string; contextId?: string; partition?: string };

type DesktopBridge = {
  openLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
  revealLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
  openExternalUrl?: (url: string) => Promise<OpenLocalPathResult>;
  prepareBrowserContext?: (instanceId: string) => Promise<DesktopBrowserContextResult>;
  releaseBrowserContext?: (contextId: string) => Promise<{ ok: boolean }>;
  touchBrowserContext?: (contextId: string) => Promise<{ ok: boolean }>;
  setBrowserTabThrottled?: (webContentsId: number, throttled: boolean) => Promise<{ ok: boolean }>;
  onBrowserNewTab?: (listener: (input: { instanceId?: string; url?: string }) => void) => () => void;
  onBrowserFocusAddress?: (listener: (input: { webContentsId?: number }) => void) => () => void;
  logBrowserDiagnostic?: (input: { message: string; instanceId?: string }) => void;
};

function desktopBridge() {
  return (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
}

export function canOpenDesktopLocalPath() {
  return typeof desktopBridge()?.openLocalPath === "function";
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

export function setDesktopBrowserTabThrottled(webContentsId: number, throttled: boolean) {
  return desktopBridge()?.setBrowserTabThrottled?.(webContentsId, throttled) ?? Promise.resolve({ ok: false });
}

export function canRenewDesktopBrowserContext() {
  return typeof desktopBridge()?.touchBrowserContext === "function";
}

export function onDesktopBrowserFocusAddress(listener: (input: { webContentsId?: number }) => void) {
  return desktopBridge()?.onBrowserFocusAddress?.(listener);
}

export function logDesktopBrowserDiagnostic(message: string, instanceId?: string) {
  desktopBridge()?.logBrowserDiagnostic?.({ message, ...(instanceId ? { instanceId } : {}) });
}
