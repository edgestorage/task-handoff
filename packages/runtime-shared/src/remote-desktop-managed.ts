/** CP → node-agent → instance private transport. This module is deliberately
 * outside the public protocol entry: callers cannot supply URLs or headers. */
import { z } from "zod";
import { DesktopCaptureTargetSchema, DesktopRequestIdSchema, DesktopSignalSchema, DesktopIceConfigSchema } from "@task-handoff/protocol/remote-desktop";
/** Control Plane -> Node Agent private fallback context. These are transport
 * headers, not public protocol fields or tickets. */
export const DESKTOP_FALLBACK_VIEWER_HEADER = "x-task-handoff-desktop-viewer";
export const DESKTOP_FALLBACK_GENERATION_HEADER = "x-task-handoff-desktop-generation";
export const DESKTOP_FALLBACK_ACTOR_HEADER = "x-task-handoff-desktop-actor";
export const DESKTOP_FALLBACK_DEVICE_HEADER = "x-task-handoff-desktop-device";
export const DESKTOP_FALLBACK_TARGET_HEADER = "x-task-handoff-desktop-target";
export const DesktopFallbackRoleSchema = z.enum(["media", "control"]);
export type DesktopFallbackRole = z.infer<typeof DesktopFallbackRoleSchema>;
export const DesktopFallbackAttachSchema = z.object({
  type: z.literal("fallback.attach"),
  role: DesktopFallbackRoleSchema,
  fallbackGeneration: z.string().min(1).max(128),
  viewerSessionId: z.string().min(1).max(4096),
  actorId: z.string().min(1).max(4096),
  deviceSessionId: z.string().min(1).max(4096),
  captureTarget: DesktopCaptureTargetSchema,
}).strict();
export const DesktopOwnerSchema = z.object({ actorId: z.string().min(1).max(4096), deviceSessionId: z.string().min(1).max(4096) }).strict();
const base = z.object({ requestId: DesktopRequestIdSchema, owner: DesktopOwnerSchema }).strict();
const session = base.extend({ viewerSessionId: z.string().min(1).max(4096) });
export const DesktopAttachSchema = session.extend({ captureTarget: DesktopCaptureTargetSchema, attachToken: z.string().min(1).max(4096) });
export const DesktopManagedSchemas = {
  windows: base,
  reserve: base.extend({ captureTarget: DesktopCaptureTargetSchema }),
  takeover: session.extend({ captureTarget: DesktopCaptureTargetSchema }),
  snapshot: session, stop: session,
  "force-stop": z.object({ requestId: DesktopRequestIdSchema, viewerSessionId: z.string().min(1).max(4096) }).strict(),
  "settings-get": z.object({}).strict(),
  "settings-set": z.object({ enabled: z.boolean() }).strict(),
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
  return { method: "POST", path: `/api/internal/remote-desktop/${operation}` };
}
