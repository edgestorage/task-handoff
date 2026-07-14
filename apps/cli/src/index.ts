import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SOCKET_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONVERSATION_ID,
  DINGDING_CHAT_ID,
  DINGDING_ALLOWED_USER_IDS,
  DINGDING_CARD_CALLBACK_ROUTE_KEY,
  DINGDING_CARD_TEMPLATE_ID,
  DINGDING_CARD_USER_ID_TYPE,
  DINGDING_CLIENT_ID,
  DINGDING_CLIENT_SECRET,
  DINGDING_CONVERSATION_ID,
  DINGDING_CORP_ID,
  DINGDING_ROBOT_CODE,
  TELEGRAM_CHAT_ID,
  TELEGRAM_ALLOWED_USER_IDS,
  TELEGRAM_CONVERSATION_ID,
  TELEGRAM_TOKEN,
  WECHAT_BASE_URL,
  WECHAT_CHAT_ID,
  WECHAT_CONVERSATION_ID,
  WECHAT_CONTEXT_TOKEN,
  WECHAT_TOKEN,
  WECHAT_UPDATES_BUF,
} from "@task-handoff/core/core/config";
import { runReceiver } from "@task-handoff/receiver-worker/receiver-entry";
import { runSender } from "@task-handoff/protocol/sender";
import { runMcpServer } from "./mcp";
import { runWebServer } from "@task-handoff/controlled-instance/web/server";
import { runControlPlaneServer } from "@task-handoff/control-plane/server";
import { runNodeAgentServer } from "@task-handoff/control-plane/node-agent";
import { runCodexApprovalHook } from "./hooks/codex-approval";
import { runUnifiedInstallAction } from "./hooks/unified-install";
import { parseDuration } from "@task-handoff/core/core/duration";
import { normalizeAttachmentInputs } from "@task-handoff/core/core/attachments";
import { box } from "@task-handoff/terminal-ui";

function parseTimeout(value: string) {
  return parseDuration(value);
}

function parseConversationId(value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Conversation id must be a positive integer.");
  }
  return id;
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port must be a valid TCP port.");
  }
  return port;
}

function parseAuthMode(value: string) {
  if (value !== "disabled" && value !== "password") {
    throw new Error("Auth mode must be disabled or password.");
  }
  return value;
}

function parseNodeAgentConnectionMode(value: string) {
  if (value !== "local-ipc" && value !== "local-loopback") {
    throw new Error("Node agent connection mode must be local-ipc or local-loopback.");
  }
  return value;
}

function defaultNodeAgentEndpoint() {
  const host = process.env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1";
  const port = Number(process.env.TASK_HANDOFF_NODE_AGENT_PORT) || 8091;
  return process.env.TASK_HANDOFF_NODE_AGENT_ENDPOINT || `http://${host}:${port}`;
}

async function createNodeAgentPairingInvite(options: { endpoint: string; token?: string; expiresInMs?: number }) {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const response = await fetch(`${endpoint}/api/node-agent/pairing/invites`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { nodeId?: unknown; joinToken?: unknown; expiresAt?: unknown };
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `Node agent pairing invite failed with HTTP ${response.status}`);
  }
  const joinToken = typeof payload.data?.joinToken === "string" ? payload.data.joinToken : "";
  if (!joinToken) {
    throw new Error("Node agent pairing invite response did not include a join token.");
  }
  return {
    nodeId: typeof payload.data?.nodeId === "string" ? payload.data.nodeId : "",
    joinToken,
    expiresAt: typeof payload.data?.expiresAt === "string" ? payload.data.expiresAt : "",
  };
}

function showDetailedHelp(program: Command) {
  console.log(
    box("task-handoff", [
      "Hand off CLI task results to a receiver, Telegram, and human replies.",
      "Replies are rendered as Markdown by default.",
      "",
      "Common commands:",
      "  task-handoff control-plane",
      "  task-handoff node-agent",
      "  task-handoff node-agent-invite",
      "  task-handoff web",
      "  task-handoff receiver",
      "  task-handoff mcp",
      "  task-handoff install mcp all",
      "  task-handoff install hook codex",
      "  task-handoff codex-approval-hook",
      "  task-handoff claude-approval-hook",
      "  task-handoff send --result \"# Build finished\"",
      "  task-handoff send -c 2 --result \"# Build finished\"",
      "  task-handoff send --raw --result \"# keep markdown literal\"",
      "  task-handoff send \"build finished\"",
      "",
      "Result text supports Markdown. Telegram delivery renders Markdown.",
      "",
      "Receiver commands:",
      "  /conversation use <id>",
      "  /conversation default <id>",
      "  /telegram bind <bot-token> [chat-id]",
      "  /telegram conversation <id>",
      "  /telegram chat <chat-id>",
      "  /telegram status",
      "  /wechat login",
      "  /wechat conversation <id>",
      "  /wechat status",
      "  /timeout 10m",
      "  /timeout reset",
      "  /target **continue**",
      "  /target clear",
      "",
      `Receiver default timeout: ${DEFAULT_TIMEOUT_MS} ms / 1 hour.`,
      "Sender timeout: receiver-controlled unless --timeout is provided.",
      `Default conversation: ${DEFAULT_CONVERSATION_ID}`,
      `Default socket: ${DEFAULT_SOCKET_PATH}`,
    ]),
  );
  console.log("");
  program.helpInformation().trimEnd().split("\n").forEach((line) => console.log(line));
}

function normalizeLegacyArgs(argv: string[]) {
  if (argv[2] === undefined) {
    argv.push("help");
  }
}

async function main() {
  const program = new Command();
  let packageVersion = "unknown";
  try {
    packageVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || packageVersion;
  } catch {
    // Keep the CLI usable when package metadata is unavailable.
  }

  program
    .name("task-handoff")
    .description("Hand off a task result to a long-running receiver and wait for its reply.")
    .version(packageVersion)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ task-handoff control-plane",
        "  $ task-handoff node-agent",
        "  $ task-handoff node-agent-invite",
        "  $ task-handoff web",
        "  $ task-handoff receiver",
        "  $ task-handoff mcp",
        "  $ task-handoff install mcp all",
        "  $ task-handoff install hook codex",
        "  $ task-handoff status mcp all",
        "  $ task-handoff uninstall hook claude",
        "  $ task-handoff codex-approval-hook",
        "  $ task-handoff claude-approval-hook",
        "  $ task-handoff send --result \"build finished\"",
        "  $ task-handoff send -c 2 --result \"build finished\"",
        "  $ task-handoff send \"build finished\"",
        "  $ task-handoff help",
      ].join("\n"),
    );

  program
    .command("send")
    .description("Send a result and wait for a receiver reply.")
    .argument("[result...]", "Markdown result text to send")
    .option("-r, --result <value>", "Markdown result value to send")
    .option("-c, --conversation <id>", "passive conversation id", parseConversationId, DEFAULT_CONVERSATION_ID)
    .option("-t, --timeout <ms>", "sender timeout in milliseconds", parseTimeout)
    .option("-s, --socket <path>", "Unix socket path", DEFAULT_SOCKET_PATH)
    .option("--file <path...>", "file attachment path; sent only when the receiver clicks its button")
    .option("--image <path...>", "image attachment path; sent only when the receiver clicks its button")
    .option("--raw", "print receiver reply without Markdown rendering")
    .action((resultParts: string[], options) => {
      const result = options.result ?? (resultParts.length ? resultParts.join(" ") : undefined);
      const timeoutOverridden = process.argv.includes("--timeout") || process.argv.includes("-t");
      const attachments = normalizeAttachmentInputs([
        ...(options.image || []).map((filePath: string) => ({ kind: "image" as const, path: filePath })),
        ...(options.file || []).map((filePath: string) => ({ kind: "file" as const, path: filePath })),
      ]);
      runSender({
        result,
        socketPath: options.socket,
        conversationId: options.conversation,
        timeoutMs: options.timeout,
        timeoutOverridden,
        raw: options.raw,
        attachments,
      });
    });

  for (const action of ["install", "status", "uninstall"] as const) {
    program
      .command(`${action} <component> [target]`)
      .description(`${action[0].toUpperCase()}${action.slice(1)} task-handoff mcp or hook integration.`)
      .option("--codex-home <path>", "Codex home directory")
      .option("--claude-home <path>", "Claude home directory")
      .option("--name <value>", "MCP server name to manage")
      .option("--command <value>", "hook command to install")
      .action((component: string, target: string | undefined, options) => {
        try {
          runUnifiedInstallAction(action, component, target, {
            codexHome: options.codexHome,
            claudeHome: options.claudeHome,
            name: options.name,
            command: options.command,
          });
        } catch (error: unknown) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      });
  }

  program
    .command("claude-approval-hook")
    .description("Run the Claude Code PermissionRequest hook bridge.")
    .option("-c, --conversation <id>", "passive conversation id", parseConversationId)
    .option("-s, --socket <path>", "Unix socket path", DEFAULT_SOCKET_PATH)
    .option("-t, --timeout <ms>", "sender timeout in milliseconds", parseTimeout)
    .action((options) => {
      void runCodexApprovalHook({
        conversationId: options.conversation,
        socketPath: options.socket,
        timeoutMs: options.timeout,
      });
    });

  program
    .command("codex-approval-hook")
    .description("Run the Codex PermissionRequest hook bridge.")
    .option("-c, --conversation <id>", "passive conversation id", parseConversationId)
    .option("-s, --socket <path>", "Unix socket path", DEFAULT_SOCKET_PATH)
    .option("-t, --timeout <ms>", "sender timeout in milliseconds", parseTimeout)
    .action((options) => {
      void runCodexApprovalHook({
        conversationId: options.conversation,
        socketPath: options.socket,
        timeoutMs: options.timeout,
      });
    });

  program
    .command("mcp")
    .description("Run an MCP stdio server exposing the sender as a tool.")
    .option("-s, --socket <path>", "Unix socket path", DEFAULT_SOCKET_PATH)
    .option("-t, --timeout <ms>", "sender timeout in milliseconds", parseTimeout)
    .action((options) => {
      const timeoutOverridden = process.argv.includes("--timeout") || process.argv.includes("-t");
      runMcpServer({
        socketPath: options.socket,
        timeoutMs: options.timeout,
        timeoutOverridden,
      });
    });

  program
    .command("control-plane")
    .description("Run the TaskHandoff control plane server.")
    .option("--host <host>", "Control plane host", process.env.TASK_HANDOFF_CONTROL_PLANE_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Control plane port", parsePort, Number(process.env.TASK_HANDOFF_CONTROL_PLANE_PORT) || 8081)
    .option("--data-dir <path>", "Control plane data directory")
    .option("--static-dir <path>", "Control plane Web UI static directory")
    .option("--auth-mode <mode>", "Control plane auth mode: disabled or password", parseAuthMode, process.env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "password")
    .action(async (options) => {
      await runControlPlaneServer({
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        staticDir: options.staticDir,
        auth: { mode: options.authMode },
      });
    });

  program
    .command("node-agent")
    .description("Run a node agent that executes controlled instances on this host.")
    .option("--host <host>", "Node agent host", process.env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Node agent port", parsePort, Number(process.env.TASK_HANDOFF_NODE_AGENT_PORT) || 8091)
    .option("--data-dir <path>", "Node agent data directory")
    .option("--token <token>", "Bearer token required by the control plane")
    .option("--connection-mode <mode>", "Local control connection mode: local-ipc or local-loopback", parseNodeAgentConnectionMode)
    .option("--ipc-path <path>", "Unix socket path used when connection mode is local-ipc")
    .option("--control-plane-tunnel-url <url>", "Control plane reverse WebSocket tunnel URL")
    .action(async (options) => {
      await runNodeAgentServer({
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        token: options.token,
        connectionMode: options.connectionMode,
        ipcPath: options.ipcPath,
        controlPlaneTunnelUrl: options.controlPlaneTunnelUrl,
      });
    });

  program
    .command("node-agent-invite")
    .description("Create a one-time join token from a node agent.")
    .option("--endpoint <url>", "Node agent endpoint", defaultNodeAgentEndpoint())
    .option("--token <token>", "Bearer token for local node-agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--expires-in-ms <ms>", "Invite expiry in milliseconds", (value) => {
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms <= 0) {
        throw new Error("Expiry must be a positive integer.");
      }
      return ms;
    })
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const invite = await createNodeAgentPairingInvite({
        endpoint: options.endpoint,
        token: options.token,
        expiresInMs: options.expiresInMs,
      });
      if (options.json) {
        console.log(JSON.stringify(invite, null, 2));
        return;
      }
      if (invite.nodeId) {
        console.log(`Node: ${invite.nodeId}`);
      }
      console.log(`Join token: ${invite.joinToken}`);
      if (invite.expiresAt) {
        console.log(`Expires: ${invite.expiresAt}`);
      }
    });

  program
    .command("web")
    .description("Run the TaskHandoff web server.")
    .option("--host <host>", "Web server host", process.env.TASK_HANDOFF_WEB_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Web server port", parsePort, Number(process.env.TASK_HANDOFF_WEB_PORT) || 8080)
    .option("--static-dir <path>", "Web UI static directory")
    .action(async (options) => {
      await runWebServer({
        host: options.host,
        port: options.port,
        staticDir: options.staticDir,
      });
    });

  program
    .command("receiver")
    .description("Run the long-running receiver.")
    .option("-s, --socket <path>", "Unix socket path", DEFAULT_SOCKET_PATH)
    .option("--telegram-token <token>", "Telegram bot token", TELEGRAM_TOKEN)
    .option("--telegram-chat-id <id>", "Telegram target chat id", TELEGRAM_CHAT_ID)
    .option("--telegram-allowed-user-ids <ids>", "Comma-separated Telegram user ids allowed to control the bot", TELEGRAM_ALLOWED_USER_IDS.join(","))
    .option("--telegram-conversation <id>", "Telegram passive conversation id", parseConversationId, TELEGRAM_CONVERSATION_ID)
    .option("--wechat-token <token>", "Wechat iLink bot token", WECHAT_TOKEN)
    .option("--wechat-base-url <url>", "Wechat iLink base URL", WECHAT_BASE_URL)
    .option("--wechat-chat-id <id>", "Wechat target chat id", WECHAT_CHAT_ID)
    .option("--wechat-conversation <id>", "Wechat passive conversation id", parseConversationId, WECHAT_CONVERSATION_ID)
    .option("--wechat-context-token <token>", "Wechat conversation context token", WECHAT_CONTEXT_TOKEN)
    .option("--wechat-updates-buf <cursor>", "Wechat getupdates cursor", WECHAT_UPDATES_BUF)
    .option("--dingding-client-id <id>", "DingDing stream client id", DINGDING_CLIENT_ID)
    .option("--dingding-client-secret <secret>", "DingDing stream client secret", DINGDING_CLIENT_SECRET)
    .option("--dingding-corp-id <id>", "DingDing corp id", DINGDING_CORP_ID)
    .option("--dingding-robot-code <code>", "DingDing robot code", DINGDING_ROBOT_CODE)
    .option("--dingding-card-template-id <id>", "DingDing interactive card template id", DINGDING_CARD_TEMPLATE_ID)
    .option("--dingding-card-callback-route-key <key>", "DingDing interactive card callback route key", DINGDING_CARD_CALLBACK_ROUTE_KEY)
    .option("--dingding-card-user-id-type <type>", "DingDing interactive card user id type", Number, DINGDING_CARD_USER_ID_TYPE)
    .option("--dingding-chat-id <id>", "DingDing target conversation id", DINGDING_CHAT_ID)
    .option("--dingding-allowed-user-ids <ids>", "Comma-separated DingDing user ids allowed to control the bot", DINGDING_ALLOWED_USER_IDS.join(","))
    .option("--dingding-conversation <id>", "DingDing passive conversation id", parseConversationId, DINGDING_CONVERSATION_ID)
    .option("--headless", "Run receiver without interactive terminal input.")
    .action(async (options) => {
      await runReceiver({
        socketPath: options.socket,
        telegramToken: options.telegramToken,
        telegramChatId: options.telegramChatId,
        telegramAllowedUserIds: options.telegramAllowedUserIds,
        telegramConversationId: options.telegramConversation,
        wechatToken: options.wechatToken,
        wechatBaseUrl: options.wechatBaseUrl,
        wechatChatId: options.wechatChatId,
        wechatConversationId: options.wechatConversation,
        wechatContextToken: options.wechatContextToken,
        wechatUpdatesBuf: options.wechatUpdatesBuf,
        dingdingClientId: options.dingdingClientId,
        dingdingClientSecret: options.dingdingClientSecret,
        dingdingCorpId: options.dingdingCorpId,
        dingdingRobotCode: options.dingdingRobotCode,
        dingdingCardTemplateId: options.dingdingCardTemplateId,
        dingdingCardCallbackRouteKey: options.dingdingCardCallbackRouteKey,
        dingdingCardUserIdType: options.dingdingCardUserIdType,
        dingdingChatId: options.dingdingChatId,
        dingdingAllowedUserIds: options.dingdingAllowedUserIds,
        dingdingConversationId: options.dingdingConversation,
        headless: options.headless,
      });
    });

  program
    .command("help")
    .description("Show detailed help.")
    .action(() => {
      showDetailedHelp(program);
    });

  normalizeLegacyArgs(process.argv);
  await program.parseAsync(process.argv);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
