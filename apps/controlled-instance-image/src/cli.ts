import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SOCKET_PATH,
  DINGDING_ALLOWED_USER_IDS,
  DINGDING_CARD_CALLBACK_ROUTE_KEY,
  DINGDING_CARD_TEMPLATE_ID,
  DINGDING_CARD_USER_ID_TYPE,
  DINGDING_CHAT_ID,
  DINGDING_CLIENT_ID,
  DINGDING_CLIENT_SECRET,
  DINGDING_CONVERSATION_ID,
  DINGDING_CORP_ID,
  DINGDING_ROBOT_CODE,
  TELEGRAM_ALLOWED_USER_IDS,
  TELEGRAM_CHAT_ID,
  TELEGRAM_CONVERSATION_ID,
  TELEGRAM_TOKEN,
  WECHAT_BASE_URL,
  WECHAT_CHAT_ID,
  WECHAT_CONTEXT_TOKEN,
  WECHAT_CONVERSATION_ID,
  WECHAT_TOKEN,
  WECHAT_UPDATES_BUF,
} from "@task-handoff/core/core/config";
import { runWebServer } from "@task-handoff/controlled-instance/web/server";
import { runReceiver } from "@task-handoff/receiver-worker/receiver-entry";

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

function normalizeArgs(argv: string[]) {
  if (argv[2] === undefined) {
    argv.push("web");
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  process.env.TASK_HANDOFF_CLI_PATH ||= __filename;
  const program = new Command();

  program.name("task-handoff-controlled-instance").description("Run a TaskHandoff controlled instance.").version(packageVersion());

  program
    .command("web")
    .description("Run the controlled instance web server.")
    .option("--host <host>", "Web server host", process.env.TASK_HANDOFF_WEB_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Web server port", parsePort, Number(process.env.TASK_HANDOFF_WEB_PORT) || 8080)
    .option("-s, --socket <path>", "Unix socket path", DEFAULT_SOCKET_PATH)
    .option(
      "--static-dir <path>",
      "Web UI static directory",
      process.env.TASK_HANDOFF_WEB_STATIC_DIR || path.resolve(__dirname, "..", "ui"),
    )
    .option("--receiver-auto-start", "Start the receiver runtime with the web server.")
    .action(async (options) => {
      await runWebServer({
        host: options.host,
        port: options.port,
        socketPath: options.socket,
        staticDir: options.staticDir,
        receiverAutoStart: options.receiverAutoStart,
      });
    });

  program
    .command("receiver")
    .description("Run the controlled instance receiver.")
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

  normalizeArgs(process.argv);
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
