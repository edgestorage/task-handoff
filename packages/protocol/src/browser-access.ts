import { z } from "zod";

// Public HTTP response for handing a short-lived relay credential to a
// Browser client. The server-side authorization record stays private.
export const BrowserAccessHandshakeSchema = z.object({
  accessId: z.string().trim().min(1).max(120),
  token: z.string().trim().min(32).max(512),
  expiresAt: z.string().datetime(),
  relayPath: z.literal("/browser-relay"),
}).strict();

export type BrowserAccessHandshake = z.infer<typeof BrowserAccessHandshakeSchema>;
