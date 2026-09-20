import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { z } from "zod";
import type { StoryAgentToolService } from "./story-tools.ts";
import {
  STORY_AGENT_TOOL_DESCRIPTIONS,
  STORY_AGENT_TOOL_NAMES,
  STORY_AGENT_TOOL_SCHEMAS,
  StoryAgentToolNameSchema,
  type StoryAgentToolName,
} from "@task-handoff/protocol/story-agent-tools";

const InvocationSchema = z.object({
  provider: z.literal("opencode"),
  providerSessionId: z.string().min(1).max(240),
  tool: StoryAgentToolNameSchema,
  arguments: z.unknown().optional(),
}).strict();

const STORY_AGENT_READ_ONLY_TOOLS = new Set<StoryAgentToolName>([
  "story_list_content",
  "story_list_actions",
  "story_list_automations",
  "story_list_automation_runs",
  "story_list_ai_sessions",
  "story_get_ai_session",
  "story_get_ai_session_turn",
]);

type StoryAgentToolBridgeOptions = {
  service: StoryAgentToolService;
  resolveSession(provider: "codex" | "opencode", providerSessionId: string): AiSessionStatus | undefined;
  endpoint: string;
  pluginPath?: string;
  token?: string;
};

function sameToken(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function bearerToken(request: FastifyRequest) {
  return request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function errorDetails(error: unknown) {
  return {
    code: typeof error === "object" && error && "code" in error ? String(error.code) : "STORY_TOOL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    statusCode: error instanceof z.ZodError
      ? 400
      : typeof error === "object" && error && "statusCode" in error && Number.isInteger(error.statusCode)
      ? Number(error.statusCode)
      : 500,
  };
}

export class StoryAgentToolBridge {
  readonly token: string;
  private readonly options: StoryAgentToolBridgeOptions;

  constructor(options: StoryAgentToolBridgeOptions) {
    this.options = options;
    this.token = options.token || crypto.randomBytes(32).toString("base64url");
  }

  runtimeEnvironment() {
    return {
      TASK_HANDOFF_AGENT_TOOLS_ENDPOINT: this.options.endpoint,
      TASK_HANDOFF_AGENT_TOOLS_TOKEN: this.token,
    };
  }

  openCodeRuntimeEnvironment() {
    return {
      ...this.runtimeEnvironment(),
      ...(this.options.pluginPath ? { TASK_HANDOFF_OPENCODE_STORY_PLUGIN: this.options.pluginPath } : {}),
    };
  }

  register(app: FastifyInstance) {
    const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!sameToken(bearerToken(request), this.token)) {
        return reply.code(403).send({ error: { code: "AGENT_TOOL_FORBIDDEN", message: "Agent tool token is required." } });
      }
    };

    app.post("/api/internal/agent-tools/invoke", {
      config: { taskHandoffAuth: "public" },
      preHandler: authenticate,
      bodyLimit: 256 * 1024,
    }, async (request, reply) => {
      try {
        const input = InvocationSchema.parse(request.body || {});
        const session = this.options.resolveSession(input.provider, input.providerSessionId);
        if (!session) throw Object.assign(new Error("AI Session was not found for the Story tool call."), { code: "AI_SESSION_NOT_FOUND", statusCode: 404 });
        return { data: await this.options.service.invoke(session, input.tool, input.arguments) };
      } catch (error) {
        const details = errorDetails(error);
        return reply.code(details.statusCode).send({ error: { code: details.code, message: details.message } });
      }
    });

    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/api/internal/agent-tools/mcp",
      config: { taskHandoffAuth: "public" },
      preHandler: authenticate,
      bodyLimit: 256 * 1024,
      handler: async (request, reply) => {
        const server = this.createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        reply.hijack();
        try {
          await server.connect(transport);
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } catch (error) {
          if (!reply.raw.headersSent) {
            const details = errorDetails(error);
            reply.raw.writeHead(details.statusCode, { "content-type": "application/json" });
            reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: details.message }, id: null }));
          } else if (!reply.raw.writableEnded) {
            reply.raw.end();
          }
        } finally {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }
        return reply;
      },
    });
  }

  private createMcpServer() {
    const server = new McpServer({ name: "task-handoff-story", version: "1.0.0" });
    const invoke = async (tool: StoryAgentToolName, args: unknown, extra: { _meta?: Record<string, unknown>; signal: AbortSignal }) => {
      const threadId = typeof extra._meta?.threadId === "string" ? extra._meta.threadId : undefined;
      if (!threadId) throw Object.assign(new Error("Codex did not provide a thread identity for the Story tool call."), { code: "AI_SESSION_IDENTITY_REQUIRED", statusCode: 400 });
      const session = this.options.resolveSession("codex", threadId);
      if (!session) throw Object.assign(new Error("AI Session was not found for the Story tool call."), { code: "AI_SESSION_NOT_FOUND", statusCode: 404 });
      const result = STORY_AGENT_TOOL_SCHEMAS[tool].output.parse(await this.options.service.invoke(session, tool, args, extra.signal));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    };
    for (const name of STORY_AGENT_TOOL_NAMES) {
      server.registerTool(name, {
        description: STORY_AGENT_TOOL_DESCRIPTIONS[name],
        inputSchema: STORY_AGENT_TOOL_SCHEMAS[name].input as z.ZodObject,
        outputSchema: STORY_AGENT_TOOL_SCHEMAS[name].output as z.ZodObject,
        ...(STORY_AGENT_READ_ONLY_TOOLS.has(name) ? { annotations: { readOnlyHint: true } } : {}),
      }, (args, extra) => invoke(name, args, extra));
    }
    return server;
  }
}
