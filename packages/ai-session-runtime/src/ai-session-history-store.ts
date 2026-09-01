import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  AI_SESSION_HISTORY_DEFAULT_LIMIT,
  AI_SESSION_HISTORY_MAX_LIMIT,
  AiSessionHistoryIndexSchema,
  AiSessionHistoryDetailSchema,
  AiSessionHistoryItemSchema,
  AiSessionHistoryTurnSchema,
  type AiSessionHistoryDetail,
  type AiSessionHistoryIndex,
  type AiSessionHistoryItem,
  type AiSessionHistoryTurn,
} from "@task-handoff/protocol/ai-sessions";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

const HISTORY_INDEX_FIELDS = new Set(["schemaVersion", "items"]);
const HISTORY_ITEM_FIELDS = new Set([
  "id",
  "agent",
  "creationSource",
  "providerSessionId",
  "lineage",
  "storyId",
  "title",
  "userPrompt",
  "lastMessage",
  "cwd",
  "cwdFolderId",
  "lastActiveAt",
  "archivedAt",
]);
const HISTORY_TURN_FIELDS = new Set([
  "id",
  "providerTurnId",
  "userPrompt",
  "userMessages",
  "status",
  "phase",
  "summary",
  "lastMessage",
  "contextCompactions",
  "startedAt",
  "updatedAt",
  "completedAt",
]);

export type AiSessionHistoryWarning = {
  kind: "index" | "item" | "detail";
  id: string;
  reason: string;
};

export type AiSessionHistoryStoreOptions = {
  limit?: number;
  onWarning?: (warning: AiSessionHistoryWarning) => void;
  onRemove?: (sessionId: string) => void;
};

function historyLimit(value: number | undefined) {
  return Number.isInteger(value) && value !== undefined && value >= 1 && value <= AI_SESSION_HISTORY_MAX_LIMIT
    ? value
    : AI_SESSION_HISTORY_DEFAULT_LIMIT;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function knownFields(record: Record<string, unknown>, fields: ReadonlySet<string>) {
  return Object.fromEntries([...fields].filter((field) => Object.prototype.hasOwnProperty.call(record, field)).map((field) => [field, record[field]]));
}

function providerIdentity(item: Pick<AiSessionHistoryItem, "agent" | "providerSessionId">) {
  return `${item.agent}:${item.providerSessionId}`;
}

export function sortAndLimitAiSessionHistory(
  items: readonly AiSessionHistoryItem[],
  limit = AI_SESSION_HISTORY_DEFAULT_LIMIT,
) {
  const sorted = [...items].sort((left, right) => (
    Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt)
    || Date.parse(right.archivedAt) - Date.parse(left.archivedAt)
    || left.id.localeCompare(right.id)
  ));
  const ids = new Set<string>();
  const providerIds = new Set<string>();
  const normalized: AiSessionHistoryItem[] = [];
  for (const item of sorted) {
    const providerId = providerIdentity(item);
    if (ids.has(item.id) || providerIds.has(providerId)) continue;
    ids.add(item.id);
    providerIds.add(providerId);
    normalized.push(item);
    if (normalized.length === historyLimit(limit)) break;
  }
  return normalized;
}

export function sanitizeAiSessionHistoryIndex(
  value: unknown,
  onWarning?: (warning: AiSessionHistoryWarning) => void,
  limit = AI_SESSION_HISTORY_DEFAULT_LIMIT,
): AiSessionHistoryIndex {
  const record = recordValue(value);
  if (!record) {
    onWarning?.({ kind: "index", id: "index", reason: "invalid index replaced with an empty index" });
    return AiSessionHistoryIndexSchema.parse({});
  }
  const unknownIndexFields = Object.keys(record).filter((field) => !HISTORY_INDEX_FIELDS.has(field));
  if (unknownIndexFields.length) {
    onWarning?.({ kind: "index", id: "index", reason: `unknown fields ignored: ${unknownIndexFields.join(", ")}` });
  }
  const sourceItems = Array.isArray(record.items) ? record.items : [];
  if (!Array.isArray(record.items) && record.items !== undefined) {
    onWarning?.({ kind: "index", id: "index", reason: "invalid items replaced with an empty list" });
  }
  const items = sourceItems.flatMap((value, index) => {
    const item = recordValue(value);
    const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `item[${index}]`;
    if (!item) {
      onWarning?.({ kind: "item", id, reason: "invalid item removed" });
      return [];
    }
    const lineage = sanitizeLineage(item.lineage);
    const candidate = {
      ...knownFields(item, HISTORY_ITEM_FIELDS),
      creationSource: item.creationSource === "ai-session" ? "ai-session" : "app-session",
      ...(lineage ? { lineage } : {}),
    };
    const parsed = AiSessionHistoryItemSchema.safeParse(candidate);
    if (!parsed.success) {
      onWarning?.({ kind: "item", id, reason: "item failed current schema and was removed" });
      return [];
    }
    if (Object.keys(item).some((field) => !HISTORY_ITEM_FIELDS.has(field))) {
      onWarning?.({ kind: "item", id, reason: "unknown or legacy fields ignored" });
    }
    return [parsed.data];
  });
  const normalized = sortAndLimitAiSessionHistory(items, limit);
  if (normalized.length < items.length) {
    onWarning?.({ kind: "index", id: "index", reason: "duplicate or excess items removed" });
  }
  return AiSessionHistoryIndexSchema.parse({ schemaVersion: 1, items: normalized });
}

function sanitizeLineage(value: unknown) {
  const record = recordValue(value);
  if (!record || record.kind !== "fork" || typeof record.parentProviderSessionId !== "string") return undefined;
  return {
    kind: "fork" as const,
    parentProviderSessionId: record.parentProviderSessionId,
    ...(typeof record.throughTurnId === "string" ? { throughTurnId: record.throughTurnId } : {}),
  };
}

export class AiSessionHistoryStore {
  private readonly filePath: string;
  private readonly onWarning?: (warning: AiSessionHistoryWarning) => void;
  private readonly onRemove?: (sessionId: string) => void;
  private limit: number;

  constructor(paths: Pick<TaskHandoffStoragePaths, "dataDir">, options: AiSessionHistoryStoreOptions = {}) {
    this.filePath = path.join(paths.dataDir, "ai-session-history", "index.json");
    this.onWarning = options.onWarning;
    this.onRemove = options.onRemove;
    this.limit = historyLimit(options.limit);
  }

  path() {
    return this.filePath;
  }

  retentionLimit() {
    return this.limit;
  }

  setRetentionLimit(limit: number) {
    const nextLimit = historyLimit(limit);
    if (nextLimit !== limit) throw new Error(`AI session history limit must be an integer between 1 and ${AI_SESSION_HISTORY_MAX_LIMIT}.`);
    const current = this.list();
    this.limit = nextLimit;
    const retained = sortAndLimitAiSessionHistory(current, this.limit);
    const removed = current.filter((item) => !retained.some((candidate) => candidate.id === item.id));
    if (removed.length) {
      this.saveIndex({ schemaVersion: 1, items: retained });
      this.removeEntries(removed.map((item) => item.id));
    }
    return { limit: this.limit, removed };
  }

  list() {
    const loaded = this.load();
    if (loaded.rewrite) {
      this.saveIndex(loaded.index);
      this.removeEntries(loaded.removedIds);
    }
    return loaded.index.items;
  }

  get(id: string) {
    return this.list().find((item) => item.id === id);
  }

  detail(id: string): AiSessionHistoryDetail | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.detailPath(id), "utf8"));
    } catch (error: unknown) {
      const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
      this.onWarning?.({ kind: "detail", id, reason: `${missing ? "missing" : "unreadable"} detail replaced with empty turns` });
      return AiSessionHistoryDetailSchema.parse({ item, turns: [] });
    }
    const sanitized = this.sanitizeDetail(item, raw);
    if (sanitized.rewrite) this.saveDetail(sanitized.detail);
    return sanitized.detail;
  }

  upsert(item: AiSessionHistoryItem, turns?: readonly AiSessionHistoryTurn[]) {
    const parsed = AiSessionHistoryItemSchema.parse(item);
    const current = this.list();
    if (turns) this.saveDetail(AiSessionHistoryDetailSchema.parse({ item: parsed, turns: [...turns].slice(-50) }));
    const items = sortAndLimitAiSessionHistory([
      parsed,
      ...current.filter((entry) => entry.id !== parsed.id && providerIdentity(entry) !== providerIdentity(parsed)),
    ], this.limit);
    if (JSON.stringify(items) !== JSON.stringify(current)) this.saveIndex({ schemaVersion: 1, items });
    this.removeEntries(current.filter((entry) => !items.some((next) => next.id === entry.id)).map((entry) => entry.id));
    return parsed;
  }

  remove(id: string) {
    return this.removeByIds([id], true);
  }

  /** Removes an entry from archived history without releasing resources now owned by the active session. */
  activate(id: string) {
    return this.removeByIds([id], false);
  }

  removeIdentity(agent: AiSessionHistoryItem["agent"], providerSessionId: string) {
    return this.removeByIdentity(agent, providerSessionId, true);
  }

  /** Removes an identity from archived history without releasing resources now owned by the active session. */
  activateIdentity(agent: AiSessionHistoryItem["agent"], providerSessionId: string) {
    return this.removeByIdentity(agent, providerSessionId, false);
  }

  private removeByIds(ids: readonly string[], releaseResources: boolean) {
    const removedIds = new Set(ids);
    const items = this.list();
    const next = items.filter((item) => !removedIds.has(item.id));
    if (next.length === items.length) return false;
    this.saveIndex({ schemaVersion: 1, items: next });
    this.removeEntries(items.filter((item) => removedIds.has(item.id)).map((item) => item.id), releaseResources);
    return true;
  }

  private removeByIdentity(agent: AiSessionHistoryItem["agent"], providerSessionId: string, releaseResources: boolean) {
    const items = this.list();
    const identity = `${agent}:${providerSessionId}`;
    const next = items.filter((item) => providerIdentity(item) !== identity);
    if (next.length === items.length) return false;
    this.saveIndex({ schemaVersion: 1, items: next });
    this.removeEntries(items.filter((item) => providerIdentity(item) === identity).map((item) => item.id), releaseResources);
    return true;
  }

  private load(): { index: AiSessionHistoryIndex; rewrite: boolean; removedIds: string[] } {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { index: AiSessionHistoryIndexSchema.parse({}), rewrite: false, removedIds: [] };
      }
      this.onWarning?.({ kind: "index", id: "index", reason: "unreadable index replaced with an empty index" });
      return { index: AiSessionHistoryIndexSchema.parse({}), rewrite: false, removedIds: [] };
    }
    const index = sanitizeAiSessionHistoryIndex(raw, this.onWarning, this.limit);
    const retainedIds = new Set(index.items.map((item) => item.id));
    const source = recordValue(raw);
    const removedIds = (Array.isArray(source?.items) ? source.items : [])
      .flatMap((item) => {
        const record = recordValue(item);
        return typeof record?.id === "string" && record.id.trim() && !retainedIds.has(record.id.trim())
          ? [record.id.trim()]
          : [];
      });
    return { index, rewrite: JSON.stringify(raw) !== JSON.stringify(index), removedIds };
  }

  private saveIndex(index: AiSessionHistoryIndex) {
    const normalized = AiSessionHistoryIndexSchema.parse({
      schemaVersion: 1,
      items: sortAndLimitAiSessionHistory(index.items, this.limit),
    });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileAtomic.sync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  }

  private sanitizeDetail(item: AiSessionHistoryItem, value: unknown): { detail: AiSessionHistoryDetail; rewrite: boolean } {
    const record = recordValue(value);
    if (!record || recordValue(record.item)?.id !== item.id || !Array.isArray(record.turns)) {
      this.onWarning?.({ kind: "detail", id: item.id, reason: "invalid detail replaced with empty turns" });
      return { detail: AiSessionHistoryDetailSchema.parse({ item, turns: [] }), rewrite: true };
    }
    const turns = record.turns.flatMap((value, index) => {
      const turn = recordValue(value);
      const parsed = turn ? AiSessionHistoryTurnSchema.safeParse(knownFields(turn, HISTORY_TURN_FIELDS)) : undefined;
      if (!parsed?.success) {
        this.onWarning?.({ kind: "detail", id: item.id, reason: `invalid turn[${index}] removed` });
        return [];
      }
      return [parsed.data];
    }).slice(-50);
    const detail = AiSessionHistoryDetailSchema.parse({ item, turns });
    return { detail, rewrite: JSON.stringify(value) !== JSON.stringify(detail) };
  }

  private detailPath(id: string) {
    const file = `${crypto.createHash("sha256").update(id).digest("hex")}.json`;
    return path.join(path.dirname(this.filePath), "details", file);
  }

  private saveDetail(detail: AiSessionHistoryDetail) {
    const filePath = this.detailPath(detail.item.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic.sync(filePath, `${JSON.stringify(detail, null, 2)}\n`, { mode: 0o600 });
  }

  private removeDetails(ids: readonly string[]) {
    for (const id of ids) {
      try {
        fs.unlinkSync(this.detailPath(id));
      } catch (error: unknown) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          this.onWarning?.({ kind: "detail", id, reason: "detail cleanup failed" });
        }
      }
    }
  }

  private removeEntries(ids: readonly string[], releaseResources = true) {
    this.removeDetails(ids);
    if (releaseResources) for (const id of new Set(ids)) this.onRemove?.(id);
  }
}
