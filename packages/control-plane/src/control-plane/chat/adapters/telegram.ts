import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { AiSessionMessageAttachment } from "@task-handoff/protocol/ai-sessions";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import { renderBoundedTelegramProgressText } from "@task-handoff/core/core/chat-render";
import { TelegramProgressStore } from "@task-handoff/core/core/telegram-progress";
import { downloadTelegramFile, telegramImageAttachments } from "@task-handoff/core/core/telegram-images";
import { sendTelegramMessage, telegramFileLink, type TelegramMessageOptions } from "./telegram-gateway.ts";
import type {
  ChatGatewaySendAdapter,
  ChatGatewayIncomingMessage,
  ChatGatewayProgressStore,
  ChatGatewayProgressUpdate,
} from "./contracts.ts";

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
      send: (text, route, progressOptions) => options.send(options.requireBridge(route?.bridgeId || ""), route?.chatId || "", renderBoundedTelegramProgressText(text), {
        rawMarkdownV2: true,
        replyMarkup: progressReplyMarkup(progressOptions),
      }),
      edit: (messageId, text, route, progressOptions) => options.edit(options.requireBridge(route?.bridgeId || ""), route?.chatId || "", messageId, renderBoundedTelegramProgressText(text), {
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

export function createTelegramSendAdapter(
  fetchImpl: typeof fetch,
  bridge: ChatBridgeConfig,
): ChatGatewaySendAdapter {
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
      source: {
        type: "inline",
        encoding: "base64",
        data: bytes.toString("base64"),
      },
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

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}

function progressReplyMarkup(options: { actions?: Array<{ text: string; callbackData: string }>; actionRows?: Array<Array<{ text: string; callbackData: string }>> } | undefined) {
  const actionRows = Array.isArray(options?.actionRows) ? options.actionRows : undefined;
  if (actionRows) {
    return createInlineKeyboard(actionRows);
  }
  const actions = Array.isArray(options?.actions) ? options.actions : [];
  return createInlineKeyboard(actions.map((action) => [action]));
}
