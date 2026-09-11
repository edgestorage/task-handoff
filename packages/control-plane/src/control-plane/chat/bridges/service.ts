import {
  ChatBridgeConfigSchema,
  type ChatBridgeConfig,
  type ChatSessionBinding,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneChatStore } from "./repository.ts";
import { createId } from "../../../shared/persistence/store.ts";
import { defaultChatBridgeName, mergeChatBridgeSettings, publicChatBridge } from "./records.ts";
import { CreateChatBridgeInputSchema, UpdateChatBridgeInputSchema } from "./inputs.ts";
import { now, throwNotFound } from "../../common/helpers.ts";

export type ChatBridgeServiceOptions = {
  store: ControlPlaneChatStore;
};

export class ChatBridgeService {
  private readonly store: ControlPlaneChatStore;

  constructor(options: ChatBridgeServiceOptions) {
    this.store = options.store;
  }

  list() {
    return this.store.listBridges();
  }

  require(id: string) {
    const bridge = this.store.getPublicBridge(id);
    if (!bridge) {
      throwNotFound("CHAT_BRIDGE_NOT_FOUND", `Chat bridge ${id} was not found.`);
    }
    return bridge;
  }

  resolve(id: string) {
    const bridge = this.store.resolveBridge(id);
    if (!bridge) {
      throwNotFound("CHAT_BRIDGE_NOT_FOUND", `Chat bridge ${id} was not found.`);
    }
    return bridge;
  }

  async create(input: unknown) {
    const parsedInput = CreateChatBridgeInputSchema.parse(input);
    const timestamp = now();
    const bridge = ChatBridgeConfigSchema.parse({
      ...parsedInput,
      id: createId(`chat_${parsedInput.channel}`),
      name: parsedInput.name || defaultChatBridgeName(parsedInput.channel, this.store.listBridges().filter((item) => item.channel === parsedInput.channel).length + 1),
      enabled: parsedInput.enabled ?? false,
      allowedUserIds: parsedInput.allowedUserIds || [],
      pollIntervalMs: parsedInput.pollIntervalMs || 3000,
      settings: mergeChatBridgeSettings({}, parsedInput.settings),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.store.putBridge(bridge);
    return publicChatBridge(bridge);
  }

  async update(id: string, input: unknown) {
    const parsedInput = UpdateChatBridgeInputSchema.parse(input);
    const current = this.resolve(id);
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
    await this.store.putBridge(updated);
    return this.require(id);
  }

  async delete(id: string) {
    return this.store.deleteBridge(id);
  }
}
