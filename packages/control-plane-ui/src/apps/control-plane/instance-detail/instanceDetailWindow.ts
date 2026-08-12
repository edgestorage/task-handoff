export const INSTANCE_DETAIL_ROUTE_PREFIX = "/instance-detail/";

export type InstanceDetailRoute = {
  instanceId: string;
};

export function buildInstanceDetailPath(instanceId: string) {
  const normalized = instanceId.trim();
  if (!normalized) throw new Error("Instance id is required.");
  return `${INSTANCE_DETAIL_ROUTE_PREFIX}${encodeURIComponent(normalized)}`;
}

export function parseInstanceDetailRoute(location: Pick<Location, "pathname" | "search" | "hash">): InstanceDetailRoute | undefined {
  if (location.search || location.hash || !location.pathname.startsWith(INSTANCE_DETAIL_ROUTE_PREFIX)) return undefined;
  const encodedId = location.pathname.slice(INSTANCE_DETAIL_ROUTE_PREFIX.length);
  if (!encodedId || encodedId.includes("/")) return undefined;
  try {
    const instanceId = decodeURIComponent(encodedId).trim();
    if (!instanceId || instanceId.includes("/")) return undefined;
    return { instanceId };
  } catch {
    return undefined;
  }
}

export type InstanceWindowResult = {
  ok: boolean;
  action?: "opened" | "focused" | "switched" | "error";
  code?: string;
  instanceId?: string;
};

type DesktopBridge = {
  openInstanceDetailWindow?: (instanceId: string) => Promise<InstanceWindowResult>;
  switchInstanceDetailWindow?: (instanceId: string) => Promise<InstanceWindowResult>;
};

export function instanceDetailUrl(instanceId: string, origin = window.location.origin) {
  return new URL(buildInstanceDetailPath(instanceId), origin).toString();
}

export async function openInstanceDetailWindow(instanceId: string): Promise<InstanceWindowResult> {
  const bridge = (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
  if (bridge?.openInstanceDetailWindow) {
    try {
      return await bridge.openInstanceDetailWindow(instanceId);
    } catch {
      return { ok: false, action: "error", code: "desktop-ipc-failed", instanceId };
    }
  }
  const opened = window.open(instanceDetailUrl(instanceId), "_blank", "popup,width=1280,height=820");
  if (!opened) return { ok: false, action: "error", code: "popup-blocked", instanceId };
  opened.opener = null;
  return { ok: true, action: "opened", instanceId };
}

export async function switchDesktopInstanceDetailWindow(instanceId: string): Promise<InstanceWindowResult | undefined> {
  const bridge = (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
  return bridge?.switchInstanceDetailWindow?.(instanceId);
}
