import { z } from "zod";
import { STORY_TOOL_DESCRIPTIONS, type StoryToolName } from "./story-tool-contract.ts";

type OpenCodeToolContext = {
  sessionID: string;
  abort: AbortSignal;
};

type PluginOptions = {
  endpoint?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

async function invoke(options: PluginOptions, tool: StoryToolName, args: unknown, context: OpenCodeToolContext) {
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
    tool: {
      story_list_content: {
        description: STORY_TOOL_DESCRIPTIONS.story_list_content,
        args: {
          page: z.number().int().min(1).max(500).default(1).describe("One-based page number."),
          pageSize: z.number().int().min(1).max(100).default(20).describe("Maximum documents to return per page."),
        },
        execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, "story_list_content", args, context),
      },
      story_get_content: {
        description: STORY_TOOL_DESCRIPTIONS.story_get_content,
        args: {
          storyPaths: z.array(z.string()).min(1).max(20),
          destinationPath: z.string(),
        },
        execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, "story_get_content", args, context),
      },
      story_set_content: {
        description: STORY_TOOL_DESCRIPTIONS.story_set_content,
        args: {
          storyPath: z.string(),
          title: z.string().optional(),
          sourcePath: z.string(),
          expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        },
        execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, "story_set_content", args, context),
      },
    },
  });
}

export default createOpenCodeStoryPlugin();
