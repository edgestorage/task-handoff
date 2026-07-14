import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ChannelState } from "@task-handoff/core/storage/repositories";

const CHANNEL_FILE_RE = /^(telegram|wechat|dingding)\.([^.]+)\.json$/;

function clean(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function cleanRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function receiverToolForChannel(state: ChannelState) {
  const secrets = state.secrets || {};
  if (state.channel === "telegram") {
    return cleanRecord({
      enabled: state.enabled,
      token: clean(secrets.botToken),
      allowedUserIds: state.allowedUserIds,
      defaultChatId: clean(state.defaultChatId),
    });
  }
  if (state.channel === "wechat") {
    return cleanRecord({
      enabled: state.enabled,
      token: clean(secrets.token) || clean(secrets.webhookUrl),
      baseUrl: clean(secrets.baseUrl),
      contextToken: clean(secrets.contextToken),
      updatesBuf: clean(state.state?.updatesBuf),
      defaultChatId: clean(state.defaultChatId),
    });
  }
  return cleanRecord({
    enabled: state.enabled,
    clientId: clean(secrets.clientId),
    clientSecret: clean(secrets.clientSecret),
    corpId: clean(secrets.corpId),
    robotCode: clean(secrets.robotCode),
    cardTemplateId: clean(secrets.cardTemplateId),
    cardCallbackRouteKey: clean(secrets.cardCallbackRouteKey),
    cardUserIdType: secrets.cardUserIdType,
    allowedUserIds: state.allowedUserIds,
    defaultChatId: clean(state.defaultChatId),
  });
}

function receiverBindingsForChannel(state: ChannelState) {
  const defaultChatId = clean(state.defaultChatId);
  const bindings = state.bindings || {};
  const next: Record<string, Record<string, unknown>> = {};
  for (const [chatId, binding] of Object.entries(bindings)) {
    next[chatId] = cleanRecord({
      conversationId: binding.conversationId,
      contextToken: clean(binding.contextToken),
    });
  }
  if (defaultChatId && !next[defaultChatId]) {
    next[defaultChatId] = { conversationId: 1 };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function loadReceiverSettings(configPath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveReceiverSettings(configPath: string, settings: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileAtomic.sync(configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function syncChannelStateToReceiverSettings(state: ChannelState, configPath: string) {
  const current = loadReceiverSettings(configPath);
  const currentChatTools = current.chatTools && typeof current.chatTools === "object" && !Array.isArray(current.chatTools) ? current.chatTools as Record<string, Record<string, unknown>> : {};
  const currentChatBindings =
    current.chatBindings && typeof current.chatBindings === "object" && !Array.isArray(current.chatBindings) ? current.chatBindings as Record<string, Record<string, unknown>> : {};
  const chatTools = {
    ...currentChatTools,
    [state.channel]: {
      ...(currentChatTools[state.channel] || {}),
      [state.instanceId]: receiverToolForChannel(state),
    },
  };
  const bindings = receiverBindingsForChannel(state);
  const chatBindings = {
    ...currentChatBindings,
    [state.channel]: {
      ...(currentChatBindings[state.channel] || {}),
      ...(bindings ? { [state.instanceId]: bindings } : {}),
    },
  };
  const next = {
    ...current,
    chatTools,
    chatBindings,
  };
  saveReceiverSettings(configPath, next);
  return next;
}

export function syncChannelDirectoryToReceiverSettings(channelsDir: string, configPath: string) {
  if (!fs.existsSync(channelsDir)) {
    return loadReceiverSettings(configPath);
  }
  let current = loadReceiverSettings(configPath);
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(CHANNEL_FILE_RE);
    if (!match) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(channelsDir, entry.name), "utf8")) as ChannelState;
      if (parsed.channel !== match[1] || parsed.instanceId !== match[2]) {
        continue;
      }
      current = syncChannelStateToReceiverSettings(parsed, configPath);
    } catch {
      continue;
    }
  }
  return current;
}
