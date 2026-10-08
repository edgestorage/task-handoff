import { z } from "zod";
import {
  AgentDefinitionIdSchema,
  AgentDefinitionRevisionSchema,
  AgentExecutionPolicySchema,
} from "./agent-definitions.ts";
import { AgentOrchestrationIdSchema, defaultAgentOrchestrationId } from "./agent-orchestrations.ts";

const StableIdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const AgentRunIdSchema = StableIdSchema;
export const AgentRunMemberIdSchema = StableIdSchema;
export const AgentRunRevisionSchema = z.number().int().nonnegative();

export const AGENT_RUN_DEFAULT_BUDGET = Object.freeze({
  maxMembers: 16,
  maxDepth: 4,
  maxConcurrency: 4,
});
export const AGENT_RUN_MAX_RESULT_CHARACTERS = 128_000;
export const AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS = 32_000;

export const AgentRunStatusSchema = z.enum([
  "queued", "preparing", "running", "finalizing", "completed", "failed", "cancelled",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunAuthorizationSubjectSchema = z.object({
  kind: z.enum(["control-plane-user", "standalone-operator"]),
  subjectId: StableIdSchema,
  authorizationRevision: z.number().int().nonnegative().optional(),
}).strict();
export type AgentRunAuthorizationSubject = z.infer<typeof AgentRunAuthorizationSubjectSchema>;

export const AgentRunStoryProvenanceSchema = z.object({
  source: z.literal("story-session").optional(),
  initiatingInstanceId: StableIdSchema,
  initiatingAiSessionId: StableIdSchema,
  storyId: StableIdSchema,
  // Optional source metadata is retained for audit/N-1 compatibility only. Node Agent execution
  // never treats it as a live authorization lease or re-checks a Control Plane during a Run.
  authorizationSubject: AgentRunAuthorizationSubjectSchema.optional(),
}).strict();
export const AgentRunControlPlaneProvenanceSchema = z.object({
  source: z.literal("control-plane"),
  authorizationSubject: AgentRunAuthorizationSubjectSchema.optional(),
}).strict();
export const AgentRunProvenanceSchema = z.union([
  AgentRunStoryProvenanceSchema,
  AgentRunControlPlaneProvenanceSchema,
]);
export type AgentRunProvenance = z.infer<typeof AgentRunProvenanceSchema>;

export const AgentRunBudgetSchema = z.object({
  maxMembers: z.number().int().positive(),
  maxDepth: z.number().int().nonnegative(),
  maxConcurrency: z.number().int().positive(),
}).strict();
export type AgentRunBudget = z.infer<typeof AgentRunBudgetSchema>;

export const AgentRunInputSchema = z.object({
  prompt: z.string().trim().min(1).max(128_000),
}).strict();
export type AgentRunInput = z.infer<typeof AgentRunInputSchema>;

/** Frozen public execution intent. Runtime paths, credentials and resolved secrets stay internal. */
export const AgentRunMemberExecutionSnapshotSchema = z.object({
  agentRevision: AgentDefinitionRevisionSchema,
  targetInstanceId: StableIdSchema,
  cwdFolderId: StableIdSchema,
  appendedPrompt: z.string().max(32_000),
  providerId: StableIdSchema,
  modelEntityId: StableIdSchema.optional(),
  modelName: z.string().trim().min(1).max(120).optional(),
  modelUpstreamName: z.string().trim().min(1).max(240).optional(),
  reasoningEffort: z.string().trim().min(1).max(120).optional(),
  permissionMode: z.string().trim().min(1).max(120).optional(),
  executionPolicy: AgentExecutionPolicySchema,
}).strict();
export type AgentRunMemberExecutionSnapshot = z.infer<typeof AgentRunMemberExecutionSnapshotSchema>;

export const AgentRunErrorSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(4_000),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AgentRunError = z.infer<typeof AgentRunErrorSchema>;

export const AgentRunResultSchema = z.object({
  text: z.string().max(AGENT_RUN_MAX_RESULT_CHARACTERS),
  truncated: z.boolean().default(false),
  source: z.literal("provider-final-message").default("provider-final-message"),
}).strict();
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const AgentRunResultDeliverySchema = z.object({
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  deliveredAt: z.string().datetime().optional(),
  error: AgentRunErrorSchema.optional(),
}).strict();
export type AgentRunResultDelivery = z.infer<typeof AgentRunResultDeliverySchema>;

export const AgentRunToolResultSchema = z.object({
  runId: AgentRunIdSchema,
  status: z.enum(["completed", "failed", "cancelled"]),
  result: z.object({
    text: z.string().max(AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS),
    truncated: z.boolean(),
  }).strict().optional(),
  error: AgentRunErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "completed" && !value.result) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A completed Agent Run tool result requires result text." });
  }
  if (value.status !== "completed" && !value.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A failed or cancelled Agent Run tool result requires an error." });
  }
});
export type AgentRunToolResult = z.infer<typeof AgentRunToolResultSchema>;

export const AgentRunCleanupDiagnosticSchema = z.object({
  status: z.enum(["pending", "completed", "retrying", "manual-intervention"]),
  attempts: z.number().int().nonnegative(),
  message: z.string().max(4_000).optional(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentRunCleanupDiagnostic = z.infer<typeof AgentRunCleanupDiagnosticSchema>;

export const AgentRunSharedSpaceDiagnosticSchema = z.object({
  runtimeId: StableIdSchema,
  state: z.enum(["preparing", "active", "retained", "expiring", "delete-retrying", "expired", "manual-intervention"]),
  usageBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type AgentRunSharedSpaceDiagnostic = z.infer<typeof AgentRunSharedSpaceDiagnosticSchema>;

export const AgentRunMemberSchema = z.object({
  memberId: AgentRunMemberIdSchema,
  runId: AgentRunIdSchema,
  agentId: AgentDefinitionIdSchema,
  parentMemberId: AgentRunMemberIdSchema.optional(),
  instanceId: StableIdSchema,
  aiSessionId: StableIdSchema.optional(),
  role: z.enum(["root", "callee"]),
  depth: z.number().int().nonnegative(),
  status: AgentRunStatusSchema,
  input: AgentRunInputSchema.optional(),
  executionSnapshot: AgentRunMemberExecutionSnapshotSchema,
  result: AgentRunResultSchema.optional(),
  error: AgentRunErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
}).strict();
export type AgentRunMember = z.infer<typeof AgentRunMemberSchema>;

export const AgentRunTimelineEntrySchema = z.object({
  runId: AgentRunIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  kind: z.string().trim().min(1).max(120),
  memberId: AgentRunMemberIdSchema.optional(),
  data: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type AgentRunTimelineEntry = z.infer<typeof AgentRunTimelineEntrySchema>;

export const AgentRunSchema = z.object({
  runId: AgentRunIdSchema,
  clientRequestId: StableIdSchema,
  revision: AgentRunRevisionSchema,
  status: AgentRunStatusSchema,
  input: AgentRunInputSchema.optional(),
  provenance: AgentRunProvenanceSchema,
  /** Run 绑定的编排：入口成员与成员调用授权都从这张编排解析。 */
  orchestrationId: AgentOrchestrationIdSchema,
  rootMemberId: AgentRunMemberIdSchema,
  budget: AgentRunBudgetSchema,
  result: AgentRunResultSchema.optional(),
  resultDelivery: AgentRunResultDeliverySchema.optional(),
  error: AgentRunErrorSchema.optional(),
  cleanup: AgentRunCleanupDiagnosticSchema.optional(),
  sharedSpace: AgentRunSharedSpaceDiagnosticSchema.optional(),
  members: z.array(AgentRunMemberSchema).optional(),
  timeline: z.array(AgentRunTimelineEntrySchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
}).strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentRunCreateInputSchema = z.object({
  clientRequestId: StableIdSchema,
  orchestrationId: AgentOrchestrationIdSchema,
  /** 入口成员；缺省时使用编排唯一的顶级节点，多顶级节点必须显式指定。 */
  entryAgentId: AgentDefinitionIdSchema.optional(),
  input: AgentRunInputSchema,
  provenance: AgentRunProvenanceSchema,
  budget: AgentRunBudgetSchema.optional(),
}).strict();
/** Control Plane UI input. Provenance is derived from the authenticated request, never caller supplied. */
export const AgentRunManualCreateInputSchema = z.object({
  clientRequestId: StableIdSchema,
  orchestrationId: AgentOrchestrationIdSchema,
  entryAgentId: AgentDefinitionIdSchema.optional(),
  input: AgentRunInputSchema,
  budget: AgentRunBudgetSchema.optional(),
}).strict();
export const AgentRunCancelInputSchema = z.object({ expectedRevision: AgentRunRevisionSchema.optional() }).strict();
export type AgentRunCreateInput = z.infer<typeof AgentRunCreateInputSchema>;
export type AgentRunManualCreateInput = z.infer<typeof AgentRunManualCreateInputSchema>;
export type AgentRunCancelInput = z.infer<typeof AgentRunCancelInputSchema>;

export const AgentRunListSchema = z.object({ runs: z.array(AgentRunSchema) }).strict();

export const AGENT_RUN_SERVICE_ERROR_CODES = [
  "AGENT_RUN_NOT_FOUND",
  "AGENT_RUN_MEMBER_NOT_FOUND",
  "AGENT_RUN_IDEMPOTENCY_CONFLICT",
  "AGENT_RUN_REVISION_CONFLICT",
  "AGENT_RUN_INITIATING_INSTANCE_UNKNOWN",
  "AGENT_RUN_ORCHESTRATION_UNKNOWN",
  "AGENT_RUN_ENTRY_REQUIRED",
  "AGENT_RUN_ENTRY_INVALID",
  "AGENT_RUN_INVOCATION_FORBIDDEN",
  "AGENT_RUN_EXECUTION_UNSUPPORTED",
  "AGENT_RUN_ALREADY_TERMINAL",
] as const;
export const AgentRunServiceErrorCodeSchema = z.enum(AGENT_RUN_SERVICE_ERROR_CODES);
export type AgentRunServiceErrorCode = z.infer<typeof AgentRunServiceErrorCodeSchema>;

export const AGENT_RUN_CHANGED_EVENT_TYPE = "agent.run.changed";
export const AgentRunChangedEventSchema = z.object({
  runId: AgentRunIdSchema,
  revision: AgentRunRevisionSchema,
  run: AgentRunSchema,
}).strict();
export const AGENT_RUN_MEMBER_CHANGED_EVENT_TYPE = "agent.run.member.changed";
export const AgentRunMemberChangedEventSchema = z.object({
  runId: AgentRunIdSchema,
  memberId: AgentRunMemberIdSchema,
  revision: AgentRunRevisionSchema,
  member: AgentRunMemberSchema,
}).strict();

/** Control Plane adds transport-derived node identity in a separate aggregate envelope. */
export const AgentRunAggregateSchema = z.object({
  runs: z.array(z.object({ nodeId: StableIdSchema, run: AgentRunSchema }).strict()),
  unavailableNodeIds: z.array(StableIdSchema).default([]),
}).strict();
export const AgentRunAggregateEventSchema = z.object({
  nodeId: StableIdSchema,
  event: z.union([AgentRunChangedEventSchema, AgentRunMemberChangedEventSchema]),
}).strict();

const MemberConsumerSchema = AgentRunMemberSchema.strip().extend({
  // Compatibility for v0.0.32 and Agent Run members created before input persistence.
  input: AgentRunInputSchema.strip().optional(),
  executionSnapshot: AgentRunMemberExecutionSnapshotSchema.strip(),
  result: AgentRunResultSchema.strip().optional(),
  error: AgentRunErrorSchema.strip().optional(),
});
const TimelineConsumerSchema = AgentRunTimelineEntrySchema.strip();
const RunConsumerSchema = AgentRunSchema.strip().extend({
  // Compatibility: runs persisted before orchestration binding normalize to the root Agent's default orchestration.
  orchestrationId: AgentOrchestrationIdSchema.optional(),
  // Compatibility for v0.0.32 and Agent Run records created before input persistence.
  input: AgentRunInputSchema.strip().optional(),
  provenance: z.union([
    AgentRunStoryProvenanceSchema.strip().extend({
      authorizationSubject: AgentRunAuthorizationSubjectSchema.strip().optional(),
    }),
    AgentRunControlPlaneProvenanceSchema.strip().extend({
      authorizationSubject: AgentRunAuthorizationSubjectSchema.strip().optional(),
    }),
  ]),
  budget: AgentRunBudgetSchema.strip(),
  result: AgentRunResultSchema.strip().optional(),
  resultDelivery: AgentRunResultDeliverySchema.strip().extend({
    error: AgentRunErrorSchema.strip().optional(),
  }).optional(),
  error: AgentRunErrorSchema.strip().optional(),
  cleanup: AgentRunCleanupDiagnosticSchema.strip().optional(),
  sharedSpace: AgentRunSharedSpaceDiagnosticSchema.strip().optional(),
  members: z.array(MemberConsumerSchema).optional(),
  timeline: z.array(TimelineConsumerSchema).optional(),
}).transform((value) => {
  const orchestrationId = value.orchestrationId ?? (() => {
    const root = (value.members ?? []).find((member) => member.memberId === value.rootMemberId);
    if (!root) throw new Error("An Agent Run without an orchestration binding requires its root member to normalize.");
    return defaultAgentOrchestrationId(root.agentId);
  })();
  return { ...value, orchestrationId };
});
const RunChangedEventConsumerSchema = z.object({
  runId: AgentRunIdSchema,
  revision: AgentRunRevisionSchema,
  run: RunConsumerSchema,
}).strip();
const RunMemberChangedEventConsumerSchema = z.object({
  runId: AgentRunIdSchema,
  memberId: AgentRunMemberIdSchema,
  revision: AgentRunRevisionSchema,
  member: MemberConsumerSchema,
}).strip();
const RunAggregateEventConsumerSchema = z.object({
  nodeId: StableIdSchema,
  event: z.union([RunChangedEventConsumerSchema, RunMemberChangedEventConsumerSchema]),
}).strip();

export function sanitizeAgentRun(input: unknown): AgentRun { return RunConsumerSchema.parse(input); }
export function sanitizeAgentRunMember(input: unknown): AgentRunMember { return MemberConsumerSchema.parse(input); }
export function sanitizeAgentRunTimelineEntry(input: unknown): AgentRunTimelineEntry { return TimelineConsumerSchema.parse(input); }
export function sanitizeAgentRunAggregateEvent(input: unknown) { return RunAggregateEventConsumerSchema.parse(input); }

export const AGENT_RUN_TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "failed", "cancelled"]);
const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ["preparing", "finalizing"],
  preparing: ["running", "finalizing"],
  running: ["finalizing"],
  finalizing: ["completed", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};
export function canTransitionAgentRunStatus(from: AgentRunStatus, to: AgentRunStatus) {
  return from === to || AGENT_RUN_TRANSITIONS[from].includes(to);
}

/** A run leaves finalizing only after its root member and cleanup have both converged. */
export function agentRunTerminalStatus(
  rootMemberStatus: AgentRunStatus,
  cleanup: AgentRunCleanupDiagnostic | undefined,
): Extract<AgentRunStatus, "completed" | "failed" | "cancelled"> | undefined {
  if (!AGENT_RUN_TERMINAL_STATUSES.has(rootMemberStatus) || !cleanup) return undefined;
  if (cleanup.status === "manual-intervention") return "failed";
  if (cleanup.status !== "completed") return undefined;
  return rootMemberStatus as Extract<AgentRunStatus, "completed" | "failed" | "cancelled">;
}
