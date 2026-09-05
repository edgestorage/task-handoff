import { z } from "zod";
import {
  AiAgentKindSchema,
  AiSessionGitSelectionSchema,
  AiSessionModelSelectionSchema,
  AiSessionPermissionModeSchema,
  AiSessionReasoningEffortSchema,
  AiSessionSendModeSchema,
} from "./ai-sessions.ts";
import { StoryIdSchema } from "./story-id.ts";

export { StoryIdSchema } from "./story-id.ts";

export const STORY_PROTOCOL_VERSION = "2026-09-05";
export const STORY_DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const STORY_DEFAULT_MAX_BATCH_PATHS = 20;
export const STORY_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
export const STORY_MIN_IDLE_AI_SESSIONS = 1;
export const STORY_DEFAULT_MAX_IDLE_AI_SESSIONS = 5;
export const STORY_MAX_IDLE_AI_SESSIONS = 50;

export const StorySessionRetentionSettingsSchema = z.object({
  maxIdleAiSessions: z.number().int().min(STORY_MIN_IDLE_AI_SESSIONS).max(STORY_MAX_IDLE_AI_SESSIONS).default(STORY_DEFAULT_MAX_IDLE_AI_SESSIONS),
}).strict();

export const StoryPathSchema = z.string().trim().min(1).max(1024).refine((value) => {
  if (value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Story paths must be normalized relative POSIX paths.");

export const StoryRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const StoryDocumentSchema = z.object({
  title: z.string().trim().min(1).max(240),
  storyPath: StoryPathSchema,
  revision: StoryRevisionSchema,
}).strict();

export const StorySessionPresetSchema = z.object({
  agent: AiAgentKindSchema.optional(),
  mode: AiSessionSendModeSchema.optional(),
  permissionMode: AiSessionPermissionModeSchema.optional(),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  gitSelection: AiSessionGitSelectionSchema.optional(),
}).strict();

export const StoryActionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  promptTemplate: z.string().trim().min(1).max(32_000),
  targetInstanceId: z.string().trim().min(1).max(120).optional(),
  sessionPreset: StorySessionPresetSchema.optional(),
}).strict();

export const StoryActionInputSchema = StoryActionSchema.omit({ id: true }).strict();

export const StoryActionUpdateInputSchema = StoryActionInputSchema.extend({
  id: StoryActionSchema.shape.id.optional(),
}).strict();

export const StoryAutomationScheduleSchema = z.discriminatedUnion("scheduleKind", [
  z.object({
    scheduleKind: z.literal("interval"),
    intervalMs: z.number().int().min(60_000),
  }).strict(),
  z.object({
    scheduleKind: z.literal("daily"),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    scheduleKind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((value) => new Set(value).size === value.length, "Weekdays must be unique."),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    scheduleKind: z.literal("monthly"),
    dayOfMonth: z.number().int().min(-3).max(31).refine((value) => value !== 0, "Day of month must not be zero."),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().trim().min(1).max(120),
  }).strict(),
]);

export const StoryAutomationPolicySchema = z.object({
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(20).default(1),
  whenBusy: z.enum(["skip", "queue"]).default("skip"),
}).strict();

export const StoryAutomationSchema = z.object({
  id: z.string().trim().min(1).max(120),
  storyId: StoryIdSchema,
  actionId: StoryActionSchema.shape.id,
  schedule: StoryAutomationScheduleSchema,
  enabled: z.boolean().default(true),
  policy: StoryAutomationPolicySchema.default({ maxConcurrentRuns: 1, whenBusy: "skip" }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export const StoryAutomationInputSchema = StoryAutomationSchema.omit({ id: true, createdAt: true, updatedAt: true }).strict();
export const StoryAutomationWithActionInputSchema = z.object({
  action: StoryActionSchema,
  automation: StoryAutomationInputSchema.omit({ storyId: true, actionId: true }).strict(),
}).strict();
export const StoryAutomationUpdateInputSchema = z.object({
  actionId: StoryAutomationSchema.shape.actionId.optional(),
  schedule: StoryAutomationScheduleSchema.optional(),
  enabled: z.boolean().optional(),
  policy: StoryAutomationPolicySchema.optional(),
}).strict()
  .refine((value) => Object.keys(value).length > 0, "At least one Automation field is required.");

export const StoryAutomationErrorSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
}).strict();

export const StoryAutomationRunStatusSchema = z.enum(["queued", "dispatching", "running", "completed", "failed", "skipped"]);
export const StoryAutomationRunSchema = z.object({
  id: z.string().trim().min(1).max(160),
  automationId: StoryAutomationSchema.shape.id,
  eventType: z.enum(["manual", "schedule"]),
  status: StoryAutomationRunStatusSchema,
  scheduledFor: z.string().datetime(),
  targetInstanceId: z.string().trim().min(1).max(120),
  aiSessionId: z.string().trim().min(1).max(120).optional(),
  error: StoryAutomationErrorSchema.optional(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
}).strict();

export const StoryAutomationEffectiveStatusSchema = z.enum(["disabled", "blocked", "scheduled", "running", "error"]);
export const StoryAutomationStatusSchema = z.object({
  automation: StoryAutomationSchema,
  effectiveStatus: StoryAutomationEffectiveStatusSchema,
  blockedReason: StoryAutomationErrorSchema.optional(),
  nextRunAt: z.string().datetime().optional(),
  currentRuns: z.array(StoryAutomationRunSchema).max(20).default([]),
  lastRun: StoryAutomationRunSchema.optional(),
}).strict();

export const StoryAutomationListSchema = z.object({
  automations: z.array(StoryAutomationStatusSchema).default([]),
}).strict();

export const StoryAutomationRunsSchema = z.object({
  runs: z.array(StoryAutomationRunSchema).max(120).default([]),
}).strict();

export const StoryAutomationManualRunInputSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(160),
}).strict();

export const StoryAutomationChangedEventType = "story.automation.changed";
export const StoryAutomationChangedEventSchema = z.object({
  storyId: StoryIdSchema,
  automationId: StoryAutomationSchema.shape.id,
  change: z.enum(["created", "updated", "deleted", "status", "run"]),
  status: StoryAutomationStatusSchema.optional(),
  run: StoryAutomationRunSchema.optional(),
}).strict();

export const StorySchema = z.object({
  id: StoryIdSchema,
  ownerNodeId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(4000).optional(),
  documents: z.array(StoryDocumentSchema).max(500).default([]),
  actions: z.array(StoryActionSchema).max(50).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
}).strict();

export const StoryListSchema = z.object({
  stories: z.array(StorySchema).default([]),
}).strict();

export const StoryCreateInputSchema = z.object({
  title: StorySchema.shape.title,
  description: StorySchema.shape.description,
  actions: z.array(StoryActionInputSchema).max(50).optional(),
  maxIdleAiSessions: StorySessionRetentionSettingsSchema.shape.maxIdleAiSessions.optional(),
}).strict();

export const StoryUpdateInputSchema = z.object({
  title: StorySchema.shape.title.optional(),
  description: StorySchema.shape.description.nullable().optional(),
  actions: z.array(StoryActionUpdateInputSchema).max(50).optional(),
  maxIdleAiSessions: StorySessionRetentionSettingsSchema.shape.maxIdleAiSessions.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one Story field is required.");

export const StoryDocumentUpdateInputSchema = z.object({
  title: StoryDocumentSchema.shape.title.optional(),
  storyPath: StoryPathSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one document field is required.");

export const StoryDocumentOrderInputSchema = z.object({
  storyPaths: z.array(StoryPathSchema).max(500),
}).strict();

export const StoryManagementContentSetInputSchema = z.object({
  storyPath: StoryPathSchema,
  title: StoryDocumentSchema.shape.title.optional(),
  expectedRevision: StoryRevisionSchema.optional(),
}).strict();

export const StoryContentListSchema = z.object({
  documents: z.array(StoryDocumentSchema).max(500),
}).strict();

export const StoryContentPreviewSchema = z.object({
  storyPath: StoryPathSchema,
  revision: StoryRevisionSchema,
  content: z.string(),
  size: z.number().int().nonnegative(),
}).strict();

export const StoryContentGetInputSchema = z.object({
  storyPaths: z.array(StoryPathSchema).min(1).max(STORY_DEFAULT_MAX_BATCH_PATHS),
  destinationPath: z.string().trim().min(1).max(4096),
}).strict();

export const StoryContentSetInputSchema = z.object({
  storyPath: StoryPathSchema,
  title: StoryDocumentSchema.shape.title.optional(),
  sourcePath: z.string().trim().min(1).max(4096),
  expectedRevision: StoryRevisionSchema.optional(),
}).strict();

export const StoryContentTransferItemSchema = z.object({
  storyPath: StoryPathSchema,
  path: z.string().trim().min(1).max(4096).optional(),
  revision: StoryRevisionSchema.optional(),
  error: z.object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2000),
  }).strict().optional(),
}).strict();

export const StoryContentGetResultSchema = z.object({
  items: z.array(StoryContentTransferItemSchema).min(1).max(STORY_DEFAULT_MAX_BATCH_PATHS),
}).strict();

export const StoryChangedEventType = "story.changed";

export const StoryChangedEventSchema = z.object({
  storyId: StoryIdSchema,
  nodeId: z.string().trim().min(1).max(120),
  change: z.enum([
    "created",
    "updated",
    "archived",
    "restored",
    "deleted",
    "content.written",
    "document.updated",
    "document.reordered",
    "document.deleted",
  ]).optional(),
  storyPath: StoryPathSchema.optional(),
}).strict();

export type Story = z.infer<typeof StorySchema>;
export type StoryAction = z.infer<typeof StoryActionSchema>;
export type StoryActionInput = z.infer<typeof StoryActionInputSchema>;
export type StoryAutomation = z.infer<typeof StoryAutomationSchema>;
export type StoryAutomationInput = z.infer<typeof StoryAutomationInputSchema>;
export type StoryAutomationWithActionInput = z.infer<typeof StoryAutomationWithActionInputSchema>;
export type StoryAutomationUpdateInput = z.infer<typeof StoryAutomationUpdateInputSchema>;
export type StoryAutomationSchedule = z.infer<typeof StoryAutomationScheduleSchema>;
export type StoryAutomationPolicy = z.infer<typeof StoryAutomationPolicySchema>;
export type StoryAutomationRun = z.infer<typeof StoryAutomationRunSchema>;
export type StoryAutomationStatus = z.infer<typeof StoryAutomationStatusSchema>;
export type StoryAutomationChangedEvent = z.infer<typeof StoryAutomationChangedEventSchema>;
export type StoryAutomationManualRunInput = z.infer<typeof StoryAutomationManualRunInputSchema>;
export type StorySessionPreset = z.infer<typeof StorySessionPresetSchema>;
export type StoryCreateInput = z.infer<typeof StoryCreateInputSchema>;
export type StoryDocument = z.infer<typeof StoryDocumentSchema>;
export type StoryContentPreview = z.infer<typeof StoryContentPreviewSchema>;
export type StoryUpdateInput = z.infer<typeof StoryUpdateInputSchema>;
export type StoryChangedEvent = z.infer<typeof StoryChangedEventSchema>;
export type StorySessionRetentionSettings = z.infer<typeof StorySessionRetentionSettingsSchema>;
