import type { ChatBridgeConfig, ChatSessionBinding } from "@task-handoff/protocol/control-plane";

export function defaultChatBridgeName(channel: ChatBridgeConfig["channel"], index: number) {
  const label = channel === "telegram"
    ? "Telegram"
    : channel === "wechat"
      ? "WeChat"
      : channel === "dingding"
        ? "DingDing"
        : channel === "lark"
          ? "Lark"
          : "Web";
  return `${label} ${index}`;
}

export function chatSessionBindingId(channel: ChatSessionBinding["channel"], chatSessionId: string, bridgeId?: string) {
  const scope = bridgeId || channel;
  return `${scope}:${chatSessionId.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`;
}

export function publicChatBridge(config: ChatBridgeConfig) {
  const { token: _token, ...publicConfig } = config;
  return {
    ...publicConfig,
    settings: publicChatBridgeSettings(config.settings),
    tokenSet: Boolean(config.token),
  };
}

export function mergeChatBridgeSettings(current: Record<string, unknown>, patch: Record<string, unknown> | undefined) {
  if (!patch) {
    return current;
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function publicChatBridgeSettings(settings: Record<string, unknown>) {
  const next = { ...settings };
  if (typeof next.clientSecret === "string" && next.clientSecret) {
    delete next.clientSecret;
    next.clientSecretSet = true;
  }
  if (typeof next.appSecret === "string" && next.appSecret) {
    delete next.appSecret;
    next.appSecretSet = true;
  }
  return next;
}
