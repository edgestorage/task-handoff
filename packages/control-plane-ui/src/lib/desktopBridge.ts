type OpenLocalPathResult = {
  ok: boolean;
  code?: string;
  error?: string;
};

type DesktopBridge = {
  openLocalPath?: (path: string) => Promise<OpenLocalPathResult>;
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
