import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import {
  StoryContentGetInputSchema,
  StoryContentPageInputSchema,
  StoryContentSetInputSchema,
} from "@task-handoff/protocol/stories";
import { z } from "zod";
import type { StoryAgentToolService } from "./story-tools.ts";
import { STORY_TOOL_DESCRIPTIONS } from "../story-tool-contract.ts";

const InvocationSchema = z.object({
  provider: z.literal("opencode"),
  providerSessionId: z.string().min(1).max(240),
  tool: z.enum(["story_list_content", "story_get_content", "story_set_content"]),
  arguments: z.unknown().optional(),
}).strict();

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
    const invoke = async (tool: string, args: unknown, extra: { _meta?: Record<string, unknown>; signal: AbortSignal }) => {
      const threadId = typeof extra._meta?.threadId === "string" ? extra._meta.threadId : undefined;
      if (!threadId) throw Object.assign(new Error("Codex did not provide a thread identity for the Story tool call."), { code: "AI_SESSION_IDENTITY_REQUIRED", statusCode: 400 });
      const session = this.options.resolveSession("codex", threadId);
      if (!session) throw Object.assign(new Error("AI Session was not found for the Story tool call."), { code: "AI_SESSION_NOT_FOUND", statusCode: 404 });
      const result = await this.options.service.invoke(session, tool, args, extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    };
    server.registerTool("story_list_content", {
      description: STORY_TOOL_DESCRIPTIONS.story_list_content,
      inputSchema: StoryContentPageInputSchema,
    }, (args, extra) => invoke("story_list_content", args, extra));
    server.registerTool("story_get_content", {
      description: STORY_TOOL_DESCRIPTIONS.story_get_content,
      inputSchema: StoryContentGetInputSchema,
    }, (args, extra) => invoke("story_get_content", args, extra));
    server.registerTool("story_set_content", {
      description: STORY_TOOL_DESCRIPTIONS.story_set_content,
      inputSchema: StoryContentSetInputSchema,
    }, (args, extra) => invoke("story_set_content", args, extra));
    return server;
  }
}
