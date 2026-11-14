import { z } from "zod";
import { DateTimeSchema, IdSchema } from "./common.ts";

/** Independent of the WebSocket framing and Node Agent connection protocols. */
export const TURN_GRANT_PROTOCOL_VERSION = "2026-11-14";
export const RELAY_TURN_CAPABILITY = "turn-v1";

export const TurnUrlSchema = z.string().max(512).regex(/^turns?:[a-zA-Z0-9.\[\]:-]+:\d+\?transport=(udp|tcp)$/).superRefine((value, context) => {
  const match = /^(turns?):(.+):(\d+)\?transport=(udp|tcp)$/.exec(value);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535 || (match[1] === "turns" && match[4] !== "tcp")) {
    context.addIssue({ code: "custom", message: "Invalid TURN endpoint." });
  }
  try { new URL(`https://${match?.[2]}:${match?.[3]}`); }
  catch { context.addIssue({ code: "custom", message: "Invalid TURN host." }); }
});

// The CP installation is resolved from its authenticated account session;
// callers cannot choose a payer, target CP, TURN endpoint, or billing identity.
export const TurnGrantCreateSchema = z.strictObject({
  protocolVersion: z.literal(TURN_GRANT_PROTOCOL_VERSION),
  preferredRegion: z.string().min(1).max(80).optional(),
  preferredRelayId: IdSchema.optional(),
});
export const TurnGrantRenewSchema = z.strictObject({ protocolVersion: z.literal(TURN_GRANT_PROTOCOL_VERSION) });
export const TurnGrantReleaseSchema = TurnGrantRenewSchema;

// Unsigned responses deliberately strip additive fields at every object level.
export const TurnGrantSchema = z.object({
  grantId: IdSchema,
  iceServers: z.array(z.object({ urls: z.array(TurnUrlSchema).min(1), username: z.string().min(1), credential: z.string().min(1) })).min(1),
  iceCredentialsExpiresAt: DateTimeSchema,
  renewAfter: DateTimeSchema,
}).superRefine((value, context) => {
  if (Date.parse(value.renewAfter) >= Date.parse(value.iceCredentialsExpiresAt)) context.addIssue({ code: "custom", message: "Renewal must precede expiration." });
});
export const TurnGrantReleasedSchema = z.object({
  grantId: IdSchema,
  released: z.literal(true),
  // REST credentials remain usable until expiry; existing allocations can
  // Refresh past it. A successful release never asserts immediate media stop.
  dataPlaneRevocation: z.literal("not-guaranteed"),
});
export type TurnGrant = z.infer<typeof TurnGrantSchema>;
export type TurnGrantCreate = z.infer<typeof TurnGrantCreateSchema>;
export function sanitizeTurnGrant(value: unknown): TurnGrant { return TurnGrantSchema.parse(value); }
