import { STREAMING_WEBSOCKET_BRIDGE_OPTIONS } from "@task-handoff/protocol/websocket-bridge";
/** CP → node-agent → instance private transport. This module is deliberately
 * outside the public protocol entry: callers cannot supply URLs or headers. */
import { z } from "zod";
import { DesktopCaptureSelectionSchema, DesktopRequestIdSchema, DesktopSignalSchema, DesktopIceConfigSchema } from "@task-handoff/protocol/remote-desktop";
/** Control Plane -> Node Agent private fallback context. These are transport
 * headers, not public protocol fields or tickets. */
export const DESKTOP_FALLBACK_VIEWER_HEADER = "x-task-handoff-desktop-viewer";
export const DESKTOP_FALLBACK_GENERATION_HEADER = "x-task-handoff-desktop-generation";
export const DESKTOP_FALLBACK_ACTOR_HEADER = "x-task-handoff-desktop-actor";
export const DESKTOP_FALLBACK_DEVICE_HEADER = "x-task-handoff-desktop-device";
export const DESKTOP_FALLBACK_SELECTION_HEADER = "x-task-handoff-desktop-selection";
export const DesktopFallbackRoleSchema = z.enum(["media", "control"]);
export type DesktopFallbackRole = z.infer<typeof DesktopFallbackRoleSchema>;
export const DesktopFallbackAttachSchema = z.object({
  type: z.literal("fallback.attach"),
  role: DesktopFallbackRoleSchema,
  fallbackGeneration: z.string().min(1).max(128),
  viewerSessionId: z.string().min(1).max(4096),
  actorId: z.string().min(1).max(4096),
  deviceSessionId: z.string().min(1).max(4096),
  captureSelection: DesktopCaptureSelectionSchema,
}).strict();
export const DesktopOwnerSchema = z.object({ actorId: z.string().min(1).max(4096), deviceSessionId: z.string().min(1).max(4096) }).strict();
const base = z.object({ requestId: DesktopRequestIdSchema, owner: DesktopOwnerSchema }).strict();
const session = base.extend({ viewerSessionId: z.string().min(1).max(4096) });
export const DesktopAttachSchema = session.extend({ captureSelection: DesktopCaptureSelectionSchema, attachToken: z.string().min(1).max(4096) });
export const DesktopManagedSchemas = {
  sources: base,
  reserve: base.extend({ captureSelection: DesktopCaptureSelectionSchema }),
  takeover: session.extend({ captureSelection: DesktopCaptureSelectionSchema }),
  snapshot: session, stop: session,
  "force-stop": z.object({ requestId: DesktopRequestIdSchema, viewerSessionId: z.string().min(1).max(4096) }).strict(),
  "settings-get": z.object({}).strict(),
  "settings-set": z.object({ enabled: z.boolean() }).strict(),
  "permissions-get": z.object({}).strict(),
  "permissions-request": z.object({ kind: z.enum(["screen-capture", "input"]) }).strict(),
  preflight: z.object({}).strict(),
} as const;
export type DesktopManagedOperation = keyof typeof DesktopManagedSchemas;
export const DesktopManagedOperationSchema = z.enum(Object.keys(DesktopManagedSchemas) as [DesktopManagedOperation, ...DesktopManagedOperation[]]);
export const DesktopManagedSignalSchema = z.union([
  DesktopSignalSchema,
  z.object({ type: z.literal("configureIce"), requestId: DesktopRequestIdSchema, ...DesktopIceConfigSchema.shape }).strict(),
]);
export function desktopManagedEndpoint(operation: DesktopManagedOperation) {
  if (operation === "settings-get") return { method: "GET", path: "/api/internal/remote-desktop/settings" };
  if (operation === "settings-set") return { method: "PUT", path: "/api/internal/remote-desktop/settings" };
  if (operation === "permissions-get") return { method: "GET", path: "/api/internal/remote-desktop/permissions" };
  if (operation === "permissions-request") return { method: "POST", path: "/api/internal/remote-desktop/permissions/request" };
  return { method: "POST", path: `/api/internal/remote-desktop/${operation}` };
}

/** Transport-local policy, derived from the existing managed endpoint. It is
 * never sent over the wire. Keep ordinary proxies' cumulative limits intact. */
export const DESKTOP_FALLBACK_BRIDGE_OPTIONS = STREAMING_WEBSOCKET_BRIDGE_OPTIONS;

export function managedWebSocketBridgeOptions(route: string) {
  const pathname = route.split("?", 1)[0];
  return /^\/instances\/[^/]+\/remote-desktop\/fallback\/(media|control)$/.test(pathname)
    ? DESKTOP_FALLBACK_BRIDGE_OPTIONS
    : {};
}
