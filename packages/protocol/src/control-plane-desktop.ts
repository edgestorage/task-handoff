import { z } from "zod";
import { DesktopCreateSchema, DesktopIceServerSchema } from "./remote-desktop.ts";

// Selection is required at the CP boundary because local viewer preferences
// cannot decide which credentials the CP configures on the remote media peer.
// Compatibility for v0.0.51: omitted selection keeps the existing custom issuer.
export const ControlPlaneDesktopCreateSchema = DesktopCreateSchema.extend({ turnSource: z.enum(["none", "custom"]).optional() });

// Control Plane owns these settings. They are separate from the component's
// media protocol and never become instance capabilities or session records.
export const CustomTurnUrlSchema = z.string().trim().min(1).max(2048).refine(value =>
  /^(turn|turns):(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?(?:\?transport=(udp|tcp))?$/i.test(value)
  && !(/^turns:/i.test(value) && /transport=udp$/i.test(value)), "Invalid TURN URL").refine(value => {
    try { new URL(value.replace(/^turns?:/i, "https://")); return true; } catch { return false; }
  }, "Invalid TURN host or port");
const fields = {
  enabled: z.boolean(),
  urls: z.array(CustomTurnUrlSchema).max(16),
  authentication: z.enum(["password", "shared-secret"]),
  username: z.string().trim().max(512),
};
export const CustomTurnSettingsSchema = z.object({
  ...fields, revision: z.number().int().nonnegative(), configured: z.boolean(), secretConfigured: z.boolean(),
}).strip();
export const CustomTurnUpdateSchema = z.object({
  ...fields, expectedRevision: z.number().int().nonnegative(), secret: z.string().min(1).max(8192).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authentication === "password" && value.secret && !DesktopIceServerSchema.shape.credential.safeParse(value.secret).success)
    ctx.addIssue({ code: "custom", path: ["secret"], message: "Password exceeds the ICE credential wire limit." });
  if (value.enabled && (!value.urls.length || (value.authentication === "password" && !value.username)))
    ctx.addIssue({ code: "custom", message: "Enabled TURN requires URLs and an authentication identity." });
});
export const DesktopConnectionOptionsSchema = z.object({
  customTurn: z.object({ configured: z.boolean() }).strip(),
  cloudTurn: z.object({ signedIn: z.boolean(), available: z.boolean() }).strip(),
}).strip();
export type CustomTurnSettings = z.infer<typeof CustomTurnSettingsSchema>;
export type CustomTurnUpdate = z.infer<typeof CustomTurnUpdateSchema>;
export type DesktopConnectionOptions = z.infer<typeof DesktopConnectionOptionsSchema>;
export const unavailableDesktopConnectionOptions: DesktopConnectionOptions = {
  customTurn: { configured: false }, cloudTurn: { signedIn: false, available: false },
};
