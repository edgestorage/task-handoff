import type { AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import { AI_SESSION_AGENT_TOOL_NAMES, type AiSessionAgentToolName } from "@task-handoff/protocol/ai-session-agent-tools";
import type { OpenCodePermissionRule } from "./client.ts";

export function openCodeSessionPermissionRules(
  mode: undefined,
  enabledTools: undefined,
  current?: readonly OpenCodePermissionRule[],
): undefined;
export function openCodeSessionPermissionRules(
  mode: AiSessionPermissionMode,
  enabledTools: readonly AiSessionAgentToolName[] | undefined,
  current?: readonly OpenCodePermissionRule[],
): OpenCodePermissionRule[];
export function openCodeSessionPermissionRules(
  mode: AiSessionPermissionMode | undefined,
  enabledTools: readonly AiSessionAgentToolName[],
  current?: readonly OpenCodePermissionRule[],
): OpenCodePermissionRule[];
export function openCodeSessionPermissionRules(
  mode: AiSessionPermissionMode | undefined,
  enabledTools: readonly AiSessionAgentToolName[] | undefined,
  current: readonly OpenCodePermissionRule[] = [],
): OpenCodePermissionRule[] | undefined {
  // Compatibility for v0.0.33: omitted policy inputs must not mutate provider-owned session permissions.
  if (mode === undefined && enabledTools === undefined) return undefined;
  const base = mode === undefined
    ? current.filter((rule) => !AI_SESSION_AGENT_TOOL_NAMES.includes(rule.permission as AiSessionAgentToolName))
    : mode === "full-access"
    ? [{ permission: "*", pattern: "*", action: "allow" as const }]
    : mode === "auto-review" ? [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
    ] as OpenCodePermissionRule[]
    : [{ permission: "*", pattern: "*", action: "ask" as const }];
  if (enabledTools === undefined) return base;
  const enabled = new Set(enabledTools);
  return [
    ...base,
    ...AI_SESSION_AGENT_TOOL_NAMES.map((permission): OpenCodePermissionRule => ({
      permission,
      pattern: "*",
      action: enabled.has(permission) ? "allow" : "deny",
    })),
  ];
}
