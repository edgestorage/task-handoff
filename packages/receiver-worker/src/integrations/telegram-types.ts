import type { ChatRoute } from "@task-handoff/core/core/chat";

type TelegramRoute = ChatRoute & {
  target?: {
    chatId?: unknown;
  };
};

type TelegramTargetRoute = Partial<ChatRoute> & {
  target?: {
    chatId?: unknown;
    replyToMessageId?: unknown;
  };
};

type TelegramExtra = Record<string, unknown> & {
  rawMarkdownV2?: boolean;
  parseMode?: "MarkdownV2" | "Markdown";
  reply_markup?: unknown;
};

type TelegramMessage = {
  chat?: { id?: string | number };
  from?: { id?: string | number };
  message_id?: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id?: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
};

type TelegramApi = {
  sendMessage: (chatId: string, text: string, extra?: Record<string, unknown>) => Promise<unknown>;
  editMessageText: (
    chatId: string,
    messageId: number,
    inlineMessageId: undefined,
    text: string,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
  deleteMessage: (chatId: string, messageId: number) => Promise<unknown>;
  callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
  getFileLink: (fileId: string) => Promise<URL | string>;
};

export type { TelegramApi, TelegramExtra, TelegramMessage, TelegramRoute, TelegramTargetRoute };
