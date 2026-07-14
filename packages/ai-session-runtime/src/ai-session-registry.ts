import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import writeFileAtomic from "write-file-atomic";
import { resolveStoragePaths } from "@task-handoff/core/storage/paths";
import { findClaudeTranscriptPath, findCodexTranscriptPath, summarizeTranscriptLine } from "@task-handoff/core/core/transcript";
import { AiSessionMessageAttachmentMetaSchema } from "@task-handoff/protocol/ai-sessions";
import type {
  AiSessionLifecycle,
  AiSessionMessageAttachment,
  AiSessionMessageAttachmentMeta,
  AiSessionPhase,
  AiSessionQueuedMessage,
  AiSessionReducerInput,
  AiSessionRealtimeInput,
  AiSessionSnapshotInput,
  AiSessionSource,
  AiSessionStatus,
  AiSessionSummary,
  AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import {
  compact,
  currentActiveTurnIsPending,
  messageText,
  nextActiveTurnId,
  normalizeTurns,
  snapshotMissingPendingActiveTurn,
  sourcePriority,
  stableGeneratedTurnId,
  transcriptTurnId,
  turnHasResponse,
  turnMeta,
  updateTurns,
  type TurnMeta,
} from "./ai-session-turns";

type AiSessionStartInput = {
  agent: string;
  appSessionId?: string;
  appId?: string;
  providerSessionId?: string;
  conversationId?: number;
  title?: string;
  cwd?: string;
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  status?: AiSessionLifecycle;
  phase?: AiSessionPhase;
  summary?: string;
};

type AiSessionUpdateInput = Partial<
  Pick<
    AiSessionStatus,
    "appSessionId" | "appId" | "providerSessionId" | "activeTurnId" | "conversationId" | "title" | "cwd" | "userPrompt" | "turns" | "status" | "phase" | "summary" | "lastMessage" | "currentTool" | "transcriptPath" | "error"
    | "providerMeta"
    | "appBindingKeys"
    | "actions"
    | "completedAt"
    | "transcriptSize"
    | "queue"
  >
> & {
  counters?: Partial<AiSessionStatus["counters"]>;
};

type RegistryOptions = {
  dir?: string;
  retentionMs?: number;
  idleAfterMs?: number;
  staleAfterMs?: number;
  orphanedAppSessionRetentionMs?: number;
};

type AppSessionPresenceCandidate = {
  id?: unknown;
  status?: unknown;
};

type AppSessionBindingCandidate = {
  id?: unknown;
  appId?: unknown;
  title?: unknown;
  status?: unknown;
  process?: {
    pid?: unknown;
  };
  tty?: {
    cwd?: unknown;
  };
  launch?: {
    cwd?: unknown;
  };
  ai?: {
    claude?: {
      short?: unknown;
      controlSock?: unknown;
      providerSessionId?: unknown;
      pid?: unknown;
      cwd?: unknown;
      state?: unknown;
      tempo?: unknown;
      cliVersion?: unknown;
      source?: unknown;
    };
  };
};

type ClaudeRuntimeSessionFile = {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  status?: unknown;
};

type ActiveAiProcessSnapshot = {
  agent: "codex" | "claude";
  providerSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
};

type AiSessionAgent = "codex" | "claude";

type TranscriptBackfill = {
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  lastMessage?: string;
  summary?: string;
};

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_AFTER_MS = 30 * 1000;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_ORPHANED_APP_SESSION_RETENTION_MS = 5 * 60 * 1000;
const TRANSCRIPT_BACKFILL_MAX_BYTES = 512 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function aiSessionDir() {
  const configured = process.env.TASK_HANDOFF_AI_SESSION_DIR;
  if (configured?.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(resolveStoragePaths().dataDir, "ai-sessions");
}

function ensureDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown) {
  ensureDirectory(path.dirname(filePath));
  writeFileAtomic.sync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function normalizeCounters(counters?: Partial<AiSessionStatus["counters"]>): AiSessionStatus["counters"] {
  return {
    toolCalls: Math.max(0, Number(counters?.toolCalls) || 0),
    edits: Math.max(0, Number(counters?.edits) || 0),
    approvals: Math.max(0, Number(counters?.approvals) || 0),
  };
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = [...new Set(value.map((item) => compact(item, maxLength)).filter(Boolean))].slice(0, maxItems);
  return items.length ? items : undefined;
}

function normalizeActions(value: unknown): AiSessionStatus["actions"] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const actions = {
    send: typeof record.send === "boolean" ? record.send : undefined,
    interrupt: typeof record.interrupt === "boolean" ? record.interrupt : undefined,
    approval: typeof record.approval === "boolean" ? record.approval : undefined,
  };
  return actions.send === undefined && actions.interrupt === undefined && actions.approval === undefined ? undefined : actions;
}

function emptyQueue() {
  return { pendingCount: 0, items: [] };
}

function queueFromItems(items: AiSessionQueuedMessage[]) {
  const normalizedItems = items.map(normalizeQueuedMessage).filter((item): item is AiSessionQueuedMessage => Boolean(item)).slice(0, 100);
  return {
    pendingCount: normalizedItems.filter((item) => item.status === "queued" || item.status === "sending").length,
    items: normalizedItems,
  };
}

function normalizeQueue(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as { items?: unknown } : {};
  return queueFromItems(Array.isArray(record.items) ? record.items as AiSessionQueuedMessage[] : []);
}

function normalizeQueuedMessage(value: unknown): AiSessionQueuedMessage | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<AiSessionQueuedMessage> : undefined;
  if (!record?.id || !record.message || !record.createdAt || !record.updatedAt) {
    return undefined;
  }
  const status = record.status === "sending" || record.status === "failed" ? record.status : "queued";
  return {
    id: compact(record.id, 120),
    message: messageText(record.message),
    attachments: normalizeMessageAttachmentMetas(record.attachments),
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error ? compact(record.error, 4000) : undefined,
  };
}

function normalizeMessageAttachmentMetas(value: unknown): AiSessionMessageAttachmentMeta[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const parsed = AiSessionMessageAttachmentMetaSchema.safeParse(item);
      return parsed.success ? parsed.data : undefined;
    })
    .filter((item): item is AiSessionMessageAttachmentMeta => Boolean(item))
    .slice(0, 6);
}

function attachmentMetas(attachments: AiSessionMessageAttachment[] = []): AiSessionMessageAttachmentMeta[] {
  return attachments.slice(0, 6).map((attachment) => AiSessionMessageAttachmentMetaSchema.parse({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
  }));
}

function normalizeSession(value: unknown): AiSessionStatus | undefined {
  const record = value && typeof value === "object" ? (value as Partial<AiSessionStatus>) : undefined;
  if (!record?.id || !record.agent || !record.startedAt || !record.updatedAt) {
    return undefined;
  }
  return {
    id: compact(record.id, 120),
    agent: compact(record.agent, 80),
    appSessionId: record.appSessionId ? compact(record.appSessionId, 120) : undefined,
    appId: record.appId ? compact(record.appId, 120) : undefined,
    providerSessionId: record.providerSessionId ? compact(record.providerSessionId, 240) : undefined,
    providerMeta: record.providerMeta && typeof record.providerMeta === "object" && !Array.isArray(record.providerMeta) ? record.providerMeta : undefined,
    appBindingKeys: normalizeStringArray(record.appBindingKeys, 20, 240),
    actions: normalizeActions(record.actions),
    activeTurnId: record.activeTurnId ? compact(record.activeTurnId, 240) : undefined,
    conversationId: Number.isInteger(record.conversationId) && Number(record.conversationId) > 0 ? Number(record.conversationId) : undefined,
    title: record.title ? compact(record.title, 240) : undefined,
    cwd: record.cwd ? compact(record.cwd, 4096) : undefined,
    userPrompt: record.userPrompt ? messageText(record.userPrompt) : undefined,
    turns: normalizeTurns(record.turns),
    status: normalizeLifecycle(record.status),
    phase: normalizePhase(record.phase),
    summary: record.summary ? compact(record.summary, 1000) : undefined,
    lastMessage: record.lastMessage ? messageText(record.lastMessage) : undefined,
    currentTool: record.currentTool?.name
      ? {
          name: compact(record.currentTool.name, 120),
          inputPreview: record.currentTool.inputPreview ? compact(record.currentTool.inputPreview, 500) : undefined,
          startedAt: record.currentTool.startedAt,
        }
      : undefined,
    transcriptPath: record.transcriptPath ? compact(record.transcriptPath, 4096) : undefined,
    transcriptSize: Number.isInteger(record.transcriptSize) && Number(record.transcriptSize) >= 0 ? Number(record.transcriptSize) : undefined,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    error: record.error ? compact(record.error, 4000) : undefined,
    counters: normalizeCounters(record.counters),
    queue: normalizeQueue(record.queue),
  };
}

function normalizeLifecycle(value: unknown): AiSessionLifecycle {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "waiting") {
    return "waiting";
  }
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "idle" || normalized === "completed" || normalized === "stale" || normalized === "stopped" || normalized === "exited") {
    return "idle";
  }
  return "running";
}

function normalizePhase(value: unknown): AiSessionPhase {
  return ["thinking", "tool", "editing", "approval", "responding", "unknown"].includes(String(value))
    ? (value as AiSessionPhase)
    : "unknown";
}

function maxIso(lhs: string, rhs: string) {
  return Date.parse(lhs) >= Date.parse(rhs) ? lhs : rhs;
}

function sessionIdentityKey(session: AiSessionStatus) {
  if (session.appSessionId) {
    return `${session.agent}:app:${session.appSessionId}`;
  }
  if (session.providerSessionId) {
    return `${session.agent}:provider:${session.providerSessionId}`;
  }
  if (session.transcriptPath) {
    return `${session.agent}:transcript:${session.transcriptPath}`;
  }
  return `${session.agent}:id:${session.id}`;
}

function betterCanonicalSession(lhs: AiSessionStatus, rhs: AiSessionStatus) {
  const lhsActivity = Number(Boolean(lhs.userPrompt)) + Number(Boolean(lhs.summary)) + Number(Boolean(lhs.lastMessage)) + (lhs.turns?.length || 0);
  const rhsActivity = Number(Boolean(rhs.userPrompt)) + Number(Boolean(rhs.summary)) + Number(Boolean(rhs.lastMessage)) + (rhs.turns?.length || 0);
  if (lhsActivity !== rhsActivity) {
    return lhsActivity > rhsActivity ? lhs : rhs;
  }
  return Date.parse(lhs.updatedAt) >= Date.parse(rhs.updatedAt) ? lhs : rhs;
}

function summaryForHeartbeat(session: AiSessionStatus): AiSessionSummary {
  return {
    id: session.id,
    agent: session.agent,
    appSessionId: session.appSessionId,
    appId: session.appId,
    providerSessionId: session.providerSessionId,
    providerMeta: session.providerMeta,
    appBindingKeys: session.appBindingKeys,
    actions: actionsForSession(session),
    activeTurnId: session.activeTurnId,
    conversationId: session.conversationId,
    title: session.title,
    cwd: session.cwd,
    userPrompt: session.userPrompt,
    turns: session.turns,
    status: session.status,
    phase: session.phase,
    summary: session.summary,
    lastMessage: session.lastMessage,
    currentTool: session.currentTool,
    queue: session.queue,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    error: session.error,
  };
}

function actionsForSession(session: AiSessionStatus): AiSessionStatus["actions"] {
  const active = session.status === "running" || session.status === "waiting";
  const configured = session.actions || {};
  return {
    send: configured.send ?? true,
    interrupt: Boolean(active && configured.interrupt !== false),
    approval: Boolean(session.status === "waiting" && session.phase === "approval" && configured.approval !== false),
  };
}

function deriveProgressPatch(text: string, kind?: "user" | "assistant" | "tool"): AiSessionUpdateInput {
  const summary = compact(text, 1000);
  if (kind === "user") {
    const userPrompt = messageText(text);
    return { userPrompt };
  }
  if (kind === "assistant") {
    return { status: "running", phase: "responding", summary, lastMessage: messageText(text) };
  }
  if (/approval|permission|approve|deny/i.test(summary)) {
    return { status: "waiting", phase: "approval", summary, counters: { approvals: 1 } };
  }
  if (/^Editing\b|Finished editing\b|Edit failed/i.test(summary)) {
    return { status: "running", phase: "editing", summary, counters: { edits: 1 } };
  }
  if (/^Tool\b|^Running\b|^Finished\b|^Failed\b/i.test(summary)) {
    return { status: "running", phase: "tool", summary, counters: { toolCalls: 1 } };
  }
  if (summary) {
    return { status: "running", phase: "responding", summary, lastMessage: messageText(text) };
  }
  return {};
}

function canonicalRealtimeTurnId(
  current: AiSessionStatus,
  event: Pick<AiSessionRealtimeInput, "source" | "activeTurnId">,
  userPrompt?: unknown,
) {
  const incomingTurnId = event.activeTurnId ? compact(event.activeTurnId, 240) : undefined;
  if (event.source !== "transcript-tail" || !incomingTurnId || !current.activeTurnId || incomingTurnId === current.activeTurnId) {
    return incomingTurnId || current.activeTurnId;
  }
  const activeTurn = normalizeTurns(current.turns).find((turn) => turn.id === current.activeTurnId);
  if (!activeTurn || turnHasResponse(activeTurn)) {
    return incomingTurnId;
  }
  const prompt = userPrompt ? messageText(userPrompt) : "";
  if (prompt && activeTurn.userPrompt && activeTurn.userPrompt !== prompt) {
    return incomingTurnId;
  }
  return current.activeTurnId;
}

function resolveTranscript(agent: string, providerSessionId?: string, cwd?: string) {
  if (!providerSessionId) {
    return undefined;
  }
  return agent === "claude" ? findClaudeTranscriptPath(providerSessionId, cwd) : findCodexTranscriptPath(providerSessionId);
}

function readTranscriptTail(transcriptPath: string, stat = fs.statSync(transcriptPath)) {
  const start = Math.max(0, stat.size - TRANSCRIPT_BACKFILL_MAX_BYTES);
  const fd = fs.openSync(transcriptPath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function transcriptBackfill(transcriptPath: string, stat = fs.statSync(transcriptPath)): TranscriptBackfill {
  const state = { calls: new Map() };
  const backfill: TranscriptBackfill = {};
  let activeTurnId: string | undefined;
  const promptCounts = new Map<string, number>();
  for (const line of readTranscriptTail(transcriptPath, stat).split(/\r?\n/)) {
    const summary = summarizeTranscriptLine(line, state);
    if (!summary?.text) {
      continue;
    }
    const timestamp = summary.timestamp || stat.mtime.toISOString();
    if (summary.kind === "user") {
      const userPrompt = messageText(summary.text);
      backfill.userPrompt = userPrompt;
      const seed = summary.key || summary.timestamp;
      if (seed) {
        activeTurnId = transcriptTurnId(userPrompt, seed);
      } else {
        const occurrence = (promptCounts.get(userPrompt) || 0) + 1;
        promptCounts.set(userPrompt, occurrence);
        activeTurnId = transcriptTurnId(userPrompt, undefined, occurrence);
      }
      backfill.turns = updateTurns(backfill.turns, { activeTurnId, userPrompt }, timestamp);
      continue;
    }
    backfill.summary = compact(summary.text, 1000);
    backfill.lastMessage = messageText(summary.text);
    backfill.turns = updateTurns(backfill.turns, { activeTurnId, summary: backfill.summary, lastMessage: backfill.lastMessage }, timestamp);
  }
  return backfill;
}

export class AiSessionRegistry {
  readonly dir: string;
  readonly retentionMs: number;
  readonly idleAfterMs: number;
  readonly staleAfterMs: number;
  readonly orphanedAppSessionRetentionMs: number;
  private readonly orphanedAppSessionAt = new Map<string, number>();
  private readonly queuedAttachmentPayloads = new Map<string, AiSessionMessageAttachment[]>();
  private readonly changes = new EventEmitter();

  constructor(options: RegistryOptions = {}) {
    this.dir = options.dir || aiSessionDir();
    this.retentionMs = options.retentionMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_RETENTION_MS) || DEFAULT_RETENTION_MS);
    this.idleAfterMs = options.idleAfterMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_IDLE_AFTER_MS) || DEFAULT_IDLE_AFTER_MS);
    this.staleAfterMs = options.staleAfterMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_STALE_AFTER_MS) || DEFAULT_STALE_AFTER_MS);
    this.orphanedAppSessionRetentionMs = options.orphanedAppSessionRetentionMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_ORPHAN_RETENTION_MS) || DEFAULT_ORPHANED_APP_SESSION_RETENTION_MS);
  }

  sessionPath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  onChange(listener: (reason: string) => void) {
    this.changes.on("change", listener);
    return () => {
      this.changes.off("change", listener);
    };
  }

  start(input: AiSessionStartInput, options: { meta?: TurnMeta; timestamp?: string; suppressPromptTurn?: boolean } = {}) {
    const timestamp = options.timestamp || nowIso();
    const meta = options.meta || turnMeta({ source: "control", observedAt: timestamp });
    const session: AiSessionStatus = {
      id: `ais_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      agent: compact(input.agent || "unknown", 80),
      appSessionId: input.appSessionId ? compact(input.appSessionId, 120) : undefined,
      appId: input.appId ? compact(input.appId, 120) : undefined,
      providerSessionId: input.providerSessionId ? compact(input.providerSessionId, 240) : undefined,
      providerMeta: undefined,
      activeTurnId: undefined,
      conversationId: input.conversationId,
      title: input.title ? compact(input.title, 240) : undefined,
      cwd: input.cwd ? compact(input.cwd, 4096) : undefined,
      userPrompt: input.userPrompt ? messageText(input.userPrompt) : undefined,
      turns: updateTurns(undefined, { userPrompt: options.suppressPromptTurn ? undefined : input.userPrompt, turns: input.turns }, timestamp, meta),
      status: normalizeLifecycle(input.status || "idle"),
      phase: normalizePhase(input.phase || "unknown"),
      summary: input.summary ? compact(input.summary, 1000) : undefined,
      startedAt: timestamp,
      updatedAt: timestamp,
      counters: { toolCalls: 0, edits: 0, approvals: 0 },
      queue: emptyQueue(),
    };
    this.put(session);
    return session;
  }

  get(id: string) {
    return normalizeSession(readJsonFile(this.sessionPath(id)));
  }

  put(session: AiSessionStatus) {
    ensureDirectory(this.dir);
    writeJsonAtomic(this.sessionPath(session.id), session);
    this.emitChange("write");
    return session;
  }

  private update(id: string, patch: AiSessionUpdateInput, options: { updatedAt?: string; preserveUpdatedAt?: boolean; replaceActivity?: boolean; replaceTurns?: boolean; clearResponse?: boolean; suppressPromptTurn?: boolean; suppressTurnUpdate?: boolean; meta?: TurnMeta } = {}) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const counters = {
      toolCalls: current.counters.toolCalls + Math.max(0, Number(patch.counters?.toolCalls) || 0),
      edits: current.counters.edits + Math.max(0, Number(patch.counters?.edits) || 0),
      approvals: current.counters.approvals + Math.max(0, Number(patch.counters?.approvals) || 0),
    };
    const updatedAt = options.preserveUpdatedAt ? current.updatedAt : options.updatedAt || nowIso();
    const turnPatch = options.suppressPromptTurn ? { ...patch, userPrompt: undefined } : patch;
    const turns = options.suppressTurnUpdate
      ? normalizeTurns(options.replaceTurns ? undefined : current.turns)
      : updateTurns(options.replaceTurns ? undefined : current.turns, turnPatch, updatedAt, options.meta);
    const prompt = patch.userPrompt ? messageText(patch.userPrompt) : "";
    const latestTurn = turns.at(-1);
    const startsEmptyTurn = Boolean(prompt && !patch.lastMessage && latestTurn?.userPrompt === prompt && !latestTurn.summary && !latestTurn.lastMessage);
    const updated: AiSessionStatus = {
      ...current,
      ...patch,
      id: current.id,
      agent: current.agent,
      startedAt: current.startedAt,
      updatedAt,
      status: patch.status ? normalizeLifecycle(patch.status) : current.status,
      phase: patch.phase ? normalizePhase(patch.phase) : current.phase,
      summary: options.replaceActivity
        ? (patch.summary ? compact(patch.summary, 1000) : undefined)
        : options.clearResponse
          ? undefined
        : (patch.summary ? compact(patch.summary, 1000) : startsEmptyTurn ? undefined : current.summary),
      lastMessage: options.replaceActivity
        ? (patch.lastMessage ? messageText(patch.lastMessage) : undefined)
        : options.clearResponse
          ? undefined
        : (patch.lastMessage ? messageText(patch.lastMessage) : startsEmptyTurn ? undefined : current.lastMessage),
      userPrompt: options.replaceActivity
        ? (patch.userPrompt ? messageText(patch.userPrompt) : undefined)
        : (patch.userPrompt ? messageText(patch.userPrompt) : current.userPrompt),
      turns,
      error: patch.error ? compact(patch.error, 4000) : current.error,
      counters,
      queue: patch.queue ? normalizeQueue(patch.queue) : current.queue,
    };
    return this.put(updated);
  }

  enqueueMessage(id: string, message: string, attachments: AiSessionMessageAttachment[] = []) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const timestamp = nowIso();
    const item: AiSessionQueuedMessage = {
      id: `aiq_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      message: messageText(message),
      attachments: attachmentMetas(attachments),
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const items = [...(current.queue?.items || []), item];
    const updated = this.update(id, { queue: queueFromItems(items) }, { updatedAt: timestamp, suppressTurnUpdate: true });
    if (updated && attachments.length) {
      this.queuedAttachmentPayloads.set(item.id, attachments.slice(0, 6));
    }
    return updated ? { session: updated, item } : undefined;
  }

  queuedMessages(id: string) {
    return this.get(id)?.queue || emptyQueue();
  }

  nextQueuedMessage(id: string) {
    return this.queuedMessages(id).items.find((item) => item.status === "queued");
  }

  queuedMessageAttachments(queueId: string) {
    return this.queuedAttachmentPayloads.get(queueId) || [];
  }

  markQueuedMessageSending(id: string, queueId: string) {
    return this.patchQueuedMessage(id, queueId, { status: "sending", error: undefined });
  }

  markQueuedMessageFailed(id: string, queueId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return this.patchQueuedMessage(id, queueId, { status: "failed", error: compact(message, 4000) });
  }

  retryQueuedMessage(id: string, queueId: string) {
    return this.patchQueuedMessage(id, queueId, { status: "queued", error: undefined });
  }

  removeQueuedMessage(id: string, queueId: string) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const items = (current.queue?.items || []).filter((item) => item.id !== queueId);
    this.queuedAttachmentPayloads.delete(queueId);
    return this.update(id, { queue: queueFromItems(items) }, { suppressTurnUpdate: true });
  }

  reorderQueuedMessages(id: string, queueIds: string[]) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const currentItems = current.queue?.items || [];
    const byId = new Map(currentItems.map((item) => [item.id, item]));
    const ordered = queueIds.map((queueId) => byId.get(queueId)).filter((item): item is AiSessionQueuedMessage => Boolean(item));
    const remaining = currentItems.filter((item) => !queueIds.includes(item.id));
    return this.update(id, { queue: queueFromItems([...ordered, ...remaining]) }, { suppressTurnUpdate: true });
  }

  private patchQueuedMessage(id: string, queueId: string, patch: Partial<Pick<AiSessionQueuedMessage, "status" | "error">>) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const timestamp = nowIso();
    let found = false;
    const items = (current.queue?.items || []).map((item) => {
      if (item.id !== queueId) {
        return item;
      }
      found = true;
      return { ...item, ...patch, updatedAt: timestamp };
    });
    if (!found) {
      return undefined;
    }
    return this.update(id, { queue: queueFromItems(items) }, { updatedAt: timestamp, suppressTurnUpdate: true });
  }

  bindProviderSession(id: string, providerSessionId: string) {
    const current = this.get(id);
    const transcriptPath = current ? resolveTranscript(current.agent, providerSessionId, current.cwd) : undefined;
    return this.update(id, {
      providerSessionId,
      transcriptPath,
      status: "running",
      phase: "thinking",
      summary: `${current?.agent || "AI"} session ${providerSessionId} started`,
    });
  }

  apply(input: AiSessionReducerInput) {
    const observedAt = input.observedAt || nowIso();
    const normalized = { ...input, observedAt, sourcePriority: sourcePriority(input.source, input.sourcePriority) } as AiSessionReducerInput;
    if (input.type === "snapshot") {
      return this.reduceSnapshotInput(normalized as AiSessionSnapshotInput);
    }
    return this.reduceRealtimeInput(normalized as AiSessionRealtimeInput);
  }

  applyRealtimeEvent(id: string, event: Omit<AiSessionRealtimeInput, "type" | "sessionId" | "source"> & { source?: AiSessionSource }) {
    return this.apply({ type: "event", sessionId: id, source: event.source || "realtime", ...event });
  }

  private reduceRealtimeInput(event: AiSessionRealtimeInput) {
    const id = event.sessionId;
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const meta = turnMeta(event);
    if (event.kind === "send-ack") {
      const updatedAt = event.observedAt || nowIso();
      const userPrompt = messageText(event.userPrompt);
      return this.update(id, {
        activeTurnId: event.activeTurnId || stableGeneratedTurnId(userPrompt, updatedAt),
        status: event.status || "running",
        phase: event.phase || "thinking",
        userPrompt,
      }, { updatedAt, meta });
    }
    if (event.kind === "lifecycle") {
      const status = event.status || current.status;
      if ((status === "idle" || status === "failed") && currentActiveTurnIsPending(current)) {
        return current;
      }
      return this.update(id, {
        activeTurnId: status === "running" || status === "waiting" ? event.activeTurnId || current.activeTurnId : current.activeTurnId,
        status,
        phase: event.phase || current.phase,
      }, { updatedAt: event.observedAt, meta });
    }
    if (event.kind === "turn-started") {
      return this.update(id, {
        activeTurnId: event.activeTurnId || current.activeTurnId,
        status: event.status || "running",
        phase: event.phase || "thinking",
      }, { updatedAt: event.observedAt, meta });
    }
    if (event.kind === "user-message") {
      const activeTurnId = canonicalRealtimeTurnId(current, event, event.userPrompt);
      return this.update(id, {
        activeTurnId,
        status: event.status || "running",
        phase: event.phase || "thinking",
        userPrompt: event.userPrompt,
      }, { updatedAt: event.observedAt, meta });
    }
    if (event.kind === "assistant-message") {
      const activeTurnId = canonicalRealtimeTurnId(current, event);
      const completedFromTranscript = event.source === "transcript-tail";
      return this.update(id, {
        activeTurnId,
        status: event.status || (completedFromTranscript ? "idle" : "running"),
        phase: event.phase || (completedFromTranscript ? "unknown" : "responding"),
        summary: event.text,
        lastMessage: event.text,
      }, { updatedAt: event.observedAt, meta });
    }
    if (event.kind === "approval-requested") {
      return this.update(id, {
        activeTurnId: event.activeTurnId || current.activeTurnId,
        status: event.status || "waiting",
        phase: event.phase || "approval",
        summary: event.summary || event.text,
        counters: event.counters || { approvals: 1 },
      }, { updatedAt: event.observedAt, meta });
    }
    if (event.kind === "turn-completed") {
      const error = event.error ? compact(event.error, 4000) : undefined;
      const responseText = event.text || event.summary || (event.status === "failed" ? error : undefined);
      const hasResponse = Boolean(responseText);
      return this.update(id, {
        activeTurnId: !event.activeTurnId || event.activeTurnId === current.activeTurnId ? undefined : current.activeTurnId,
        status: event.status || "idle",
        phase: event.phase || "unknown",
        summary: responseText,
        lastMessage: responseText,
        error,
      }, { updatedAt: event.observedAt, meta, clearResponse: !hasResponse });
    }
    return undefined;
  }

  applyAdapterSnapshot(input: Omit<AiSessionSnapshotInput, "type" | "source"> & { source?: AiSessionSource }) {
    return this.apply({ type: "snapshot", source: input.source || "control", ...input });
  }

  private reduceSnapshotInput(input: AiSessionSnapshotInput) {
    const meta = turnMeta(input);
    const existing = this.readSessions().find((session) =>
      (input.appSessionId && session.appSessionId === input.appSessionId) ||
      (input.providerSessionId && session.providerSessionId === input.providerSessionId) ||
      (input.transcriptPath && session.transcriptPath === input.transcriptPath)
    );
    if (!existing) {
      const session = this.start({
        agent: input.agent,
        appSessionId: input.appSessionId,
        appId: input.appId,
        providerSessionId: input.providerSessionId,
        conversationId: input.conversationId,
        title: input.title,
        cwd: input.cwd,
        userPrompt: input.userPrompt,
        turns: input.turns,
        status: input.status || "idle",
        phase: input.phase || "unknown",
        summary: input.summary,
      }, { meta, timestamp: input.observedAt, suppressPromptTurn: !input.turns?.length });
      return this.update(session.id, {
        providerMeta: input.providerMeta,
        appBindingKeys: input.appBindingKeys,
        actions: input.actions,
        lastMessage: input.lastMessage,
        transcriptPath: input.transcriptPath,
        transcriptSize: input.transcriptSize,
        status: input.status || session.status,
        phase: input.phase || "unknown",
      }, { updatedAt: input.observedAt, meta, suppressTurnUpdate: !input.turns?.length });
    }
    this.orphanedAppSessionAt.delete(existing.id);
    return this.reduceSnapshot(existing.id, input);
  }

  private reduceSnapshot(id: string, event: AiSessionSnapshotInput) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const meta = turnMeta(event);
    const incomingTurns = normalizeTurns(event.turns, meta);
    const staleActivitySnapshot = snapshotMissingPendingActiveTurn(current, incomingTurns);
    const snapshotHasActiveTurn = Boolean(current.activeTurnId && incomingTurns.some((turn) => turn.id === current.activeTurnId));
    const incomingActiveTurn = current.activeTurnId ? incomingTurns.find((turn) => turn.id === current.activeTurnId) : undefined;
    const ignoreSnapshotTopLevelResponse = Boolean(
      event.replaceActivity &&
      current.activeTurnId &&
      snapshotHasActiveTurn &&
      !turnHasResponse(incomingActiveTurn)
    );
    const replaceAppBinding = isAuthoritativeAppBindingSnapshot(event);
    return this.update(id, {
      appSessionId: replaceAppBinding ? event.appSessionId : event.appSessionId || current.appSessionId,
      appId: event.appId || current.appId,
      providerSessionId: event.providerSessionId || current.providerSessionId,
      providerMeta: event.providerMeta || current.providerMeta,
      appBindingKeys: replaceAppBinding ? event.appBindingKeys : event.appBindingKeys || current.appBindingKeys,
      actions: event.actions || current.actions,
      activeTurnId: nextActiveTurnId(current, event, staleActivitySnapshot),
      conversationId: event.conversationId || current.conversationId,
      title: event.title || current.title,
      cwd: event.cwd || current.cwd,
      userPrompt: staleActivitySnapshot ? current.userPrompt : event.userPrompt || current.userPrompt,
      turns: staleActivitySnapshot ? current.turns : event.turns,
      lastMessage: staleActivitySnapshot ? current.lastMessage : ignoreSnapshotTopLevelResponse ? undefined : event.lastMessage || current.lastMessage,
      transcriptPath: event.transcriptPath || current.transcriptPath,
      transcriptSize: event.transcriptSize ?? current.transcriptSize,
      status: staleActivitySnapshot ? current.status : event.status || current.status,
      phase: staleActivitySnapshot ? current.phase : event.phase || current.phase,
      summary: staleActivitySnapshot ? current.summary : ignoreSnapshotTopLevelResponse ? undefined : event.replaceActivity ? event.summary : event.summary || current.summary,
    }, {
      updatedAt: event.observedAt,
      meta,
      replaceActivity: Boolean(event.replaceActivity),
      suppressPromptTurn: !incomingTurns.length,
      suppressTurnUpdate: !incomingTurns.length,
      replaceTurns: Boolean(event.replaceActivity && !staleActivitySnapshot && incomingTurns.length === 0 && !event.userPrompt && !event.summary && !event.lastMessage),
    });
  }

  attachTranscript(id: string, transcriptPath?: string) {
    if (!transcriptPath) {
      const current = this.get(id);
      transcriptPath = current ? resolveTranscript(current.agent, current.providerSessionId, current.cwd) : undefined;
    }
    const current = this.get(id);
    return transcriptPath && current
      ? this.applyAdapterSnapshot({
          source: "transcript-scan",
          agent: current.agent,
          appId: current.appId,
          appSessionId: current.appSessionId,
          providerSessionId: current.providerSessionId,
          cwd: current.cwd,
          transcriptPath,
          status: current.status,
          phase: current.phase,
        })
      : current;
  }

  progress(id: string, text: string, kind?: "user" | "assistant" | "tool") {
    if (kind === "user") {
      return this.applyRealtimeEvent(id, { kind: "user-message", userPrompt: text });
    }
    if (kind === "assistant") {
      return this.applyRealtimeEvent(id, { kind: "assistant-message", text });
    }
    const patch = deriveProgressPatch(text, kind);
    return this.applyRealtimeEvent(id, {
      kind: patch.status === "waiting" ? "approval-requested" : "assistant-message",
      text: patch.summary || text,
      status: patch.status,
      phase: patch.phase,
      counters: patch.counters,
      source: "realtime",
    });
  }

  complete(id: string, output?: string) {
    return this.applyRealtimeEvent(id, {
      kind: "turn-completed",
      status: "idle",
      phase: "responding",
      text: output ? messageText(output) : "Completed",
      source: "control",
    });
  }

  fail(id: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return this.applyRealtimeEvent(id, {
      kind: "turn-completed",
      status: "failed",
      phase: "unknown",
      text: `Failed: ${message}`,
      source: "control",
    });
  }

  markWaitingByConversation(conversationId: number, summary: string) {
    const session = this.list()
      .filter((entry) => entry.conversationId === conversationId && !["idle", "failed"].includes(entry.status))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    return session ? this.applyRealtimeEvent(session.id, { kind: "approval-requested", status: "waiting", phase: "approval", summary, counters: { approvals: 1 }, source: "realtime" }) : undefined;
  }

  list() {
    return this.canonicalSessions(this.readSessions().filter((session) => !this.orphanedAppSessionAt.has(session.id)));
  }

  private readSessions() {
    ensureDirectory(this.dir);
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const now = Date.now();
    return files
      .map((name) => normalizeSession(readJsonFile(path.join(this.dir, name))))
      .filter((session): session is AiSessionStatus => Boolean(session))
      .map((session) => this.withDerivedLifecycle(session, now))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private canonicalSessions(sessions: AiSessionStatus[]) {
    const byIdentity = new Map<string, AiSessionStatus>();
    for (const session of sessions) {
      const key = sessionIdentityKey(session);
      const existing = byIdentity.get(key);
      byIdentity.set(key, existing ? betterCanonicalSession(existing, session) : session);
    }
    return [...byIdentity.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  reconcileAppSessionBindings(appSessions: AppSessionPresenceCandidate[] = [], now = Date.now()) {
    const appSessionIds = new Set(
      appSessions
        .filter((session) => typeof session.status !== "string" || session.status === "running")
        .map((session) => (typeof session.id === "string" ? session.id.trim() : ""))
        .filter(Boolean),
    );
    let hidden = 0;
    let deleted = 0;
    for (const session of this.readSessions()) {
      if (!session.appSessionId) {
        this.orphanedAppSessionAt.delete(session.id);
        continue;
      }
      if (appSessionIds.has(session.appSessionId)) {
        this.orphanedAppSessionAt.delete(session.id);
        continue;
      }
      const orphanedAt = this.orphanedAppSessionAt.get(session.id) ?? now;
      this.orphanedAppSessionAt.set(session.id, orphanedAt);
      hidden += 1;
      if (now - orphanedAt >= this.orphanedAppSessionRetentionMs) {
        fs.rmSync(this.sessionPath(session.id), { force: true });
        this.orphanedAppSessionAt.delete(session.id);
        deleted += 1;
        this.emitChange("delete");
      }
    }
    return { hidden, deleted };
  }

  reconcileAdapterSessions(input: {
    agent: "codex" | "claude";
    appSessionIds?: Set<string>;
    providerSessionIds?: Set<string>;
    providerShorts?: Set<string>;
  }) {
    const appSessionIds = input.appSessionIds || new Set<string>();
    const providerSessionIds = input.providerSessionIds || new Set<string>();
    const providerShorts = input.providerShorts || new Set<string>();
    let deleted = 0;
    for (const session of this.readSessions()) {
      if (session.agent !== input.agent) {
        continue;
      }
      if (!session.appSessionId && !session.providerSessionId && !session.providerMeta?.short) {
        continue;
      }
      if (session.appSessionId && appSessionIds.has(session.appSessionId)) {
        this.orphanedAppSessionAt.delete(session.id);
        continue;
      }
      if (session.providerSessionId && providerSessionIds.has(session.providerSessionId)) {
        this.orphanedAppSessionAt.delete(session.id);
        continue;
      }
      const short = typeof session.providerMeta?.short === "string" ? session.providerMeta.short : "";
      if (short && providerShorts.has(short)) {
        this.orphanedAppSessionAt.delete(session.id);
        continue;
      }
      fs.rmSync(this.sessionPath(session.id), { force: true });
      this.orphanedAppSessionAt.delete(session.id);
      deleted += 1;
      this.emitChange("delete");
    }
    return { deleted };
  }

  snapshot(limit = 20): AiSessionsSnapshot {
    const sessions = this.list().slice(0, limit);
    return this.snapshotFromSessions(sessions);
  }

  boundSnapshot(appSessions: AppSessionPresenceCandidate[] = [], limit = 20): AiSessionsSnapshot {
    const appSessionIds = new Set(
      appSessions
        .filter((session) => typeof session.status !== "string" || session.status === "running")
        .map((session) => (typeof session.id === "string" ? session.id.trim() : ""))
        .filter(Boolean),
    );
    const sessions = this.list()
      .filter((session) => Boolean(session.appSessionId && appSessionIds.has(session.appSessionId)))
      .slice(0, limit);
    return this.snapshotFromSessions(sessions);
  }

  private snapshotFromSessions(sessions: AiSessionStatus[]): AiSessionsSnapshot {
    return {
      runningCount: sessions.filter((session) => session.status === "running").length,
      waitingCount: sessions.filter((session) => session.status === "waiting").length,
      staleCount: 0,
      sessions: sessions.map(summaryForHeartbeat),
      updatedAt: nowIso(),
    };
  }

  prune() {
    const canonicalIds = new Set(this.canonicalSessions(this.readSessions()).map((session) => session.id));
    for (const session of this.readSessions()) {
      if (!canonicalIds.has(session.id)) {
        fs.rmSync(this.sessionPath(session.id), { force: true });
        this.emitChange("delete");
      }
    }
    const cutoff = Date.now() - this.retentionMs;
    for (const session of this.readSessions()) {
      if (["idle", "failed"].includes(session.status) && Date.parse(session.updatedAt) < cutoff) {
        fs.rm(this.sessionPath(session.id), { force: true }, () => this.emitChange("delete"));
      }
    }
  }

  ingestTranscriptLine(id: string, line: string, state: { calls: Map<string, never>; promptCounts?: Map<string, number>; activeTurnId?: string }) {
    const summary = summarizeTranscriptLine(line, state);
    if (!summary?.text) {
      return this.get(id);
    }
    const timestamp = summary.timestamp || nowIso();
    if (summary.kind === "user") {
      const userPrompt = messageText(summary.text);
      const seed = summary.key || summary.timestamp;
      if (seed) {
        state.activeTurnId = transcriptTurnId(userPrompt, seed);
      } else {
        state.promptCounts ||= new Map<string, number>();
        const occurrence = (state.promptCounts.get(userPrompt) || 0) + 1;
        state.promptCounts.set(userPrompt, occurrence);
        state.activeTurnId = transcriptTurnId(userPrompt, undefined, occurrence);
      }
      return this.applyRealtimeEvent(id, { kind: "user-message", activeTurnId: state.activeTurnId, providerTurnId: state.activeTurnId, userPrompt, observedAt: timestamp, source: "transcript-tail" });
    }
    if (summary.kind === "assistant") {
      return this.applyRealtimeEvent(id, { kind: "assistant-message", activeTurnId: state.activeTurnId, providerTurnId: state.activeTurnId, text: summary.text, observedAt: timestamp, source: "transcript-tail" });
    }
    const patch = deriveProgressPatch(summary.text, summary.kind);
    return this.applyRealtimeEvent(id, {
      kind: patch.status === "waiting" ? "approval-requested" : "assistant-message",
      activeTurnId: state.activeTurnId,
      providerTurnId: state.activeTurnId,
      text: patch.summary || summary.text,
      status: patch.status,
      phase: patch.phase,
      counters: patch.counters,
      observedAt: timestamp,
      source: "transcript-tail",
    });
  }

  createFromTranscript(agent: "codex" | "claude", transcriptPath: string, options: { providerSessionId?: string; cwd?: string } = {}) {
    const stat = fs.statSync(transcriptPath);
    const timestamp = stat.mtime.toISOString();
    const backfill = transcriptBackfill(transcriptPath, stat);
    const existing = this.readSessions().find((session) =>
      session.transcriptPath === transcriptPath ||
      (options.providerSessionId && session.providerSessionId === options.providerSessionId)
    );
    if (existing) {
      const transcriptOnly = !existing.appSessionId && !existing.conversationId;
      const hasKnownSize = Number.isInteger(existing.transcriptSize);
      const sizeIncreased = hasKnownSize && stat.size > Number(existing.transcriptSize);
      const observedAt = transcriptOnly && sizeIncreased
        ? nowIso()
        : transcriptOnly && !sizeIncreased
          ? existing.updatedAt
          : maxIso(existing.updatedAt, timestamp);
      return this.applyAdapterSnapshot({
        source: "transcript-scan",
        agent,
        transcriptPath,
        transcriptSize: stat.size,
        providerSessionId: options.providerSessionId || existing.providerSessionId,
        cwd: options.cwd || existing.cwd,
        userPrompt: existing.userPrompt || backfill.userPrompt,
        turns: backfill.turns?.length ? backfill.turns : existing.turns,
        summary: backfill.summary || existing.summary,
        lastMessage: backfill.lastMessage || existing.lastMessage,
        status: transcriptOnly && sizeIncreased ? "running" : existing.status,
        phase: transcriptOnly && sizeIncreased && existing.phase === "unknown" ? "responding" : existing.phase,
        observedAt,
        replaceActivity: Boolean(backfill.turns?.length),
      }) || existing;
    }
    const session = this.start({
      agent,
      providerSessionId: options.providerSessionId,
      cwd: options.cwd,
      userPrompt: backfill.userPrompt,
      turns: backfill.turns,
      status: this.lifecycleForTranscriptMtime(stat.mtimeMs),
      phase: "unknown",
      summary: backfill.summary || `${agent} transcript detected`,
    }, { meta: turnMeta({ source: "transcript-scan", observedAt: timestamp }), timestamp, suppressPromptTurn: !backfill.turns?.length });
    return this.applyAdapterSnapshot({
      source: "transcript-scan",
      agent: session.agent,
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
      userPrompt: session.userPrompt,
      turns: session.turns,
      summary: session.summary,
      lastMessage: backfill.lastMessage,
      transcriptPath,
      transcriptSize: stat.size,
      status: session.status,
      phase: session.phase,
      observedAt: timestamp,
    }) || session;
  }

  private emitChange(reason: string) {
    this.changes.emit("change", reason);
  }

  reconcileActiveProcesses(activeProcesses: ActiveAiProcessSnapshot[]) {
    const matched = new Set<string>();
    for (const process of activeProcesses) {
      const session = this.list().find((entry) =>
        entry.agent === process.agent &&
        (
          (process.providerSessionId && entry.providerSessionId === process.providerSessionId) ||
          (process.transcriptPath && entry.transcriptPath === process.transcriptPath)
        )
      );
      if (!session) {
        continue;
      }
      matched.add(session.id);
      this.applyAdapterSnapshot({
        source: "process-scan",
        agent: session.agent,
        appId: session.appId,
        appSessionId: session.appSessionId,
        providerSessionId: process.providerSessionId || session.providerSessionId,
        cwd: process.cwd || session.cwd,
        title: session.title,
        userPrompt: session.userPrompt,
        turns: session.turns,
        summary: session.summary,
        lastMessage: session.lastMessage,
        status: "running",
        phase: session.phase === "unknown" ? "thinking" : session.phase,
        transcriptPath: process.transcriptPath || session.transcriptPath,
      });
    }
    return matched;
  }

  private withDerivedLifecycle(session: AiSessionStatus, now = Date.now()) {
    if (["idle", "failed", "waiting"].includes(session.status)) {
      return session;
    }
    const age = now - Date.parse(session.updatedAt);
    if (age > this.staleAfterMs && session.transcriptPath && !session.conversationId) {
      return { ...session, status: "idle" as const };
    }
    if (age > this.idleAfterMs && session.status === "running") {
      return { ...session, status: "idle" as const };
    }
    return session;
  }

  private lifecycleForTranscriptMtime(mtimeMs: number): AiSessionLifecycle {
    const age = Date.now() - mtimeMs;
    if (age > this.staleAfterMs) {
      return "idle";
    }
    if (age > this.idleAfterMs) {
      return "idle";
    }
    return "running";
  }
}

function isAuthoritativeAppBindingSnapshot(event: AiSessionSnapshotInput) {
  return event.source === "app-session" || (
    event.source === "adapter-snapshot" &&
    event.agent === "codex" &&
    event.appId === "codex-app-server"
  );
}

export function createAiSessionRegistry(options: RegistryOptions = {}) {
  return new AiSessionRegistry(options);
}

export function scanRecentTranscripts(registry = createAiSessionRegistry(), agents: readonly AiSessionAgent[] = ["claude"]) {
  const maxFiles = Number(process.env.TASK_HANDOFF_AI_SESSION_SCAN_MAX_FILES) || 100;
  const sinceMs = Number(process.env.TASK_HANDOFF_AI_SESSION_SCAN_SINCE_MS) || 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - sinceMs;
  const candidates: Array<{ agent: "codex" | "claude"; filePath: string; mtimeMs: number }> = [];
  const agentSet = new Set(agents);

  const collect = (agent: "codex" | "claude", root: string) => {
    if (!agentSet.has(agent)) {
      return;
    }
    const stack = [root];
    while (stack.length > 0 && candidates.length < maxFiles * 3) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stat = fs.statSync(entryPath);
          if (stat.mtimeMs >= cutoff) {
            candidates.push({ agent, filePath: entryPath, mtimeMs: stat.mtimeMs });
          }
        }
      }
    }
  };

  collect("codex", path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"));
  collect("claude", path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "projects"));

  for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles)) {
    registry.createFromTranscript(candidate.agent, candidate.filePath, {
      providerSessionId: path.basename(candidate.filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] || path.basename(candidate.filePath, ".jsonl"),
    });
  }
  registry.prune();
  return registry.snapshot();
}

function commandOutput(command: string, args: string[], timeout = 500) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    });
  } catch {
    return "";
  }
}

function firstUuid(value: string) {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
}

function parseLsofPath(output: string, marker: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(-1) || "")
    .filter((entry) => entry.includes(marker) && entry.endsWith(".jsonl"))
    .sort()
    .at(-1);
}

function workingDirectoryFromLsof(output: string) {
  const cwdLine = output.split(/\r?\n/).find((line) => /\bcwd\b/.test(line));
  return cwdLine?.trim().split(/\s+/).at(-1);
}

function discoverActiveAiProcesses(commandRunner = commandOutput, agents: readonly AiSessionAgent[] = ["claude"]): ActiveAiProcessSnapshot[] {
  const ps = commandRunner("/bin/ps", ["-Ao", "pid=,tty=,command="], 700);
  const snapshots: ActiveAiProcessSnapshot[] = [];
  const claimed = new Set<string>();
  const agentSet = new Set(agents);
  for (const line of ps.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || match[2] === "??") {
      continue;
    }
    const [, pid, , command] = match;
    const lower = command.toLowerCase();
    const agent = /\bclaude\b/.test(lower) ? "claude" : /\bcodex\b/.test(lower) ? "codex" : undefined;
    if (!agent || !agentSet.has(agent) || lower.includes("task-handoff")) {
      continue;
    }
    const lsof = commandRunner("/usr/sbin/lsof", ["-p", pid], 700);
    const transcriptPath = agent === "codex"
      ? parseLsofPath(lsof, "/.codex/sessions/")
      : parseLsofPath(lsof, "/.claude/projects/");
    const providerSessionId = transcriptPath ? firstUuid(transcriptPath) : firstUuid(command);
    const key = `${agent}:${providerSessionId || transcriptPath || pid}`;
    if (!claimed.add(key)) {
      continue;
    }
    snapshots.push({
      agent,
      providerSessionId,
      transcriptPath,
      cwd: workingDirectoryFromLsof(lsof),
    });
  }
  return snapshots;
}

export function reconcileActiveAiProcesses(
  registry = createAiSessionRegistry(),
  agents: readonly AiSessionAgent[] = ["claude"],
  commandRunner = commandOutput,
) {
  registry.reconcileActiveProcesses(discoverActiveAiProcesses(commandRunner, agents));
  return registry.snapshot();
}

function claudeLifecycle(value: unknown): AiSessionLifecycle {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "idle") {
    return "idle";
  }
  if (normalized === "stopped" || normalized === "exited" || normalized === "failed") {
    return normalized === "failed" ? "failed" : "idle";
  }
  return ["active", "busy", "running", "thinking", "working"].includes(normalized) ? "running" : "idle";
}

function claudeSessionsDir(claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude")) {
  return path.join(claudeHome, "sessions");
}

function readClaudeRuntimeSessions(claudeHome?: string) {
  const dir = claudeSessionsDir(claudeHome);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Map<number, ClaudeRuntimeSessionFile>();
  }
  const byPid = new Map<number, ClaudeRuntimeSessionFile>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const record = readJsonFile<ClaudeRuntimeSessionFile>(path.join(dir, entry.name));
    const pid = Number(record?.pid || path.basename(entry.name, ".json"));
    if (record?.sessionId && Number.isInteger(pid) && pid > 0) {
      byPid.set(pid, record);
    }
  }
  return byPid;
}

export function scanClaudeAppSessionBindings(
  registry = createAiSessionRegistry(),
  appSessions: AppSessionBindingCandidate[] = [],
  claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"),
) {
  const claudeSessionsByPid = readClaudeRuntimeSessions(claudeHome);
  for (const appSession of appSessions) {
    const appId = compact(appSession.appId, 120);
    const appSessionId = compact(appSession.id, 120);
    const status = compact(appSession.status, 80).toLowerCase();
    const pid = Number(appSession.process?.pid);
    if (appId !== "claude" || !appSessionId || (status && status !== "running") || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const claudeSession = claudeSessionsByPid.get(pid);
    const providerSessionId = compact(claudeSession?.sessionId, 240);
    if (!providerSessionId) {
      continue;
    }
    const cwd = compact(claudeSession?.cwd || appSession.tty?.cwd || appSession.launch?.cwd, 4096);
    registry.applyAdapterSnapshot({
      agent: "claude",
      appId,
      appSessionId,
      providerSessionId,
      title: compact(appSession.title, 240) || "Claude",
      cwd,
      transcriptPath: findClaudeTranscriptPath(providerSessionId, cwd, claudeHome),
      status: claudeLifecycle(claudeSession?.status),
    });
  }
  return registry.snapshot();
}
