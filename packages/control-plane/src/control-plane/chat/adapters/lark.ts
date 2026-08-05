import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { ChatGatewaySendAdapter } from "./contracts.ts";

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
    send: async (chatId, text) => {
      if (!larkRuntime) return undefined;
      const result = await larkRuntime.channel.send(chatId, { markdown: text });
      return {
        provider: "lark",
        interactionId: result.messageId,
        raw: result,
      };
    },
  };
}
