import {
  ChatSessionBindingSchema,
  type ChatSessionBinding,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneChatStore } from "../bridges/repository.ts";
import { chatSessionBindingId } from "../bridges/records.ts";
import { now, throwNotFound } from "../../common/helpers.ts";

export type ChatSessionServiceOptions = {
  store: ControlPlaneChatStore;
};

export class ChatSessionService {
  private readonly store: ControlPlaneChatStore;

  constructor(options: ChatSessionServiceOptions) {
    this.store = options.store;
  }

  list() {
    return this.store.listSessions();
  }

  require(id: string) {
    const record = this.store.getSession(id);
    if (!record) {
      throwNotFound("CHAT_SESSION_NOT_FOUND", `Chat session ${id} was not found.`);
    }
    return record;
  }

  async upsert(input: Pick<ChatSessionBinding, "channel" | "chatSessionId"> & Partial<ChatSessionBinding>) {
    const timestamp = now();
    const id = chatSessionBindingId(input.channel, input.chatSessionId, input.bridgeId);
    const current = this.store.getSession(id);
    const record = ChatSessionBindingSchema.parse({
      ...(current || {}),
      ...input,
      id,
      channel: input.channel,
      bridgeId: input.bridgeId,
      chatSessionId: input.chatSessionId,
      lastUsedAt: timestamp,
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    await this.store.putSession(record);
    return record;
  }
}
