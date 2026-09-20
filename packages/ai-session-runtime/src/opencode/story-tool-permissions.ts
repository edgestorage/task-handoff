import type { AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import { STORY_AGENT_TOOL_NAMES, type StoryAgentToolName } from "@task-handoff/protocol/story-agent-tools";
import type { OpenCodePermissionRule } from "./client.ts";

export function openCodeSessionPermissionRules(
  mode: AiSessionPermissionMode | undefined,
  enabledTools: readonly StoryAgentToolName[],
  current: readonly OpenCodePermissionRule[] = [],
): OpenCodePermissionRule[] {
  const base = mode === undefined
    ? current.filter((rule) => !STORY_AGENT_TOOL_NAMES.includes(rule.permission as StoryAgentToolName))
    : mode === "full-access"
    ? [{ permission: "*", pattern: "*", action: "allow" as const }]
    : mode === "auto-review" ? [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
    ] as OpenCodePermissionRule[]
    : [{ permission: "*", pattern: "*", action: "ask" as const }];
  const enabled = new Set(enabledTools);
  return [
    ...base,
    ...STORY_AGENT_TOOL_NAMES.map((permission): OpenCodePermissionRule => ({
      permission,
      pattern: "*",
      action: enabled.has(permission) ? "allow" : "deny",
    })),
  ];
}
