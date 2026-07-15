import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { ChatGatewaySendAdapter } from "./contracts.ts";
import { createDingdingSendAdapter, type DingdingRuntimeState } from "./dingding.ts";
import { createTelegramSendAdapter } from "./telegram.ts";
import { createWechatSendAdapter } from "./wechat.ts";

export function createChatGatewaySendAdapter(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  dingdingRuntime?: DingdingRuntimeState;
}): ChatGatewaySendAdapter {
  const { fetchImpl, bridge, dingdingRuntime } = input;
  if (bridge.channel === "telegram") {
    return createTelegramSendAdapter(fetchImpl, bridge);
  }
  if (bridge.channel === "dingding") {
    return createDingdingSendAdapter(fetchImpl, bridge, dingdingRuntime);
  }
  if (bridge.channel === "wechat") {
    return createWechatSendAdapter(fetchImpl, bridge);
  }
  return {
    bridge,
    send: async () => undefined,
  };
}
