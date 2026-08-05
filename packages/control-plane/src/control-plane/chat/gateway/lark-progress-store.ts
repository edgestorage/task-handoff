import type { ChatGatewayProgressUpdate } from "../adapters/contracts.ts";
import type { LarkRuntimeState } from "../adapters/lark.ts";

type LarkProgressEntry = {
  bridgeId: string;
  messageId?: string;
  delivered?: boolean;
  lastText: string;
  lastUpdateAt: number;
  pending?: Promise<unknown>;
  pendingText?: string;
  timer?: ReturnType<typeof setTimeout>;
  cancelPending?: (error: Error) => void;
};

const LARK_PROGRESS_UPDATE_MS = 1000;
const LARK_PROGRESS_SUMMARY_MAX_CHARS = 50;

function larkProgressCard(text: string) {
  return {
    schema: "2.0",
    config: {
      summary: { content: larkProgressSummary(text) },
    },
    body: {
      elements: [{
        tag: "markdown",
        content: text,
      }],
    },
  };
}

function larkProgressSummary(text: string) {
  const summary = text.replace(/\s+/g, " ").trim();
  return summary.length <= LARK_PROGRESS_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, LARK_PROGRESS_SUMMARY_MAX_CHARS - 3)}...`;
}

export class LarkProgressStore {
  readonly entries = new Map<string, LarkProgressEntry>();
  private readonly generations = new Map<string, number>();
  private readonly updateIntervalMs: number;

  constructor(updateIntervalMs = LARK_PROGRESS_UPDATE_MS) {
    this.updateIntervalMs = updateIntervalMs;
  }

  clear() {
    for (const bridgeId of new Set([...this.generations.keys(), ...[...this.entries.values()].map((entry) => entry.bridgeId)])) {
      this.clearBridge(bridgeId);
    }
  }

  clearBridge(bridgeId: string) {
    this.generations.set(bridgeId, this.generation(bridgeId) + 1);
    for (const [key, entry] of this.entries) {
      if (entry.bridgeId !== bridgeId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.cancelPending?.(new Error("Lark progress update was cancelled."));
      this.entries.delete(key);
    }
  }

  private generation(bridgeId: string) {
    return this.generations.get(bridgeId) || 0;
  }

  private isCurrent(bridgeId: string, generation: number) {
    return this.generation(bridgeId) === generation;
  }

  async applyUpdate(input: ChatGatewayProgressUpdate, runtime: LarkRuntimeState) {
    const generation = this.generation(input.bridge.id);
    let existing = this.entries.get(input.key);
    if (existing?.pending) await existing.pending;
    if (!this.isCurrent(input.bridge.id, generation)) return false;
    existing = this.entries.get(input.key);
    if (existing?.messageId) {
      if (existing.lastText === input.text) return true;
      const elapsed = Date.now() - existing.lastUpdateAt;
      if (elapsed < this.updateIntervalMs) {
        existing.pendingText = input.text;
        if (!existing.timer) {
          existing.pending = new Promise((resolve, reject) => {
            existing.cancelPending = reject;
            existing.timer = setTimeout(() => {
              existing.timer = undefined;
              existing.cancelPending = undefined;
              const nextText = existing.pendingText;
              existing.pendingText = undefined;
              if (!nextText) return resolve(undefined);
              this.updateExistingEntry(input, runtime, existing, nextText, generation).then(resolve, reject);
            }, this.updateIntervalMs - elapsed);
          }).finally(() => {
            existing.pending = undefined;
            existing.timer = undefined;
            existing.cancelPending = undefined;
          });
        }
        await existing.pending;
        return this.isCurrent(input.bridge.id, generation) && this.entries.has(input.key);
      }
      await this.updateExistingEntry(input, runtime, existing, input.text, generation);
      return this.isCurrent(input.bridge.id, generation);
    }

    const entry: LarkProgressEntry = {
      bridgeId: input.bridge.id,
      lastText: input.text,
      lastUpdateAt: Date.now(),
    };
    entry.pending = runtime.channel.send(input.chatId, { card: larkProgressCard(input.text) }).then((result) => {
      if (!this.isCurrent(input.bridge.id, generation)) return;
      entry.messageId = result.messageId;
      entry.delivered = true;
      entry.lastUpdateAt = Date.now();
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
    runtime: LarkRuntimeState,
    entry: LarkProgressEntry,
    text: string,
    generation: number,
  ) {
    if (!entry.messageId) return;
    await runtime.channel.updateCard(entry.messageId, larkProgressCard(text));
    if (!this.isCurrent(input.bridge.id, generation)) return;
    entry.lastText = text;
    entry.lastUpdateAt = Date.now();
  }
}
