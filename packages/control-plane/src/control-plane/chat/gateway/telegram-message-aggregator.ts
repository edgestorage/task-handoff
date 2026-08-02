import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { AiSessionMessageAttachment } from "@task-handoff/protocol/ai-sessions";
import { createInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import crypto from "node:crypto";
import type { TelegramMessageOptions } from "../adapters/telegram-gateway.ts";

const DEFAULT_AGGREGATE_DELAY_MS = 1000;

export type TelegramMessageContext = {
  sourceMessageId?: number;
  replyToMessageId?: number;
  quoteText?: string;
};

type TelegramMessageAggregate = {
  bridgeId: string;
  chatId: string;
  userId?: string;
  texts: string[];
  attachments: AiSessionMessageAttachment[];
  context?: TelegramMessageContext;
  explicit: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type TelegramMessageAggregatorOptions = {
  requireBridge: (id: string) => ChatBridgeConfig;
  send: (bridge: ChatBridgeConfig, chatId: string, text: string, options?: TelegramMessageOptions) => Promise<unknown>;
  answerCallback: (bridge: ChatBridgeConfig, callbackQueryId: string, text: string) => Promise<unknown>;
  dispatch: (
    bridge: ChatBridgeConfig,
    chatId: string,
    userId: string | undefined,
    text: string,
    attachments: AiSessionMessageAttachment[],
    context: TelegramMessageContext,
  ) => Promise<unknown>;
  onError?: (bridgeId: string, error: unknown) => void;
  delayMs?: number;
};

export class TelegramMessageAggregator {
  private readonly aggregates = new Map<string, TelegramMessageAggregate>();
  private readonly endTokens = new Map<string, string>();
  private readonly options: TelegramMessageAggregatorOptions;
  private readonly delayMs: number;

  constructor(options: TelegramMessageAggregatorOptions) {
    this.options = options;
    this.delayMs = options.delayMs ?? DEFAULT_AGGREGATE_DELAY_MS;
  }

  async handleIncoming(
    bridge: ChatBridgeConfig,
    chatId: string,
    userId: string | undefined,
    text: string,
    attachments: AiSessionMessageAttachment[] = [],
    context: TelegramMessageContext = {},
    options: { autoBegin?: boolean } = {},
  ) {
    const normalized = text.trim();
    const command = normalized.split(/\s+/, 1)[0]?.toLowerCase() || "";
    const key = aggregateKey(bridge.id, chatId, userId);
    const existing = this.aggregates.get(key);
    if (options.autoBegin && !existing) {
      this.start(key, bridge, chatId, userId, context);
      this.enqueue(key, bridge, chatId, userId, text, attachments, context, true);
      await this.sendCollectionStarted(bridge, chatId, key, context.sourceMessageId, "Image received. Continue sending messages, then send /end when done.");
      return;
    }
    if (command === "/begin") {
      this.start(key, bridge, chatId, userId, context);
      await this.sendCollectionStarted(bridge, chatId, key, context.sourceMessageId, "Started collecting messages. Send /end when done.");
      return;
    }
    if (command === "/end") {
      await this.flush(key, "manual");
      return;
    }
    if (existing?.explicit) {
      this.enqueue(key, bridge, chatId, userId, text, attachments, context, true);
      return;
    }
    if (normalized.startsWith("/")) {
      await this.options.dispatch(bridge, chatId, userId, text, attachments, context);
      return;
    }
    this.enqueue(key, bridge, chatId, userId, text, attachments, context, false);
  }

  async handleEndCallback(
    bridge: ChatBridgeConfig,
    chatId: string,
    callbackQueryId: string,
    token: string,
    userId: string | undefined,
  ) {
    const key = this.endTokens.get(token) || "";
    if (key !== aggregateKey(bridge.id, chatId, userId)) {
      await this.options.answerCallback(bridge, callbackQueryId, "This collection is not active here");
      return;
    }
    const flushed = await this.flush(key, "callback");
    await this.options.answerCallback(bridge, callbackQueryId, flushed ? "Collected message sent" : "No messages collected");
  }

  stop() {
    for (const aggregate of this.aggregates.values()) {
      if (aggregate.timer) clearTimeout(aggregate.timer);
    }
    this.aggregates.clear();
    this.endTokens.clear();
  }

  stopBridge(bridgeId: string) {
    for (const [key, aggregate] of this.aggregates) {
      if (aggregate.bridgeId !== bridgeId) continue;
      if (aggregate.timer) clearTimeout(aggregate.timer);
      this.aggregates.delete(key);
    }
    for (const [token, key] of this.endTokens) {
      if (key.startsWith(`${bridgeId}:`)) this.endTokens.delete(token);
    }
  }

  private start(
    key: string,
    bridge: ChatBridgeConfig,
    chatId: string,
    userId: string | undefined,
    context: TelegramMessageContext,
  ) {
    const existing = this.aggregates.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    this.aggregates.set(key, {
      bridgeId: bridge.id,
      chatId,
      userId,
      texts: [],
      attachments: [],
      context,
      explicit: true,
    });
  }

  private enqueue(
    key: string,
    bridge: ChatBridgeConfig,
    chatId: string,
    userId: string | undefined,
    text: string,
    attachments: AiSessionMessageAttachment[],
    context: TelegramMessageContext,
    explicit: boolean,
  ) {
    const existing = this.aggregates.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const aggregate = existing || {
      bridgeId: bridge.id,
      chatId,
      userId,
      texts: [],
      attachments: [],
      context,
      explicit,
    };
    aggregate.bridgeId = bridge.id;
    aggregate.chatId = chatId;
    aggregate.userId = userId;
    aggregate.context = mergeContext(aggregate.context, context);
    aggregate.explicit = aggregate.explicit || explicit;
    if (text.trim()) aggregate.texts.push(text);
    aggregate.attachments.push(...attachments);
    aggregate.timer = aggregate.explicit
      ? undefined
      : setTimeout(() => {
          void this.flush(key, "timer").catch((error) => this.options.onError?.(aggregate.bridgeId, error));
        }, this.delayMs);
    this.aggregates.set(key, aggregate);
  }

  private async flush(key: string, reason: "timer" | "manual" | "callback") {
    const aggregate = this.aggregates.get(key);
    if (!aggregate) return false;
    if (aggregate.timer) clearTimeout(aggregate.timer);
    this.aggregates.delete(key);
    const bridge = this.options.requireBridge(aggregate.bridgeId);
    const text = aggregate.texts.join("\n\n").trim();
    if (!text && !aggregate.attachments.length) {
      if (reason !== "timer") {
        await this.options.send(bridge, aggregate.chatId, "No messages collected.", {
          replyToMessageId: aggregate.context?.sourceMessageId,
        });
      }
      return false;
    }
    await this.options.dispatch(
      bridge,
      aggregate.chatId,
      aggregate.userId,
      text,
      aggregate.attachments,
      aggregate.context || {},
    );
    return true;
  }

  private sendCollectionStarted(
    bridge: ChatBridgeConfig,
    chatId: string,
    key: string,
    replyToMessageId: number | undefined,
    text: string,
  ) {
    return this.options.send(bridge, chatId, text, {
      replyToMessageId,
      replyMarkup: createInlineKeyboard([[
        { text: "/end", callbackData: this.endCallbackData(key) },
      ]]),
    });
  }

  private endCallbackData(key: string) {
    const token = crypto.createHash("sha256").update(key).digest("base64url").slice(0, 16);
    this.endTokens.set(token, key);
    return `task_handoff:cp_msg_end:${token}`;
  }
}

function aggregateKey(bridgeId: string, chatId: string, userId: string | undefined) {
  return [bridgeId, chatId, userId || ""].join(":");
}

function mergeContext(current: TelegramMessageContext | undefined, next: TelegramMessageContext) {
  return {
    sourceMessageId: current?.sourceMessageId ?? next.sourceMessageId,
    replyToMessageId: current?.replyToMessageId ?? next.replyToMessageId,
    quoteText: current?.quoteText || next.quoteText,
  };
}
