import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONVERSATION_ID } from "@task-handoff/core/core/config";
import { loadSettings, patchSettings } from "@task-handoff/core/core/persistence";
import { normalizeConversations } from "@task-handoff/core/core/conversations";
import { DomainStore } from "@task-handoff/core/storage/domain-store";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

const ConversationModeSchema = z.enum(["passive", "codex", "claude"]);
const ConversationStatusSchema = z.enum(["open", "closed"]);
const ConversationAgentSchema = z.enum(["codex", "claude"]);

const ConversationRecordSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.number().int().positive(),
  mode: ConversationModeSchema.default("passive"),
  status: ConversationStatusSchema.default("open"),
  title: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  agent: ConversationAgentSchema.optional(),
  agentSessionId: z.string().optional(),
  codexSessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});

const ConversationIndexItemSchema = z.object({
  id: z.number().int().positive(),
  status: ConversationStatusSchema.default("open"),
  mode: ConversationModeSchema.default("passive"),
  title: z.string().optional(),
  updatedAt: z.string(),
});

const ConversationIndexSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  defaultConversationId: z.number().int().positive().default(DEFAULT_CONVERSATION_ID),
  nextConversationId: z.number().int().positive().default(DEFAULT_CONVERSATION_ID + 1),
  items: z.array(ConversationIndexItemSchema).default([]),
});

const ConversationPatchSchema = z.object({
  mode: ConversationModeSchema.optional(),
  status: ConversationStatusSchema.optional(),
  title: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  timeoutMs: z.number().positive().optional(),
  agent: ConversationAgentSchema.optional(),
  agentSessionId: z.string().trim().min(1).optional(),
  codexSessionId: z.string().trim().min(1).optional(),
});

export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
export type ConversationIndex = z.infer<typeof ConversationIndexSchema>;
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>;

function now() {
  return new Date().toISOString();
}

function parseConversationId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function toNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function compactPatch(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactPatch);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
        .map(([key, entry]) => [key, compactPatch(entry)]),
    );
  }
  return value;
}

function indexItem(record: ConversationRecord) {
  return {
    id: record.id,
    status: record.status,
    mode: record.mode,
    title: record.title,
    updatedAt: record.updatedAt,
  };
}

export class ConversationStore {
  private readonly indexStore: DomainStore<ConversationIndex>;

  constructor(private readonly paths: TaskHandoffStoragePaths) {
    this.indexStore = new DomainStore(path.join(paths.conversationsDir, "index.json"), {
      schema: ConversationIndexSchema,
      defaultValue: () => ({ schemaVersion: 1, defaultConversationId: DEFAULT_CONVERSATION_ID, nextConversationId: DEFAULT_CONVERSATION_ID + 1, items: [] }),
    });
  }

  indexPath() {
    return this.indexStore.path();
  }

  list() {
    const index = this.ensureSeeded();
    const records = index.items
      .map((item) => this.loadRecord(item.id))
      .filter((record): record is ConversationRecord => Boolean(record))
      .sort((a, b) => a.id - b.id);
    return {
      schemaVersion: 1 as const,
      defaultConversationId: index.defaultConversationId,
      nextConversationId: index.nextConversationId,
      indexPath: this.indexStore.path(),
      items: records,
    };
  }

  get(id: number) {
    this.ensureSeeded();
    return this.loadRecord(id);
  }

  create(patch: Record<string, unknown> = {}) {
    const index = this.ensureSeeded();
    const timestamp = now();
    const id = parseConversationId(patch.id) || index.nextConversationId;
    if (this.loadRecord(id)) {
      throw Object.assign(new Error(`Conversation ${id} already exists.`), { code: "CONVERSATION_EXISTS" });
    }
    const parsed = ConversationPatchSchema.parse(compactPatch(patch));
    const record = ConversationRecordSchema.parse({
      schemaVersion: 1,
      id,
      mode: parsed.mode || "passive",
      status: parsed.status || "open",
      title: parsed.title,
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
      agent: parsed.agent || (parsed.mode === "codex" || parsed.mode === "claude" ? parsed.mode : undefined),
      agentSessionId: parsed.agentSessionId,
      codexSessionId: parsed.codexSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.saveRecord(record);
    this.saveIndex({
      ...index,
      nextConversationId: Math.max(index.nextConversationId, id + 1),
      items: [...index.items, indexItem(record)].sort((a, b) => a.id - b.id),
    });
    return record;
  }

  update(id: number, patch: Record<string, unknown>) {
    const record = this.getRequired(id);
    const parsed = ConversationPatchSchema.parse(compactPatch(patch));
    const timestamp = now();
    const next = ConversationRecordSchema.parse({
      ...record,
      ...parsed,
      agent: parsed.agent || (parsed.mode === "codex" || parsed.mode === "claude" ? parsed.mode : record.agent),
      updatedAt: timestamp,
      closedAt: parsed.status === "closed" ? record.closedAt || timestamp : parsed.status === "open" ? undefined : record.closedAt,
    });
    this.saveRecord(next);
    this.updateIndexItem(next);
    return next;
  }

  use(id: number) {
    const record = this.getRequired(id);
    const index = this.ensureSeeded();
    this.saveIndex({ ...index, defaultConversationId: id });
    patchSettings({ defaultConversationId: id });
    return record;
  }

  close(id: number) {
    return this.update(id, { status: "closed" });
  }

  reopen(id: number) {
    return this.update(id, { status: "open" });
  }

  delete(id: number) {
    const index = this.ensureSeeded();
    if (id === index.defaultConversationId) {
      throw Object.assign(new Error("Default conversation cannot be deleted."), { code: "CONVERSATION_DEFAULT" });
    }
    const record = this.getRequired(id);
    const filePath = this.recordPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.saveIndex({
      ...index,
      items: index.items.filter((item) => item.id !== id),
    });
    return record;
  }

  private ensureSeeded() {
    if (fs.existsSync(this.indexStore.path())) {
      return this.indexStore.load();
    }

    const settings = loadSettings();
    const normalized = normalizeConversations(settings);
    const records = normalized.conversations.map((conversation) =>
      ConversationRecordSchema.parse({
        schemaVersion: 1,
        ...conversation,
        agentSessionId: conversation.agentSessionId,
        codexSessionId: conversation.codexSessionId,
      }),
    );
    for (const record of records) {
      this.saveRecord(record);
    }
    const defaultConversationId = parseConversationId(settings.defaultConversationId) || normalized.defaultConversationId || DEFAULT_CONVERSATION_ID;
    const index = ConversationIndexSchema.parse({
      schemaVersion: 1,
      defaultConversationId,
      nextConversationId: normalized.nextConversationId,
      items: records.map(indexItem),
    });
    this.saveIndex(index);
    patchSettings({ defaultConversationId });
    return index;
  }

  private getRequired(id: number) {
    const record = this.get(id);
    if (!record) {
      throw Object.assign(new Error("Conversation not found."), { code: "CONVERSATION_NOT_FOUND" });
    }
    return record;
  }

  private recordPath(id: number) {
    return path.join(this.paths.conversationsDir, `conversation-${id}.json`);
  }

  private loadRecord(id: number) {
    const filePath = this.recordPath(id);
    try {
      return ConversationRecordSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private saveRecord(record: ConversationRecord) {
    const store = new DomainStore(this.recordPath(record.id), {
      schema: ConversationRecordSchema,
      defaultValue: () => record,
    });
    store.save(record);
  }

  private saveIndex(index: ConversationIndex) {
    this.indexStore.save(ConversationIndexSchema.parse(index));
  }

  private updateIndexItem(record: ConversationRecord) {
    const index = this.ensureSeeded();
    this.saveIndex({
      ...index,
      items: index.items.map((item) => (item.id === record.id ? indexItem(record) : item)).sort((a, b) => a.id - b.id),
    });
  }
}

export function conversationIdParam(value: string) {
  const id = parseConversationId(value);
  if (!id) {
    throw Object.assign(new Error("Conversation id must be a positive integer."), { code: "CONVERSATION_ID_INVALID" });
  }
  return id;
}
