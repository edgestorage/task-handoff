import { z } from "zod";

const AiSessionCapabilityAgentSchema = z.string().trim().min(1).max(120);

export const AiSessionProviderCapabilitySchema = z.object({
  agent: AiSessionCapabilityAgentSchema,
  actions: z.object({
    create: z.boolean().default(false),
    send: z.boolean().default(false),
    queue: z.boolean().default(false),
    steer: z.boolean().default(false),
    interrupt: z.boolean().default(false),
    archive: z.boolean().default(false),
    delete: z.boolean().default(false),
    fork: z.boolean().default(false),
    approvalDecisions: z.array(z.enum(["allow", "deny", "skip"])).max(3).default([]),
  }).passthrough(),
  timeline: z.object({
    sessionRead: z.boolean().default(false),
    turnRead: z.boolean().default(false),
    liveItems: z.boolean().default(false),
  }).passthrough(),
}).passthrough();

export const AiSessionProviderCapabilitiesSchema = z.array(AiSessionProviderCapabilitySchema).max(100).default([]);

export type AiSessionProviderCapability = z.infer<typeof AiSessionProviderCapabilitySchema>;
