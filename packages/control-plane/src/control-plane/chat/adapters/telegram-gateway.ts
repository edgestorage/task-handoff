import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import { telegramMarkdownEscape, telegramMarkdownV2ToLegacy } from "@task-handoff/core/core/chat-render";
import type { ChatInlineKeyboard } from "@task-handoff/core/core/chat-interactions";

export type TelegramMessageOptions = {
  replyMarkup?: ChatInlineKeyboard;
  replyToMessageId?: number;
  rawMarkdownV2?: boolean;
  parseMode?: "MarkdownV2" | "Markdown";
};

type TelegramRequest = (body: Record<string, unknown>) => Promise<Response>;

export async function answerTelegramCallback(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, callbackQueryId: string, text: string) {
  if (!bridge.token || !callbackQueryId) {
    return;
  }
  await fetchImpl(`https://api.telegram.org/bot${bridge.token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text.slice(0, 200),
    }),
  });
}

export async function editTelegramMessage(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, chatId: string, messageId: number, text: string, options: TelegramMessageOptions = {}) {
  if (!bridge.token) {
    return;
  }
  const request = (body: Record<string, unknown>) => fetchImpl(`https://api.telegram.org/bot${bridge.token}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return sendOrEditTelegramMarkdown(request, "editMessageText", text, {
    chat_id: chatId,
    message_id: messageId,
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  }, options);
}

export async function sendTelegramMessage(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, chatId: string, text: string, options: TelegramMessageOptions = {}) {
  if (!bridge.token) {
    return;
  }
  const request = (body: Record<string, unknown>) => fetchImpl(`https://api.telegram.org/bot${bridge.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return sendOrEditTelegramMarkdown(request, "sendMessage", text, {
    chat_id: chatId,
    ...(options.replyToMessageId ? { reply_to_message_id: options.replyToMessageId, allow_sending_without_reply: true } : {}),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  }, options);
}

export async function deleteTelegramMessage(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, chatId: string, messageId: number) {
  if (!bridge.token || !Number.isInteger(messageId)) {
    return;
  }
  const response = await fetchImpl(`https://api.telegram.org/bot${bridge.token}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram deleteMessage failed with HTTP ${response.status}`);
  }
}

export async function telegramFileLink(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, fileId: string) {
  if (!bridge.token || !fileId) {
    throw new Error("Telegram file id is required.");
  }
  const response = await fetchImpl(`https://api.telegram.org/bot${bridge.token}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { file_path?: string } };
  if (!response.ok || payload.ok === false || !payload.result?.file_path) {
    throw new Error(payload.description || `Telegram getFile failed with HTTP ${response.status}`);
  }
  return `https://api.telegram.org/file/bot${bridge.token}/${payload.result.file_path}`;
}

async function sendOrEditTelegramMarkdown(
  request: TelegramRequest,
  operation: "sendMessage" | "editMessageText",
  text: string,
  body: Record<string, unknown>,
  options: TelegramMessageOptions,
) {
  const parseMode = options.parseMode || "MarkdownV2";
  const markdownText = options.rawMarkdownV2 ? String(text) : telegramMarkdownEscape(text);
  const response = await request({
    ...body,
    text: markdownText,
    disable_web_page_preview: true,
    parse_mode: parseMode,
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (response.ok && payload.ok !== false) {
    return payload.result;
  }
  if (operation === "editMessageText" && isTelegramMessageNotModified(payload.description)) {
    return undefined;
  }
  if (options.rawMarkdownV2 && parseMode === "MarkdownV2") {
    const markdownFallbackResponse = await request({
      ...body,
      text: telegramMarkdownV2ToLegacy(text),
      disable_web_page_preview: true,
      parse_mode: "Markdown",
    });
    const markdownFallbackPayload = (await markdownFallbackResponse.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
    if (markdownFallbackResponse.ok && markdownFallbackPayload.ok !== false) {
      return markdownFallbackPayload.result;
    }
    if (operation === "editMessageText" && isTelegramMessageNotModified(markdownFallbackPayload.description)) {
      return undefined;
    }
  }
  const plainResponse = await request({
    ...body,
    text: options.rawMarkdownV2 ? telegramMarkdownV2ToLegacy(text) : String(text),
    disable_web_page_preview: true,
  });
  const plainPayload = (await plainResponse.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (plainResponse.ok && plainPayload.ok !== false) {
    return plainPayload.result;
  }
  if (operation === "editMessageText" && isTelegramMessageNotModified(plainPayload.description)) {
    return undefined;
  }
  throw new Error(plainPayload.description || payload.description || `Telegram ${operation} failed with HTTP ${plainResponse.status}`);
}

function isTelegramMessageNotModified(value: unknown) {
  return typeof value === "string" && value.toLowerCase().includes("message is not modified");
}
