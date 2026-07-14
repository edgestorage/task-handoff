import os from "node:os";
import path from "node:path";
import { CONFIG_PATH, loadSettings } from "./persistence";

const settings = loadSettings();

export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_CONVERSATION_ID = Number(settings.defaultConversationId) || 1;
export const AUTO_TARGET_SAFETY_MS = 250;
export const DEFAULT_SOCKET_PATH =
  process.env.TASK_HANDOFF_SOCKET ||
  path.join(os.tmpdir(), `task-handoff-${process.getuid ? process.getuid() : "user"}.sock`);

export {
  CONFIG_PATH,
};

const telegramTool = settings.chatTools?.telegram?.default || {};
const telegramChatId = telegramTool.defaultChatId;
const telegramBinding = telegramChatId ? settings.chatBindings?.telegram?.default?.[telegramChatId] : undefined;

function parseList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const TELEGRAM_CHAT_ID = telegramChatId;
export const TELEGRAM_TOKEN = telegramTool.token;
export const TELEGRAM_ALLOWED_USER_IDS = parseList(telegramTool.allowedUserIds);
export const TELEGRAM_CONVERSATION_ID = Number(telegramBinding?.conversationId) || DEFAULT_CONVERSATION_ID;
const wechatSettings = settings.wechat || {};

export const WECHAT_BASE_URL = wechatSettings.baseUrl;
export const WECHAT_CHAT_ID = wechatSettings.chatId;
export const WECHAT_CONTEXT_TOKEN = wechatSettings.contextToken;
export const WECHAT_TOKEN = wechatSettings.token;
export const WECHAT_UPDATES_BUF = wechatSettings.updatesBuf;
export const WECHAT_CONVERSATION_ID = Number(wechatSettings.conversationId) || DEFAULT_CONVERSATION_ID;

const dingdingTool = settings.chatTools?.dingding?.default || {};
const dingdingChatId = dingdingTool.defaultChatId;
const dingdingBinding = dingdingChatId ? settings.chatBindings?.dingding?.default?.[dingdingChatId] : undefined;

export const DINGDING_CLIENT_ID = dingdingTool.clientId;
export const DINGDING_CLIENT_SECRET = dingdingTool.clientSecret;
export const DINGDING_CORP_ID = dingdingTool.corpId;
export const DINGDING_ROBOT_CODE = dingdingTool.robotCode;
export const DINGDING_CARD_TEMPLATE_ID =
  dingdingTool.cardTemplateId ||
  "13fc6717-12e4-43ed-8533-111a310d4995.schema";
export const DINGDING_CARD_CALLBACK_ROUTE_KEY =
  dingdingTool.cardCallbackRouteKey ||
  "bi_workflow_ticket";
export const DINGDING_CARD_USER_ID_TYPE = Number(dingdingTool.cardUserIdType) || 1;
export const DINGDING_CHAT_ID = dingdingChatId;
export const DINGDING_ALLOWED_USER_IDS = parseList(dingdingTool.allowedUserIds);
export const DINGDING_CONVERSATION_ID = Number(dingdingBinding?.conversationId) || DEFAULT_CONVERSATION_ID;
