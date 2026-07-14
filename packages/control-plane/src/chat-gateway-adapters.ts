import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { AiSessionMessageAttachment } from "@task-handoff/protocol/ai-sessions";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInlineKeyboard, inlineKeyboardToActions } from "@task-handoff/core/core/chat-interactions";
import type { ChatInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import { renderTelegramProgressText } from "@task-handoff/core/core/chat-render";
import { TelegramProgressStore } from "@task-handoff/core/core/telegram-progress";
import { downloadTelegramFile, telegramImageAttachments } from "@task-handoff/core/core/telegram-images";
import { sendTelegramMessage, telegramFileLink, type TelegramMessageOptions } from "./telegram-gateway.ts";

export type ChatGatewayAdapterContext = {
  fetchImpl: typeof fetch;
};

export type ChatGatewaySendOptions = {
  replyMarkup?: ChatInlineKeyboard;
  replyToMessageId?: number;
  rawMarkdownV2?: boolean;
  parseMode?: "MarkdownV2" | "Markdown";
  sessionWebhook?: string;
  senderId?: string;
  contextToken?: string;
};

export type ChatGatewaySentMessage = {
  provider: string;
  raw?: unknown;
  messageId?: number;
  interactionId?: string;
};

export type ChatGatewayActionContext = {
  bridgeId: string;
  chatId: string;
  userId?: string;
  actionId?: string;
  interactionId?: string;
  raw?: unknown;
};

export type ChatGatewayActionResult = {
  callbackData?: string;
  response?: unknown;
  context: ChatGatewayActionContext;
};

export type ChatGatewayIncomingMessage = {
  chatId: string;
  userId?: string;
  text: string;
  contextToken?: string;
  sessionWebhook?: string;
  senderId?: string;
};

export type DingdingConversationType = "IM_GROUP" | "IM_SINGLE" | "IM_ROBOT";

export type DingdingRobotEvent = ChatGatewayIncomingMessage & {
  senderId?: string;
  sessionWebhook?: string;
  conversationType?: DingdingConversationType;
  raw: Record<string, unknown>;
};

export type DingdingCardEvent = {
  userId?: string;
  chatId: string;
  senderId?: string;
  deliverySenderId?: string;
  sessionWebhook?: string;
  conversationType?: DingdingConversationType;
  callbackData: string;
  body: Record<string, unknown>;
  params: Record<string, unknown>;
};

export type TelegramCallbackEvent = {
  updateId?: number;
  callbackQuery: Record<string, unknown>;
};

export type TelegramMessageEvent = ChatGatewayIncomingMessage & {
  updateId?: number;
  message: Record<string, unknown>;
  messageId?: number;
  replyToMessageId?: number;
  quoteText?: string;
  autoBegin?: boolean;
  rawText: string;
  hasSingleImageWithoutText: boolean;
};

export type TelegramPollResult = {
  updates: Array<TelegramCallbackEvent | TelegramMessageEvent>;
  conflict?: string;
};

export type ChatGatewayCallbackAction =
  | { type: "ai-session"; index: number }
  | { type: "instance-app-menu"; instanceId: string }
  | { type: "launch-app"; instanceId: string; appId: string }
  | { type: "pending-decision"; routeId: string; decision: "allow" | "deny" | "skip" };

export type ChatGatewayTokenResolver = (
  token: string,
  expectedType: "instance-app-menu" | "launch-app" | "pending-decision",
) => { instanceId?: string; appId?: string; routeId?: string; decision?: unknown };

export type ChatGatewayAdapterRuntime = {
  bridge: ChatBridgeConfig;
  start?: () => void | Promise<void>;
  stop?: () => void;
  send: (chatId: string, text: string, options?: ChatGatewaySendOptions) => Promise<ChatGatewaySentMessage | undefined>;
  edit?: (chatId: string, messageId: number, text: string, options?: ChatGatewaySendOptions) => Promise<unknown>;
  delete?: (chatId: string, messageId: number) => Promise<unknown>;
  answerAction?: (actionContext: ChatGatewayActionContext, text: string) => Promise<unknown>;
};

export type ChatGatewayProgressUpdate = {
  bridge: ChatBridgeConfig;
  key: string;
  chatId: string;
  text: string;
  actionRows?: Array<Array<{ text: string; callbackData: string }>>;
  replyMarkup?: ChatInlineKeyboard;
  dingdingRuntime?: DingdingRuntimeState;
};

export type ChatGatewayProgressStore = {
  applyUpdate: (input: ChatGatewayProgressUpdate) => Promise<boolean>;
};

type TelegramProgressRoute = { bridgeId: string; chatId: string };

export class TelegramProgressAdapter implements ChatGatewayProgressStore {
  readonly store: TelegramProgressStore<TelegramProgressRoute>;

  constructor(options: {
    updateIntervalMs?: number;
    requireBridge: (id: string) => ChatBridgeConfig;
    send: (bridge: ChatBridgeConfig, chatId: string, text: string, options?: TelegramMessageOptions) => Promise<unknown>;
    edit: (bridge: ChatBridgeConfig, chatId: string, messageId: number, text: string, options?: TelegramMessageOptions) => Promise<unknown>;
    deleteMessage: (bridge: ChatBridgeConfig, chatId: string, messageId: number) => Promise<unknown>;
    onLog?: (message: string) => void;
  }) {
    this.store = new TelegramProgressStore<TelegramProgressRoute>({
      updateIntervalMs: options.updateIntervalMs,
      send: (text, route, progressOptions) => options.send(options.requireBridge(route?.bridgeId || ""), route?.chatId || "", renderTelegramProgressText(text), {
        rawMarkdownV2: true,
        replyMarkup: progressReplyMarkup(progressOptions),
      }),
      edit: (messageId, text, route, progressOptions) => options.edit(options.requireBridge(route?.bridgeId || ""), route?.chatId || "", messageId, renderTelegramProgressText(text), {
        rawMarkdownV2: true,
        replyMarkup: progressReplyMarkup(progressOptions),
      }),
      delete: (messageId, route) => options.deleteMessage(options.requireBridge(route?.bridgeId || ""), route?.chatId || "", messageId),
      onLog: options.onLog,
    });
  }

  get entries() {
    return this.store.entries;
  }

  remember(key: string, messageId: number, text: string, route: TelegramProgressRoute) {
    return this.store.remember(key, messageId, text, route);
  }

  rekey(currentKey: string, nextKey: string) {
    return this.store.rekey(currentKey, nextKey);
  }

  delete(key: string) {
    return this.store.delete(key);
  }

  async applyUpdate(input: ChatGatewayProgressUpdate) {
    return this.store.applyUpdate(input.key, input.text, { bridgeId: input.bridge.id, chatId: input.chatId }, { actionRows: input.actionRows });
  }
}

export function parseChatGatewayCallbackAction(data: string, resolveToken: ChatGatewayTokenResolver): ChatGatewayCallbackAction | undefined {
  const sessionMatch = data.match(/^task_handoff:cp_session:(\d+)$/);
  if (sessionMatch) {
    return {
      type: "ai-session",
      index: Number(sessionMatch[1]),
    };
  }
  const instanceAppsMatch = data.match(/^task_handoff:cp_i:([^:]+)$/) || data.match(/^task_handoff:cp_instance_apps:([^:]+)$/);
  if (instanceAppsMatch) {
    if (instanceAppsMatch[0].startsWith("task_handoff:cp_i:")) {
      const action = resolveToken(instanceAppsMatch[1], "instance-app-menu");
      return {
        type: "instance-app-menu",
        instanceId: requireTokenField(action.instanceId, "instanceId"),
      };
    }
    return {
      type: "instance-app-menu",
      instanceId: decodeChatCallbackPart(instanceAppsMatch[1]),
    };
  }
  const launchAppMatch = data.match(/^task_handoff:cp_a:([^:]+)$/) || data.match(/^task_handoff:cp_launch_app:([^:]+):([^:]+)$/);
  if (launchAppMatch) {
    if (launchAppMatch[0].startsWith("task_handoff:cp_a:")) {
      const action = resolveToken(launchAppMatch[1], "launch-app");
      return {
        type: "launch-app",
        instanceId: requireTokenField(action.instanceId, "instanceId"),
        appId: requireTokenField(action.appId, "appId"),
      };
    }
    return {
      type: "launch-app",
      instanceId: decodeChatCallbackPart(launchAppMatch[1]),
      appId: decodeChatCallbackPart(launchAppMatch[2]),
    };
  }
  const approvalTokenMatch = data.match(/^task_handoff:cp_p:([^:]+)$/);
  if (approvalTokenMatch) {
    const action = resolveToken(approvalTokenMatch[1], "pending-decision");
    return {
      type: "pending-decision",
      routeId: requireTokenField(action.routeId, "routeId"),
      decision: requireTokenDecision(action.decision),
    };
  }
  const approvalMatch = data.match(/^task_handoff:approval:([^:]+:ai:[^:]+):(allow|deny|skip)$/);
  if (approvalMatch) {
    return {
      type: "pending-decision",
      routeId: approvalMatch[1],
      decision: approvalMatch[2] as "allow" | "deny" | "skip",
    };
  }
  return undefined;
}

function requireTokenField(value: unknown, fieldName: string) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throwInvalidChatActionToken(`Chat action token is missing ${fieldName}.`);
}

function requireTokenDecision(value: unknown): "allow" | "deny" | "skip" {
  if (value === "allow" || value === "deny" || value === "skip") {
    return value;
  }
  throwInvalidChatActionToken("Chat action token has an invalid decision.");
}

function throwInvalidChatActionToken(message: string): never {
  const error = new Error(message);
  Object.assign(error, { statusCode: 400, code: "CHAT_ACTION_TOKEN_INVALID" });
  throw error;
}

export type DingdingClientLike = {
  connect: () => Promise<unknown>;
  disconnect: () => void;
  registerCallbackListener: (topic: string, listener: (message: unknown) => void) => void;
  socketCallBackResponse: (messageId: string, response: unknown) => void;
};

export type DingdingRuntimeState = {
  client: DingdingClientLike;
  chatWebhooks: Map<string, string>;
  senderIds: Map<string, string>;
  conversationTypes: Map<string, DingdingConversationType>;
  accessToken?: { value: string; expiresAt: number };
  onLog?: (level: "info" | "warn", data: Record<string, unknown>, message: string) => void;
};

type DingdingProgressEntry = {
  bridgeId: string;
  outTrackId?: string;
  delivered?: boolean;
  lastText: string;
  lastActionsFingerprint: string;
  lastUpdateAt: number;
  pending?: Promise<unknown>;
  pendingText?: string;
  pendingReplyMarkup?: ChatInlineKeyboard;
  timer?: ReturnType<typeof setTimeout>;
  cancelPending?: (error: Error) => void;
};

const DINGDING_PROGRESS_UPDATE_MS = 1000;

export class DingdingProgressStore implements ChatGatewayProgressStore {
  readonly entries = new Map<string, DingdingProgressEntry>();
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }

  clear() {
    this.clearEntries(() => true);
  }

  clearBridge(bridgeId: string) {
    this.clearEntries((entry) => entry.bridgeId === bridgeId);
  }

  private clearEntries(matches: (entry: DingdingProgressEntry) => boolean) {
    for (const [key, entry] of this.entries) {
      if (!matches(entry)) {
        continue;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.cancelPending?.(new Error("DingDing progress update was cancelled."));
      this.entries.delete(key);
    }
  }

  async applyUpdate(input: ChatGatewayProgressUpdate) {
    const runtime = input.dingdingRuntime;
    if (!runtime) {
      return false;
    }
    const nextActionsFingerprint = dingdingActionsFingerprint(input.replyMarkup);
    let existing = this.entries.get(input.key);
    if (existing?.pending) {
      await existing.pending;
    }
    existing = this.entries.get(input.key);
    if (existing?.outTrackId) {
      if (existing.lastText === input.text && existing.lastActionsFingerprint === nextActionsFingerprint) {
        return true;
      }
      const elapsed = Date.now() - (existing.lastUpdateAt || 0);
      if (elapsed < DINGDING_PROGRESS_UPDATE_MS) {
        existing.pendingText = input.text;
        existing.pendingReplyMarkup = input.replyMarkup;
        if (!existing.timer) {
          existing.pending = new Promise((resolve, reject) => {
            existing.cancelPending = reject;
            existing.timer = setTimeout(() => {
              existing.timer = undefined;
              existing.cancelPending = undefined;
              const nextText = existing.pendingText;
              const nextReplyMarkup = existing.pendingReplyMarkup;
              existing.pendingText = undefined;
              existing.pendingReplyMarkup = undefined;
              if (!nextText) {
                resolve(undefined);
                return;
              }
              this.updateExistingEntry(input, existing, nextText, nextReplyMarkup, dingdingActionsFingerprint(nextReplyMarkup)).then(resolve, reject);
            }, DINGDING_PROGRESS_UPDATE_MS - elapsed);
          }).finally(() => {
            existing.pending = undefined;
            existing.timer = undefined;
            existing.cancelPending = undefined;
          });
        }
        await existing.pending;
        return this.entries.has(input.key);
      }
      await this.updateExistingEntry(input, existing, input.text, input.replyMarkup, nextActionsFingerprint);
      return true;
    }
    const entry: DingdingProgressEntry = { bridgeId: input.bridge.id, lastText: input.text, lastActionsFingerprint: nextActionsFingerprint, lastUpdateAt: Date.now() };
    entry.pending = sendDingdingActionsCard({
      fetchImpl: this.fetchImpl,
      bridge: input.bridge,
      runtime,
      chatId: input.chatId,
      text: input.text,
      replyMarkup: input.replyMarkup,
      sessionWebhook: runtime.chatWebhooks.get(input.chatId) || stringSetting(input.bridge.settings.sessionWebhook),
      senderId: runtime.senderIds.get(input.chatId) || stringSetting(input.bridge.settings.senderId),
      title: "TaskHandoff 执行中",
      step: "progress",
      forceCard: true,
    }).then((result) => {
      if (result?.outTrackId) {
        entry.outTrackId = result.outTrackId;
      }
      if (result?.delivered) {
        entry.delivered = true;
        entry.lastUpdateAt = Date.now();
      }
    }).catch((error) => {
      this.entries.delete(input.key);
      throw error;
    }).finally(() => {
      entry.pending = undefined;
    });
    this.entries.set(input.key, entry);
    await entry.pending;
    return Boolean(entry.delivered);
  }

  private async updateExistingEntry(
    input: ChatGatewayProgressUpdate,
    entry: DingdingProgressEntry,
    text: string,
    replyMarkup: ChatInlineKeyboard | undefined,
    actionsFingerprint: string,
  ) {
    const runtime = input.dingdingRuntime;
    if (!runtime || !entry.outTrackId) {
      return;
    }
    await updateDingdingActionsCard({
      fetchImpl: this.fetchImpl,
      bridge: input.bridge,
      runtime,
      outTrackId: entry.outTrackId,
      text,
      replyMarkup,
      title: "TaskHandoff 执行中",
      step: "progress",
    });
    entry.lastText = text;
    entry.lastActionsFingerprint = actionsFingerprint;
    entry.lastUpdateAt = Date.now();
  }
}

export function createChatGatewaySendAdapter(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  dingdingRuntime?: DingdingRuntimeState;
}): Pick<ChatGatewayAdapterRuntime, "bridge" | "send"> {
  const { fetchImpl, bridge, dingdingRuntime } = input;
  if (bridge.channel === "telegram") {
    return {
      bridge,
      send: async (chatId, text, options = {}) => {
        const raw = await sendTelegramMessage(fetchImpl, bridge, chatId, text, {
          replyMarkup: options.replyMarkup,
          replyToMessageId: options.replyToMessageId,
          rawMarkdownV2: options.rawMarkdownV2,
          parseMode: options.parseMode,
        });
        return {
          provider: "telegram",
          raw,
          messageId: Number(asRecord(raw).message_id) || undefined,
        };
      },
    };
  }
  if (bridge.channel === "dingding") {
    return {
      bridge,
      send: async (chatId, text, options = {}) => {
        const sessionWebhook = options.sessionWebhook || dingdingRuntime?.chatWebhooks.get(chatId) || stringSetting(bridge.settings.sessionWebhook);
        if (options.replyMarkup && dingdingRuntime) {
          const result = await sendDingdingActionsCard({
            fetchImpl,
            bridge,
            runtime: dingdingRuntime,
            chatId,
            text,
            replyMarkup: options.replyMarkup,
            sessionWebhook,
            senderId: options.senderId || dingdingRuntime.senderIds.get(chatId) || stringSetting(bridge.settings.senderId),
          });
          if (result?.delivered) {
            return { provider: "dingding", interactionId: result.outTrackId };
          }
        }
        if (sessionWebhook) {
          await sendDingdingWebhook(fetchImpl, sessionWebhook, text, dingdingRuntime?.onLog);
          return { provider: "dingding" };
        }
        return undefined;
      },
    };
  }
  if (bridge.channel === "wechat") {
    return {
      bridge,
      send: async (chatId, text, options = {}) => {
        const contextToken = options.contextToken || stringSetting(bridge.settings.contextToken);
        if (!contextToken) {
          return undefined;
        }
        await sendWechatMessage(fetchImpl, bridge, chatId, contextToken, text);
        return { provider: "wechat" };
      },
    };
  }
  return {
    bridge,
    send: async () => undefined,
  };
}

export async function pollTelegramUpdates(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  offset?: number;
}) {
  const params = new URLSearchParams({
    timeout: "0",
    ...(input.offset ? { offset: String(input.offset + 1) } : {}),
  });
  const response = await input.fetchImpl(`https://api.telegram.org/bot${input.bridge.token}/getUpdates?${params.toString()}`);
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: Array<Record<string, unknown>>; description?: string };
  if (!response.ok || payload.ok === false) {
    if (response.status === 409 || /terminated by other getUpdates request/i.test(String(payload.description || ""))) {
      return {
        updates: [],
        conflict: payload.description || "Telegram getUpdates conflict: another bot instance is polling this token.",
      } satisfies TelegramPollResult;
    }
    throw new Error(payload.description || `Telegram getUpdates failed with HTTP ${response.status}`);
  }
  const updates: TelegramPollResult["updates"] = [];
  for (const update of payload.result || []) {
    const updateId = Number(update.update_id);
    const normalizedUpdateId = Number.isInteger(updateId) ? updateId : undefined;
    const callbackQuery = asRecord(update.callback_query);
    if (Object.keys(callbackQuery).length > 0) {
      updates.push({ updateId: normalizedUpdateId, callbackQuery });
      continue;
    }
    const message = asRecord(update.message || update.edited_message);
    if (Object.keys(message).length === 0) {
      continue;
    }
    const chat = asRecord(message.chat);
    const from = asRecord(message.from);
    const chatId = chat.id !== undefined ? String(chat.id) : input.bridge.defaultChatId;
    const userId = from.id !== undefined ? String(from.id) : undefined;
    if (!chatId) {
      continue;
    }
    const rawText = stringSetting(message.text ?? message.caption);
    const imageAttachments = telegramImageAttachments(message);
    if (!rawText && imageAttachments.length === 0) {
      continue;
    }
    updates.push({
      updateId: normalizedUpdateId,
      chatId,
      userId,
      text: rawText,
      rawText,
      message,
      messageId: messageIdFromTelegramMessage(message),
      replyToMessageId: messageIdFromTelegramMessage(asRecord(message.reply_to_message)),
      quoteText: stringSetting(asRecord(message.quote).text),
      autoBegin: imageAttachments.length === 1 && !rawText.trim(),
      hasSingleImageWithoutText: imageAttachments.length === 1 && !rawText.trim(),
    });
  }
  return { updates } satisfies TelegramPollResult;
}

export async function telegramMessageAttachmentsWithDownloadedImages(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  message: Record<string, unknown>;
  onImageDownloadError?: (data: { fileId: string; fileName?: string; error: unknown }) => void;
}) {
  const imagePaths = await downloadedTelegramImagePaths(input.fetchImpl, input.bridge, input.message, input.onImageDownloadError);
  return imagePaths.map((filePath, index): AiSessionMessageAttachment => {
    const bytes = fs.readFileSync(filePath);
    return {
      id: `tg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      kind: "image",
      name: path.basename(filePath) || `telegram-image-${index + 1}`,
      mime: mimeForImagePath(filePath),
      size: bytes.length,
      data: bytes.toString("base64"),
    };
  });
}

function mimeForImagePath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

export async function pollWechatMessages(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  cursor?: string;
}) {
  const settings = input.bridge.settings || {};
  const baseUrl = stringSetting(settings.baseUrl) || `https://ilinkai.${"wei"}${"xin"}.qq.com`;
  const response = await input.fetchImpl(`${baseUrl}/ilink/bot/getupdates`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${input.bridge.token}`,
      "X-WECHAT-UIN": String(Math.floor(Math.random() * 2 ** 31)),
    },
    body: JSON.stringify({
      get_updates_buf: input.cursor,
      base_info: { channel_version: "1.0.2" },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const errcode = Number(payload.errcode ?? payload.ret ?? 0);
  if (errcode !== 0) {
    throw new Error(stringSetting(payload.errmsg || payload.msg) || `chat bridge API returned ${errcode}`);
  }
  const messages: ChatGatewayIncomingMessage[] = [];
  for (const value of Array.isArray(payload.msgs) ? payload.msgs : []) {
    const message = asRecord(value);
    if (message.message_type !== 1) {
      continue;
    }
    const chatId = stringSetting(message.from_user_id);
    const text = wechatText(message);
    if (!chatId || !text) {
      continue;
    }
    messages.push({
      chatId,
      text,
      contextToken: stringSetting(message.context_token),
    });
  }
  return {
    cursor: stringSetting(payload.get_updates_buf),
    messages,
  };
}

export function markdownTitle(text: string) {
  const line = String(text || "").split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim();
  return line.slice(0, 20) || "消息通知";
}

export function jsonValuesToString(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : JSON.stringify(item)]));
}

export function dingdingOpenSpaceIdIMGroup(openConversationId: string) {
  return `dtv1.card//IM_GROUP.${openConversationId}`;
}

export function dingdingOpenSpaceIdIMSingle(openConversationId: string) {
  return `dtv1.card//IM_SINGLE.${openConversationId}`;
}

export function dingdingOpenSpaceIdIMRobot(senderId: string) {
  return `dtv1.card//IM_ROBOT.${senderId}`;
}

export function dingdingChatIdFromCardCallback(body: Record<string, unknown>, params: Record<string, unknown>) {
  const direct = stringSetting(params.biz_conversation_id).trim();
  if (direct) {
    return direct;
  }
  return stringSetting(body.spaceId).replace(/^dtv1\.card\/\/(?:IM_GROUP|IM_SINGLE|IM_ROBOT)\./, "");
}

function dingdingConversationType(value: unknown, options: { robotMessage?: boolean } = {}): DingdingConversationType | undefined {
  const type = stringSetting(value).trim().toUpperCase();
  if (type === "2" || type === "IM_GROUP") {
    return "IM_GROUP";
  }
  if (type === "1" || type === "IM_SINGLE") {
    return options.robotMessage ? "IM_ROBOT" : "IM_SINGLE";
  }
  if (type === "IM_ROBOT") {
    return "IM_ROBOT";
  }
  return undefined;
}

export function dingdingCallbackData(actionId: string) {
  if (actionId.startsWith("task_handoff:")) {
    return actionId;
  }
  if (!actionId.startsWith("th_cb_")) {
    return "";
  }
  try {
    return Buffer.from(actionId.slice("th_cb_".length), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

export function dingdingCardUpdateResponse(description: string, replyMarkup: ChatInlineKeyboard | undefined, step: string, body: Record<string, unknown>, params: Record<string, unknown>) {
  const chatId = dingdingChatIdFromCardCallback(body, params);
  return {
    cardUpdateOptions: { updateCardDataByKey: true, updatePrivateDataByKey: false },
    cardData: {
      cardParamMap: jsonValuesToString({
        type: "actions",
        title: "TaskHandoff",
        description,
        list: inlineKeyboardToActions(replyMarkup),
        biz_out_track_id: body.outTrackId || params.biz_out_track_id || "",
        biz_conversation_id: chatId,
        biz_sender_id: params.biz_sender_id || body.userId || "",
        biz_session_webhook: params.biz_session_webhook || "",
        biz_conversation_type: params.biz_conversation_type || "",
        biz_step: step,
        error_msg: "",
      }),
    },
  };
}

export function parseDingdingRobotEvent(data: unknown): DingdingRobotEvent | undefined {
  const body = parseJsonRecord(data);
  const chatId = stringSetting(body.conversationId);
  const text = stringSetting(asRecord(body.text).content).trim();
  if (!chatId || !text) {
    return undefined;
  }
  const senderId = stringSetting(body.senderStaffId || body.senderId);
  return {
    chatId,
    userId: senderId || undefined,
    senderId: senderId || undefined,
    sessionWebhook: stringSetting(body.sessionWebhook) || undefined,
    conversationType: dingdingConversationType(body.conversationType, { robotMessage: true }),
    text,
    raw: body,
  };
}

export function parseDingdingCardEvent(data: unknown): DingdingCardEvent {
  const body = parseJsonRecord(data);
  const cardActionData = recordSetting(body.cardActionData || body.content);
  const privateData = recordSetting(cardActionData.cardPrivateData || body.cardPrivateData || body.content);
  const params = recordSetting(privateData.params || cardActionData.params || body.params);
  const userId = stringSetting(body.userId);
  const deliverySenderId = stringSetting(params.biz_sender_id);
  return {
    userId: userId || undefined,
    chatId: dingdingChatIdFromCardCallback(body, params),
    senderId: userId || undefined,
    deliverySenderId: deliverySenderId || undefined,
    sessionWebhook: stringSetting(params.biz_session_webhook) || undefined,
    conversationType: dingdingConversationType(params.biz_conversation_type || body.conversationType || body.conversation_type),
    callbackData: dingdingCallbackData(dingdingSelectedActionId(body, cardActionData, privateData)),
    body,
    params,
  };
}

function dingdingSelectedActionId(body: Record<string, unknown>, cardActionData: Record<string, unknown>, privateData: Record<string, unknown>) {
  const candidates: string[] = [];
  appendDingdingActionIdCandidates(candidates, privateData);
  appendDingdingActionIdCandidates(candidates, cardActionData);
  appendDingdingActionIdCandidates(candidates, body);
  return candidates.find((candidate) => dingdingCallbackData(candidate)) || "";
}

function appendDingdingActionIdCandidates(candidates: string[], record: Record<string, unknown>) {
  for (const key of ["actionIdList", "actionIds"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      candidates.push(...value.map((item) => stringSetting(item)).filter(Boolean));
    }
  }
  for (const key of ["actionId", "action_id", "id", "actionValue"]) {
    const value = stringSetting(record[key]);
    if (value) {
      candidates.push(value);
    }
  }
}

export async function sendDingdingWebhook(fetchImpl: typeof fetch, sessionWebhook: string, text: string, onLog?: DingdingRuntimeState["onLog"]) {
  onLog?.("info", {
    target: "sessionWebhook",
    hasSessionWebhook: Boolean(sessionWebhook),
    textPreview: compactLogText(text),
  }, "dingding webhook send requested");
  const response = await fetchImpl(sessionWebhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: {
        title: markdownTitle(text),
        text,
      },
    }),
  });
  const payload = await response.json().catch(() => undefined);
  onLog?.(response.ok ? "info" : "warn", {
    target: "sessionWebhook",
    status: response.status,
    response: dingdingResponseLogSummary(payload),
  }, "dingding webhook send completed");
  if (!response.ok) {
    throw new Error(`DingDing webhook failed with HTTP ${response.status}`);
  }
}

async function sendWechatMessage(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, chatId: string, contextToken: string, text: string) {
  const baseUrl = stringSetting(bridge.settings.baseUrl) || `https://ilinkai.${"wei"}${"xin"}.qq.com`;
  const response = await fetchImpl(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${bridge.token}`,
      "X-WECHAT-UIN": String(Math.floor(Math.random() * 2 ** 31)),
    },
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: "1.0.2" },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.errcode) {
    throw new Error(stringSetting(payload.errmsg) || `WeChat send failed with HTTP ${response.status}`);
  }
}

function wechatText(message: Record<string, unknown>) {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    const record = asRecord(item);
    if (record.type !== 1) {
      continue;
    }
    const text = stringSetting(asRecord(record.text_item).text).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

async function downloadedTelegramImagePaths(
  fetchImpl: typeof fetch,
  bridge: ChatBridgeConfig,
  message: Record<string, unknown>,
  onError: ((data: { fileId: string; fileName?: string; error: unknown }) => void) | undefined,
) {
  const paths: string[] = [];
  for (const attachment of telegramImageAttachments(message)) {
    try {
      const filePath = await downloadTelegramFile({
        getFileLink: (fileId) => telegramFileLink(fetchImpl, bridge, fileId),
        fetchFile: fetchImpl,
      }, attachment.fileId, attachment.fileName, attachment.fileSize);
      paths.push(filePath);
    } catch (error) {
      onError?.({ fileId: attachment.fileId, fileName: attachment.fileName, error });
    }
  }
  return paths;
}

function messageIdFromTelegramMessage(message: Record<string, unknown> | undefined) {
  const id = Number(message?.message_id);
  return Number.isInteger(id) ? id : undefined;
}

export async function sendDingdingActionsCard(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  runtime: DingdingRuntimeState;
  chatId: string;
  text: string;
  replyMarkup?: ChatInlineKeyboard;
  sessionWebhook?: string;
  senderId?: string;
  title?: string;
  step?: string;
  forceCard?: boolean;
}) {
  const actions = inlineKeyboardToActions(input.replyMarkup);
  if (!actions.length && !input.forceCard) {
    if (input.sessionWebhook) {
      await sendDingdingWebhook(input.fetchImpl, input.sessionWebhook, input.text, input.runtime.onLog);
    }
    return input.sessionWebhook ? { delivered: true } : undefined;
  }
  const settings = input.bridge.settings || {};
  const robotCode = stringSetting(settings.robotCode);
  const cardTemplateId = stringSetting(settings.cardTemplateId) || "13fc6717-12e4-43ed-8533-111a310d4995.schema";
  const callbackRouteKey = stringSetting(settings.cardCallbackRouteKey) || "bi_workflow_ticket";
  const senderId = input.senderId || input.runtime.senderIds.get(input.chatId) || stringSetting(settings.senderId);
  const conversationType = dingdingRuntimeConversationType(input.runtime, input.chatId);
  if (!robotCode || !cardTemplateId || !senderId) {
    if (input.sessionWebhook && !input.forceCard) {
      await sendDingdingWebhook(input.fetchImpl, input.sessionWebhook, input.text, input.runtime.onLog);
      return { delivered: true };
    }
    throw new Error("DingDing card target is incomplete.");
  }
  const outTrackId = `task_handoff_cp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const cardParamMap = jsonValuesToString({
    type: "actions",
    title: input.title || markdownTitle(input.text),
    description: input.text,
    list: actions,
    biz_out_track_id: outTrackId,
    biz_step: input.step || "task_handoff_actions",
    biz_conversation_id: input.chatId,
    biz_sender_id: senderId,
    biz_session_webhook: input.sessionWebhook || input.runtime.chatWebhooks.get(input.chatId) || "",
    biz_conversation_type: conversationType,
    error_msg: "",
  });
  const deliveryTarget = dingdingCardDeliveryTarget(conversationType, input.chatId, senderId, robotCode);
  input.runtime.onLog?.("info", {
    target: "card",
    chatId: input.chatId,
    senderId,
    conversationType,
    openSpaceId: deliveryTarget.openSpaceId,
    hasSessionWebhook: Boolean(input.sessionWebhook || input.runtime.chatWebhooks.get(input.chatId)),
    hasReplyMarkup: Boolean(input.replyMarkup),
    actionCount: actions.length,
    textPreview: compactLogText(input.text),
  }, "dingding card send requested");
  await dingdingApi(input.fetchImpl, input.bridge, input.runtime, "POST", "/v1.0/card/instances/createAndDeliver", {
    userId: senderId,
    cardTemplateId,
    outTrackId,
    callbackType: "STREAM",
    callbackRouteKey,
    cardData: { cardParamMap },
    userIdType: Number(settings.cardUserIdType || 1),
    ...deliveryTarget,
  });
  return { delivered: true, outTrackId };
}

function dingdingRuntimeConversationType(runtime: DingdingRuntimeState, chatId: string): DingdingConversationType {
  return runtime.conversationTypes?.get(chatId) || "IM_GROUP";
}

function dingdingCardDeliveryTarget(
  conversationType: DingdingConversationType,
  chatId: string,
  senderId: string,
  robotCode: string,
) {
  if (conversationType === "IM_SINGLE") {
    return {
      openSpaceId: dingdingOpenSpaceIdIMSingle(chatId),
      imSingleOpenSpaceModel: {},
      imSingleOpenDeliverModel: { extension: {} },
    };
  }
  if (conversationType === "IM_ROBOT") {
    return {
      openSpaceId: dingdingOpenSpaceIdIMRobot(senderId),
      imRobotOpenSpaceModel: { supportForward: false },
      imRobotOpenDeliverModel: { extension: {}, robotCode, spaceType: "IM_ROBOT" },
    };
  }
  return {
    openSpaceId: dingdingOpenSpaceIdIMGroup(chatId),
    imGroupOpenSpaceModel: { supportForward: false },
    imGroupOpenDeliverModel: { extension: {}, robotCode },
  };
}

export async function updateDingdingActionsCard(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  runtime: DingdingRuntimeState;
  outTrackId: string;
  text: string;
  replyMarkup?: ChatInlineKeyboard;
  title?: string;
  step?: string;
}) {
  await dingdingApi(input.fetchImpl, input.bridge, input.runtime, "PUT", "/v1.0/card/instances", {
    outTrackId: input.outTrackId,
    cardData: {
      cardParamMap: jsonValuesToString({
        type: "actions",
        title: input.title || "TaskHandoff",
        description: input.text,
        list: inlineKeyboardToActions(input.replyMarkup),
        biz_step: input.step || "updated",
        error_msg: "",
      }),
    },
    cardUpdateOptions: {
      updateCardDataByKey: true,
      updatePrivateDataByKey: false,
    },
    userIdType: Number(input.bridge.settings.cardUserIdType || 1),
  });
}

async function dingdingApi(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, runtime: DingdingRuntimeState, method: "POST" | "PUT", path: string, body: Record<string, unknown>) {
  const token = await dingdingAccessToken(fetchImpl, bridge, runtime);
  runtime.onLog?.("info", {
    method,
    path,
    body: dingdingRequestLogSummary(body),
  }, "dingding api request");
  const response = await fetchImpl(`https://api.dingtalk.com${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  runtime.onLog?.(response.ok ? "info" : "warn", {
    method,
    path,
    status: response.status,
    response: dingdingResponseLogSummary(payload),
  }, "dingding api response");
  if (!response.ok) {
    throw new Error(`DingDing API failed with HTTP ${response.status}`);
  }
  const record = asRecord(payload);
  const code = record.code ?? record.errcode;
  const success = record.success;
  if ((code !== undefined && String(code) !== "0") || success === false) {
    throw new Error(stringSetting(record.message || record.errmsg) || `DingDing API returned ${String(code || "failure")}`);
  }
  const deliveryError = dingdingDeliveryError(payload);
  if (deliveryError) {
    throw new Error(deliveryError);
  }
  return response;
}

function dingdingDeliveryError(payload: unknown) {
  const deliverResults = asRecord(asRecord(payload).result).deliverResults;
  if (!Array.isArray(deliverResults)) {
    return "";
  }
  const failed = deliverResults.find((item) => asRecord(item).success === false);
  if (!failed) {
    return "";
  }
  const record = asRecord(failed);
  const spaceId = stringSetting(record.spaceId);
  const error = stringSetting(record.errorMsg || record.message || record.errmsg) || "delivery failed";
  return spaceId ? `DingDing card delivery failed for ${spaceId}: ${error}` : `DingDing card delivery failed: ${error}`;
}

function dingdingRequestLogSummary(body: Record<string, unknown>) {
  const record = asRecord(body);
  const cardData = asRecord(record.cardData);
  const cardParamMap = asRecord(cardData.cardParamMap);
  return {
    openSpaceId: stringSetting(record.openSpaceId),
    outTrackId: stringSetting(record.outTrackId),
    userId: stringSetting(record.userId),
    userIdType: record.userIdType,
    callbackType: stringSetting(record.callbackType),
    callbackRouteKey: stringSetting(record.callbackRouteKey),
    hasImGroupTarget: Boolean(record.imGroupOpenSpaceModel || record.imGroupOpenDeliverModel),
    hasImSingleTarget: Boolean(record.imSingleOpenSpaceModel || record.imSingleOpenDeliverModel),
    hasImRobotTarget: Boolean(record.imRobotOpenSpaceModel || record.imRobotOpenDeliverModel),
    imGroupOpenDeliverModel: summarizeDingdingDeliverModel(record.imGroupOpenDeliverModel),
    imSingleOpenDeliverModel: summarizeDingdingDeliverModel(record.imSingleOpenDeliverModel),
    imRobotOpenDeliverModel: summarizeDingdingDeliverModel(record.imRobotOpenDeliverModel),
    bizConversationId: stringSetting(cardParamMap.biz_conversation_id),
    bizConversationType: stringSetting(cardParamMap.biz_conversation_type),
    bizSenderId: stringSetting(cardParamMap.biz_sender_id),
    hasBizSessionWebhook: Boolean(stringSetting(cardParamMap.biz_session_webhook)),
  };
}

function summarizeDingdingDeliverModel(value: unknown) {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return undefined;
  }
  return {
    hasExtension: Boolean(record.extension),
    hasRobotCode: Boolean(stringSetting(record.robotCode)),
    spaceType: stringSetting(record.spaceType),
    recipients: Array.isArray(record.recipients) ? record.recipients.length : undefined,
    atUserIds: record.atUserIds && typeof record.atUserIds === "object" ? Object.keys(record.atUserIds as Record<string, unknown>).length : undefined,
  };
}

function dingdingResponseLogSummary(payload: unknown) {
  const record = asRecord(payload);
  const result = asRecord(record.result);
  return {
    code: record.code ?? record.errcode,
    message: compactLogText(record.message || record.errmsg, 240),
    success: record.success,
    requestId: record.requestId,
    result: Object.keys(result).length ? result : undefined,
  };
}

function compactLogText(value: unknown, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function dingdingAccessToken(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, runtime: DingdingRuntimeState) {
  if (runtime.accessToken && runtime.accessToken.expiresAt > Date.now() + 60_000) {
    return runtime.accessToken.value;
  }
  const clientSecret = stringSetting(bridge.settings.clientSecret);
  if (!bridge.token || !clientSecret) {
    throw new Error("DingDing client id/secret is not configured.");
  }
  const response = await fetchImpl("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: bridge.token, appSecret: clientSecret }),
  });
  const payload = (await response.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number };
  if (!response.ok || !payload.accessToken) {
    throw new Error(`DingDing access token failed with HTTP ${response.status}`);
  }
  const expireIn = Number(payload.expireIn || 7200);
  runtime.accessToken = {
    value: payload.accessToken,
    expiresAt: Date.now() + Math.max(60, expireIn - 120) * 1000,
  };
  return runtime.accessToken.value;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordSetting(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    return parseJsonRecord(value);
  }
  return {};
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseJsonRecord(value: unknown) {
  try {
    return asRecord(JSON.parse(String(value || "{}")));
  } catch {
    return {};
  }
}

function dingdingActionsFingerprint(replyMarkup: ChatInlineKeyboard | undefined) {
  return JSON.stringify(inlineKeyboardToActions(replyMarkup));
}

function progressReplyMarkup(options: { actions?: Array<{ text: string; callbackData: string }>; actionRows?: Array<Array<{ text: string; callbackData: string }>> } | undefined): ChatInlineKeyboard | undefined {
  const actionRows = Array.isArray(options?.actionRows) ? options.actionRows : undefined;
  if (actionRows) {
    return createInlineKeyboard(actionRows);
  }
  const actions = Array.isArray(options?.actions) ? options.actions : [];
  return createInlineKeyboard(actions.map((action) => [action]));
}

function decodeChatCallbackPart(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}
