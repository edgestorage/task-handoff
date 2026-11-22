import { z } from "zod";
import {
  STORY_AGENT_TOOL_DESCRIPTIONS,
  STORY_AGENT_TOOL_NAMES,
  STORY_AGENT_TOOL_SCHEMAS,
  type StoryAgentToolName,
} from "@task-handoff/protocol/story-agent-tools";
import {
  AGENT_INVOCATION_TOOL_DESCRIPTION,
  AGENT_INVOCATION_TOOL_SCHEMA,
  type AgentInvocationToolName,
} from "@task-handoff/protocol/agent-invocation-tools";
import { BROWSER_AGENT_TOOL_NAMES, type BrowserAgentToolName } from "@task-handoff/protocol/browser-agent-tools";

type OpenCodeToolContext = {
  sessionID: string;
  callID?: string;
  abort: AbortSignal;
};

type PluginOptions = {
  endpoint?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

const BROWSER_CDP_ACCESS_DESCRIPTION = "Return a short-lived standard CDP (Chrome DevTools Protocol) endpoint and token for this embedded browser — the browser tabs shown in the TaskHandoff browser panel. The endpoint follows Chrome's CDP semantics: use the standard /json discovery endpoints and each target's webSocketDebuggerUrl, then send normal CDP methods and events. This is the embedded browser's endpoint, not a separate local Chromium instance. If browser access is disabled, the call returns status=pending with a requestRef, status=denied, or status=expired; ask the user to approve it in the approval center and call again after approval. When granted, send Authorization: Bearer <token> or ?token=<token> on HTTP requests.";

async function invoke(options: PluginOptions, tool: StoryAgentToolName | AgentInvocationToolName | BrowserAgentToolName, args: unknown, context: OpenCodeToolContext) {
  const endpoint = options.endpoint?.trim();
  const token = options.token?.trim();
  if (!endpoint || !token) throw new Error("TaskHandoff Story tools are not configured.");
  const response = await (options.fetch || globalThis.fetch)(`${endpoint}/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "opencode",
      providerSessionId: context.sessionID,
      tool,
      arguments: args,
      ...(context.callID ? { callId: context.callID } : {}),
    }),
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
    tool: Object.fromEntries([
      ...STORY_AGENT_TOOL_NAMES.map((name) => [name, {
      description: STORY_AGENT_TOOL_DESCRIPTIONS[name],
      args: inputShape(name),
      execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, name, args, context),
      }] as const),
      ["agent_run", {
        description: AGENT_INVOCATION_TOOL_DESCRIPTION,
        args: AGENT_INVOCATION_TOOL_SCHEMA.input.shape,
        execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, "agent_run", args, context),
      }],
      ...BROWSER_AGENT_TOOL_NAMES.map((name) => [name, {
        description: BROWSER_CDP_ACCESS_DESCRIPTION,
        args: {},
        execute: (args: unknown, context: OpenCodeToolContext) => invoke(options, name, args, context),
      }] as const),
    ]),
  });
}

function inputShape(name: StoryAgentToolName) {
  const schema = STORY_AGENT_TOOL_SCHEMAS[name].input;
  if (!(schema instanceof z.ZodObject)) throw new Error(`Story tool ${name} input must be an object schema.`);
  return schema.shape;
}

export default createOpenCodeStoryPlugin();
