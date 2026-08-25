import {
  AiSessionLineageSchema,
  AiSessionMessageAttachmentMetaSchema,
  AiSessionQueuedMessageSchema,
  AiSessionReferenceSchema,
  AiSessionStatusSchema,
  AiSessionSubAgentSchema,
  AiSessionToolSchema,
  AiSessionTurnSchema,
} from "@task-handoff/protocol/ai-sessions";
import type {
  AiSessionLifecycle,
  AiSessionMessageAttachment,
  AiSessionMessageAttachmentMeta,
  AiSessionPhase,
  AiSessionQueuedMessage,
  AiSessionReference,
  AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import { compact, messageText, normalizeTurns } from "../ai-session-turns";

const PERSISTED_AI_SESSION_FIELD_NAMES = [
  "id", "agent", "creationSource", "appSessionId", "appId", "providerSessionId", "lineage", "providerMeta", "appBindingKeys", "actions",
  "activeTurnId", "title", "cwd", "cwdFolderId", "userPrompt", "turns", "status", "phase", "summary", "lastMessage", "lastMessageItemId",
  "currentTool", "toolCallsSinceLastMessage", "subAgents", "transcriptPath", "transcriptSize", "startedAt", "updatedAt",
  "completedAt", "error", "counters", "queue",
] as const satisfies readonly (keyof AiSessionStatus)[];

const PERSISTED_SESSION_FIELDS = new Set<string>(PERSISTED_AI_SESSION_FIELD_NAMES);

export type PersistedAiSession = Pick<AiSessionStatus, typeof PERSISTED_AI_SESSION_FIELD_NAMES[number]>;

const PERSISTED_TOOL_FIELDS = new Set(Object.keys(AiSessionToolSchema.shape));
const PERSISTED_SUB_AGENT_FIELDS = new Set(Object.keys(AiSessionSubAgentSchema.shape));
const PERSISTED_QUEUE_ITEM_FIELDS = new Set(Object.keys(AiSessionQueuedMessageSchema.shape));
const PERSISTED_ATTACHMENT_META_FIELDS = new Set(Object.keys(AiSessionMessageAttachmentMetaSchema.shape));

function warnUnknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, context: string) {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) {
    console.warn(`[ai-session] Ignoring unknown ${context} fields: ${unknown.join(", ")}`);
  }
}

export function normalizeAiSessionCounters(counters?: Partial<AiSessionStatus["counters"]>): AiSessionStatus["counters"] {
  return {
    toolCalls: Math.max(0, Number(counters?.toolCalls) || 0),
    edits: Math.max(0, Number(counters?.edits) || 0),
    approvals: Math.max(0, Number(counters?.approvals) || 0),
  };
}

function normalizeNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizeTool(value: unknown): AiSessionStatus["currentTool"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  warnUnknownFields(record, PERSISTED_TOOL_FIELDS, "currentTool");
  if (typeof record.name !== "string" || !record.name.trim()) {
    return undefined;
  }
  const candidate = {
    ...(typeof record.id === "string" && record.id.trim() ? { id: compact(record.id, 240) } : {}),
    ...(typeof record.kind === "string" && record.kind.trim() ? { kind: compact(record.kind, 80) } : {}),
    name: compact(record.name, 120),
    ...(typeof record.inputPreview === "string" && record.inputPreview.trim() ? { inputPreview: compact(record.inputPreview, 500) } : {}),
    ...(typeof record.startedAt === "string" && AiSessionToolSchema.shape.startedAt.safeParse(record.startedAt).success
      ? { startedAt: record.startedAt }
      : {}),
  };
  const parsed = AiSessionToolSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeAiSessionSubAgents(value: unknown): AiSessionStatus["subAgents"] {
  if (!Array.isArray(value)) return [];
  const byThreadId = new Map<string, AiSessionStatus["subAgents"][number]>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    warnUnknownFields(record, PERSISTED_SUB_AGENT_FIELDS, "subAgent");
    const candidate = {
      ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof record.activity === "string" ? { activity: record.activity } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    };
    const parsed = AiSessionSubAgentSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const previous = byThreadId.get(parsed.data.threadId);
    if (!previous || Date.parse(parsed.data.updatedAt) >= Date.parse(previous.updatedAt)) {
      byThreadId.set(parsed.data.threadId, parsed.data);
    }
  }
  return [...byThreadId.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.threadId.localeCompare(right.threadId))
    .slice(0, 50);
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value.map((item) => compact(item, maxLength)).filter(Boolean))].slice(0, maxItems);
  return items.length ? items : undefined;
}

function normalizeActions(value: unknown): AiSessionStatus["actions"] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const actions = {
    send: typeof record.send === "boolean" ? record.send : undefined,
    interrupt: typeof record.interrupt === "boolean" ? record.interrupt : undefined,
    approval: typeof record.approval === "boolean" ? record.approval : undefined,
    fork: typeof record.fork === "boolean" ? record.fork : undefined,
    openApp: typeof record.openApp === "boolean" ? record.openApp : undefined,
    close: typeof record.close === "boolean" ? record.close : undefined,
  };
  return Object.values(actions).every((action) => action === undefined) ? undefined : actions;
}

export function emptyAiSessionQueue(): AiSessionStatus["queue"] {
  return { revision: 0, pendingCount: 0, items: [] };
}

export function normalizeAiSessionQueueItems(items: AiSessionQueuedMessage[], revision: unknown = 0): AiSessionStatus["queue"] {
  const normalizedItems = items
    .map(normalizeQueuedMessage)
    .filter((item): item is AiSessionQueuedMessage => Boolean(item))
    .slice(0, 100)
    .sort((left, right) => queueStatusRank(left.status) - queueStatusRank(right.status));
  return {
    revision: normalizeNonNegativeInteger(revision),
    pendingCount: normalizedItems.filter((item) => item.status === "queued" || item.status === "sending").length,
    items: normalizedItems,
  };
}

export function normalizeAiSessionQueue(value: unknown): AiSessionStatus["queue"] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as { revision?: unknown; items?: unknown } : {};
  return normalizeAiSessionQueueItems(
    Array.isArray(record.items) ? record.items as AiSessionQueuedMessage[] : [],
    record.revision,
  );
}

function queueStatusRank(status: AiSessionQueuedMessage["status"]) {
  return status === "sending" ? 0 : status === "queued" ? 1 : 2;
}

function normalizeQueuedMessage(value: unknown): AiSessionQueuedMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  warnUnknownFields(record, PERSISTED_QUEUE_ITEM_FIELDS, "queue item");
  if (typeof record.id !== "string" || typeof record.message !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    return undefined;
  }
  const candidate = {
    id: compact(record.id, 120),
    ...(typeof record.messageId === "string" && record.messageId.trim() ? { messageId: compact(record.messageId, 240) } : {}),
    message: messageText(record.message),
    attachments: normalizeAiSessionMessageAttachmentMetas(record.attachments),
    references: normalizeAiSessionReferences(record.references),
    ...(record.permissionMode === "ask" || record.permissionMode === "auto-review" || record.permissionMode === "full-access"
      ? { permissionMode: record.permissionMode }
      : {}),
    status: record.status === "sending" || record.status === "failed" ? record.status : "queued",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.error === "string" && record.error ? { error: compact(record.error, 4000) } : {}),
  };
  const parsed = AiSessionQueuedMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeAiSessionReferences(value: unknown): AiSessionReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = AiSessionReferenceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 20);
}

export function normalizeAiSessionMessageAttachmentMetas(value: unknown): AiSessionMessageAttachmentMeta[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      warnUnknownFields(record, PERSISTED_ATTACHMENT_META_FIELDS, "queue attachment");
      const candidate = {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
        ...(typeof record.size === "number" ? { size: record.size } : {}),
        sourceType: record.sourceType === "runtime-path" ? "runtime-path" : "inline",
      };
      const parsed = AiSessionMessageAttachmentMetaSchema.safeParse(candidate);
      return parsed.success ? parsed.data : undefined;
    })
    .filter((item): item is AiSessionMessageAttachmentMeta => Boolean(item))
    .slice(0, 6);
}

export function aiSessionAttachmentMetas(attachments: AiSessionMessageAttachment[] = []): AiSessionMessageAttachmentMeta[] {
  return attachments.slice(0, 6).map((attachment) => AiSessionMessageAttachmentMetaSchema.parse({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    sourceType: attachment.source.type,
  }));
}

export function normalizeAiSessionLifecycle(value: unknown): AiSessionLifecycle {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "waiting") return "waiting";
  if (normalized === "failed") return "failed";
  if (normalized === "idle" || normalized === "completed" || normalized === "stale" || normalized === "stopped" || normalized === "exited") return "idle";
  return "running";
}

export function normalizeAiSessionPhase(value: unknown): AiSessionPhase {
  return ["thinking", "tool", "editing", "approval", "responding", "unknown"].includes(String(value))
    ? (value as AiSessionPhase)
    : "unknown";
}

function normalizePersistedTurns(value: unknown): AiSessionStatus["turns"] {
  if (!Array.isArray(value)) return [];
  return normalizeTurns(value)
    .map((turn) => {
      const parsed = AiSessionTurnSchema.safeParse(turn);
      return parsed.success ? parsed.data : undefined;
    })
    .filter((turn): turn is NonNullable<AiSessionStatus["turns"]>[number] => Boolean(turn));
}

/**
 * Migrates persisted/cross-version runtime data by projecting known fields
 * before applying the current strict protocol schema.
 */
export function decodePersistedAiSession(value: unknown): AiSessionStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.agent !== "string" || typeof record.startedAt !== "string" || typeof record.updatedAt !== "string") {
    return undefined;
  }
  warnUnknownFields(record, PERSISTED_SESSION_FIELDS, "session");
  const appBindingKeys = normalizeStringArray(record.appBindingKeys, 20, 240);
  const actions = normalizeActions(record.actions);
  const lineage = AiSessionLineageSchema.safeParse(record.lineage);
  const currentTool = normalizeTool(record.currentTool);
  const completedAt = typeof record.completedAt === "string" && AiSessionStatusSchema.shape.completedAt.safeParse(record.completedAt).success
    ? record.completedAt
    : undefined;
  const candidate = {
    id: compact(record.id, 120),
    agent: compact(record.agent, 80),
    creationSource: record.creationSource === "ai-session" ? "ai-session" : "app-session",
    ...(typeof record.appSessionId === "string" && record.appSessionId ? { appSessionId: compact(record.appSessionId, 120) } : {}),
    ...(typeof record.appId === "string" && record.appId ? { appId: compact(record.appId, 120) } : {}),
    ...(typeof record.providerSessionId === "string" && record.providerSessionId ? { providerSessionId: compact(record.providerSessionId, 240) } : {}),
    ...(lineage.success ? { lineage: lineage.data } : {}),
    ...(record.providerMeta && typeof record.providerMeta === "object" && !Array.isArray(record.providerMeta) ? { providerMeta: record.providerMeta } : {}),
    ...(appBindingKeys ? { appBindingKeys } : {}),
    ...(actions ? { actions } : {}),
    ...(typeof record.activeTurnId === "string" && record.activeTurnId ? { activeTurnId: compact(record.activeTurnId, 240) } : {}),
    ...(typeof record.title === "string" && record.title ? { title: compact(record.title, 240) } : {}),
    ...(typeof record.cwd === "string" && record.cwd ? { cwd: compact(record.cwd, 4096) } : {}),
    ...(typeof record.cwdFolderId === "string" && record.cwdFolderId ? { cwdFolderId: compact(record.cwdFolderId, 120) } : {}),
    ...(typeof record.userPrompt === "string" && record.userPrompt ? { userPrompt: messageText(record.userPrompt) } : {}),
    turns: normalizePersistedTurns(record.turns),
    status: normalizeAiSessionLifecycle(record.status),
    phase: normalizeAiSessionPhase(record.phase),
    ...(typeof record.summary === "string" && record.summary ? { summary: compact(record.summary, 1000) } : {}),
    ...(typeof record.lastMessage === "string" && record.lastMessage ? { lastMessage: messageText(record.lastMessage) } : {}),
    ...(typeof record.lastMessageItemId === "string" && record.lastMessageItemId
      ? { lastMessageItemId: compact(record.lastMessageItemId, 240) }
      : {}),
    ...(currentTool ? { currentTool } : {}),
    toolCallsSinceLastMessage: normalizeNonNegativeInteger(record.toolCallsSinceLastMessage),
    subAgents: normalizeAiSessionSubAgents(record.subAgents),
    ...(typeof record.transcriptPath === "string" && record.transcriptPath ? { transcriptPath: compact(record.transcriptPath, 4096) } : {}),
    ...(Number.isInteger(record.transcriptSize) && Number(record.transcriptSize) >= 0 ? { transcriptSize: Number(record.transcriptSize) } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(typeof record.error === "string" && record.error ? { error: compact(record.error, 4000) } : {}),
    counters: normalizeAiSessionCounters(record.counters as Partial<AiSessionStatus["counters"]> | undefined),
    queue: normalizeAiSessionQueue(record.queue),
  };
  const parsed = AiSessionStatusSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function encodePersistedAiSession(session: AiSessionStatus): PersistedAiSession {
  const current = AiSessionStatusSchema.parse(session);
  const encoded: Partial<PersistedAiSession> = {};
  for (const field of PERSISTED_AI_SESSION_FIELD_NAMES) {
    const value = current[field];
    if (value !== undefined) {
      Object.assign(encoded, { [field]: value });
    }
  }
  return encoded as PersistedAiSession;
}

// Compatibility for v0.0.23: callers used this name before persistence became
// an explicit codec. Keep the façade while all reads converge on decode().
export function sanitizePersistedAiSession(value: unknown) {
  return decodePersistedAiSession(value);
}
