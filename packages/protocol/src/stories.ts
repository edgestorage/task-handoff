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

export const STORY_PROTOCOL_VERSION = "2026-09-03";
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

export const StoryActionParameterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  required: z.boolean().default(false),
  defaultValue: z.string().max(4000).optional(),
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
  parameters: z.array(StoryActionParameterSchema).max(20).default([]),
  sessionPreset: StorySessionPresetSchema.optional(),
}).strict();

export const StoryActionInputSchema = StoryActionSchema.omit({ id: true }).strict();

export const StoryActionUpdateInputSchema = StoryActionInputSchema.extend({
  id: StoryActionSchema.shape.id.optional(),
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
export type StorySessionPreset = z.infer<typeof StorySessionPresetSchema>;
export type StoryCreateInput = z.infer<typeof StoryCreateInputSchema>;
export type StoryDocument = z.infer<typeof StoryDocumentSchema>;
export type StoryContentPreview = z.infer<typeof StoryContentPreviewSchema>;
export type StoryUpdateInput = z.infer<typeof StoryUpdateInputSchema>;
export type StoryChangedEvent = z.infer<typeof StoryChangedEventSchema>;
export type StorySessionRetentionSettings = z.infer<typeof StorySessionRetentionSettingsSchema>;
