import { z } from "zod";
import {
  AiAgentKindSchema,
  AiSessionModelSelectionSchema,
  AiSessionPermissionModeSchema,
  AiSessionReasoningEffortSchema,
} from "./ai-sessions.ts";
import { AgentRunErrorSchema, AgentRunIdSchema, AgentRunMemberIdSchema, AgentRunResultSchema } from "./agent-runs.ts";
import { AiSessionAgentToolNameSchema } from "./ai-session-agent-tools.ts";

const RuntimeRootSchema = z.object({
  type: z.literal("runtime-path"),
  path: z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/"), "Agent Run runtime paths must be absolute POSIX paths."),
}).strict();

/** Private Node Agent -> controlled instance request. Runtime paths are Node-derived. */
export const AgentRunMemberInstanceCreateInputSchema = z.object({
  runId: AgentRunIdSchema,
  memberId: AgentRunMemberIdSchema,
  clientRequestId: z.string().trim().min(1).max(160),
  providerId: AiAgentKindSchema,
  cwd: RuntimeRootSchema,
  writableRoots: z.object({ workspace: RuntimeRootSchema, shared: RuntimeRootSchema }).strict(),
  prompt: z.string().trim().min(1).max(128_000),
  appendedPrompt: z.string().max(32_000),
  permissionMode: AiSessionPermissionModeSchema.optional(),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  enabledTools: z.array(AiSessionAgentToolNameSchema).max(100).default([]),
}).strict().superRefine((input, context) => {
  if (input.cwd.path !== input.writableRoots.workspace.path) {
    context.addIssue({ code: "custom", path: ["writableRoots", "workspace"], message: "The workspace writable root must be the member cwd." });
  }
  if (input.writableRoots.workspace.path === input.writableRoots.shared.path) {
    context.addIssue({ code: "custom", path: ["writableRoots"], message: "Workspace and shared roots must be distinct." });
  }
});

export const AgentRunMemberInstanceCreateResultSchema = z.object({
  disposition: z.enum(["created", "already-created"]),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
}).strict();

export const AgentRunMemberInstanceStatusSchema = z.object({
  runId: AgentRunIdSchema,
  memberId: AgentRunMemberIdSchema,
  aiSessionId: z.string().trim().min(1).max(120),
  status: z.enum(["running", "completed", "failed"]),
  result: AgentRunResultSchema.optional(),
  error: AgentRunErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "completed" && !value.result) context.addIssue({ code: "custom", path: ["result"], message: "Completed member status requires a result." });
  if (value.status === "failed" && !value.error) context.addIssue({ code: "custom", path: ["error"], message: "Failed member status requires an error." });
});

export const AgentRunMemberInstanceCloseResultSchema = z.object({
  runId: AgentRunIdSchema,
  memberId: AgentRunMemberIdSchema,
  aiSessionId: z.string().trim().min(1).max(120),
  closed: z.boolean(),
}).strict();

/** Private behavior-probe snapshot. Member sessions are excluded by the controlled instance authority. */
export const AgentRunInstanceProbeStateSchema = z.object({
  ordinaryAiSessionIds: z.array(z.string().trim().min(1).max(120)).max(10_000),
}).strict();

export type AgentRunMemberInstanceCreateInput = z.infer<typeof AgentRunMemberInstanceCreateInputSchema>;
export type AgentRunMemberInstanceStatus = z.infer<typeof AgentRunMemberInstanceStatusSchema>;
export type AgentRunInstanceProbeState = z.infer<typeof AgentRunInstanceProbeStateSchema>;
