import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { ChatGatewaySendAdapter } from "./contracts.ts";
import { createDingdingSendAdapter, type DingdingRuntimeState } from "./dingding.ts";
import { createLarkSendAdapter, type LarkRuntimeState } from "./lark.ts";
import { createTelegramSendAdapter } from "./telegram.ts";
import { createWechatSendAdapter } from "./wechat.ts";

export function createChatGatewaySendAdapter(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  dingdingRuntime?: DingdingRuntimeState;
  larkRuntime?: LarkRuntimeState;
}): ChatGatewaySendAdapter {
  const { fetchImpl, bridge, dingdingRuntime, larkRuntime } = input;
  if (bridge.channel === "telegram") {
    return createTelegramSendAdapter(fetchImpl, bridge);
  }
  if (bridge.channel === "dingding") {
    return createDingdingSendAdapter(fetchImpl, bridge, dingdingRuntime);
  }
  if (bridge.channel === "lark") {
    return createLarkSendAdapter(bridge, larkRuntime);
  }
  if (bridge.channel === "wechat") {
    return createWechatSendAdapter(fetchImpl, bridge);
  }
  return {
    bridge,
    send: async () => undefined,
  };
}
