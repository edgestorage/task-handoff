import { z } from "zod";
import {
  STORY_AGENT_TOOL_DESCRIPTIONS,
  STORY_AGENT_TOOL_NAMES,
  STORY_AGENT_TOOL_SCHEMAS,
  type StoryAgentToolName,
} from "@task-handoff/protocol/story-agent-tools";

type OpenCodeToolContext = {
  sessionID: string;
  abort: AbortSignal;
};

type PluginOptions = {
  endpoint?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

async function invoke(options: PluginOptions, tool: StoryAgentToolName, args: unknown, context: OpenCodeToolContext) {
  const endpoint = options.endpoint?.trim();
  const token = options.token?.trim();
  if (!endpoint || !token) throw new Error("TaskHandoff Story tools are not configured.");
  const response = await (options.fetch || globalThis.fetch)(`${endpoint}/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "opencode", providerSessionId: context.sessionID, tool, arguments: args }),
    signal: context.abort,
  });
  const payload = await response.json() as { data?: unknown; error?: { code?: string; message?: string } };
  if (!response.ok) {
    const message = payload.error?.message || `TaskHandoff Story tool failed with HTTP ${response.status}.`;
    throw Object.assign(new Error(message), { code: payload.error?.code });
  }
  return JSON.stringify(payload.data);
}

export function createOpenCodeStoryPlugin(options: PluginOptions = {
  endpoint: process.env.TASK_HANDOFF_AGENT_TOOLS_ENDPOINT,
  token: process.env.TASK_HANDOFF_AGENT_TOOLS_TOKEN,
}) {
  return async () => ({
    tool: Object.fromEntries(STORY_AGENT_TOOL_NAMES.map((name) => [name, {
      description: STORY_AGENT_TOOL_DESCRIPTIONS[name],
      args: inputShape(name),
      execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, name, args, context),
    }])),
  });
}

function inputShape(name: StoryAgentToolName) {
  const schema = STORY_AGENT_TOOL_SCHEMAS[name].input;
  if (!(schema instanceof z.ZodObject)) throw new Error(`Story tool ${name} input must be an object schema.`);
  return schema.shape;
}

export default createOpenCodeStoryPlugin();
