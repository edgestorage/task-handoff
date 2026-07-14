import type { ChatProgressOptions } from "@task-handoff/core/core/chat";

const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTelegramMessageNotModified(error: unknown) {
  return /message is not modified/i.test(errorMessage(error));
}

function isTelegramMessageTooLong(error: unknown) {
  const message = errorMessage(error);
  return /message(_|\s+)too(_|\s+)long|MESSAGE_TOO_LONG/i.test(message);
}

function telegramRetryAfterMs(error: unknown) {
  const errorRecord = asRecord(error);
  const response = asRecord(errorRecord.response);
  const parameters = asRecord(response.parameters || errorRecord.parameters);
  const retryAfter = parameters.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  const match = /retry after (\d+)/i.exec(errorMessage(error));
  if (!match) {
    return undefined;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitTelegramText(text: unknown, limit = TELEGRAM_SAFE_MESSAGE_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) {
    return [value];
  }

  const chunks: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    const minimumSplit = Math.floor(limit * 0.6);
    const newlineIndex = rest.lastIndexOf("\n", limit);
    let splitAt = newlineIndex >= minimumSplit ? newlineIndex + 1 : -1;
    if (splitAt < minimumSplit) {
      const spaceIndex = rest.lastIndexOf(" ", limit);
      splitAt = spaceIndex >= minimumSplit ? spaceIndex + 1 : -1;
    }
    if (splitAt < minimumSplit) {
      splitAt = limit;
    }
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

function telegramProgressReplyMarkup(options?: ChatProgressOptions) {
  const actions = options?.actions || [];
  if (actions.length === 0) {
    return undefined;
  }
  return {
    inline_keyboard: actions.map((action) => [
      {
        text: action.text,
        callback_data: action.callbackData,
      },
    ]),
  };
}

export {
  asRecord,
  errorMessage,
  isTelegramMessageNotModified,
  isTelegramMessageTooLong,
  sleep,
  splitTelegramText,
  telegramProgressReplyMarkup,
  telegramRetryAfterMs,
};
