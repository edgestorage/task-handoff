import { z } from "zod";
import {
  StoryAutomationErrorSchema,
  StoryAutomationPolicySchema,
  StoryAutomationRunSchema,
  StoryAutomationScheduleSchema,
  StorySessionPresetSchema,
} from "@task-handoff/protocol/stories";

export const StoryAutomationExecutionInputSchema = z.object({
  storyId: z.string().trim().min(1).max(120),
  actionId: z.string().trim().min(1).max(120),
  targetInstanceId: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32_000),
  sessionPreset: StorySessionPresetSchema.optional(),
  cwd: z.string().trim().min(1).max(4096),
}).strict();

export const StoredStoryAutomationScheduleSchema = StoryAutomationScheduleSchema;
export const StoredStoryAutomationPolicySchema = StoryAutomationPolicySchema;
export const StoredStorySessionPresetSchema = StorySessionPresetSchema;
export const StoredStoryAutomationErrorSchema = StoryAutomationErrorSchema;

export const StoredStoryAutomationRunSchema = StoryAutomationRunSchema.extend({
  executionKey: z.string().trim().min(1).max(160),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  executionInput: StoryAutomationExecutionInputSchema,
}).strict();

export type StoryAutomationExecutionInput = z.infer<typeof StoryAutomationExecutionInputSchema>;
export type StoredStoryAutomationRun = z.infer<typeof StoredStoryAutomationRunSchema>;
