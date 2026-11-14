import { z } from "zod";
import { CustomTurnSettingsSchema, DesktopConnectionOptionsSchema, type CustomTurnUpdate } from "@task-handoff/protocol/control-plane-desktop";
import { ApiError } from "./client";

import {
  DesktopCreatedSchema,
  DesktopFallbackSessionSchema,
  DesktopNativePermissionsSchema,
  DesktopSessionSnapshotSchema,
  DesktopSourcesSchema,
  type DesktopCaptureSelection,
  type DesktopSource,
  type DesktopFallbackSession,
  type DesktopNativePermissionKind,
  type DesktopNativePermissions,
  type DesktopSessionSnapshot,
} from "@task-handoff/protocol/remote-desktop";
import { deleteApiData, getApiData, postApiData, putApiData } from "./client";
import { createBrowserUuid } from "../lib/random-id";

export type RemoteDesktopSource = DesktopSource;
export type RemoteDesktopCreated = z.infer<typeof DesktopCreatedSchema>;

export async function listRemoteDesktopSources(instanceId: string, signal?: AbortSignal) {
  const value = await getApiData<{ sources: RemoteDesktopSource[] }>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/sources`, { signal });
  return { sources: DesktopSourcesSchema.parse(value.sources) };
}
export function createRemoteDesktopSession(instanceId: string, selection: DesktopCaptureSelection, turnSource?: "none" | "custom") {
  return postApiData<RemoteDesktopCreated>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions`, { requestId: createBrowserUuid(), selection, ...(turnSource ? { turnSource } : {}) }).then(value => DesktopCreatedSchema.parse(value));
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
export function getRemoteDesktopPermissions(instanceId: string) {
  return getApiData<DesktopNativePermissions>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/permissions`).then(value => DesktopNativePermissionsSchema.parse(value));
}
export function requestRemoteDesktopPermission(instanceId: string, kind: DesktopNativePermissionKind) {
  return postApiData<DesktopNativePermissions>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/permissions/request`, { kind }).then(value => DesktopNativePermissionsSchema.parse(value));
}
export function takeoverRemoteDesktopSession(instanceId: string, viewerSessionId: string, selection: DesktopCaptureSelection) {
  return postApiData<RemoteDesktopCreated>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}/takeover`, { requestId: createBrowserUuid(), selection }).then(value => DesktopCreatedSchema.parse(value));
}
export function forceStopRemoteDesktopSession(instanceId: string, viewerSessionId: string) {
  return postApiData<{ stopped: boolean }>(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(viewerSessionId)}/force-stop`, { requestId: createBrowserUuid() });
}

export async function getDesktopConnectionOptions(instanceId: string, signal?: AbortSignal) {
  try {
    return DesktopConnectionOptionsSchema.parse(await getApiData(`controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop/connection-options`, { signal }));
  } catch (error) {
    // Compatibility for v0.0.51: absent additive endpoint disables only the
    // new TURN choices; P2P and WebSocket remain usable.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
export async function getCustomTurnSettings() {
  return CustomTurnSettingsSchema.parse(await getApiData("control-plane/desktop-turn"));
}
export async function updateCustomTurnSettings(input: CustomTurnUpdate) {
  return CustomTurnSettingsSchema.parse(await putApiData("control-plane/desktop-turn", input));
}
