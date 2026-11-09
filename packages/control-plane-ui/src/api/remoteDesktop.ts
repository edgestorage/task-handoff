import { z } from "zod";
import {
  DesktopCreatedSchema,
  DesktopFallbackSessionSchema,
  DesktopSessionSnapshotSchema,
  DesktopWindowsSchema,
  type DesktopCaptureTarget,
  type DesktopFallbackSession,
  type DesktopSessionSnapshot,
} from "@task-handoff/protocol/remote-desktop";
import { deleteApiData, getApiData, postApiData, putApiData } from "./client";
import { createBrowserUuid } from "../lib/random-id";

export type RemoteDesktopWindow = z.infer<typeof import("@task-handoff/protocol/remote-desktop").DesktopWindowSchema>;
export type RemoteDesktopCreated = z.infer<typeof DesktopCreatedSchema>;

export async function listRemoteDesktopWindows(instanceId: string, signal?: AbortSignal) {
  const value = await getApiData<{ windows: RemoteDesktopWindow[] }>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/windows`, { signal });
  return { windows: DesktopWindowsSchema.parse(value.windows) };
}
export function createRemoteDesktopSession(instanceId: string, captureTarget: DesktopCaptureTarget) {
  return postApiData<RemoteDesktopCreated>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions`, { requestId: createBrowserUuid(), captureTarget }).then(value => DesktopCreatedSchema.parse(value));
}
export function stopRemoteDesktopSession(instanceId: string, viewerSessionId: string) {
  return deleteApiData<{ stopped: boolean }>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}`, { requestId: createBrowserUuid() });
}
export function recoverRemoteDesktopSession(instanceId: string, viewerSessionId: string) {
  return getApiData<DesktopSessionSnapshot>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}`).then(value => DesktopSessionSnapshotSchema.parse(value));
}
export function requestRemoteDesktopFallback(
  instanceId: string,
  viewerSessionId: string,
  reason: "ice-failed" | "recovery-timeout",
  diagnosticCode?: string,
) {
  return postApiData<DesktopFallbackSession>(
    `controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}/fallback`,
    { requestId: createBrowserUuid(), reason, ...(diagnosticCode ? { diagnosticCode } : {}) },
  ).then(value => DesktopFallbackSessionSchema.parse(value));
}
const RemoteDesktopSettingsSchema = z.object({ enabled: z.boolean() }).strip();
export type RemoteDesktopSettings = z.infer<typeof RemoteDesktopSettingsSchema>;
export function getRemoteDesktopSettings(instanceId: string) {
  return getApiData<RemoteDesktopSettings>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/settings`).then(value => RemoteDesktopSettingsSchema.parse(value));
}
export function updateRemoteDesktopSettings(instanceId: string, enabled: boolean) {
  return putApiData<RemoteDesktopSettings>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/settings`, { enabled }).then(value => RemoteDesktopSettingsSchema.parse(value));
}
export function takeoverRemoteDesktopSession(instanceId: string, viewerSessionId: string, captureTarget: DesktopCaptureTarget) {
  return postApiData<RemoteDesktopCreated>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}/takeover`, { requestId: createBrowserUuid(), captureTarget }).then(value => DesktopCreatedSchema.parse(value));
}
export function forceStopRemoteDesktopSession(instanceId: string, viewerSessionId: string) {
  return postApiData<{ stopped: boolean }>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}/force-stop`, { requestId: createBrowserUuid() });
}
