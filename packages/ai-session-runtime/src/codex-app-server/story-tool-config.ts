import type { StoryAgentToolName } from "@task-handoff/protocol/story-agent-tools";

export function codexThreadConfig(reasoningEffort?: string, storyAgentTools?: StoryAgentToolName[]): Record<string, unknown> {
  return {
    ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
    ...(storyAgentTools ? {
      "mcp_servers.task_handoff_story.enabled": storyAgentTools.length > 0,
      ...(storyAgentTools.length > 0
        ? { "mcp_servers.task_handoff_story.enabled_tools": storyAgentTools }
        : {}),
    } : {}),
  };
}
