type OpenLocalPathResult = {
  ok: boolean;
  code?: string;
  error?: string;
};

export type DesktopBrowserContextResult = { ok: boolean; code?: string; message?: string; contextId?: string; partition?: string };

type DesktopBridge = {
  openLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
  prepareBrowserContext?: (instanceId: string) => Promise<DesktopBrowserContextResult>;
  releaseBrowserContext?: (contextId: string) => Promise<{ ok: boolean }>;
  onBrowserNewTab?: (listener: (input: { instanceId?: string; url?: string }) => void) => () => void;
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

export function logDesktopBrowserDiagnostic(message: string, instanceId?: string) {
  desktopBridge()?.logBrowserDiagnostic?.({ message, ...(instanceId ? { instanceId } : {}) });
}
