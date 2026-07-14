type ChatButton = {
  text: string;
  callbackData: string;
};

type ChatInlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
};

type ChatInteractionPayload = {
  text: string;
  replyMarkup?: ChatInlineKeyboard;
};

type ChatPickerItem = {
  text: string;
  callbackData?: string;
  url?: string;
};

function createInlineKeyboard(rows: ChatPickerItem[][]): ChatInlineKeyboard {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({
        text: button.text,
        ...(button.url ? { url: button.url } : { callback_data: button.callbackData || "" }),
      })),
    ),
  };
}

function createSingleColumnKeyboard(items: ChatPickerItem[], limit = 40) {
  return createInlineKeyboard(items.slice(0, limit).map((item) => [item]));
}

function encodeChatActionData(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeChatActionData(value: string) {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function inlineKeyboardToActions(replyMarkup: unknown) {
  const keyboard = asRecord(replyMarkup).inline_keyboard;
  const rows = Array.isArray(keyboard) ? keyboard : [];
  const actions: Array<{ text: string; id: string }> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      const item = asRecord(button);
      const callbackData = String(item.callback_data || "");
      const text = String(item.text || "").trim();
      if (text && callbackData) {
        actions.push({ text, id: `th_cb_${encodeChatActionData(callbackData)}` });
      }
    }
  }
  return actions.slice(0, 40);
}

function chatActionIdToCallbackData(actionId: unknown) {
  const text = String(actionId || "");
  return text.startsWith("th_cb_") ? decodeChatActionData(text.slice("th_cb_".length)) : "";
}

function compactChatLabel(value: unknown, maxLength: number) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export {
  chatActionIdToCallbackData,
  compactChatLabel,
  createInlineKeyboard,
  createSingleColumnKeyboard,
  decodeChatActionData,
  encodeChatActionData,
  inlineKeyboardToActions,
};

export type { ChatButton, ChatInlineKeyboard, ChatInteractionPayload, ChatPickerItem };
