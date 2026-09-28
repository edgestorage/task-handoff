import { z } from "zod";
import { AgentDefinitionIdSchema } from "./agent-definitions.ts";
import { AgentOrchestrationIdSchema } from "./agent-orchestrations.ts";
import { AgentRunBudgetSchema, AgentRunToolResultSchema } from "./agent-runs.ts";

export const AGENT_INVOCATION_TOOL_POLICY_VERSION = "2026-09-28";
export const AGENT_INVOCATION_TOOL_NAMES = ["agent_run"] as const;

export const AgentInvocationToolNameSchema = z.enum(AGENT_INVOCATION_TOOL_NAMES);
export type AgentInvocationToolName = z.infer<typeof AgentInvocationToolNameSchema>;

/**
 * 调用授权的单位是 (agentId, orchestrationId)：同一 Agent 在不同编排里的可调用关系互不影响。
 * Story 入口集合与 Run 绑定的编排出边都解析成同一份 grant。
 */
export const AgentInvocationTargetSchema = z.object({
  agentId: AgentDefinitionIdSchema,
  orchestrationId: AgentOrchestrationIdSchema,
}).strict();
export type AgentInvocationTarget = z.infer<typeof AgentInvocationTargetSchema>;

export const AgentInvocationToolGrantSchema = z.object({
  enabledTools: z.array(AgentInvocationToolNameSchema).max(AGENT_INVOCATION_TOOL_NAMES.length),
  allowedTargets: z.array(AgentInvocationTargetSchema).max(50),
}).strict();
export type AgentInvocationToolGrant = z.infer<typeof AgentInvocationToolGrantSchema>;

export const AgentInvocationToolInputSchema = z.object({
  agentId: AgentDefinitionIdSchema,
  /** 缺省时由服务端从 Story 入口集合解析；同一 Agent 绑定多张编排时调用方必须显式指定。 */
  orchestrationId: AgentOrchestrationIdSchema.optional(),
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

export function resolveAgentInvocationToolGrant(targets: readonly AgentInvocationTarget[]): AgentInvocationToolGrant {
  const allowedTargets = [...new Map(targets.map((target) => [`${target.agentId}\u001f${target.orchestrationId}`, target])).values()]
    .sort((left, right) => (left.agentId === right.agentId
      ? left.orchestrationId.localeCompare(right.orchestrationId)
      : left.agentId.localeCompare(right.agentId)));
  return AgentInvocationToolGrantSchema.parse({
    enabledTools: allowedTargets.length ? AGENT_INVOCATION_TOOL_NAMES : [],
    allowedTargets,
  });
}

export function agentInvocationToolRevisionSource(authorityRevision: string, grant: AgentInvocationToolGrant) {
  const normalized = AgentInvocationToolGrantSchema.parse(grant);
  return JSON.stringify([
    AGENT_INVOCATION_TOOL_POLICY_VERSION,
    authorityRevision,
    normalized.enabledTools,
    normalized.allowedTargets,
  ]);
}

const AgentInvocationToolGrantConsumerSchema = z.object({
  enabledTools: z.array(z.string()).max(100).optional(),
  allowedTargets: z.array(AgentInvocationTargetSchema).max(50).optional(),
}).strip();

export function sanitizeAgentInvocationToolGrant(input: unknown): AgentInvocationToolGrant {
  const parsed = AgentInvocationToolGrantConsumerSchema.parse(input ?? {});
  const allowedTargets = [...new Map((parsed.allowedTargets ?? [])
    .map((target) => [`${target.agentId}\u001f${target.orchestrationId}`, target])).values()]
    .sort((left, right) => (left.agentId === right.agentId
      ? left.orchestrationId.localeCompare(right.orchestrationId)
      : left.agentId.localeCompare(right.agentId)));
  const enabledTools = (parsed.enabledTools ?? [])
    .filter((name): name is AgentInvocationToolName => AgentInvocationToolNameSchema.safeParse(name).success);
  return AgentInvocationToolGrantSchema.parse({
    enabledTools: allowedTargets.length ? [...new Set(enabledTools)] : [],
    allowedTargets,
  });
}
