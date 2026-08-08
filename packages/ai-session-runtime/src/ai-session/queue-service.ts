import { randomUUID } from "node:crypto";
import type {
  AiSessionMessageAttachment,
  AiSessionPermissionMode,
  AiSessionReference,
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

export type AiSessionQueueReorderResult =
  | { kind: "updated"; session: AiSessionStatus }
  | { kind: "unchanged"; session: AiSessionStatus }
  | { kind: "revision-conflict"; currentRevision: number }
  | { kind: "order-invalid" };

export type AiSessionQueueEditResult =
  | { kind: "updated"; session: AiSessionStatus }
  | { kind: "unchanged"; session: AiSessionStatus }
  | { kind: "revision-conflict"; currentRevision: number }
  | { kind: "not-found" }
  | { kind: "not-editable" };

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
    references: AiSessionReference[] = [],
    permissionMode?: AiSessionPermissionMode,
  ): AiSessionEnqueueResult | undefined {
    const timestamp = this.now();
    const item: AiSessionQueuedMessage = {
      id: this.generateQueueId(),
      message: messageText(message),
      attachments: aiSessionAttachmentMetas(attachments),
      references,
      ...(permissionMode ? { permissionMode } : {}),
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
    const item = this.queuedMessages(current).items.find((entry) => entry.id === queueId);
    if (!item) return undefined;
    const remaining = this.queuedMessages(current).items.filter((entry) => entry.id !== queueId);
    const timestamp = this.now();
    return this.withQueue(current, [...remaining, { ...item, status: "queued", error: undefined, updatedAt: timestamp }], timestamp);
  }

  removeQueuedMessage(current: AiSessionStatus, queueId: string) {
    if (!this.queuedMessages(current).items.some((item) => item.id === queueId)) return undefined;
    const items = this.queuedMessages(current).items.filter((item) => item.id !== queueId);
    this.queuedAttachmentPayloads.delete(queueId);
    return this.withQueue(current, items, this.now());
  }

  editQueuedMessage(current: AiSessionStatus, queueId: string, expectedRevision: number, message: string): AiSessionQueueEditResult {
    if (current.queue.revision !== expectedRevision) {
      return { kind: "revision-conflict", currentRevision: current.queue.revision };
    }
    const item = this.queuedMessages(current).items.find((entry) => entry.id === queueId);
    if (!item) return { kind: "not-found" };
    if (item.status !== "queued") return { kind: "not-editable" };
    const normalizedMessage = messageText(message);
    if (item.message === normalizedMessage) return { kind: "unchanged", session: current };
    const timestamp = this.now();
    const items = this.queuedMessages(current).items.map((entry) => entry.id === queueId
      ? { ...entry, message: normalizedMessage, updatedAt: timestamp }
      : entry);
    return { kind: "updated", session: this.withQueue(current, items, timestamp) };
  }

  reorderQueuedMessages(current: AiSessionStatus, expectedRevision: number, queueIds: string[]): AiSessionQueueReorderResult {
    if (current.queue.revision !== expectedRevision) {
      return { kind: "revision-conflict", currentRevision: current.queue.revision };
    }
    const currentItems = this.queuedMessages(current).items;
    const queuedItems = currentItems.filter((item) => item.status === "queued");
    const requested = new Set(queueIds);
    if (requested.size !== queueIds.length
      || queueIds.length !== queuedItems.length
      || queuedItems.some((item) => !requested.has(item.id))) {
      return { kind: "order-invalid" };
    }
    if (queuedItems.every((item, index) => item.id === queueIds[index])) {
      return { kind: "unchanged", session: current };
    }
    const byId = new Map(queuedItems.map((item) => [item.id, item]));
    const ordered = queueIds.map((queueId) => byId.get(queueId)!);
    const nonQueued = currentItems.filter((item) => item.status !== "queued");
    return { kind: "updated", session: this.withQueue(current, [...nonQueued, ...ordered], this.now()) };
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
      queue: normalizeAiSessionQueueItems(items, current.queue.revision + 1),
    };
  }
}
