import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import { createInlineKeyboard, type ChatInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import crypto from "node:crypto";
import type { TelegramMessageOptions } from "../adapters/telegram-gateway.ts";

const QUEUE_BUTTON_LIMIT = 5;
const QUEUE_BUTTON_TEXT_MAX = 48;
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

type QueueAction =
  | { type: "steer"; instanceId: string; sessionId: string; queueId: string }
  | { type: "delete-menu"; instanceId: string; sessionId: string }
  | { type: "delete-item"; instanceId: string; sessionId: string; queueId: string };

type CallbackContext = {
  bridge: ChatBridgeConfig;
  chatId: string;
  callbackQueryId: string;
  userId?: string;
  messageId?: number | string;
  actionAllowed?: (instanceId: string, sessionId: string) => boolean;
  answer?: (text: string) => Promise<unknown>;
  send?: (text: string, options?: { replyMarkup?: ChatInlineKeyboard }) => Promise<unknown>;
  deleteMessage?: () => Promise<unknown>;
};

type TelegramAiSessionCallbacksOptions = {
  interrupt: (instanceId: string, sessionId: string) => Promise<unknown>;
  queue: (instanceId: string, sessionId: string) => Promise<unknown>;
  steer: (instanceId: string, sessionId: string, queueId: string) => Promise<unknown>;
  remove: (instanceId: string, sessionId: string, queueId: string) => Promise<unknown>;
  actionAllowed: (bridge: ChatBridgeConfig, chatId: string, instanceId: string, sessionId: string, messageId?: number) => boolean;
  answer: (bridge: ChatBridgeConfig, callbackQueryId: string, text: string) => Promise<unknown>;
  send: (bridge: ChatBridgeConfig, chatId: string, text: string, options?: TelegramMessageOptions) => Promise<unknown>;
  deleteMessage: (bridge: ChatBridgeConfig, chatId: string, messageId: number) => Promise<unknown>;
  setBridgeError: (bridgeId: string, error: string) => void;
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
  tokenTtlMs?: number;
  now?: () => number;
};

type ExpiringToken<T> = { value: T; expiresAt: number };

export class TelegramAiSessionCallbacks {
  private readonly cancelTokens = new Map<string, ExpiringToken<{ instanceId: string; sessionId: string }>>();
  private readonly queueActionTokens = new Map<string, ExpiringToken<QueueAction>>();
  private readonly options: TelegramAiSessionCallbacksOptions;

  constructor(options: TelegramAiSessionCallbacksOptions) {
    this.options = options;
  }

  cancelCallbackData(instanceId: string, sessionId: string) {
    this.pruneExpired();
    const token = tokenFor([instanceId, sessionId]);
    this.cancelTokens.set(token, this.expiring({ instanceId, sessionId }));
    return `task_handoff:cp_ai_cancel:${token}`;
  }

  queueSteerCallbackData(instanceId: string, sessionId: string, queueId: string) {
    return `task_handoff:cp_ai_steer:${this.queueActionToken({ type: "steer", instanceId, sessionId, queueId })}`;
  }

  queueDeleteMenuCallbackData(instanceId: string, sessionId: string) {
    return `task_handoff:cp_ai_qdel_menu:${this.queueActionToken({ type: "delete-menu", instanceId, sessionId })}`;
  }

  async tryHandle(data: string, context: CallbackContext) {
    this.pruneExpired();
    const cancelToken = callbackToken(data, "task_handoff:cp_ai_cancel:");
    if (cancelToken !== undefined) {
      const target = this.cancelTokens.get(cancelToken)?.value;
      if (!target) return this.expired(context);
      await this.cancel(context, target.instanceId, target.sessionId);
      return true;
    }
    const steerToken = callbackToken(data, "task_handoff:cp_ai_steer:");
    if (steerToken !== undefined) {
      const target = this.queueActionTokens.get(steerToken)?.value;
      if (!target || target.type !== "steer") return this.expired(context);
      await this.steer(context, target);
      return true;
    }
    const deleteMenuToken = callbackToken(data, "task_handoff:cp_ai_qdel_menu:");
    if (deleteMenuToken !== undefined) {
      const target = this.queueActionTokens.get(deleteMenuToken)?.value;
      if (!target || target.type !== "delete-menu") return this.expired(context);
      await this.deleteMenu(context, target);
      return true;
    }
    const deleteItemToken = callbackToken(data, "task_handoff:cp_ai_qdel:");
    if (deleteItemToken !== undefined) {
      const target = this.queueActionTokens.get(deleteItemToken)?.value;
      if (!target || target.type !== "delete-item") return this.expired(context);
      await this.deleteItem(context, target);
      return true;
    }
    return false;
  }

  private async cancel(context: CallbackContext, instanceId: string, sessionId: string) {
    if (!await this.requireAllowed(context, instanceId, sessionId)) return;
    await this.run(context, {
      instanceId,
      sessionId,
      successText: "Interrupt sent",
      failurePrefix: "Interrupt failed",
      logMessage: "chat ai session cancel sent",
      operation: () => this.options.interrupt(instanceId, sessionId),
    });
  }

  private async steer(context: CallbackContext, target: Extract<QueueAction, { type: "steer" }>) {
    if (!await this.requireAllowed(context, target.instanceId, target.sessionId)) return;
    await this.run(context, {
      ...target,
      successText: "Steered queued message",
      failurePrefix: "Steer failed",
      logMessage: "chat ai session queued message steered",
      operation: () => this.options.steer(target.instanceId, target.sessionId, target.queueId),
    });
  }

  private async deleteMenu(context: CallbackContext, target: Extract<QueueAction, { type: "delete-menu" }>) {
    if (!await this.requireAllowed(context, target.instanceId, target.sessionId)) return;
    try {
      const queue = asRecord(await this.options.queue(target.instanceId, target.sessionId));
      const items = (Array.isArray(queue.items) ? queue.items : [])
        .map(asRecord)
        .filter((item) => stringValue(item.status) === "queued" && stringValue(item.id));
      if (!items.length) {
        await this.answer(context, "Queue is empty");
        return;
      }
      const rows = items.slice(0, QUEUE_BUTTON_LIMIT).map((item, index) => [{
        text: queueButtonText(stringValue(item.message), index),
        callbackData: this.queueDeleteItemCallbackData(target.instanceId, target.sessionId, stringValue(item.id)),
      }]);
      await this.send(context, "Delete queued message", {
        replyMarkup: createInlineKeyboard(rows),
      });
      await this.answer(context, "Select a queued message");
      this.options.info(this.logData(context, target, { itemCount: items.length }), "chat ai session queue delete menu sent");
    } catch (error) {
      await this.fail(context, error, "Queue menu failed");
    }
  }

  private async deleteItem(context: CallbackContext, target: Extract<QueueAction, { type: "delete-item" }>) {
    if (!await this.requireAllowed(context, target.instanceId, target.sessionId)) return;
    try {
      await this.options.remove(target.instanceId, target.sessionId, target.queueId);
      await this.answer(context, "Queued message deleted");
      if (context.deleteMessage || Number.isInteger(context.messageId)) {
        await this.deleteMessage(context).catch((error) => {
          this.options.warn(
            this.logData(context, target, { messageId: context.messageId, error: errorMessage(error) }),
            "chat ai session queue delete menu message delete failed",
          );
        });
      }
      this.options.info(this.logData(context, target), "chat ai session queued message deleted");
    } catch (error) {
      await this.fail(context, error, "Delete failed");
    }
  }

  private async run(
    context: CallbackContext,
    input: {
      instanceId: string;
      sessionId: string;
      queueId?: string;
      successText: string;
      failurePrefix: string;
      logMessage: string;
      operation: () => Promise<unknown>;
    },
  ) {
    try {
      await input.operation();
      await this.answer(context, input.successText);
      this.options.info(this.logData(context, input), input.logMessage);
    } catch (error) {
      await this.fail(context, error, input.failurePrefix);
    }
  }

  private async requireAllowed(context: CallbackContext, instanceId: string, sessionId: string) {
    const allowed = context.actionAllowed
      ? context.actionAllowed(instanceId, sessionId)
      : this.options.actionAllowed(
          context.bridge,
          context.chatId,
          instanceId,
          sessionId,
          Number.isInteger(context.messageId) ? context.messageId as number : undefined,
        );
    if (allowed) return true;
    await this.answer(context, "This chat is not bound to that AI session");
    return false;
  }

  private async fail(context: CallbackContext, error: unknown, prefix: string) {
    const message = errorMessage(error);
    this.options.setBridgeError(context.bridge.id, message);
    await this.answer(context, `${prefix}: ${compactText(message, 120)}`);
  }

  private async expired(context: CallbackContext) {
    await this.answer(context, "This AI session action expired");
    return true;
  }

  private answer(context: CallbackContext, text: string) {
    return context.answer
      ? context.answer(text)
      : this.options.answer(context.bridge, context.callbackQueryId, text);
  }

  private send(context: CallbackContext, text: string, options: { replyMarkup?: ChatInlineKeyboard }) {
    return context.send
      ? context.send(text, options)
      : this.options.send(context.bridge, context.chatId, text, options);
  }

  private deleteMessage(context: CallbackContext) {
    if (context.deleteMessage) {
      return context.deleteMessage();
    }
    if (Number.isInteger(context.messageId)) {
      return this.options.deleteMessage(context.bridge, context.chatId, context.messageId as number);
    }
    return Promise.resolve(undefined);
  }

  private queueDeleteItemCallbackData(instanceId: string, sessionId: string, queueId: string) {
    return `task_handoff:cp_ai_qdel:${this.queueActionToken({ type: "delete-item", instanceId, sessionId, queueId })}`;
  }

  private queueActionToken(action: QueueAction) {
    this.pruneExpired();
    const token = tokenFor([action.type, action.instanceId, action.sessionId, "queueId" in action ? action.queueId : ""]);
    this.queueActionTokens.set(token, this.expiring(action));
    return token;
  }

  clear() {
    this.cancelTokens.clear();
    this.queueActionTokens.clear();
  }

  private expiring<T>(value: T): ExpiringToken<T> {
    return { value, expiresAt: (this.options.now || Date.now)() + (this.options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS) };
  }

  private pruneExpired() {
    const timestamp = (this.options.now || Date.now)();
    for (const [token, entry] of this.cancelTokens) if (entry.expiresAt <= timestamp) this.cancelTokens.delete(token);
    for (const [token, entry] of this.queueActionTokens) if (entry.expiresAt <= timestamp) this.queueActionTokens.delete(token);
  }

  private logData(
    context: CallbackContext,
    target: { instanceId: string; sessionId: string; queueId?: string },
    extra: Record<string, unknown> = {},
  ) {
    return {
      bridgeId: context.bridge.id,
      chatId: context.chatId,
      instanceId: target.instanceId,
      sessionId: target.sessionId,
      ...(target.queueId ? { queueId: target.queueId } : {}),
      userId: context.userId,
      ...extra,
    };
  }
}

function callbackToken(data: string, prefix: string) {
  if (!data.startsWith(prefix)) return undefined;
  const token = data.slice(prefix.length);
  return token && !token.includes(":") ? token : undefined;
}

function tokenFor(parts: string[]) {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 16);
}

function queueButtonText(message: unknown, index: number) {
  const prefix = `${index + 1}. `;
  const normalized = stringValue(message).replace(/\s+/g, " ").trim() || "Queued message";
  const budget = Math.max(8, QUEUE_BUTTON_TEXT_MAX - prefix.length);
  const chars = Array.from(normalized);
  const text = chars.length > budget ? `${chars.slice(0, Math.max(1, budget - 3)).join("")}...` : normalized;
  return `${prefix}${text}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}
