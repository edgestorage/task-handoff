import { z } from "zod";
import { AgentDefinitionIdSchema, AgentDefinitionRevisionSchema } from "./agent-definitions.ts";
import { AgentRunBudgetSchema, AgentRunToolResultSchema } from "./agent-runs.ts";

export const AGENT_INVOCATION_TOOL_POLICY_VERSION = "2026-09-26";
export const AGENT_INVOCATION_TOOL_NAMES = ["agent_run"] as const;

export const AgentInvocationToolNameSchema = z.enum(AGENT_INVOCATION_TOOL_NAMES);
export type AgentInvocationToolName = z.infer<typeof AgentInvocationToolNameSchema>;

export const AgentInvocationToolGrantSchema = z.object({
  enabledTools: z.array(AgentInvocationToolNameSchema).max(AGENT_INVOCATION_TOOL_NAMES.length),
  allowedAgentIds: z.array(AgentDefinitionIdSchema).max(50),
}).strict();
export type AgentInvocationToolGrant = z.infer<typeof AgentInvocationToolGrantSchema>;

export const AgentInvocationToolResolutionSchema = AgentInvocationToolGrantSchema.extend({
  revision: AgentDefinitionRevisionSchema,
}).strict();
export type AgentInvocationToolResolution = z.infer<typeof AgentInvocationToolResolutionSchema>;

export const AgentInvocationToolInputSchema = z.object({
  agentId: AgentDefinitionIdSchema,
  prompt: z.string().trim().min(1).max(128_000),
  budget: AgentRunBudgetSchema.optional(),
}).strict();
export type AgentInvocationToolInput = z.infer<typeof AgentInvocationToolInputSchema>;

export const AgentInvocationRequestSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/),
  input: AgentInvocationToolInputSchema,
}).strict();
export type AgentInvocationRequest = z.infer<typeof AgentInvocationRequestSchema>;

export const AGENT_INVOCATION_TOOL_DESCRIPTION =
  "Run an Agent authorized for this Story and wait for its bounded final result.";
export const AGENT_INVOCATION_TOOL_SCHEMA = Object.freeze({
  input: AgentInvocationToolInputSchema,
  output: AgentRunToolResultSchema,
});

export function resolveAgentInvocationToolGrant(agentIds: readonly string[]): AgentInvocationToolGrant {
  const allowedAgentIds = [...new Set(agentIds)].sort();
  return AgentInvocationToolGrantSchema.parse({
    enabledTools: allowedAgentIds.length ? AGENT_INVOCATION_TOOL_NAMES : [],
    allowedAgentIds,
  });
}

export function agentInvocationToolRevisionSource(authorityRevision: string, grant: AgentInvocationToolGrant) {
  const normalized = AgentInvocationToolGrantSchema.parse(grant);
  return JSON.stringify([
    AGENT_INVOCATION_TOOL_POLICY_VERSION,
    authorityRevision,
    normalized.enabledTools,
    normalized.allowedAgentIds,
  ]);
}

const AgentInvocationToolGrantConsumerSchema = z.object({
  enabledTools: z.array(z.string()).max(100).optional(),
  allowedAgentIds: z.array(AgentDefinitionIdSchema).max(50).optional(),
}).strip();

export function sanitizeAgentInvocationToolGrant(input: unknown): AgentInvocationToolGrant {
  const parsed = AgentInvocationToolGrantConsumerSchema.parse(input ?? {});
  const allowedAgentIds = [...new Set(parsed.allowedAgentIds ?? [])].sort();
  const enabledTools = (parsed.enabledTools ?? [])
    .filter((name): name is AgentInvocationToolName => AgentInvocationToolNameSchema.safeParse(name).success);
  return AgentInvocationToolGrantSchema.parse({
    enabledTools: allowedAgentIds.length ? [...new Set(enabledTools)] : [],
    allowedAgentIds,
  });
}
