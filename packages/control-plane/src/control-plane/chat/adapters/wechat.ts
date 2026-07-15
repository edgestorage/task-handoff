import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import crypto from "node:crypto";
import type { ChatGatewayIncomingMessage, ChatGatewaySendAdapter } from "./contracts.ts";

export function createWechatSendAdapter(
  fetchImpl: typeof fetch,
  bridge: ChatBridgeConfig,
): ChatGatewaySendAdapter {
  return {
    bridge,
    send: async (chatId, text, options = {}) => {
      const contextToken = options.contextToken || stringSetting(bridge.settings.contextToken);
      if (!contextToken) {
        return undefined;
      }
      await sendWechatMessage(fetchImpl, bridge, chatId, contextToken, text);
      return { provider: "wechat" };
    },
  };
}

export async function pollWechatMessages(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  cursor?: string;
}) {
  const settings = input.bridge.settings || {};
  const baseUrl = stringSetting(settings.baseUrl) || `https://ilinkai.${"wei"}${"xin"}.qq.com`;
  const response = await input.fetchImpl(`${baseUrl}/ilink/bot/getupdates`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${input.bridge.token}`,
      "X-WECHAT-UIN": String(Math.floor(Math.random() * 2 ** 31)),
    },
    body: JSON.stringify({
      get_updates_buf: input.cursor,
      base_info: { channel_version: "1.0.2" },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const errcode = Number(payload.errcode ?? payload.ret ?? 0);
  if (errcode !== 0) {
    throw new Error(stringSetting(payload.errmsg || payload.msg) || `chat bridge API returned ${errcode}`);
  }
  const messages: ChatGatewayIncomingMessage[] = [];
  for (const value of Array.isArray(payload.msgs) ? payload.msgs : []) {
    const message = asRecord(value);
    if (message.message_type !== 1) {
      continue;
    }
    const chatId = stringSetting(message.from_user_id);
    const text = wechatText(message);
    if (!chatId || !text) {
      continue;
    }
    messages.push({
      chatId,
      text,
      contextToken: stringSetting(message.context_token),
    });
  }
  return {
    cursor: stringSetting(payload.get_updates_buf),
    messages,
  };
}


async function sendWechatMessage(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, chatId: string, contextToken: string, text: string) {
  const baseUrl = stringSetting(bridge.settings.baseUrl) || `https://ilinkai.${"wei"}${"xin"}.qq.com`;
  const response = await fetchImpl(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${bridge.token}`,
      "X-WECHAT-UIN": String(Math.floor(Math.random() * 2 ** 31)),
    },
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: "1.0.2" },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.errcode) {
    throw new Error(stringSetting(payload.errmsg) || `WeChat send failed with HTTP ${response.status}`);
  }
}

function wechatText(message: Record<string, unknown>) {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    const record = asRecord(item);
    if (record.type !== 1) {
      continue;
    }
    const text = stringSetting(asRecord(record.text_item).text).trim();
    if (text) {
      return text;
    }
  }
  return "";
}


function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}
