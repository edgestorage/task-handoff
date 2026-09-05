import { z } from "zod";
import {
  AiAgentKindSchema,
  AiSessionGitSelectionSchema,
  AiSessionModelSelectionSchema,
  AiSessionPermissionModeSchema,
  AiSessionReasoningEffortSchema,
  AiSessionRuntimePathSchema,
} from "./ai-sessions.ts";
import { StoryIdSchema } from "./story-id.ts";

/** Private Node Agent -> controlled instance wire model for Story Automation dispatch. */
export const StoryAutomationInstanceCreateInputSchema = z.object({
  agent: AiAgentKindSchema,
  cwd: AiSessionRuntimePathSchema,
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  gitSelection: AiSessionGitSelectionSchema.optional(),
  message: z.string().trim().min(1).max(32_000),
  permissionMode: AiSessionPermissionModeSchema.optional(),
  clientRequestId: z.string().trim().min(1).max(160),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  storyId: StoryIdSchema,
}).strict();

export const StoryAutomationInstanceCreateResultSchema = z.object({
  disposition: z.enum(["created", "already-created"]),
  aiSessionId: z.string().trim().min(1).max(120),
}).strict();

export type StoryAutomationInstanceCreateInput = z.infer<typeof StoryAutomationInstanceCreateInputSchema>;
export type StoryAutomationInstanceCreateResult = z.infer<typeof StoryAutomationInstanceCreateResultSchema>;
