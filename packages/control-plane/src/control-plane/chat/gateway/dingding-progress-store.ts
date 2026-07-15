import type { ChatInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import type { ChatGatewayProgressUpdate } from "../adapters/contracts.ts";
import {
  dingdingActionsFingerprint,
  sendDingdingActionsCard,
  updateDingdingActionsCard,
  type DingdingRuntimeState,
} from "../adapters/dingding.ts";

type DingdingProgressEntry = {
  bridgeId: string;
  outTrackId?: string;
  delivered?: boolean;
  lastText: string;
  lastActionsFingerprint: string;
  lastUpdateAt: number;
  pending?: Promise<unknown>;
  pendingText?: string;
  pendingReplyMarkup?: ChatInlineKeyboard;
  timer?: ReturnType<typeof setTimeout>;
  cancelPending?: (error: Error) => void;
};

const DINGDING_PROGRESS_UPDATE_MS = 1000;

export class DingdingProgressStore {
  readonly entries = new Map<string, DingdingProgressEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly generations = new Map<string, number>();

  constructor(fetchImpl: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }

  clear() {
    for (const bridgeId of new Set([...this.generations.keys(), ...[...this.entries.values()].map((entry) => entry.bridgeId)])) {
      this.clearBridge(bridgeId);
    }
  }

  clearBridge(bridgeId: string) {
    this.generations.set(bridgeId, this.generation(bridgeId) + 1);
    this.clearEntries((entry) => entry.bridgeId === bridgeId);
  }

  private generation(bridgeId: string) {
    return this.generations.get(bridgeId) || 0;
  }

  private isCurrent(bridgeId: string, generation: number) {
    return this.generation(bridgeId) === generation;
  }

  private clearEntries(matches: (entry: DingdingProgressEntry) => boolean) {
    for (const [key, entry] of this.entries) {
      if (!matches(entry)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.cancelPending?.(new Error("DingDing progress update was cancelled."));
      this.entries.delete(key);
    }
  }

  async applyUpdate(input: ChatGatewayProgressUpdate, runtime: DingdingRuntimeState) {
    const generation = this.generation(input.bridge.id);
    const nextActionsFingerprint = dingdingActionsFingerprint(input.replyMarkup);
    let existing = this.entries.get(input.key);
    if (existing?.pending) await existing.pending;
    if (!this.isCurrent(input.bridge.id, generation)) return false;
    existing = this.entries.get(input.key);
    if (existing?.outTrackId) {
      if (existing.lastText === input.text && existing.lastActionsFingerprint === nextActionsFingerprint) return true;
      const elapsed = Date.now() - (existing.lastUpdateAt || 0);
      if (elapsed < DINGDING_PROGRESS_UPDATE_MS) {
        existing.pendingText = input.text;
        existing.pendingReplyMarkup = input.replyMarkup;
        if (!existing.timer) {
          existing.pending = new Promise((resolve, reject) => {
            existing.cancelPending = reject;
            existing.timer = setTimeout(() => {
              existing.timer = undefined;
              existing.cancelPending = undefined;
              const nextText = existing.pendingText;
              const nextReplyMarkup = existing.pendingReplyMarkup;
              existing.pendingText = undefined;
              existing.pendingReplyMarkup = undefined;
              if (!nextText) return resolve(undefined);
              this.updateExistingEntry(input, runtime, existing, nextText, nextReplyMarkup, dingdingActionsFingerprint(nextReplyMarkup), generation).then(resolve, reject);
            }, DINGDING_PROGRESS_UPDATE_MS - elapsed);
          }).finally(() => {
            existing.pending = undefined;
            existing.timer = undefined;
            existing.cancelPending = undefined;
          });
        }
        await existing.pending;
        return this.isCurrent(input.bridge.id, generation) && this.entries.has(input.key);
      }
      await this.updateExistingEntry(input, runtime, existing, input.text, input.replyMarkup, nextActionsFingerprint, generation);
      return this.isCurrent(input.bridge.id, generation);
    }
    const entry: DingdingProgressEntry = {
      bridgeId: input.bridge.id,
      lastText: input.text,
      lastActionsFingerprint: nextActionsFingerprint,
      lastUpdateAt: Date.now(),
    };
    entry.pending = sendDingdingActionsCard({
      fetchImpl: this.fetchImpl,
      bridge: input.bridge,
      runtime,
      chatId: input.chatId,
      text: input.text,
      replyMarkup: input.replyMarkup,
      sessionWebhook: runtime.chatWebhooks.get(input.chatId) || stringSetting(input.bridge.settings.sessionWebhook),
      senderId: runtime.senderIds.get(input.chatId) || stringSetting(input.bridge.settings.senderId),
      title: "TaskHandoff 执行中",
      step: "progress",
      forceCard: true,
    }).then((result) => {
      if (!this.isCurrent(input.bridge.id, generation)) return;
      if (result?.outTrackId) entry.outTrackId = result.outTrackId;
      if (result?.delivered) {
        entry.delivered = true;
        entry.lastUpdateAt = Date.now();
      }
    }).catch((error) => {
      if (this.isCurrent(input.bridge.id, generation)) this.entries.delete(input.key);
      throw error;
    }).finally(() => {
      entry.pending = undefined;
    });
    this.entries.set(input.key, entry);
    await entry.pending;
    return this.isCurrent(input.bridge.id, generation) && Boolean(entry.delivered);
  }

  private async updateExistingEntry(
    input: ChatGatewayProgressUpdate,
    runtime: DingdingRuntimeState,
    entry: DingdingProgressEntry,
    text: string,
    replyMarkup: ChatInlineKeyboard | undefined,
    actionsFingerprint: string,
    generation: number,
  ) {
    if (!entry.outTrackId) return;
    await updateDingdingActionsCard({
      fetchImpl: this.fetchImpl,
      bridge: input.bridge,
      runtime,
      outTrackId: entry.outTrackId,
      text,
      replyMarkup,
      title: "TaskHandoff 执行中",
      step: "progress",
    });
    if (!this.isCurrent(input.bridge.id, generation)) return;
    entry.lastText = text;
    entry.lastActionsFingerprint = actionsFingerprint;
    entry.lastUpdateAt = Date.now();
  }
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}
