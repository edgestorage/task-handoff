import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function openCodeServerConfig(env: NodeJS.ProcessEnv) {
  const configured = env.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT?.trim();
  const parsed = configured ? JSON.parse(configured) as Record<string, unknown> : {};
  const agent = asRecord(parsed.agent);
  const configuredTitle = asRecord(agent.title);
  // TaskHandoff generates titles with the session's selected model and
  // reasoning effort. OpenCode's native title agent always uses `small: true`
  // and would make an additional provider request with a different variant.
  const config: Record<string, unknown> = {
    ...parsed,
    agent: {
      ...agent,
      title: { ...configuredTitle, disable: true },
    },
  };
  const pluginPath = env.TASK_HANDOFF_OPENCODE_STORY_PLUGIN?.trim();
  if (!pluginPath || !fs.existsSync(pluginPath)) return config;
  const plugin = pathToFileURL(pluginPath).href;
  const current = Array.isArray(config.plugin) ? config.plugin : [];
  return { ...config, plugin: current.includes(plugin) ? current : [...current, plugin] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
