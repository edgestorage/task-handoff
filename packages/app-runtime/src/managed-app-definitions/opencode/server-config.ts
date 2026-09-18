import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function openCodeServerConfig(env: NodeJS.ProcessEnv) {
  const configured = env.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT?.trim();
  const parsed = configured ? JSON.parse(configured) as Record<string, unknown> : {};
  const pluginPath = env.TASK_HANDOFF_OPENCODE_STORY_PLUGIN?.trim();
  if (!pluginPath || !fs.existsSync(pluginPath)) return parsed;
  const plugin = pathToFileURL(pluginPath).href;
  const current = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  return { ...parsed, plugin: current.includes(plugin) ? current : [...current, plugin] };
}
