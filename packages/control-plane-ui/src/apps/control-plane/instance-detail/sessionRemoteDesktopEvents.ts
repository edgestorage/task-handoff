import type { SessionRemoteDesktopTarget } from "./sessionRemoteDesktopLinks.ts";

export const OPEN_SESSION_REMOTE_DESKTOP_EVENT = "task-handoff:open-session-remote-desktop";
export const CLOSE_SESSION_REMOTE_DESKTOP_EVENT = "task-handoff:close-session-remote-desktop";

export type OpenSessionRemoteDesktopDetail = {
  instanceId: string;
  sessionId: string;
  target?: SessionRemoteDesktopTarget;
};

export type CloseSessionRemoteDesktopDetail = {
  instanceId: string;
  sessionId: string;
};

export function requestOpenSessionRemoteDesktop(detail: OpenSessionRemoteDesktopDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenSessionRemoteDesktopDetail>(OPEN_SESSION_REMOTE_DESKTOP_EVENT, { detail }));
}

export function requestCloseSessionRemoteDesktop(detail: CloseSessionRemoteDesktopDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CloseSessionRemoteDesktopDetail>(CLOSE_SESSION_REMOTE_DESKTOP_EVENT, { detail }));
}
