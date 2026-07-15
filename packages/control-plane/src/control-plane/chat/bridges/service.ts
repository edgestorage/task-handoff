import {
  ChatBridgeConfigSchema,
  type ChatBridgeConfig,
  type ChatSessionBinding,
} from "@task-handoff/protocol/control-plane";
import type { JsonCollection } from "../../../shared/persistence/store.ts";
import { createId } from "../../../shared/persistence/store.ts";
import { defaultChatBridgeName, mergeChatBridgeSettings, publicChatBridge } from "./records.ts";
import { CreateChatBridgeInputSchema, UpdateChatBridgeInputSchema } from "./inputs.ts";
import { now, throwNotFound } from "../../common/helpers.ts";

export type ChatBridgeServiceOptions = {
  chatBridges: JsonCollection<ChatBridgeConfig>;
  chatSessions: JsonCollection<ChatSessionBinding>;
};

export class ChatBridgeService {
  private readonly chatBridges: JsonCollection<ChatBridgeConfig>;
  private readonly chatSessions: JsonCollection<ChatSessionBinding>;

  constructor(options: ChatBridgeServiceOptions) {
    this.chatBridges = options.chatBridges;
    this.chatSessions = options.chatSessions;
  }

  list() {
    return this.chatBridges.list().map(publicChatBridge);
  }

  require(id: string) {
    const bridge = this.chatBridges.get(id);
    if (!bridge) {
      throwNotFound("CHAT_BRIDGE_NOT_FOUND", `Chat bridge ${id} was not found.`);
    }
    return bridge;
  }

  create(input: unknown) {
    const parsedInput = CreateChatBridgeInputSchema.parse(input);
    const timestamp = now();
    const bridge = ChatBridgeConfigSchema.parse({
      ...parsedInput,
      id: createId(`chat_${parsedInput.channel}`),
      name: parsedInput.name || defaultChatBridgeName(parsedInput.channel, this.chatBridges.list().filter((item) => item.channel === parsedInput.channel).length + 1),
      enabled: parsedInput.enabled ?? false,
      allowedUserIds: parsedInput.allowedUserIds || [],
      pollIntervalMs: parsedInput.pollIntervalMs || 3000,
      settings: mergeChatBridgeSettings({}, parsedInput.settings),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.chatBridges.put(bridge);
    return publicChatBridge(bridge);
  }

  update(id: string, input: unknown) {
    const parsedInput = UpdateChatBridgeInputSchema.parse(input);
    const current = this.require(id);
    const nextSettings = mergeChatBridgeSettings(current.settings, parsedInput.settings);
    const updated = ChatBridgeConfigSchema.parse({
      ...current,
      ...parsedInput,
      id,
      channel: current.channel,
      name: parsedInput.name || current.name,
      settings: nextSettings,
      updatedAt: now(),
    });
    this.chatBridges.put(updated);
    return publicChatBridge(updated);
  }

  delete(id: string) {
    const deleted = this.chatBridges.delete(id);
    if (deleted) {
      for (const session of this.chatSessions.list()) {
        if (session.bridgeId === id) {
          this.chatSessions.delete(session.id);
        }
      }
    }
    return deleted;
  }
}
