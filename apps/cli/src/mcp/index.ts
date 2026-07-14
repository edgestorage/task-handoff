import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { normalizeAttachmentInputs } from "@task-handoff/core/core/attachments";
import { DEFAULT_CONVERSATION_ID, DEFAULT_SOCKET_PATH } from "@task-handoff/core/core/config";
import { loadSettings } from "@task-handoff/core/core/persistence";
import { waitForSenderReply, waitingForTaskMessage } from "@task-handoff/protocol/sender";
import { identitiesFromCodexThread, sessionIdsForCodexThread } from "@task-handoff/receiver-worker/state/binding-identities";
import { conversationIdForIdentities } from "@task-handoff/receiver-worker/state/conversation-bindings";

export const TOOL_NAME = "get_task";
const MCP_SENDER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type McpServerOptions = {
  socketPath?: string;
  timeoutMs?: number;
  timeoutOverridden?: boolean;
};

function compact(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function requestMetaThreadId(meta: unknown) {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const record = meta as Record<string, unknown>;
  return compact(record.threadId || record.codexThreadId || record.codexId) || undefined;
}

function conversationIdForCodexThread(threadId: unknown) {
  return conversationIdForIdentities(loadSettings(), identitiesFromCodexThread(threadId));
}

function createServer(options: McpServerOptions & { socketPath: string }) {
  const server = new McpServer({
    name: "task-handoff-sender",
    version: "1.0.0",
  });

  server.registerTool(
    TOOL_NAME,
    {
      description: "Send a result to task-handoff receiver and wait for the next task reply.",
      inputSchema: {
        conversationId: z.number().int().positive().optional(),
        result: z.string(),
        filePaths: z.array(z.string()).optional(),
        imagePaths: z.array(z.string()).optional(),
      },
    },
    async ({ conversationId, result, filePaths, imagePaths }, extra) => {
      try {
        const threadId = requestMetaThreadId(extra?._meta);
        const resolvedConversationId = conversationId ?? conversationIdForCodexThread(threadId) ?? DEFAULT_CONVERSATION_ID;
        const attachments = normalizeAttachmentInputs([
          ...((imagePaths || []) as string[]).map((filePath) => ({ kind: "image" as const, path: filePath })),
          ...((filePaths || []) as string[]).map((filePath) => ({ kind: "file" as const, path: filePath })),
        ]);
        const reply = await waitForSenderReply({
          result,
          attachments,
          conversationId: resolvedConversationId,
          socketPath: options.socketPath,
          timeoutMs: options.timeoutOverridden ? options.timeoutMs : MCP_SENDER_TIMEOUT_MS,
          timeoutOverridden: false,
          timeoutReply: waitingForTaskMessage("mcp"),
          source: "mcp",
          sessionIds: sessionIdsForCodexThread(threadId),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: reply,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    },
  );

  return server;
}

async function startMcpServer(options: McpServerOptions = {}) {
  const serverOptions = {
    socketPath: options.socketPath || DEFAULT_SOCKET_PATH,
    timeoutMs: options.timeoutMs,
    timeoutOverridden: options.timeoutOverridden,
  };
  const server = createServer(serverOptions);
  await server.connect(new StdioServerTransport());
}

export function runMcpServer(options: McpServerOptions = {}) {
  void startMcpServer(options).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { MCP_SENDER_TIMEOUT_MS };
