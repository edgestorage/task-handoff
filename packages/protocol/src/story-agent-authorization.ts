import { z } from "zod";
import { AgentDefinitionIdSchema, AgentDefinitionRevisionSchema } from "./agent-definitions.ts";
import { StoryIdSchema } from "./stories.ts";

export const StoryAgentEntrySchema = z.object({
  agentId: AgentDefinitionIdSchema,
  status: z.enum(["available", "missing-reference"]),
}).strict();
export type StoryAgentEntry = z.infer<typeof StoryAgentEntrySchema>;

/** Story owns the entry set; AgentDefinition intentionally has no reverse Story field. */
export const StoryAgentEntrySetSchema = z.object({
  storyId: StoryIdSchema,
  revision: AgentDefinitionRevisionSchema,
  entries: z.array(StoryAgentEntrySchema),
}).strict();
export type StoryAgentEntrySet = z.infer<typeof StoryAgentEntrySetSchema>;

export const StoryAgentEntrySetUpdateInputSchema = z.object({
  expectedRevision: AgentDefinitionRevisionSchema,
  agentIds: z.array(AgentDefinitionIdSchema).max(50),
}).strict();
export type StoryAgentEntrySetUpdateInput = z.infer<typeof StoryAgentEntrySetUpdateInputSchema>;

export const STORY_AGENT_AUTHORIZATION_ERROR_CODES = [
  "STORY_AGENT_ENTRY_STORY_NOT_FOUND",
  "STORY_AGENT_ENTRY_AGENT_NOT_FOUND",
  "STORY_AGENT_ENTRY_REVISION_CONFLICT",
] as const;
export const StoryAgentAuthorizationErrorCodeSchema = z.enum(STORY_AGENT_AUTHORIZATION_ERROR_CODES);
export type StoryAgentAuthorizationErrorCode = z.infer<typeof StoryAgentAuthorizationErrorCodeSchema>;

const StoryAgentEntryConsumerSchema = StoryAgentEntrySchema.strip();
const StoryAgentEntrySetConsumerSchema = StoryAgentEntrySetSchema.strip().extend({
  entries: z.array(StoryAgentEntryConsumerSchema),
});

export function sanitizeStoryAgentEntrySet(input: unknown): StoryAgentEntrySet {
  return StoryAgentEntrySetConsumerSchema.parse(input);
}
