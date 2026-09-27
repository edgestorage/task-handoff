import { z } from "zod";
import { AGENT_INVOCATION_TOOL_NAMES, AgentInvocationToolNameSchema } from "./agent-invocation-tools.ts";
import { STORY_AGENT_TOOL_NAMES, StoryAgentToolNameSchema } from "./story-agent-tools.ts";

export const AI_SESSION_AGENT_TOOL_NAMES = [
  ...STORY_AGENT_TOOL_NAMES,
  ...AGENT_INVOCATION_TOOL_NAMES,
] as const;

export const AiSessionAgentToolNameSchema = z.union([
  StoryAgentToolNameSchema,
  AgentInvocationToolNameSchema,
]);
export type AiSessionAgentToolName = z.infer<typeof AiSessionAgentToolNameSchema>;

export function aiSessionAgentToolNames(input: {
  enabledTools: readonly string[];
  agentInvocation?: { enabledTools?: readonly string[] };
}): AiSessionAgentToolName[] {
  const names = [...input.enabledTools, ...(input.agentInvocation?.enabledTools ?? [])];
  return [...new Set(names)].filter((name): name is AiSessionAgentToolName => (
    AiSessionAgentToolNameSchema.safeParse(name).success
  ));
}
