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
    if (isTransientActivity(item)) return;
    const items = this.items(providerSessionId);
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    this.cache.set(providerSessionId, items);
    this.write({ schemaVersion: 1, providerSessionId, items });
  }

  retain(providerSessionIds: Iterable<string>) {
    const retained = new Set([...providerSessionIds].map((id) => id.trim()).filter(Boolean));
    let removed = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return removed;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const filePath = path.join(this.directory, entry.name);
      let providerSessionId: string | undefined;
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        const record = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : undefined;
        providerSessionId = typeof record?.providerSessionId === "string"
          ? record.providerSessionId.trim()
          : undefined;
      } catch {
        // Invalid managed entries have no recoverable owner and are discarded.
      }
      if (providerSessionId && retained.has(providerSessionId)) continue;
      fs.unlinkSync(filePath);
      if (providerSessionId) this.cache.delete(providerSessionId);
      removed += 1;
    }
    return removed;
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
        // briefly persisted as a generic Activity. Retry warnings are likewise
        // runtime-only and must not survive adapter reconstruction.
        if (isTransientActivity(parsed.data)) continue;
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

function isTransientActivity(item: AiSessionTimelineItem) {
  return item.type === "activity" && (item.activityKind === "reasoning" || item.activityKind === "codexRetry");
}
