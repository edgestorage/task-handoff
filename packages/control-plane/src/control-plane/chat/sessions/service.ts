import {
  ChatSessionBindingSchema,
  type ChatSessionBinding,
} from "@task-handoff/protocol/control-plane";
import type { JsonCollection } from "../../../shared/persistence/store.ts";
import { chatSessionBindingId } from "../bridges/records.ts";
import { now, throwNotFound } from "../../common/helpers.ts";

export type ChatSessionServiceOptions = {
  chatSessions: JsonCollection<ChatSessionBinding>;
};

export class ChatSessionService {
  private readonly chatSessions: JsonCollection<ChatSessionBinding>;

  constructor(options: ChatSessionServiceOptions) {
    this.chatSessions = options.chatSessions;
  }

  list() {
    return this.chatSessions.list();
  }

  require(id: string) {
    const record = this.chatSessions.get(id);
    if (!record) {
      throwNotFound("CHAT_SESSION_NOT_FOUND", `Chat session ${id} was not found.`);
    }
    return record;
  }

  upsert(input: Pick<ChatSessionBinding, "channel" | "chatSessionId"> & Partial<ChatSessionBinding>) {
    const timestamp = now();
    const id = chatSessionBindingId(input.channel, input.chatSessionId, input.bridgeId);
    const current = this.chatSessions.get(id);
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
    this.chatSessions.put(record);
    return record;
  }
}
