import { z } from "zod";
import {
  AiSessionConversationAttachmentSchema,
  AiSessionDetailSchema,
  AiSessionHistoryTurnSchema,
  AiSessionTurnBodySchema,
  AiSessionTurnIndexSchema,
  AiSessionTurnTimelineSchema,
} from "./ai-sessions.ts";
import { StoryIdSchema } from "./story-id.ts";
import {
  StoryActionSchema,
  StoryAutomationEffectiveStatusSchema,
  StoryAutomationErrorSchema,
  StoryAutomationPolicySchema,
  StoryAutomationRunStatusSchema,
  StoryAutomationScheduleSchema,
  StoryContentGetInputSchema,
  StoryContentSetInputSchema,
  StoryDocumentSchema,
  StoryPathSchema,
  StoryRevisionSchema,
} from "./stories.ts";

export const STORY_AGENT_TOOL_POLICY_VERSION = "2026-09-19";

export const StoryAgentToolCategorySchema = z.enum(["content", "actions", "automations", "aiSessions"]);
export type StoryAgentToolCategory = z.infer<typeof StoryAgentToolCategorySchema>;

export const StoryAgentToolPolicySchema = z.object({
  content: z.boolean(),
  actions: z.boolean(),
  automations: z.boolean(),
  aiSessions: z.boolean(),
}).strict();
export type StoryAgentToolPolicy = z.infer<typeof StoryAgentToolPolicySchema>;

export const DEFAULT_STORY_AGENT_TOOL_POLICY: StoryAgentToolPolicy = Object.freeze({
  content: true,
  actions: false,
  automations: false,
  aiSessions: false,
});

const StoryAgentToolPolicyConsumerSchema = StoryAgentToolPolicySchema.strip().partial();

export function normalizeStoryAgentToolPolicy(input: unknown): StoryAgentToolPolicy {
  const parsed = StoryAgentToolPolicyConsumerSchema.safeParse(input);
  return StoryAgentToolPolicySchema.parse({
    ...DEFAULT_STORY_AGENT_TOOL_POLICY,
    ...(parsed.success ? parsed.data : {}),
  });
}

export function storyAgentToolPolicyRevisionSource(policy: StoryAgentToolPolicy) {
  const value = StoryAgentToolPolicySchema.parse(policy);
  return `${STORY_AGENT_TOOL_POLICY_VERSION}:${Number(value.content)}${Number(value.actions)}${Number(value.automations)}${Number(value.aiSessions)}`;
}

export const STORY_AGENT_TOOL_NAMES = [
  "story_list_content",
  "story_get_content",
  "story_set_content",
  "story_list_actions",
  "story_run_action",
  "story_list_automations",
  "story_create_automation",
  "story_update_automation",
  "story_delete_automation",
  "story_run_automation",
  "story_list_automation_runs",
  "story_list_ai_sessions",
  "story_get_ai_session",
  "story_get_ai_session_turn",
] as const;

export const StoryAgentToolNameSchema = z.enum(STORY_AGENT_TOOL_NAMES);
export type StoryAgentToolName = z.infer<typeof StoryAgentToolNameSchema>;

export const STORY_AGENT_TOOL_NAMES_BY_CATEGORY = Object.freeze({
  content: ["story_list_content", "story_get_content", "story_set_content"],
  actions: ["story_list_actions", "story_run_action"],
  automations: [
    "story_list_automations",
    "story_create_automation",
    "story_update_automation",
    "story_delete_automation",
    "story_run_automation",
    "story_list_automation_runs",
  ],
  aiSessions: ["story_list_ai_sessions", "story_get_ai_session", "story_get_ai_session_turn"],
} satisfies Record<StoryAgentToolCategory, readonly StoryAgentToolName[]>);

export const STORY_AGENT_TOOL_DESCRIPTIONS: Record<StoryAgentToolName, string> = {
  story_list_content: "List indexed documents in the current Story, ordered newest to oldest. Start with page 1 and continue with pagination.nextPage when present.",
  story_get_content: "Copy documents selected from story_list_content into the current AI Session workspace.",
  story_set_content: "Create or replace one indexed Story document from a workspace file; use expectedRevision to prevent overwriting a newer version.",
  story_list_actions: "List preset Actions in the Story assigned to the current AI Session.",
  story_run_action: "Run one preset Story Action using its configured target instance and session preset.",
  story_list_automations: "List Automations and their effective status for the current Story.",
  story_create_automation: "Create a long-lived Automation using an existing preset Action in the current Story.",
  story_update_automation: "Update or enable an Automation in the current Story with optimistic concurrency.",
  story_delete_automation: "Delete an Automation in the current Story with optimistic concurrency.",
  story_run_automation: "Run an Automation in the current Story immediately.",
  story_list_automation_runs: "List recent runs for an Automation in the current Story.",
  story_list_ai_sessions: "List other active root AI Sessions assigned to the current Story.",
  story_get_ai_session: "Read compact session details and Turn summaries for another active root AI Session in the current Story.",
  story_get_ai_session_turn: "Read one Turn's conversation and tool items from another active root AI Session in the current Story.",
};

export const STORY_AGENT_TOOL_QUERY_NAMES = new Set<StoryAgentToolName>([
  "story_list_content",
  "story_get_content",
  "story_list_actions",
  "story_list_automations",
  "story_list_automation_runs",
  "story_list_ai_sessions",
  "story_get_ai_session",
  "story_get_ai_session_turn",
]);

export function resolveStoryAgentToolNames(policy: StoryAgentToolPolicy, options: { archived?: boolean } = {}) {
  const normalized = StoryAgentToolPolicySchema.parse(policy);
  const names = (Object.keys(STORY_AGENT_TOOL_NAMES_BY_CATEGORY) as StoryAgentToolCategory[])
    .filter((category) => normalized[category])
    .flatMap((category) => STORY_AGENT_TOOL_NAMES_BY_CATEGORY[category]);
  return options.archived ? names.filter((name) => STORY_AGENT_TOOL_QUERY_NAMES.has(name)) : names;
}

export const StoryAgentToolPolicySettingsSchema = z.object({
  policy: StoryAgentToolPolicySchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const StoryAgentToolPolicyUpdateInputSchema = z.object({ policy: StoryAgentToolPolicySchema }).strict();
export const StoryAgentToolResolutionSchema = StoryAgentToolPolicySettingsSchema.extend({
  storyId: StoryIdSchema,
  enabledTools: z.array(StoryAgentToolNameSchema).max(STORY_AGENT_TOOL_NAMES.length),
}).strict();
export type StoryAgentToolResolution = z.infer<typeof StoryAgentToolResolutionSchema>;
export const StoryAgentToolPolicyInvalidatedSchema = z.object({
  storyId: StoryIdSchema,
  revision: StoryAgentToolPolicySettingsSchema.shape.revision,
}).strict();
export type StoryAgentToolPolicyInvalidated = z.infer<typeof StoryAgentToolPolicyInvalidatedSchema>;

const StoryAgentToolPolicySettingsConsumerSchema = z.object({
  policy: StoryAgentToolPolicySchema.strip(),
  revision: StoryAgentToolPolicySettingsSchema.shape.revision,
}).strip();
const StoryAgentToolResolutionConsumerSchema = StoryAgentToolPolicySettingsConsumerSchema.extend({
  storyId: StoryIdSchema,
  enabledTools: z.array(z.string()).max(100),
}).strip();

export function sanitizeStoryAgentToolPolicySettings(input: unknown) {
  return StoryAgentToolPolicySettingsConsumerSchema.parse(input);
}

export function sanitizeStoryAgentToolResolution(input: unknown) {
  const parsed = StoryAgentToolResolutionConsumerSchema.parse(input);
  return StoryAgentToolResolutionSchema.parse({
    ...parsed,
    enabledTools: parsed.enabledTools.filter((name): name is StoryAgentToolName => StoryAgentToolNameSchema.safeParse(name).success),
  });
}

export const StoryAgentPageInputSchema = z.object({
  page: z.number().int().min(1).max(500).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
}).strict();
export const StoryAgentPaginationSchema = z.object({
  totalItems: z.number().int().nonnegative(),
  nextPage: z.number().int().min(2).max(500).optional(),
}).strict();

export function storyAgentPagination(totalItems: number, page: number, pageSize: number) {
  return StoryAgentPaginationSchema.parse({
    totalItems,
    ...(page < 500 && page * pageSize < totalItems ? { nextPage: page + 1 } : {}),
  });
}

export const StoryAgentContentListInputSchema = StoryAgentPageInputSchema;
export const StoryAgentContentListResultSchema = z.object({
  documents: z.array(z.object({
    title: StoryDocumentSchema.shape.title,
    storyPath: StoryPathSchema,
  }).strict()).max(100),
  pagination: StoryAgentPaginationSchema,
}).strict();
export const StoryAgentContentGetResultSchema = z.object({
  items: z.array(z.object({
    storyPath: StoryPathSchema,
    path: z.string().trim().min(1).max(4096).optional(),
    revision: StoryRevisionSchema.optional(),
    error: z.object({
      code: z.string().trim().min(1).max(120),
      message: z.string().trim().min(1).max(2000),
    }).strict().optional(),
  }).strict()).min(1).max(20),
}).strict();
export const StoryAgentContentSetResultSchema = z.object({
  title: StoryDocumentSchema.shape.title,
  storyPath: StoryPathSchema,
  revision: StoryRevisionSchema,
  size: z.number().int().nonnegative(),
}).strict();

export const STORY_AGENT_ACTION_PROMPT_PREVIEW_CHARS = 500;
export const StoryAgentActionUnavailableReasonSchema = z.enum([
  "STORY_ARCHIVED",
  "STORY_ACTION_TARGET_REQUIRED",
  "STORY_ACTION_TARGET_UNAVAILABLE",
]);
export const StoryAgentActionListInputSchema = StoryAgentPageInputSchema;
export const StoryAgentActionListResultSchema = z.object({
  actions: z.array(z.object({
    id: StoryActionSchema.shape.id,
    title: StoryActionSchema.shape.title,
    promptPreview: z.string().max(STORY_AGENT_ACTION_PROMPT_PREVIEW_CHARS),
    promptTruncated: z.boolean(),
    executable: z.boolean(),
    unavailableReason: StoryAgentActionUnavailableReasonSchema.optional(),
  }).strict()).max(100),
  pagination: StoryAgentPaginationSchema,
}).strict();
export const StoryAgentActionRunInputSchema = z.object({
  actionId: StoryActionSchema.shape.id,
  clientRequestId: z.string().trim().min(1).max(160),
}).strict();
export const StoryAgentActionRunResultSchema = z.object({
  session: z.object({
    instanceId: z.string().trim().min(1).max(120),
    sessionId: z.string().trim().min(1).max(120),
  }).strict(),
}).strict();
export type StoryAgentActionRunResult = z.infer<typeof StoryAgentActionRunResultSchema>;

export const StoryAgentAutomationListInputSchema = StoryAgentPageInputSchema;
export const StoryAgentAutomationCreateInputSchema = z.object({
  actionId: StoryActionSchema.shape.id,
  schedule: StoryAutomationScheduleSchema,
  enabled: z.boolean().default(true),
  policy: StoryAutomationPolicySchema.default({ maxConcurrentRuns: 1, whenBusy: "skip" }),
}).strict();
export const StoryAgentAutomationUpdateInputSchema = z.object({
  automationId: z.string().trim().min(1).max(120),
  expectedUpdatedAt: z.string().datetime(),
  actionId: StoryActionSchema.shape.id.optional(),
  schedule: StoryAutomationScheduleSchema.optional(),
  enabled: z.boolean().optional(),
  policy: StoryAutomationPolicySchema.optional(),
}).strict().refine((value) => Object.keys(value).some((key) => !["automationId", "expectedUpdatedAt"].includes(key)), "At least one Automation field is required.");
export const StoryAgentAutomationDeleteInputSchema = z.object({
  automationId: z.string().trim().min(1).max(120),
  expectedUpdatedAt: z.string().datetime(),
}).strict();
export const StoryAgentAutomationRunInputSchema = z.object({
  automationId: z.string().trim().min(1).max(120),
  clientRequestId: z.string().trim().min(1).max(160),
}).strict();
export const StoryAgentAutomationRunsInputSchema = z.object({
  automationId: z.string().trim().min(1).max(120),
  page: StoryAgentPageInputSchema.shape.page,
  pageSize: StoryAgentPageInputSchema.shape.pageSize,
}).strict();
export const StoryAgentDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();

export const StoryAgentAutomationRunSchema = z.object({
  id: z.string().trim().min(1).max(160),
  eventType: z.enum(["manual", "schedule"]),
  status: StoryAutomationRunStatusSchema,
  scheduledFor: z.string().datetime(),
  session: z.object({
    instanceId: z.string().trim().min(1).max(120),
    sessionId: z.string().trim().min(1).max(120),
  }).strict().optional(),
  error: StoryAutomationErrorSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
}).strict();
export const StoryAgentAutomationStatusSchema = z.object({
  id: z.string().trim().min(1).max(120),
  actionId: StoryActionSchema.shape.id,
  schedule: StoryAutomationScheduleSchema,
  enabled: z.boolean(),
  policy: StoryAutomationPolicySchema,
  updatedAt: z.string().datetime(),
  effectiveStatus: StoryAutomationEffectiveStatusSchema,
  blockedReason: StoryAutomationErrorSchema.optional(),
  nextRunAt: z.string().datetime().optional(),
  activeRunCount: z.number().int().nonnegative(),
  lastRun: StoryAgentAutomationRunSchema.optional(),
}).strict();
export const StoryAgentAutomationListResultSchema = z.object({
  automations: z.array(StoryAgentAutomationStatusSchema).max(100),
  pagination: StoryAgentPaginationSchema,
}).strict();
export const StoryAgentAutomationRunsResultSchema = z.object({
  runs: z.array(StoryAgentAutomationRunSchema).max(100),
  pagination: StoryAgentPaginationSchema,
}).strict();

export const StoryAgentAiSessionRefSchema = z.object({
  instanceId: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).max(120),
}).strict();
export const StoryAgentAiSessionListInputSchema = StoryAgentPageInputSchema;
export const StoryAgentAiSessionSummarySchema = StoryAgentAiSessionRefSchema.extend({
  title: z.string().trim().max(240).optional(),
  agent: z.string().trim().min(1).max(120),
  status: z.enum(["running", "waiting", "idle"]),
  updatedAt: z.string().datetime(),
}).strict();
export const StoryAgentAiSessionListResultSchema = z.object({
  sessions: z.array(StoryAgentAiSessionSummarySchema).max(100),
  pagination: StoryAgentPaginationSchema,
}).strict();
export const StoryAgentAiSessionGetInputSchema = StoryAgentAiSessionRefSchema.extend({
  page: StoryAgentPageInputSchema.shape.page,
  pageSize: z.number().int().min(1).max(50).default(10),
}).strict();
export const StoryAgentAiSessionInstanceReadResultSchema = z.object({
  detail: AiSessionDetailSchema,
  turnIndex: AiSessionTurnIndexSchema,
}).strict();
export const StoryAgentAiSessionDetailSchema = z.object({
  cwd: AiSessionDetailSchema.shape.cwd,
  modelName: z.string().trim().min(1).max(240).optional(),
  reasoningEffort: AiSessionDetailSchema.shape.reasoningEffort,
  error: AiSessionDetailSchema.shape.error,
}).strict();
export const StoryAgentAiSessionTurnSummarySchema = AiSessionHistoryTurnSchema.pick({
  id: true,
  status: true,
  phase: true,
  updatedAt: true,
  completedAt: true,
}).strict();
export const StoryAgentAiSessionTurnSchema = AiSessionHistoryTurnSchema.pick({
  id: true,
  status: true,
  phase: true,
  contextCompactions: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
}).strict();
export const StoryAgentAiSessionGetResultSchema = z.object({
  ref: StoryAgentAiSessionRefSchema,
  session: StoryAgentAiSessionDetailSchema,
  turns: z.array(StoryAgentAiSessionTurnSummarySchema).max(50),
  pagination: StoryAgentPaginationSchema,
}).strict();
export const StoryAgentAiSessionTurnInputSchema = StoryAgentAiSessionRefSchema.extend({
  turnId: z.string().trim().min(1).max(240),
  page: StoryAgentPageInputSchema.shape.page,
  pageSize: z.number().int().min(1).max(50).default(20),
  maxTextChars: z.number().int().min(256).max(32_000).default(8_000),
}).strict();
const StoryAgentTruncatedTextFieldsSchema = z.array(z.enum(["text", "summary", "input", "output", "paths"])).max(5).optional();
const StoryAgentAiSessionItemBaseSchema = z.object({
  id: z.string().trim().min(1).max(240),
  truncatedFields: StoryAgentTruncatedTextFieldsSchema,
}).strict();
export const StoryAgentAiSessionUserMessageSchema = StoryAgentAiSessionItemBaseSchema.extend({
  type: z.literal("user-message"),
  text: z.string().max(32_000),
  attachments: z.array(AiSessionConversationAttachmentSchema).max(6).optional(),
}).strict();
export const StoryAgentAiSessionAgentMessageSchema = StoryAgentAiSessionItemBaseSchema.extend({
  type: z.literal("ai-message"),
  text: z.string().max(32_000),
}).strict();
export const StoryAgentAiSessionActivitySchema = StoryAgentAiSessionItemBaseSchema.extend({
  type: z.literal("activity"),
  activityKind: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  status: z.enum(["running", "completed", "failed", "waiting"]).optional(),
  summary: z.string().max(32_000).optional(),
  input: z.string().max(32_000).optional(),
  output: z.string().max(32_000).optional(),
  paths: z.array(z.string().trim().min(1).max(4096)).max(100).optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();
export const StoryAgentAiSessionItemSchema = z.discriminatedUnion("type", [
  StoryAgentAiSessionUserMessageSchema,
  StoryAgentAiSessionAgentMessageSchema,
  StoryAgentAiSessionActivitySchema,
]);
export const StoryAgentAiSessionTurnResultSchema = z.object({
  ref: StoryAgentAiSessionRefSchema,
  turn: StoryAgentAiSessionTurnSchema,
  items: z.array(StoryAgentAiSessionItemSchema).max(50),
  pagination: StoryAgentPaginationSchema,
}).strict();
export const StoryAgentAiSessionInstanceTurnResultSchema = z.object({
  body: AiSessionTurnBodySchema,
  timeline: AiSessionTurnTimelineSchema,
}).strict();

const StoryAgentAiSessionInstanceReadConsumerSchema = z.object({
  detail: AiSessionDetailSchema.strip(),
  turnIndex: AiSessionTurnIndexSchema.strip(),
}).strip();
const StoryAgentAiSessionInstanceTurnConsumerSchema = z.object({
  body: AiSessionTurnBodySchema.strip(),
  timeline: AiSessionTurnTimelineSchema.strip(),
}).strip();

export function sanitizeStoryAgentAiSessionInstanceReadResult(input: unknown) {
  return StoryAgentAiSessionInstanceReadResultSchema.parse(StoryAgentAiSessionInstanceReadConsumerSchema.parse(input));
}

export function sanitizeStoryAgentAiSessionInstanceTurnResult(input: unknown) {
  return StoryAgentAiSessionInstanceTurnResultSchema.parse(StoryAgentAiSessionInstanceTurnConsumerSchema.parse(input));
}

export const STORY_AGENT_TOOL_SCHEMAS = {
  story_list_content: { input: StoryAgentContentListInputSchema, output: StoryAgentContentListResultSchema },
  story_get_content: { input: StoryContentGetInputSchema, output: StoryAgentContentGetResultSchema },
  story_set_content: { input: StoryContentSetInputSchema, output: StoryAgentContentSetResultSchema },
  story_list_actions: { input: StoryAgentActionListInputSchema, output: StoryAgentActionListResultSchema },
  story_run_action: { input: StoryAgentActionRunInputSchema, output: StoryAgentActionRunResultSchema },
  story_list_automations: { input: StoryAgentAutomationListInputSchema, output: StoryAgentAutomationListResultSchema },
  story_create_automation: { input: StoryAgentAutomationCreateInputSchema, output: StoryAgentAutomationStatusSchema },
  story_update_automation: { input: StoryAgentAutomationUpdateInputSchema, output: StoryAgentAutomationStatusSchema },
  story_delete_automation: { input: StoryAgentAutomationDeleteInputSchema, output: StoryAgentDeleteResultSchema },
  story_run_automation: { input: StoryAgentAutomationRunInputSchema, output: StoryAgentAutomationRunSchema },
  story_list_automation_runs: { input: StoryAgentAutomationRunsInputSchema, output: StoryAgentAutomationRunsResultSchema },
  story_list_ai_sessions: { input: StoryAgentAiSessionListInputSchema, output: StoryAgentAiSessionListResultSchema },
  story_get_ai_session: { input: StoryAgentAiSessionGetInputSchema, output: StoryAgentAiSessionGetResultSchema },
  story_get_ai_session_turn: { input: StoryAgentAiSessionTurnInputSchema, output: StoryAgentAiSessionTurnResultSchema },
} satisfies Record<StoryAgentToolName, { input: z.ZodType; output: z.ZodType }>;
