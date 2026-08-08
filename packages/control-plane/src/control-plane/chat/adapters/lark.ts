import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import {
  chatActionIdToCallbackData,
  inlineKeyboardToActions,
  type ChatInlineKeyboard,
} from "@task-handoff/core/core/chat-interactions";
import type { ChatGatewaySendAdapter } from "./contracts.ts";

const LARK_PROGRESS_SUMMARY_MAX_CHARS = 50;
const LARK_ACTION_ID_KEY = "task_handoff_action_id";

export type LarkChannelLike = Pick<LarkChannel, "connect" | "disconnect" | "on" | "send" | "updateCard" | "rawWsClient">;

export type LarkRuntimeState = {
  channel: LarkChannelLike;
};

export function createLarkSendAdapter(
  bridge: ChatBridgeConfig,
  larkRuntime?: LarkRuntimeState,
): ChatGatewaySendAdapter {
  return {
    bridge,
    send: async (chatId, text, options = {}) => {
      if (!larkRuntime) return undefined;
      const result = await larkRuntime.channel.send(
        chatId,
        options.replyMarkup
          ? { card: larkCard(text, options.replyMarkup) }
          : { markdown: text },
      );
      return {
        provider: "lark",
        interactionId: result.messageId,
        raw: result,
      };
    },
  };
}

export function larkCard(text: string, replyMarkup?: ChatInlineKeyboard) {
  const actions = inlineKeyboardToActions(replyMarkup);
  return {
    schema: "2.0",
    config: {
      summary: { content: larkCardSummary(text) },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
        ...actions.map((action) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: action.text,
          },
          type: larkButtonType(action.text),
          width: "fill",
          size: "medium",
          behaviors: [{
            type: "callback",
            value: { [LARK_ACTION_ID_KEY]: action.id },
          }],
        })),
      ],
    },
  };
}

export function larkCallbackData(value: unknown) {
  const record = asRecord(value);
  return chatActionIdToCallbackData(
    record[LARK_ACTION_ID_KEY] || record.action_id || record.actionId || record.id || value,
  );
}

export function larkActionsFingerprint(replyMarkup: ChatInlineKeyboard | undefined) {
  return JSON.stringify(inlineKeyboardToActions(replyMarkup));
}

function larkCardSummary(text: string) {
  const summary = text.replace(/\s+/g, " ").trim();
  return summary.length <= LARK_PROGRESS_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, LARK_PROGRESS_SUMMARY_MAX_CHARS - 3)}...`;
}

function larkButtonType(text: string) {
  const normalized = text.trim().toLowerCase();
  if (["deny", "cancel", "delete", "remove"].some((keyword) => normalized.includes(keyword))) {
    return "danger";
  }
  if (["allow", "approve", "launch", "open"].some((keyword) => normalized.includes(keyword))) {
    return "primary";
  }
  return "default";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
