import { randomUUID } from "node:crypto";
import type {
  AiSessionMessageAttachment,
  AiSessionQueuedMessage,
  AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import { compact, messageText } from "../ai-session-turns";
import {
  aiSessionAttachmentMetas,
  emptyAiSessionQueue,
  normalizeAiSessionQueueItems,
} from "./persistence";

export type AiSessionQueueServiceOptions = {
  now?: () => string;
  generateQueueId?: () => string;
};

export type AiSessionEnqueueResult = {
  session: AiSessionStatus;
  item: AiSessionQueuedMessage;
};

type QueueItemPatch = Partial<Pick<AiSessionQueuedMessage, "status" | "error">>;

function defaultQueueId() {
  return `aiq_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Owns the process-local attachment payloads for queued messages and applies
 * queue mutations to caller-provided session snapshots.
 *
 * The returned sessions are not persisted and no events are emitted. The
 * caller remains responsible for saving a returned session as the new
 * authoritative value.
 */
export class AiSessionQueueService {
  private readonly queuedAttachmentPayloads = new Map<string, AiSessionMessageAttachment[]>();
  private readonly now: () => string;
  private readonly generateQueueId: () => string;

  constructor(options: AiSessionQueueServiceOptions = {}) {
    this.now = options.now || (() => new Date().toISOString());
    this.generateQueueId = options.generateQueueId || defaultQueueId;
  }

  enqueueMessage(
    current: AiSessionStatus,
    message: string,
    attachments: AiSessionMessageAttachment[] = [],
  ): AiSessionEnqueueResult | undefined {
    const timestamp = this.now();
    const item: AiSessionQueuedMessage = {
      id: this.generateQueueId(),
      message: messageText(message),
      attachments: aiSessionAttachmentMetas(attachments),
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const session = this.withQueue(current, [...this.queuedMessages(current).items, item], timestamp);

    // Queue normalization enforces the protocol limit. Do not retain a payload
    // for an item that could not be represented in the resulting session.
    if (!session.queue.items.some((entry) => entry.id === item.id)) {
      return undefined;
    }
    if (attachments.length) {
      this.queuedAttachmentPayloads.set(item.id, attachments.slice(0, 6));
    }
    return { session, item };
  }

  queuedMessages(current: AiSessionStatus | undefined) {
    return current?.queue || emptyAiSessionQueue();
  }

  nextQueuedMessage(current: AiSessionStatus | undefined) {
    return this.queuedMessages(current).items.find((item) => item.status === "queued");
  }

  queuedMessageAttachments(queueId: string) {
    return [...(this.queuedAttachmentPayloads.get(queueId) || [])];
  }

  markQueuedMessageSending(current: AiSessionStatus, queueId: string) {
    return this.patchQueuedMessage(current, queueId, { status: "sending", error: undefined });
  }

  markQueuedMessageFailed(current: AiSessionStatus, queueId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return this.patchQueuedMessage(current, queueId, { status: "failed", error: compact(message, 4000) });
  }

  retryQueuedMessage(current: AiSessionStatus, queueId: string) {
    return this.patchQueuedMessage(current, queueId, { status: "queued", error: undefined });
  }

  removeQueuedMessage(current: AiSessionStatus, queueId: string) {
    const items = this.queuedMessages(current).items.filter((item) => item.id !== queueId);
    this.queuedAttachmentPayloads.delete(queueId);
    return this.withQueue(current, items, this.now());
  }

  reorderQueuedMessages(current: AiSessionStatus, queueIds: string[]) {
    const currentItems = this.queuedMessages(current).items;
    const byId = new Map(currentItems.map((item) => [item.id, item]));
    const ordered = queueIds
      .map((queueId) => byId.get(queueId))
      .filter((item): item is AiSessionQueuedMessage => Boolean(item));
    const requested = new Set(queueIds);
    const remaining = currentItems.filter((item) => !requested.has(item.id));
    return this.withQueue(current, [...ordered, ...remaining], this.now());
  }

  private patchQueuedMessage(current: AiSessionStatus, queueId: string, patch: QueueItemPatch) {
    const timestamp = this.now();
    let found = false;
    const items = this.queuedMessages(current).items.map((item) => {
      if (item.id !== queueId) {
        return item;
      }
      found = true;
      return { ...item, ...patch, updatedAt: timestamp };
    });
    return found ? this.withQueue(current, items, timestamp) : undefined;
  }

  private withQueue(current: AiSessionStatus, items: AiSessionQueuedMessage[], updatedAt: string): AiSessionStatus {
    return {
      ...current,
      updatedAt,
      queue: normalizeAiSessionQueueItems(items),
    };
  }
}
