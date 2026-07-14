import path from "node:path";
import { z } from "zod";
import { DomainStore } from "./domain-store";
import { resolveStoragePaths } from "./paths";

const ChannelStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  channel: z.enum(["telegram", "wechat", "dingding"]),
  instanceId: z.string().default("default"),
  enabled: z.boolean().default(false),
  defaultChatId: z.string().optional(),
  allowedUserIds: z.array(z.string()).optional(),
  bindings: z.record(z.string(), z.object({ conversationId: z.number(), contextToken: z.string().optional() })).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
});

const ConversationIndexSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  defaultConversationId: z.number().default(1),
  nextConversationId: z.number().default(2),
  items: z.array(z.record(z.string(), z.unknown())).default([]),
});

const AppSessionIndexSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  items: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type ChannelState = z.infer<typeof ChannelStateSchema>;

export function createStorageRepositories() {
  const paths = resolveStoragePaths();
  return {
    paths,
    channel(channel: "telegram" | "wechat" | "dingding", instanceId = "default") {
      return new DomainStore<ChannelState>(path.join(paths.channelsDir, `${channel}.${instanceId}.json`), {
        schema: ChannelStateSchema,
        defaultValue: () => ({ schemaVersion: 1, channel, instanceId, enabled: false }),
      });
    },
    conversationIndex() {
      return new DomainStore(path.join(paths.conversationsDir, "index.json"), {
        schema: ConversationIndexSchema,
        defaultValue: () => ({ schemaVersion: 1, defaultConversationId: 1, nextConversationId: 2, items: [] }),
      });
    },
    appSessionIndex() {
      return new DomainStore(path.join(paths.appSessionsDir, "index.json"), {
        schema: AppSessionIndexSchema,
        defaultValue: () => ({ schemaVersion: 1, items: [] }),
      });
    },
  };
}
