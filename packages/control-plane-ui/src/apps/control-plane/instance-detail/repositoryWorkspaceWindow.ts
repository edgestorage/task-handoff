import type { RepositorySessionKind } from "@task-handoff/protocol/repository";

export type RepositoryWorkspaceRoute = {
  instanceId: string;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  view: "files" | "changes";
};

type DesktopBridge = {
  openControlPlaneWindow?: (url: string) => Promise<{ ok: boolean }>;
};

export function parseRepositoryWorkspaceRoute(location: Pick<Location, "pathname" | "search">): RepositoryWorkspaceRoute | undefined {
  if (location.pathname !== "/repository-workspace") return undefined;
  const params = new URLSearchParams(location.search);
  const instanceId = params.get("instanceId")?.trim() || "";
  const sessionId = params.get("sessionId")?.trim() || "";
  const sessionKind = params.get("sessionKind");
  const view = params.get("view") || "files";
  if (!instanceId || !sessionId) return undefined;
  if (sessionKind !== "ai-session" && sessionKind !== "app-session") return undefined;
  if (view !== "files" && view !== "changes") return undefined;
  return { instanceId, sessionId, sessionKind, view };
}

export function repositoryWorkspaceUrl(route: RepositoryWorkspaceRoute, origin = window.location.origin) {
  const url = new URL("/repository-workspace", origin);
  url.search = new URLSearchParams({
    instanceId: route.instanceId,
    sessionKind: route.sessionKind,
    sessionId: route.sessionId,
    view: route.view,
  }).toString();
  return url.toString();
}

export function repositoryWorkspaceChannelName(route: Pick<RepositoryWorkspaceRoute, "instanceId" | "sessionId" | "sessionKind">) {
  return `task-handoff.repository:${route.instanceId}:${route.sessionKind}:${route.sessionId}`;
}

export async function openRepositoryWorkspaceWindow(route: RepositoryWorkspaceRoute) {
  const url = repositoryWorkspaceUrl(route);
  const bridge = (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
  if (bridge?.openControlPlaneWindow) return (await bridge.openControlPlaneWindow(url)).ok;
  const opened = window.open(url, "_blank", "popup,width=1280,height=820");
  if (!opened) return false;
  opened.opener = null;
  return true;
}
