import net from "node:net";
import type { SenderAttachment } from "@task-handoff/core/core/attachments";
import { CONFIG_PATH, DEFAULT_CONVERSATION_ID, DEFAULT_TIMEOUT_MS } from "@task-handoff/core/core/config";
import { appendJsonl, defaultDiagnosticLogPath, processSnapshot } from "@task-handoff/core/core/diagnostics";
import { decodeLines, encodeMessage, ReceiverMessageSchema } from "@task-handoff/core/core/protocol";
import { normalizeCliMarkdown } from "@task-handoff/core/core/text";
import { color, renderMarkdown } from "@task-handoff/terminal-ui";

const WAITING_FOR_TASK_MESSAGE = "任务即将下发，请继续执行命令行发送ready以等待新任务";
const MCP_WAITING_FOR_TASK_MESSAGE = "任务即将下发，请在 MCP 端继续调用 get_task 工具发送ready以等待新任务或者目标";

type SenderOptions = {
  result?: unknown;
  socketPath: string;
  conversationId?: number;
  timeoutMs?: number;
  timeoutOverridden?: boolean;
  source?: "cli" | "mcp";
  kind?: "task" | "approval";
  cwd?: string;
  raw?: boolean;
  sessionIds?: Record<string, string>;
  timeoutReply?: string;
  attachments?: SenderAttachment[];
};

function senderLogPath() {
  return process.env.TASK_HANDOFF_SENDER_LOG || defaultDiagnosticLogPath(CONFIG_PATH, "sender.log");
}

function logSender(event: string, details: Record<string, unknown>) {
  try {
    appendJsonl(senderLogPath(), {
      event,
      process: processSnapshot(),
      ...details,
    });
  } catch {
    // Diagnostics must never break result delivery.
  }
}

function compact(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function waitingForTaskMessage(source: SenderOptions["source"] = "cli") {
  return source === "mcp" ? MCP_WAITING_FOR_TASK_MESSAGE : WAITING_FOR_TASK_MESSAGE;
}

function collectSessionIds(env = process.env) {
  const entries = {
    codexId: env.CODEX_SESSION_ID || env.CODEX_THREAD_ID,
    claudeSessionId: env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE_SESSION_ID,
    terminalSessionId: env.TERM_SESSION_ID,
  };
  return Object.fromEntries(
    Object.entries(entries)
      .map(([key, value]) => [key, compact(value)] as const)
      .filter(([, value]) => value),
  );
}

export function waitForSenderReply({
  result,
  socketPath,
  conversationId = DEFAULT_CONVERSATION_ID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutOverridden = false,
  source = "cli",
  kind = "task",
  cwd = process.cwd(),
  sessionIds: extraSessionIds,
  timeoutReply,
  attachments = [],
}: Omit<SenderOptions, "raw">): Promise<string> {
  if (result === undefined) {
    return Promise.reject(new Error("Missing result. Run `task-handoff help` for usage details."));
  }
  const normalizedResult = normalizeCliMarkdown(result);
  logSender("start", {
    conversationId,
    source,
    kind,
    cwd,
    socketPath,
    timeoutMs,
    timeoutOverridden,
    resultPreview: normalizedResult.replace(/\s+/g, " ").slice(0, 160),
    attachments: attachments.map((attachment) => ({ id: attachment.id, kind: attachment.kind, name: attachment.name, size: attachment.size })),
  });

  return new Promise((resolve, reject) => {
    let finished = false;
    let connected = false;
    let resultSent = false;
    let retryTimer: NodeJS.Timeout | undefined;
    let client: net.Socket | undefined;

    const finish = (output: string) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      client?.end();
      logSender("finish", {
        conversationId,
        source,
        cwd,
        resultSent,
        outputPreview: output.replace(/\s+/g, " ").slice(0, 160),
      });
      resolve(output);
    };

    const fail = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      client?.end();
      logSender("error", {
        conversationId,
        source,
        cwd,
        resultSent,
        message: error.message,
      });
      reject(error);
    };

    const timer =
      timeoutOverridden || timeoutReply !== undefined
        ? setTimeout(() => {
            finish(timeoutReply ?? waitingForTaskMessage(source));
          }, timeoutMs ?? DEFAULT_TIMEOUT_MS)
        : undefined;

    const sendResult = (socket: net.Socket) => {
      const sessionIds = {
        ...collectSessionIds(),
        ...(extraSessionIds || {}),
      };
      const message: {
        type: string;
        result: unknown;
        conversationId?: number;
        timeoutMs?: number;
        source?: string;
        kind?: string;
        cwd?: string;
        sessionIds?: Record<string, string>;
        attachments?: SenderAttachment[];
      } = {
        type: "result",
        result: normalizedResult,
        conversationId,
        kind,
        sessionIds,
      };
      if (attachments.length > 0) {
        message.attachments = attachments;
      }
      if (source !== "cli") {
        message.source = source;
      } else {
        message.cwd = cwd;
      }
      if (timeoutOverridden) {
        message.timeoutMs = timeoutMs;
      }
      socket.write(encodeMessage(message), () => {
        resultSent = true;
      });
    };

    const retry = () => {
      if (!finished) {
        retryTimer = setTimeout(connect, 500);
      }
    };

    const reconnect = (socket: net.Socket) => {
      if (finished || client !== socket) {
        return;
      }
      connected = false;
      resultSent = false;
      client = undefined;
      retry();
    };

    const connect = () => {
      if (finished || connected) {
        return;
      }

      const socket = net.createConnection(socketPath);
      client = socket;

      socket.once("connect", () => {
        connected = true;
        logSender("connect", {
          conversationId,
          source,
          cwd,
          socketPath,
        });
        sendResult(socket);
      });

      decodeLines(socket, ReceiverMessageSchema, (message) => {
        if (message.type === "reply") {
          finish(String(message.value ?? ""));
        } else if (message.type === "error") {
          finish("continue");
        }
      });

      socket.once("close", () => {
        if (!finished) {
          reconnect(socket);
        }
      });

      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (!connected && ["ENOENT", "ECONNREFUSED"].includes(error.code || "")) {
          reconnect(socket);
          return;
        }

        if (connected && ["ECONNRESET", "EPIPE"].includes(error.code || "")) {
          reconnect(socket);
          return;
        }

        fail(new Error(`Failed to contact receiver at ${socketPath}: ${error.message}`));
      });
    };

    connect();
  });
}

export function runSender(options: SenderOptions) {
  waitForSenderReply(options)
    .then((output) => {
      if (options.raw) {
        console.log(output);
      } else {
        process.stdout.write(`${renderMarkdown(output)}\n`);
      }
    })
    .catch((error) => {
      console.error(color.red(error.message));
      process.exitCode = 1;
    });
}

export { waitingForTaskMessage };
