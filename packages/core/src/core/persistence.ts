import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

export const CONFIG_PATH =
  process.env.TASK_HANDOFF_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "task-handoff", "config.json");

const SettingsSchema = z.record(z.string(), z.unknown());

type TelegramToolSettings = Record<string, unknown> & {
  token?: string;
  enabled?: boolean;
  defaultChatId?: string;
  allowedUserIds?: string | string[];
};

type WechatSettings = Record<string, unknown> & {
  token?: string;
  baseUrl?: string;
  chatId?: string;
  contextToken?: string;
  updatesBuf?: string;
  conversationId?: number | string;
};

type ChatToolSettings = Record<string, unknown> & {
  token?: string;
  enabled?: boolean;
  defaultChatId?: string;
  allowedUserIds?: string | string[];
  baseUrl?: string;
  contextToken?: string;
  clientId?: string;
  clientSecret?: string;
  corpId?: string;
  robotCode?: string;
  cardTemplateId?: string;
  cardCallbackRouteKey?: string;
  cardUserIdType?: number | string;
  updatesBuf?: string;
};

type ChatBindingSettings = Record<string, unknown> & {
  conversationId?: number | string;
  contextToken?: string;
  sessionWebhook?: string;
  senderId?: string;
};

type ConversationSettingsEntry = {
  id?: number | string;
  mode?: "passive" | "codex" | "claude" | string;
  status?: "open" | "closed" | string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  cwd?: string;
  timeoutMs?: number | string;
  agent?: "codex" | "claude" | string;
  agentSessionId?: string;
  codexSessionId?: string;
};

type ConversationActivitySettingsEntry = {
  source?: string;
  activatedAt?: string;
  ownerKeys?: string[];
};

type ApprovalAutoAllowSettingsEntry = {
  enabled?: boolean;
  updatedAt?: string;
  source?: string;
};

export type Settings = Record<string, unknown> & {
  conversations?: ConversationSettingsEntry[];
  nextConversationId?: number | string;
  conversationActivity?: Record<string, ConversationActivitySettingsEntry | undefined>;
  defaultConversationId?: number | string;
  chatTools?: Record<string, Record<string, ChatToolSettings> | undefined> & {
    telegram?: Record<string, ChatToolSettings> & { default?: TelegramToolSettings };
    wechat?: Record<string, ChatToolSettings>;
    dingding?: Record<string, ChatToolSettings>;
  };
  chatBindings?: Record<string, Record<string, Record<string, ChatBindingSettings>> | undefined> & {
    telegram?: Record<string, Record<string, ChatBindingSettings>> & {
      default?: Record<string, ChatBindingSettings>;
    };
    wechat?: Record<string, Record<string, ChatBindingSettings>>;
    dingding?: Record<string, Record<string, ChatBindingSettings>>;
  };
  conversationBindings?: {
    sessions?: Record<string, number | string | undefined>;
  };
  approvalPolicy?: {
    autoAllowConversations?: Record<string, ApprovalAutoAllowSettingsEntry | undefined>;
  };
  wechat?: WechatSettings;
};

export function loadSettings(): Settings {
  try {
    return SettingsSchema.parse(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))) as Settings;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    return {};
  }
}

function mergePatch(target: Settings, patch: Record<string, unknown>): Settings {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const previous = next[key];
      next[key] = mergePatch(
        previous && typeof previous === "object" && !Array.isArray(previous) ? SettingsSchema.parse(previous) : {},
        value as Record<string, unknown>,
      );
    } else if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function saveSettings(settings: Settings) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileAtomic.sync(CONFIG_PATH, `${JSON.stringify(SettingsSchema.parse(settings), null, 2)}\n`, { mode: 0o600 });
}

export function patchSettings(patch: Record<string, unknown>) {
  const settings = mergePatch(loadSettings(), patch);
  saveSettings(settings);
  return settings;
}
