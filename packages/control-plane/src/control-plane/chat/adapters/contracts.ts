import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { ChatInlineKeyboard } from "@task-handoff/core/core/chat-interactions";

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

export type ChatGatewaySendAdapter = {
  bridge: ChatBridgeConfig;
  send: (chatId: string, text: string, options?: ChatGatewaySendOptions) => Promise<ChatGatewaySentMessage | undefined>;
  edit?: (chatId: string, messageId: number, text: string, options?: ChatGatewaySendOptions) => Promise<unknown>;
  delete?: (chatId: string, messageId: number) => Promise<unknown>;
  answerAction?: (actionContext: ChatGatewayActionContext, text: string) => Promise<unknown>;
};

export type ChatGatewayAdapterRuntime = ChatGatewaySendAdapter;

export type ChatGatewayProgressUpdate = {
  bridge: ChatBridgeConfig;
  key: string;
  chatId: string;
  text: string;
  actionRows?: Array<Array<{ text: string; callbackData: string }>>;
  replyMarkup?: ChatInlineKeyboard;
};

export type ChatGatewayProgressStore = {
  applyUpdate: (input: ChatGatewayProgressUpdate) => Promise<boolean>;
};
