import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  AiSessionTimelineItemSchema,
  type AiSessionTimelineItem,
} from "@task-handoff/protocol/ai-sessions";

type StoredCodexTimeline = {
  schemaVersion: 1;
  providerSessionId: string;
  items: AiSessionTimelineItem[];
};

/**
 * Durable adapter-owned projection of Codex's authoritative single-item events.
 * Codex 0.144 and earlier cannot reconstruct every tool item through thread/read,
 * so this store preserves exactly the minimal Timeline wire projection we receive.
 */
export class CodexTimelineStore {
  private readonly cache = new Map<string, AiSessionTimelineItem[]>();

  constructor(private readonly directory: string) {}

  items(providerSessionId: string) {
    const cached = this.cache.get(providerSessionId);
    if (cached) return [...cached];
    const loaded = this.read(providerSessionId);
    this.cache.set(providerSessionId, loaded);
    return [...loaded];
  }

  upsert(providerSessionId: string, item: AiSessionTimelineItem) {
    if (isReasoningActivity(item)) return;
    const items = this.items(providerSessionId);
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    this.cache.set(providerSessionId, items);
    this.write({ schemaVersion: 1, providerSessionId, items });
  }

  private read(providerSessionId: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath(providerSessionId), "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const record = raw as Record<string, unknown>;
      if (record.schemaVersion !== 1 || record.providerSessionId !== providerSessionId || !Array.isArray(record.items)) return [];
      const items: AiSessionTimelineItem[] = [];
      const indexes = new Map<string, number>();
      for (const value of record.items) {
        const parsed = AiSessionTimelineItemSchema.safeParse(value);
        if (!parsed.success) continue;
        // Compatibility for pre-v0.0.22 development builds: Reasoning was
        // briefly persisted as a generic Activity before the adapter boundary
        // excluded it from Timeline entirely.
        if (isReasoningActivity(parsed.data)) continue;
        const index = indexes.get(parsed.data.id);
        if (index === undefined) {
          indexes.set(parsed.data.id, items.length);
          items.push(parsed.data);
        } else {
          items[index] = parsed.data;
        }
      }
      return items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      return [];
    }
  }

  private write(value: StoredCodexTimeline) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(this.filePath(value.providerSessionId), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  private filePath(providerSessionId: string) {
    const key = crypto.createHash("sha256").update(providerSessionId).digest("hex");
    return path.join(this.directory, `${key}.json`);
  }
}

function isReasoningActivity(item: AiSessionTimelineItem) {
  return item.type === "activity" && item.activityKind === "reasoning";
}
