export const AI_AGENT_IDS = ["codex", "claude", "opencode", "gemini", "commandcode", "dsh"] as const;

export type AiAgentId = typeof AI_AGENT_IDS[number];

export function isAiAgentId(agent: string | undefined): agent is AiAgentId {
  return agent !== undefined && AI_AGENT_IDS.some((id) => id === agent);
}
