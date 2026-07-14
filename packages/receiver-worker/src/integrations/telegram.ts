import { Telegraf } from "telegraf";
import { attachmentLabel } from "@task-handoff/core/core/attachments";
import type { SenderAttachment } from "@task-handoff/core/core/attachments";
import type { ChatBridgeCapabilities, ChatPayload } from "@task-handoff/core/core/chat";
import type { ChatProgressOptions } from "@task-handoff/core/core/chat";
import {
  renderPlainChatPayload,
  renderTelegramApprovalPayload,
  renderTelegramApprovalText,
  renderTelegramProgressText,
  renderTelegramTitledPayload,
  telegramMarkdownEscape,
  telegramMarkdownV2ToLegacy,
} from "@task-handoff/core/core/chat-render";
import { TelegramProgressStore, type TelegramProgressEntry } from "@task-handoff/core/core/telegram-progress";
import { box, color } from "@task-handoff/terminal-ui";
import { parseTelegramCallbackAction } from "./telegram-actions";
import { downloadTelegramFile, telegramImageAttachments, textWithTelegramImagePaths } from "./telegram-images";
import type { TelegramApi, TelegramExtra, TelegramMessage, TelegramTargetRoute } from "./telegram-types";
import {
  asRecord,
  errorMessage,
  isTelegramMessageNotModified,
  isTelegramMessageTooLong,
  sleep,
  splitTelegramText,
  telegramProgressReplyMarkup,
  telegramRetryAfterMs,
} from "./telegram-utils";

const TELEGRAM_RETRY_BASE_MS = 2_000;
const TELEGRAM_RETRY_MAX_MS = 60_000;
const TELEGRAM_PROCESSING_REACTION = "👀";
const TELEGRAM_PROGRESS_UPDATE_MS = 1000;

type TelegramBridgeOptions = {
  token?: string;
  chatId?: string;
  allowedUserIds?: string | string[];
  multiChat?: boolean;
  onText: (text: string, processing?: unknown, meta?: { chatId?: string; messageId?: number }) => unknown | Promise<unknown>;
  onEdit?: (text: string, meta?: { chatId?: string; messageId?: number }) => unknown | Promise<unknown>;
  onAction?: (action: unknown) => unknown | Promise<unknown>;
  onLog: (message: string) => void;
  onDiagnostic?: (message: string) => void;
  onChange?: (state: { token?: string; chatId?: string; allowedUserIds?: string[] }) => void;
};

function telegramApiAdapter(api: Telegraf["telegram"]): TelegramApi {
  return {
    sendMessage: (chatId, text, extra) => api.sendMessage(chatId, text, extra),
    editMessageText: (chatId, messageId, inlineMessageId, text, extra) => api.editMessageText(chatId, messageId, inlineMessageId, text, extra),
    deleteMessage: (chatId, messageId) => api.deleteMessage(chatId, messageId),
    callApi: (method, payload) => api.callApi(method as Parameters<typeof api.callApi>[0], payload),
    getFileLink: (fileId) => api.getFileLink(fileId),
  };
}

class TelegramBridge {
  token?: string;
  chatId?: string;
  allowedUserIds: string[];
  enabled: boolean;
  multiChat: boolean;
  polling: boolean;
  bot?: Telegraf;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryAttempt: number;
  launching: boolean;
  onText: (text: string, processing?: unknown, meta?: { chatId?: string; messageId?: number }) => unknown | Promise<unknown>;
  onEdit?: (text: string, meta?: { chatId?: string; messageId?: number }) => unknown | Promise<unknown>;
  onAction?: (action: unknown) => unknown | Promise<unknown>;
  onLog: (message: string) => void;
  onDiagnostic?: (message: string) => void;
  onChange?: (state: { token?: string; chatId?: string; allowedUserIds?: string[] }) => void;
  progressMessages: Map<string, TelegramProgressEntry<TelegramTargetRoute>>;
  progressStore: TelegramProgressStore<TelegramTargetRoute>;
  capabilities: ChatBridgeCapabilities;

  telegramApi() {
    if (!this.bot) {
      return undefined;
    }
    return telegramApiAdapter(this.bot.telegram);
  }

  constructor({ token, chatId, allowedUserIds, multiChat = false, onText, onEdit, onAction, onLog, onDiagnostic, onChange }: TelegramBridgeOptions) {
    this.token = token;
    this.chatId = chatId;
    this.allowedUserIds = this.normalizeAllowedUserIds(allowedUserIds);
    this.enabled = Boolean(token);
    this.multiChat = Boolean(multiChat);
    this.polling = false;
    this.bot = undefined;
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.launching = false;
    this.onText = onText;
    this.onEdit = onEdit;
    this.onAction = onAction;
    this.onLog = onLog;
    this.onDiagnostic = onDiagnostic;
    this.onChange = onChange;
    this.progressMessages = new Map();
    this.progressStore = new TelegramProgressStore<TelegramTargetRoute>({
      entries: this.progressMessages,
      send: (text, route, options) => this.sendMessage(renderTelegramProgressText(text), { rawMarkdownV2: true, ...(telegramProgressReplyMarkup(options) ? { reply_markup: telegramProgressReplyMarkup(options) } : {}) }, route),
      edit: (messageId, text, route, options, renderOptions) => this.editMessage(
        messageId,
        renderOptions ? text : renderTelegramProgressText(text),
        { rawMarkdownV2: true, ...(telegramProgressReplyMarkup(options) ? { reply_markup: telegramProgressReplyMarkup(options) } : {}), ...asRecord(renderOptions) },
        route,
      ),
      delete: (messageId, route) => {
        const chatId = this.chatIdForRoute(route);
        if (!this.enabled || !this.bot || !chatId) {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(this.telegramApi()?.deleteMessage(chatId, messageId));
      },
      retryAfterMs: telegramRetryAfterMs,
      isMessageTooLong: isTelegramMessageTooLong,
      onLog: (message) => this.onLog(color.yellow(message)),
    });
    this.capabilities = {
      markdown: true,
      buttons: true,
      editMessage: true,
      deleteMessage: true,
      reaction: true,
      progress: true,
      plainTextOnly: false,
    };
  }

  statusLines() {
    return [
      `enabled: ${this.enabled ? "yes" : "no"}`,
      `token: ${this.token ? "set" : "not set"}`,
      `chat id: ${this.chatId || "not set"}`,
      `allowed users: ${this.allowedUserIds.length || "pending first user"}`,
      `polling: ${this.polling ? "yes" : "no"}`,
      `retry: ${this.retryTimer ? "scheduled" : "idle"}`,
    ];
  }

  printStatus() {
    this.onLog(box("telegram", this.statusLines()));
  }

  emitChange() {
    this.onChange?.({
      token: this.token,
      chatId: this.chatId,
      allowedUserIds: this.allowedUserIds,
    });
  }

  chatIdForRoute(route?: TelegramTargetRoute) {
    return String(route?.target?.chatId || this.chatId || "").trim();
  }

  normalizeAllowedUserIds(value: unknown) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  isAllowedUser(userId: unknown) {
    const normalized = String(userId || "").trim();
    if (!normalized) {
      return false;
    }
    if (this.allowedUserIds.length === 0) {
      this.allowedUserIds = [normalized];
      this.onLog(color.green(`Telegram user bound: ${normalized}`));
      this.emitChange();
      return true;
    }
    return this.allowedUserIds.includes(normalized);
  }

  async send(text: string, route?: TelegramTargetRoute) {
    if (!this.enabled || !this.bot || !this.chatIdForRoute(route)) {
      return;
    }

    try {
      await this.sendMessage(text, {}, route);
    } catch (error) {
      this.onLog(color.red(`Telegram send failed: ${errorMessage(error)}`));
    }
  }

  async sendSingleMessage(text: string, extra: TelegramExtra = {}, route?: TelegramTargetRoute) {
    const chatId = this.chatIdForRoute(route);
    const telegram = this.telegramApi();
    if (!chatId || !telegram) {
      return undefined;
    }
    const rawMarkdownV2 = Boolean(extra.rawMarkdownV2);
    const parseMode = extra.parseMode;
    const messageExtra = { ...extra };
    delete messageExtra.rawMarkdownV2;
    delete messageExtra.parseMode;
    const routeTarget = asRecord(route?.target);
    const replyToMessageId = Number(routeTarget.replyToMessageId);
    if (Number.isInteger(replyToMessageId) && replyToMessageId > 0 && !("reply_to_message_id" in messageExtra)) {
      messageExtra.reply_to_message_id = replyToMessageId;
    }
    try {
      return await this.sendTelegramMessage(chatId, rawMarkdownV2 ? String(text) : telegramMarkdownEscape(text), {
        disable_web_page_preview: true,
        parse_mode: parseMode || "MarkdownV2",
        ...messageExtra,
      });
    } catch (error) {
      if (telegramRetryAfterMs(error)) {
        throw error;
      }
      if (rawMarkdownV2 && (parseMode || "MarkdownV2") === "MarkdownV2") {
        this.onDiagnostic?.(`Telegram MarkdownV2 render failed, trying Markdown: ${errorMessage(error)}`);
        const markdownFallbackText = telegramMarkdownV2ToLegacy(text);
        try {
          return await this.sendTelegramMessage(chatId, markdownFallbackText, {
            disable_web_page_preview: true,
            parse_mode: "Markdown",
            ...messageExtra,
          });
        } catch (markdownFallbackError) {
          if (telegramRetryAfterMs(markdownFallbackError)) {
            throw markdownFallbackError;
          }
          this.onDiagnostic?.(`Telegram markdown render fallback skipped: ${errorMessage(markdownFallbackError)}`);
        }
      } else {
        this.onDiagnostic?.(`Telegram markdown render fallback skipped: ${errorMessage(error)}`);
      }
      return await this.sendTelegramMessage(chatId, rawMarkdownV2 ? telegramMarkdownV2ToLegacy(text) : String(text), {
        disable_web_page_preview: true,
        ...messageExtra,
      });
    }
  }

  async sendTelegramMessage(chatId: string, text: string, extra: Record<string, unknown>) {
    const telegram = this.telegramApi();
    if (!telegram) {
      return undefined;
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await telegram.sendMessage(chatId, text, extra);
      } catch (error) {
        const retryAfterMs = telegramRetryAfterMs(error);
        if (!retryAfterMs || attempt === maxAttempts) {
          throw error;
        }
        this.onDiagnostic?.(`Telegram rate limited, retrying after ${Math.ceil(retryAfterMs / 1000)}s`);
        await sleep(retryAfterMs + 250);
      }
    }
    return undefined;
  }

  async sendMessage(text: string, extra: TelegramExtra = {}, route?: TelegramTargetRoute) {
    const chunks = splitTelegramText(text);
    let lastMessage;
    for (const [index, chunk] of chunks.entries()) {
      const messageExtra = index === 0 ? extra : { ...extra, reply_markup: undefined };
      lastMessage = await this.sendSingleMessage(chunk, messageExtra, route);
    }
    return lastMessage;
  }

  attachmentReplyMarkup(payload: ChatPayload) {
    if (!payload.id || !payload.attachments?.length) {
      return undefined;
    }
    return {
      inline_keyboard: payload.attachments.map((attachment) => [
        {
          text: attachmentLabel(attachment),
          callback_data: `task_handoff:attachment:${payload.conversationId}:${payload.id}:${attachment.id}`,
        },
      ]),
    };
  }

  async sendAttachment(attachment: SenderAttachment, route?: TelegramTargetRoute) {
    const chatId = this.chatIdForRoute(route);
    const telegram = this.telegramApi();
    if (!chatId || !telegram) {
      return undefined;
    }
    const payload = {
      chat_id: chatId,
      caption: attachment.name,
      [attachment.kind === "image" ? "photo" : "document"]: { source: attachment.path, filename: attachment.name },
    };
    return telegram.callApi(attachment.kind === "image" ? "sendPhoto" : "sendDocument", payload);
  }

  async editMessage(messageId: number, text: string, extra: TelegramExtra = {}, route?: TelegramTargetRoute) {
    const chatId = this.chatIdForRoute(route);
    const telegram = this.telegramApi();
    if (!chatId || !telegram) {
      return undefined;
    }
    const rawMarkdownV2 = Boolean(extra.rawMarkdownV2);
    const parseMode = extra.parseMode;
    const messageExtra = { ...extra };
    delete messageExtra.rawMarkdownV2;
    delete messageExtra.parseMode;
    try {
      return await telegram.editMessageText(chatId, messageId, undefined, rawMarkdownV2 ? String(text) : telegramMarkdownEscape(text), {
        disable_web_page_preview: true,
        parse_mode: parseMode || "MarkdownV2",
        ...messageExtra,
      });
    } catch (error) {
      if (isTelegramMessageNotModified(error)) {
        return undefined;
      }
      if (rawMarkdownV2 && (parseMode || "MarkdownV2") === "MarkdownV2") {
        this.onDiagnostic?.(`Telegram MarkdownV2 edit failed, trying Markdown: ${errorMessage(error)}`);
        try {
          return await telegram.editMessageText(chatId, messageId, undefined, telegramMarkdownV2ToLegacy(text), {
            disable_web_page_preview: true,
            parse_mode: "Markdown",
            ...messageExtra,
          });
        } catch (markdownFallbackError) {
          if (isTelegramMessageNotModified(markdownFallbackError)) {
            return undefined;
          }
          this.onDiagnostic?.(`Telegram markdown edit fallback skipped: ${errorMessage(markdownFallbackError)}`);
        }
      } else {
        this.onDiagnostic?.(`Telegram markdown edit fallback skipped: ${errorMessage(error)}`);
      }
      try {
        return await telegram.editMessageText(chatId, messageId, undefined, rawMarkdownV2 ? telegramMarkdownV2ToLegacy(text) : String(text), {
          disable_web_page_preview: true,
          ...messageExtra,
        });
      } catch (fallbackError) {
        if (isTelegramMessageNotModified(fallbackError)) {
          return undefined;
        }
        throw fallbackError;
      }
    }
  }

  scheduleProgressFlush(key: string, delay: number) {
    this.progressStore.scheduleFlush(key, delay);
  }

  markProgressRateLimited(key: string, value: string, retryAfterMs: number, route?: TelegramTargetRoute) {
    this.progressStore.markRateLimited(key, value, retryAfterMs, route);
  }

  async applyProgressUpdate(key: string, value: string, route?: TelegramTargetRoute, options?: ChatProgressOptions) {
    return this.progressStore.applyUpdate(key, value, route, options);
  }

  updateProgress(key: string, text: unknown, route?: TelegramTargetRoute, options?: ChatProgressOptions) {
    this.progressStore.update(key, text, route, options);
  }

  async finishProgress(key: string, text: string, extra: TelegramExtra = {}, route?: TelegramTargetRoute) {
    return this.progressStore.finish(key, text, route, undefined, extra);
  }

  async finishProgressResult(key: string, title: string, body: string, route?: TelegramTargetRoute) {
    return this.finishProgress(key, renderTelegramTitledPayload({ title, body }), { rawMarkdownV2: true }, route);
  }

  async finishProgressPayload(key: string, payload: ChatPayload, route?: TelegramTargetRoute) {
    const replyMarkup = this.attachmentReplyMarkup(payload);
    return this.progressStore.finish(
      key,
      renderTelegramTitledPayload({ title: payload.title, body: payload.body }),
      route,
      undefined,
      replyMarkup ? { reply_markup: replyMarkup } : undefined,
    );
  }

  async sendResult(title: string, body: string, route?: TelegramTargetRoute) {
    if (!this.enabled || !this.bot || !this.chatIdForRoute(route)) {
      return;
    }
    try {
      await this.sendMessage(renderTelegramTitledPayload({ title, body }), { rawMarkdownV2: true }, route);
    } catch (error) {
      this.onLog(color.red(`Telegram result send failed: ${errorMessage(error)}`));
    }
  }

  async sendTask(payload: ChatPayload, route?: TelegramTargetRoute) {
    const replyMarkup = this.attachmentReplyMarkup(payload);
    if (!replyMarkup) {
      await this.sendResult(payload.title, payload.body, route);
      return;
    }
    try {
      await this.sendMessage(renderPlainChatPayload(payload), { reply_markup: replyMarkup }, route);
    } catch (error) {
      await this.sendMessage(`${payload.title}\n\n${payload.body}`, { reply_markup: replyMarkup }, route);
    }
  }

  async deleteProgress(key: string, route?: TelegramTargetRoute) {
    return this.progressStore.delete(key, route);
  }

  async sendApproval(text: string, { id, conversationId }: { id: number; conversationId: number }) {
    if (!this.enabled || !this.bot || !this.chatId) {
      return;
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "Allow", callback_data: `task_handoff:approval:${conversationId}:${id}:allow` },
          { text: "Skip", callback_data: `task_handoff:approval:${conversationId}:${id}:skip` },
          { text: "Deny", callback_data: `task_handoff:approval:${conversationId}:${id}:deny` },
        ],
      ],
    };

    try {
      await this.sendMessage(renderTelegramApprovalText(text), { rawMarkdownV2: true, reply_markup: replyMarkup });
    } catch (error) {
      await this.sendMessage(text, { reply_markup: replyMarkup });
    }
  }

  async sendApprovalPayload(payload: ChatPayload, route?: TelegramTargetRoute) {
    if (!this.enabled || !this.bot || !this.chatIdForRoute(route)) {
      return;
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "Allow", callback_data: `task_handoff:approval:${payload.conversationId}:${payload.id}:allow` },
          { text: "Skip", callback_data: `task_handoff:approval:${payload.conversationId}:${payload.id}:skip` },
          { text: "Deny", callback_data: `task_handoff:approval:${payload.conversationId}:${payload.id}:deny` },
        ],
      ],
    };

    try {
      await this.sendMessage(renderTelegramApprovalPayload(payload), { rawMarkdownV2: true, reply_markup: replyMarkup }, route);
    } catch (error) {
      await this.sendMessage(payload.body, { reply_markup: replyMarkup }, route);
    }
  }

  bind(token: string, chatId?: string) {
    this.stop();
    this.token = token;
    this.chatId = chatId;
    this.enabled = true;
    this.onLog(color.green(chatId ? "Telegram bot and chat bound" : "Telegram bot bound"));
    if (!chatId) {
      this.onLog(color.yellow("Send a message to the bot to auto-bind the chat id."));
    }
    this.emitChange();
    this.start();
  }

  setAllowedUserIds(value: unknown) {
    this.allowedUserIds = this.normalizeAllowedUserIds(value);
    this.onLog(color.green(`Telegram allowed users: ${this.allowedUserIds.length || "pending first user"}`));
  }

  setChat(chatId: string) {
    this.chatId = chatId;
    this.onLog(color.green(`Telegram chat set: ${chatId}`));
    this.emitChange();
  }

  unbind() {
    this.stop();
    this.token = undefined;
    this.chatId = undefined;
    this.onLog(color.green("Telegram binding removed"));
    this.emitChange();
  }

  stop() {
    this.enabled = false;
    this.polling = false;
    this.launching = false;
    this.retryAttempt = 0;
    for (const entry of this.progressMessages.values()) {
      clearTimeout(entry.timer);
    }
    this.progressMessages.clear();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.bot) {
      try {
        this.bot.stop("receiver disabled");
      } catch (error) {
        // Telegraf throws when stop is called before launch completed.
      }
      this.bot = undefined;
    }
  }

  scheduleRetry(reason: string) {
    if (!this.enabled || !this.token) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryAttempt += 1;
    const delay = Math.min(TELEGRAM_RETRY_BASE_MS * 2 ** (this.retryAttempt - 1), TELEGRAM_RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, delay);
    this.onLog(color.yellow(`Telegram launch failed: ${reason}. Retrying in ${Math.round(delay / 1000)}s.`));
  }

  start() {
    if (!this.token) {
      this.onLog(color.yellow("Telegram token is not set. Use /telegram bind <bot-token> [chat-id]."));
      return;
    }
    if (this.polling || this.bot || this.launching) {
      return;
    }

    this.enabled = true;
    this.launching = true;
    this.bot = new Telegraf(this.token);
    this.bot.on("message", (ctx: unknown) => {
      void this.handleMessage(ctx).catch((error: unknown) => {
        this.onLog(color.red(`Telegram message handler failed: ${errorMessage(error)}`));
      });
    });
    this.bot.on("edited_message", (ctx: unknown) => {
      void this.handleEditedMessage(ctx).catch((error: unknown) => {
        this.onLog(color.red(`Telegram edit handler failed: ${errorMessage(error)}`));
      });
    });
    this.bot.on("callback_query", (ctx: unknown) => {
      void this.handleAction(ctx).catch((error: unknown) => {
        this.onLog(color.red(`Telegram action handler failed: ${errorMessage(error)}`));
      });
    });
    this.bot.catch((error: unknown) => {
      this.onLog(color.red(`Telegram error: ${errorMessage(error)}`));
    });
    this.bot
      .launch({ allowedUpdates: ["message", "edited_message", "callback_query"], dropPendingUpdates: true })
      .then(() => {
        this.launching = false;
        this.polling = true;
        this.retryAttempt = 0;
        this.onLog(color.green("Telegram polling enabled"));
      })
      .catch((error: unknown) => {
        this.launching = false;
        this.polling = false;
        if (this.bot) {
          try {
            this.bot.stop("launch failed");
          } catch (stopError) {
            // Telegraf can throw when launch fails before polling starts.
          }
        }
        this.bot = undefined;
        this.scheduleRetry(errorMessage(error));
      });
  }

  async reactProcessing(message: TelegramMessage) {
    if (!this.bot || !message?.chat?.id || !message?.message_id) {
      return;
    }

    try {
      await this.telegramApi()?.callApi("setMessageReaction", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reaction: [{ type: "emoji", emoji: TELEGRAM_PROCESSING_REACTION }],
        is_big: false,
      });
    } catch (error) {
      this.onLog(color.yellow(`Telegram reaction skipped: ${errorMessage(error)}`));
    }
  }

  async clearProcessingReaction(message: TelegramMessage) {
    if (!this.bot || !message?.chat?.id || !message?.message_id) {
      return;
    }

    try {
      await this.telegramApi()?.callApi("setMessageReaction", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reaction: [],
        is_big: false,
      });
    } catch (error) {
      this.onLog(color.yellow(`Telegram reaction clear skipped: ${errorMessage(error)}`));
    }
  }

  imageAttachments(message: TelegramMessage) {
    return telegramImageAttachments(message);
  }

  async downloadTelegramFile(fileId: string, fileName = "telegram-image", fileSize?: number) {
    const telegram = this.telegramApi();
    if (!telegram) {
      throw new Error("Telegram API is not ready");
    }
    return downloadTelegramFile(telegram, fileId, fileName, fileSize);
  }

  async downloadedImagePaths(message: TelegramMessage) {
    const paths: string[] = [];
    for (const attachment of this.imageAttachments(message)) {
      try {
        paths.push(await this.downloadTelegramFile(attachment.fileId, attachment.fileName, attachment.fileSize));
      } catch (error) {
        this.onLog(color.yellow(`Telegram image download skipped: ${errorMessage(error)}`));
      }
    }
    return paths;
  }

  textWithImagePaths(text: string, imagePaths: string[]) {
    return textWithTelegramImagePaths(text, imagePaths);
  }

  async handleMessage(ctx: unknown) {
    const message = asRecord(asRecord(ctx).message) as TelegramMessage;
    const chatId = String(message.chat?.id || "");
    const userId = String(message.from?.id || "");
    if (!this.isAllowedUser(userId)) {
      this.onLog(color.yellow(`Telegram unauthorized user ignored: ${userId || "unknown"}`));
      return;
    }
    const imagePaths = await this.downloadedImagePaths(message);
    const text = this.textWithImagePaths(message.text ?? message.caption ?? "", imagePaths);
    if (!text) {
      return;
    }

    if (!this.chatId) {
      this.chatId = chatId;
      this.onLog(color.green(`Telegram chat bound: ${chatId}`));
      this.emitChange();
      if (!this.multiChat) {
        return;
      }
    }

    if (!this.multiChat && String(this.chatId) !== chatId) {
      return;
    }

    await this.onText(
      text,
      {
        start: () => this.reactProcessing(message),
        done: () => this.clearProcessingReaction(message),
      },
      { chatId, messageId: message.message_id },
    );
  }

  async handleEditedMessage(ctx: unknown) {
    const rawContext = asRecord(ctx);
    const message = asRecord(rawContext.editedMessage || rawContext.edited_message) as TelegramMessage;
    const chatId = String(message.chat?.id || "");
    const userId = String(message.from?.id || "");
    if (!this.isAllowedUser(userId)) {
      this.onLog(color.yellow(`Telegram unauthorized edit ignored: ${userId || "unknown"}`));
      return;
    }

    if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
      return;
    }

    const text = String(message.text ?? message.caption ?? "").trim();
    if (!text || !message.message_id) {
      return;
    }

    const handled = await this.onEdit?.(text, { chatId, messageId: message.message_id });
    if (!handled) {
      this.onDiagnostic?.(`Telegram edit ignored for non-queued message ${chatId}/${message.message_id}`);
    }
  }

  async answerCallback(context: { answerCbQuery?: (message?: string) => Promise<unknown> }, message: string) {
    try {
      await context.answerCbQuery?.(message);
    } catch (error) {
      const text = errorMessage(error);
      if (text.includes("query is too old") || text.includes("query ID is invalid")) {
        this.onLog(color.yellow(`Telegram callback answer skipped: ${text}`));
        return;
      }
      throw error;
    }
  }

  async handleAction(ctx: unknown) {
    const rawContext = asRecord(ctx);
    const context = rawContext as {
      answerCbQuery?: (message?: string) => Promise<unknown>;
      editMessageReplyMarkup?: (markup?: unknown) => Promise<unknown>;
    };
    const query = asRecord(rawContext.callbackQuery);
    const message = asRecord(query.message) as TelegramMessage;
    const chatId = String(message.chat?.id || "");
    const userId = String(asRecord(query.from).id || "");
    if (!this.isAllowedUser(userId)) {
      await this.answerCallback(context, "not authorized");
      this.onLog(color.yellow(`Telegram unauthorized action ignored: ${userId || "unknown"}`));
      return;
    }
    const data = String(query.data || "");
    const callbackAction = parseTelegramCallbackAction(data);
    if (!callbackAction) {
      return;
    }
    if (callbackAction.type === "cwd") {
      if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
        return;
      }
      const result = asRecord(await this.onAction?.({
        ...callbackAction,
        chatId,
      }));
      await this.answerCallback(context, String(result.message || (Object.keys(result).length > 0 ? "updated" : "cwd picker not found")));
      if (result.text && message.message_id) {
        await this.editMessage(message.message_id, String(result.text), { reply_markup: result.replyMarkup }, { target: { chatId } });
      } else if (result.clear) {
        try {
          await context.editMessageReplyMarkup?.(undefined);
        } catch (error) {
          this.onLog(color.yellow(`Telegram cwd buttons update skipped: ${errorMessage(error)}`));
        }
      }
      return;
    }
    if (callbackAction.type === "history") {
      if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
        return;
      }
      const result = asRecord(await this.onAction?.({
        ...callbackAction,
        chatId,
      }));
      await this.answerCallback(context, String(result.message || (result.found ? "updated" : "history not found")));
      if (result.text && message.message_id) {
        await this.editMessage(message.message_id, String(result.text), { reply_markup: result.replyMarkup }, { target: { chatId } });
      }
      return;
    }
    if (callbackAction.type === "conversation") {
      if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
        return;
      }
      const result = asRecord(await this.onAction?.({
        ...callbackAction,
        chatId,
      }));
      await this.answerCallback(context, String(result.message || (result.found ? "updated" : "conversation not found")));
      if (result.text && message.message_id) {
        await this.editMessage(message.message_id, String(result.text), { reply_markup: result.replyMarkup }, { target: { chatId } });
      }
      return;
    }
    if (callbackAction.type === "session") {
      if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
        return;
      }
      const result = asRecord(await this.onAction?.({
        ...callbackAction,
        chatId,
      }));
      await this.answerCallback(context, String(result.message || (result.found ? "updated" : "session not found")));
      if (result.text && message.message_id) {
        await this.editMessage(message.message_id, String(result.text), { reply_markup: result.replyMarkup }, { target: { chatId } });
      }
      return;
    }
    if (callbackAction.type === "attachment") {
      if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
        return;
      }
      const result = asRecord(await this.onAction?.({
        ...callbackAction,
        chatId,
      }));
      await this.answerCallback(context, String(result.message || (result.sent ? "sent" : "attachment not found")));
      return;
    }
    if (callbackAction.type === "active_cancel") {
      if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
        return;
      }
      const result = asRecord(await this.onAction?.({
        ...callbackAction,
        chatId,
      }));
      await this.answerCallback(context, String(result.message || (result.cancelled ? "cancelled" : "no running task")));
      return;
    }
    if (!this.multiChat && this.chatId && String(this.chatId) !== chatId) {
      return;
    }
    const handled = await this.onAction?.({
      type: "approval",
      conversationId: callbackAction.conversationId,
      id: callbackAction.id,
      decision: callbackAction.decision,
    });
    await this.answerCallback(context, handled ? `${callbackAction.decision} sent` : "approval request not found");
    if (handled) {
      try {
        await context.editMessageReplyMarkup?.(undefined);
      } catch (error) {
        this.onLog(color.yellow(`Telegram approval buttons update skipped: ${errorMessage(error)}`));
      }
    }
  }
}

export { TelegramBridge, splitTelegramText, telegramMarkdownV2ToLegacy };
