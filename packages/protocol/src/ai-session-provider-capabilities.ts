import { z } from "zod";

const AiSessionCapabilityAgentSchema = z.string().trim().min(1).max(120);

export const AiSessionModelSelectionCapabilitiesSchema = z.object({
  selectModelAtCreate: z.boolean().default(false),
  selectProviderAtCreate: z.boolean().default(false),
  switchModelWithinProvider: z.boolean().default(false),
  switchProviderDuringSession: z.boolean().default(false),
}).strip().default({
  selectModelAtCreate: false,
  selectProviderAtCreate: false,
  switchModelWithinProvider: false,
  switchProviderDuringSession: false,
});

export const AiSessionReasoningEffortCapabilitiesSchema = z.object({
  selectAtCreate: z.boolean().default(false),
  updateDuringSession: z.boolean().default(false),
}).strip().default({
  selectAtCreate: false,
  updateDuringSession: false,
});

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
  // Compatibility for v0.0.28: absence disables only permission-mode UI/actions.
  permissionModes: z.array(z.enum(["ask", "auto-review", "full-access"])).max(3).default([]),
  timeline: z.object({
    sessionRead: z.boolean().default(false),
    turnRead: z.boolean().default(false),
    liveItems: z.boolean().default(false),
  }).passthrough(),
  // Compatibility for v0.0.23: absence disables only model-selection UI/actions.
  modelSelection: AiSessionModelSelectionCapabilitiesSchema.optional(),
  // Compatibility for v0.0.23: absence disables only reasoning-effort UI/actions.
  reasoningEffort: AiSessionReasoningEffortCapabilitiesSchema.optional(),
}).passthrough();

export const AiSessionProviderCapabilitiesSchema = z.array(AiSessionProviderCapabilitySchema).max(100).default([]);

export type AiSessionProviderCapability = z.infer<typeof AiSessionProviderCapabilitySchema>;
export type AiSessionModelSelectionCapabilities = z.infer<typeof AiSessionModelSelectionCapabilitiesSchema>;
export type AiSessionReasoningEffortCapabilities = z.infer<typeof AiSessionReasoningEffortCapabilitiesSchema>;

export function normalizeAiSessionModelSelectionCapabilities(
  capability: unknown,
): AiSessionModelSelectionCapabilities {
  const parsed = AiSessionProviderCapabilitySchema.safeParse(capability);
  return AiSessionModelSelectionCapabilitiesSchema.parse(
    parsed.success ? parsed.data.modelSelection : undefined,
  );
}

export function normalizeAiSessionReasoningEffortCapabilities(
  capability: unknown,
): AiSessionReasoningEffortCapabilities {
  const parsed = AiSessionProviderCapabilitySchema.safeParse(capability);
  return AiSessionReasoningEffortCapabilitiesSchema.parse(
    parsed.success ? parsed.data.reasoningEffort : undefined,
  );
}
