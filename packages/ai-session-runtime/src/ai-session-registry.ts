import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolveStoragePaths } from "@task-handoff/core/storage/paths";
import type {
  AiSessionConversationAttachment,
  AiSessionLifecycle,
  AiSessionLineage,
  AiSessionModelSelection,
  AiSessionCreationSource,
  AiSessionHistoryItem,
  AiSessionMessageAttachment,
  AiSessionPermissionMode,
  AiSessionReference,
  AiSessionPhase,
  AiSessionReducerInput,
  AiSessionRealtimeInput,
  AiSessionSnapshotInput,
  AiSessionSource,
  AiSessionStatus,
  AiSessionSummary,
  AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import { AiSessionConversationAttachmentStore, type RetainedAiSessionMessageAttachment } from "./ai-session-conversation-attachment-store";
import {
  compact,
  messageText,
  sourcePriority,
  turnMeta,
  updateTurns,
  type TurnMeta,
} from "./ai-session-turns";
import { AiSessionFileStore } from "./ai-session/file-store";
import { AiSessionQueueService } from "./ai-session/queue-service";
import {
  AiSessionReconciliationService,
  betterCanonicalSession,
  type AppSessionPresenceCandidate,
} from "./ai-session/reconciliation-service";
import {
  applyAiSessionPatch,
  reduceAiSessionRealtime,
  reduceAiSessionSnapshot,
  sameAiSessionBusinessState,
  type AiSessionPatch,
} from "./ai-session/state-reducer";
import {
  emptyAiSessionQueue as emptyQueue,
  normalizeAiSessionLifecycle as normalizeLifecycle,
  normalizeAiSessionPhase as normalizePhase,
} from "./ai-session/persistence";
import {
  commandOutput as sourceDiscoveryCommandOutput,
  reconcileActiveAiProcesses as reconcileDiscoveredActiveAiProcesses,
  scanClaudeAppSessionBindings as scanDiscoveredClaudeAppSessionBindings,
  scanRecentTranscripts as scanDiscoveredRecentTranscripts,
  type ActiveAiProcessSnapshot,
  type AiSessionAgent,
  type AiSessionDiscoveryCommandRunner,
  type AppSessionBindingCandidate,
} from "./ai-session/source-discovery";
import {
  AiSessionTranscriptService,
  resolveAiSessionTranscript,
  type AiSessionTranscriptState,
} from "./ai-session/transcript-service";

type AiSessionStartInput = {
  agent: string;
  creationSource?: AiSessionCreationSource;
  appSessionId?: string;
  appId?: string;
  providerSessionId?: string;
  lineage?: AiSessionLineage;
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionStatus["reasoningEffort"];
  storyId?: AiSessionStatus["storyId"];
  title?: string;
  cwd?: string;
  cwdFolderId?: string;
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  status?: AiSessionLifecycle;
  phase?: AiSessionPhase;
  summary?: string;
};

type AiSessionUpdateInput = AiSessionPatch;

type RegistryOptions = {
  dir?: string;
  retentionMs?: number;
  idleAfterMs?: number;
  staleAfterMs?: number;
  orphanedAppSessionRetentionMs?: number;
  conversationAttachments?: AiSessionConversationAttachmentStore;
};

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_AFTER_MS = 30 * 1000;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_ORPHANED_APP_SESSION_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_AI_SESSION_SNAPSHOT_LIMIT = 150;

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

function canonicalDetailValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDetailValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalDetailValue(entry)]));
}

const aiSessionDetailRevisionCache = new WeakMap<AiSessionStatus, string>();

export function aiSessionDetailRevision(session: AiSessionStatus) {
  const cached = aiSessionDetailRevisionCache.get(session);
  if (cached) return cached;
  const detail = canonicalDetailValue({
    appBindingKeys: session.appBindingKeys,
    cwd: session.cwd,
    error: session.error,
    providerMeta: session.providerMeta,
    modelSelection: session.modelSelection,
    reasoningEffort: session.reasoningEffort,
    queue: session.queue,
    subAgents: session.subAgents,
  });
  const revision = createHash("sha256").update(JSON.stringify(detail)).digest("base64url").slice(0, 22);
  aiSessionDetailRevisionCache.set(session, revision);
  return revision;
}

const aiSessionTurnsRevisionCache = new WeakMap<AiSessionStatus, string>();

export function aiSessionTurnBodyRevision(turn: NonNullable<AiSessionStatus["turns"]>[number]) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalDetailValue(turn)))
    .digest("base64url")
    .slice(0, 22);
}

export function aiSessionConversationTurns(session: AiSessionStatus) {
  return (session.turns || []).filter((turn) => (
    turn.userPrompt?.trim()
    || turn.lastMessage?.trim()
    || turn.summary?.trim()
    || turn.contextCompactions?.length
  ));
}

export function aiSessionTurnsRevision(session: AiSessionStatus) {
  const cached = aiSessionTurnsRevisionCache.get(session);
  if (cached) return cached;
  const index = aiSessionConversationTurns(session).map((turn) => ({
    id: turn.id,
    providerTurnId: turn.providerTurnId,
  }));
  const revision = createHash("sha256")
    .update(JSON.stringify(canonicalDetailValue(index)))
    .digest("base64url")
    .slice(0, 22);
  aiSessionTurnsRevisionCache.set(session, revision);
  return revision;
}

function summaryForHeartbeat(session: AiSessionStatus): AiSessionSummary {
  const meaningfulTurns = aiSessionConversationTurns(session);
  const lastUserTurn = [...meaningfulTurns].reverse().find((turn) => turn.userPrompt?.trim());
  return {
    id: session.id,
    agent: session.agent,
    creationSource: session.creationSource,
    appSessionId: session.appSessionId,
    appId: session.appId,
    providerSessionId: session.providerSessionId,
    lineage: session.lineage,
    modelSelection: session.modelSelection,
    reasoningEffort: session.reasoningEffort,
    storyId: session.storyId,
    appBindingKeys: session.appBindingKeys?.slice(0, 3).map((value) => compact(value, 120)),
    actions: actionsForSession(session),
    activeTurnId: session.activeTurnId,
    title: session.title,
    cwd: session.cwd ? compact(session.cwd, 512) : undefined,
    cwdFolderId: session.cwdFolderId,
    userPrompt: session.userPrompt ? compact(session.userPrompt, 400) : undefined,
    detailRevision: aiSessionDetailRevision(session),
    turnsRevision: aiSessionTurnsRevision(session),
    latestTurnRef: meaningfulTurns.length ? {
      id: meaningfulTurns.at(-1)!.id,
      bodyRevision: aiSessionTurnBodyRevision(meaningfulTurns.at(-1)!),
    } : undefined,
    turnCount: meaningfulTurns.length,
    lastUserMessageAt: lastUserTurn?.startedAt || lastUserTurn?.updatedAt || (session.userPrompt ? session.startedAt : undefined),
    status: session.status,
    phase: session.phase,
    summary: session.summary ? compact(session.summary, 300) : undefined,
    lastMessage: session.lastMessage ? compact(session.lastMessage, 800) : undefined,
    lastMessageItemId: session.lastMessageItemId,
    currentTool: session.currentTool ? { ...session.currentTool, inputPreview: undefined } : undefined,
    toolCallsSinceLastMessage: session.toolCallsSinceLastMessage,
    subAgentCount: session.subAgents.length,
    subAgents: [],
    queue: { revision: session.queue.revision, pendingCount: session.queue.pendingCount, items: [] },
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    error: session.error ? compact(session.error, 300) : undefined,
  };
}

function actionsForSession(session: AiSessionStatus): AiSessionStatus["actions"] {
  const active = session.status === "running" || session.status === "waiting";
  const configured = session.actions || {};
  return {
    send: configured.send ?? true,
    interrupt: Boolean(active && configured.interrupt !== false),
    approval: Boolean(session.status === "waiting" && session.phase === "approval" && configured.approval !== false),
    fork: configured.fork ?? false,
    openApp: configured.openApp ?? Boolean(session.providerSessionId && !session.appSessionId),
    close: configured.close ?? Boolean(session.providerSessionId),
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

export class AiSessionRegistry {
  readonly dir: string;
  readonly retentionMs: number;
  readonly idleAfterMs: number;
  readonly staleAfterMs: number;
  readonly orphanedAppSessionRetentionMs: number;
  private readonly reconciliation = new AiSessionReconciliationService();
  private readonly queueService = new AiSessionQueueService();
  private readonly transcriptService: AiSessionTranscriptService;
  private readonly store: AiSessionFileStore;
  private readonly changes = new EventEmitter();
  private readonly conversationAttachments?: AiSessionConversationAttachmentStore;
  private changeBatchDepth = 0;
  private pendingChangeReason: string | undefined;

  constructor(options: RegistryOptions = {}) {
    this.dir = options.dir || aiSessionDir();
    this.store = new AiSessionFileStore({
      dir: this.dir,
      selectProviderCandidate: (sessions) => sessions.reduce((selected, session) => betterCanonicalSession(selected, session)),
    });
    this.retentionMs = options.retentionMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_RETENTION_MS) || DEFAULT_RETENTION_MS);
    this.idleAfterMs = options.idleAfterMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_IDLE_AFTER_MS) || DEFAULT_IDLE_AFTER_MS);
    this.staleAfterMs = options.staleAfterMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_STALE_AFTER_MS) || DEFAULT_STALE_AFTER_MS);
    this.orphanedAppSessionRetentionMs = options.orphanedAppSessionRetentionMs ?? (Number(process.env.TASK_HANDOFF_AI_SESSION_ORPHAN_RETENTION_MS) || DEFAULT_ORPHANED_APP_SESSION_RETENTION_MS);
    this.conversationAttachments = options.conversationAttachments;
    this.transcriptService = new AiSessionTranscriptService({ idleAfterMs: this.idleAfterMs, staleAfterMs: this.staleAfterMs });
    if (this.conversationAttachments) {
      for (const session of this.readSessions()) {
        for (const item of session.queue.items) {
          const attachmentIds = item.attachments.map((attachment) => attachment.id);
          if (!attachmentIds.length) continue;
          const messageId = item.messageId
            || this.conversationAttachments.messageIdForAttachments(session.id, attachmentIds);
          if (messageId) {
            this.conversationAttachments.claimMessageAttachments(session.id, messageId, attachmentIds);
          }
        }
      }
    }
  }

  sessionPath(id: string) {
    return this.store.sessionPath(id);
  }

  onChange(listener: (reason: string) => void) {
    this.changes.on("change", listener);
    return () => {
      this.changes.off("change", listener);
    };
  }

  async batchChanges<T>(run: () => Promise<T> | T): Promise<T> {
    this.changeBatchDepth += 1;
    try {
      return await run();
    } finally {
      this.changeBatchDepth -= 1;
      if (this.changeBatchDepth === 0 && this.pendingChangeReason) {
        const reason = this.pendingChangeReason;
        this.pendingChangeReason = undefined;
        this.changes.emit("change", reason);
      }
    }
  }

  start(input: AiSessionStartInput, options: { meta?: TurnMeta; timestamp?: string; suppressPromptTurn?: boolean } = {}) {
    return this.put(this.initialSession(input, options));
  }

  private initialSession(input: AiSessionStartInput, options: { meta?: TurnMeta; timestamp?: string; suppressPromptTurn?: boolean } = {}) {
    const timestamp = options.timestamp || nowIso();
    const meta = options.meta || turnMeta({ source: "control", observedAt: timestamp });
    const session: AiSessionStatus = {
      id: `ais_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      agent: compact(input.agent || "unknown", 80),
      creationSource: input.creationSource || "app-session",
      appSessionId: input.appSessionId ? compact(input.appSessionId, 120) : undefined,
      appId: input.appId ? compact(input.appId, 120) : undefined,
      providerSessionId: input.providerSessionId ? compact(input.providerSessionId, 240) : undefined,
      lineage: input.lineage,
      providerMeta: undefined,
      modelSelection: input.modelSelection,
      reasoningEffort: input.reasoningEffort,
      storyId: input.storyId,
      activeTurnId: undefined,
      title: input.title ? compact(input.title, 240) : undefined,
      cwd: input.cwd ? compact(input.cwd, 4096) : undefined,
      cwdFolderId: input.cwdFolderId ? compact(input.cwdFolderId, 120) : undefined,
      userPrompt: input.userPrompt ? messageText(input.userPrompt) : undefined,
      turns: updateTurns(undefined, {
        userPrompt: options.suppressPromptTurn ? undefined : input.userPrompt,
        turns: input.turns,
        status: input.status,
      }, timestamp, meta),
      status: normalizeLifecycle(input.status || "idle"),
      phase: normalizePhase(input.phase || "unknown"),
      summary: input.summary ? compact(input.summary, 1000) : undefined,
      toolCallsSinceLastMessage: 0,
      subAgents: [],
      startedAt: timestamp,
      updatedAt: timestamp,
      counters: { toolCalls: 0, edits: 0, approvals: 0 },
      queue: emptyQueue(),
    };
    return session;
  }

  get(id: string) {
    return this.store.get(id);
  }

  conversation(id: string) {
    const session = this.store.get(id);
    return session ? this.projectConversationAttachments(session) : undefined;
  }

  private projectConversationAttachments(session: AiSessionStatus): AiSessionStatus {
    if (!this.conversationAttachments) return session;
    return {
      ...session,
      turns: session.turns?.map((turn) => ({
        ...turn,
        userMessages: turn.userMessages?.map((message) => ({
          ...message,
          attachments: message.attachments.map((attachment) => (
            this.conversationAttachments!.attachmentMetadata(session.id, message.id, attachment.id)
              || { ...attachment, contentState: "missing" as const }
          )),
        })),
      })),
    };
  }

  restoreHistory(item: AiSessionHistoryItem) {
    const current = this.get(item.id);
    const session: AiSessionStatus = {
      id: item.id,
      agent: item.agent,
      creationSource: item.creationSource,
      appId: item.agent,
      providerSessionId: item.providerSessionId,
      lineage: item.lineage,
      modelSelection: item.modelSelection,
      reasoningEffort: item.reasoningEffort,
      storyId: item.storyId,
      title: item.title,
      cwd: item.cwd,
      cwdFolderId: item.cwdFolderId,
      userPrompt: item.userPrompt,
      turns: current?.turns || [],
      status: "idle",
      phase: "unknown",
      lastMessage: item.lastMessage,
      toolCallsSinceLastMessage: 0,
      subAgents: [],
      startedAt: current?.startedAt || item.lastActiveAt,
      updatedAt: item.lastActiveAt,
      counters: current?.counters || { toolCalls: 0, edits: 0, approvals: 0 },
      queue: current?.queue || emptyQueue(),
    };
    return this.put(session);
  }

  discard(id: string) {
    return this.removeStoredSession(id);
  }

  private put(session: AiSessionStatus) {
    const current = this.get(session.id);
    if (current && sameAiSessionBusinessState(current, session)) {
      return current;
    }
    const committed = this.store.save(session);
    this.emitChange("write");
    return committed;
  }

  patch(id: string, patch: AiSessionUpdateInput) {
    return this.update(id, patch);
  }

  restoreAuthority(session: AiSessionStatus) {
    return this.put(session);
  }

  private removeStoredSession(id: string) {
    const removed = this.store.remove(id);
    this.reconciliation.forgetSession(id);
    if (removed) this.emitChange("delete");
    return removed;
  }

  getByProviderSessionId(agent: string, providerSessionId: string) {
    return this.store.findByProviderSession(compact(agent, 80), compact(providerSessionId, 240));
  }

  findTranscriptSession(identity: { transcriptPath: string; providerSessionId?: string }) {
    return this.readSessions().find((session) =>
      session.transcriptPath === identity.transcriptPath
      || Boolean(identity.providerSessionId && session.providerSessionId === identity.providerSessionId),
    );
  }

  private update(id: string, patch: AiSessionUpdateInput, options: { updatedAt?: string; preserveUpdatedAt?: boolean; replaceActivity?: boolean; replaceTurns?: boolean; clearResponse?: boolean; suppressPromptTurn?: boolean; suppressTurnUpdate?: boolean; meta?: TurnMeta } = {}) {
    const current = this.get(id);
    if (!current) return undefined;
    return this.put(applyAiSessionPatch(current, patch, {
      ...options,
      updatedAt: options.preserveUpdatedAt ? current.updatedAt : options.updatedAt || nowIso(),
    }));
  }

  enqueueMessage(id: string, message: string, attachments: AiSessionMessageAttachment[] = [], references: AiSessionReference[] = [], permissionMode?: AiSessionPermissionMode, messageId?: string) {
    const current = this.get(id);
    if (!current) return undefined;
    const result = this.queueService.enqueueMessage(current, message, attachments, references, permissionMode, messageId);
    return result ? { ...result, session: this.put(result.session) } : undefined;
  }

  queuedMessages(id: string) {
    return this.queueService.queuedMessages(this.get(id));
  }

  nextQueuedMessage(id: string) {
    return this.queueService.nextQueuedMessage(this.get(id));
  }

  queuedMessageDispatch(queueId: string) {
    const session = this.readSessions().find((candidate) => candidate.queue.items.some((item) => item.id === queueId));
    const queuedItem = session?.queue.items.find((item) => item.id === queueId);
    if (this.conversationAttachments && queuedItem?.attachments.length) {
      const attachmentIds = queuedItem.attachments.map((attachment) => attachment.id);
      return {
        // Compatibility for v0.0.21: affected queue snapshots omitted messageId.
        messageId: queuedItem.messageId || (session ? this.conversationAttachments.messageIdForAttachments(session.id, attachmentIds) : undefined),
        attachments: this.conversationAttachments.providerAttachments(attachmentIds),
      };
    }
    return { messageId: queuedItem?.messageId, attachments: this.queueService.queuedMessageAttachments(queueId) };
  }

  stageMessageAttachments(input: {
    sessionId: string;
    messageId: string;
    attachments?: AiSessionMessageAttachment[];
    runtimePathRoot?: string;
    draftScopeType?: "session" | "create-request";
    draftScopeId?: string;
    draftAttachmentIds?: readonly string[];
  }): { attachments: AiSessionConversationAttachment[]; providerAttachments: RetainedAiSessionMessageAttachment[] } {
    if (!this.conversationAttachments) {
      return { attachments: [], providerAttachments: input.attachments || [] };
    }
    return this.conversationAttachments.stageMessage(input);
  }

  commitMessageAttachments(sessionId: string, messageId: string, turnId?: string) {
    return this.conversationAttachments?.commitMessage(sessionId, messageId, turnId) || 0;
  }

  rollbackMessageAttachments(sessionId: string, messageId: string) {
    return this.conversationAttachments?.rollbackMessage(sessionId, messageId) || 0;
  }

  conversationAttachmentStore() {
    return this.conversationAttachments;
  }

  markQueuedMessageSending(id: string, queueId: string) {
    const current = this.get(id);
    const updated = current ? this.queueService.markQueuedMessageSending(current, queueId) : undefined;
    return updated ? this.put(updated) : undefined;
  }

  markQueuedMessageFailed(id: string, queueId: string, error: unknown) {
    const current = this.get(id);
    const updated = current ? this.queueService.markQueuedMessageFailed(current, queueId, error) : undefined;
    return updated ? this.put(updated) : undefined;
  }

  retryQueuedMessage(id: string, queueId: string) {
    const current = this.get(id);
    const updated = current ? this.queueService.retryQueuedMessage(current, queueId) : undefined;
    return updated ? this.put(updated) : undefined;
  }

  removeQueuedMessage(id: string, queueId: string) {
    const current = this.get(id);
    const queuedItem = current?.queue.items.find((item) => item.id === queueId);
    const attachmentIds = queuedItem?.attachments.map((attachment) => attachment.id) || [];
    const messageId = queuedItem?.messageId
      || (current && attachmentIds.length
        ? this.conversationAttachments?.messageIdForAttachments(current.id, attachmentIds)
        : undefined);
    const updated = current ? this.queueService.removeQueuedMessage(current, queueId) : undefined;
    if (messageId) this.rollbackMessageAttachments(id, messageId);
    return updated ? this.put(updated) : undefined;
  }

  editQueuedMessage(id: string, queueId: string, expectedRevision: number, message: string) {
    const current = this.get(id);
    if (!current) return undefined;
    const result = this.queueService.editQueuedMessage(current, queueId, expectedRevision, message);
    return result.kind === "updated" ? { ...result, session: this.put(result.session) } : result;
  }

  reorderQueuedMessages(id: string, expectedRevision: number, queueIds: string[]) {
    const current = this.get(id);
    if (!current) return undefined;
    const result = this.queueService.reorderQueuedMessages(current, expectedRevision, queueIds);
    return result.kind === "updated" ? { ...result, session: this.put(result.session) } : result;
  }

  bindProviderSession(id: string, providerSessionId: string) {
    const current = this.get(id);
    const transcriptPath = current ? resolveAiSessionTranscript(current.agent, providerSessionId, current.cwd) : undefined;
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
    const current = this.get(event.sessionId);
    if (!current) return undefined;
    const updated = reduceAiSessionRealtime(current, event);
    return updated === current ? current : updated ? this.put(updated) : undefined;
  }

  applyAdapterSnapshot(input: Omit<AiSessionSnapshotInput, "type" | "source"> & { source?: AiSessionSource }) {
    return this.apply({ type: "snapshot", source: input.source || "control", ...input });
  }

  private reduceSnapshotInput(input: AiSessionSnapshotInput) {
    const meta = turnMeta(input);
    let existing = input.providerSessionId
      ? this.getByProviderSessionId(input.agent, input.providerSessionId)
      : undefined;
    if (!existing) {
      existing = this.readSessions().find((session) =>
        (input.appSessionId && session.appSessionId === input.appSessionId) ||
        (input.transcriptPath && session.transcriptPath === input.transcriptPath)
      );
    }
    if (!existing) {
      const session = this.initialSession({
        agent: input.agent,
        creationSource: input.creationSource,
        appSessionId: input.appSessionId,
        appId: input.appId,
        providerSessionId: input.providerSessionId,
        lineage: input.lineage,
        modelSelection: input.modelSelection,
        reasoningEffort: input.reasoningEffort,
        storyId: input.storyId,
        title: input.title,
        cwd: input.cwd,
        cwdFolderId: input.cwdFolderId,
        userPrompt: input.userPrompt,
        turns: input.turns,
        status: input.status || "idle",
        phase: input.phase || "unknown",
        summary: input.summary,
      }, { meta, timestamp: input.observedAt, suppressPromptTurn: !input.turns?.length });
      return this.put(applyAiSessionPatch(session, {
        providerMeta: input.providerMeta,
        modelSelection: input.modelSelection,
        reasoningEffort: input.reasoningEffort,
        storyId: input.storyId || existing?.storyId,
        lineage: input.lineage,
        appBindingKeys: input.appBindingKeys,
        actions: input.actions,
        activeTurnId: input.activeTurnId,
        lastMessage: input.lastMessage,
        lastMessageItemId: input.lastMessageItemId,
        error: input.error,
        currentTool: input.status === "running" || input.status === "waiting" ? input.currentTool : undefined,
        toolCallsSinceLastMessage: input.toolCallsSinceLastMessage ?? 0,
        subAgents: input.subAgents || [],
        transcriptPath: input.transcriptPath,
        transcriptSize: input.transcriptSize,
        status: input.status || session.status,
        phase: input.phase || "unknown",
      }, { updatedAt: input.observedAt, meta, suppressTurnUpdate: !input.turns?.length }));
    }
    this.reconciliation.clearOrphan(existing.id);
    const updated = reduceAiSessionSnapshot(existing, input);
    return updated === existing ? existing : this.put(updated);
  }

  attachTranscript(id: string, transcriptPath?: string) {
    if (!transcriptPath) {
      const current = this.get(id);
      transcriptPath = current ? resolveAiSessionTranscript(current.agent, current.providerSessionId, current.cwd) : undefined;
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

  list() {
    const sessions = this.readSessions();
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const result = this.reconciliation.visibility(sessions).visibleSessionIds
      .map((id) => byId.get(id))
      .filter((session): session is AiSessionStatus => Boolean(session));
    return result;
  }

  all() {
    return this.readSessions();
  }

  private readSessions() {
    return this.store.list()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  reconcileAppSessionBindings(appSessions: AppSessionPresenceCandidate[] = [], now = Date.now()) {
    const result = this.reconciliation.reconcileAppSessionBindings({
      sessions: this.readSessions(),
      appSessions,
      now,
      orphanRetentionMs: this.orphanedAppSessionRetentionMs,
    });
    let deleted = 0;
    for (const id of result.removeSessionIds) deleted += Number(this.removeStoredSession(id));
    return { hidden: result.hiddenSessionIds.length, deleted };
  }

  reconcileAdapterSessions(input: {
    agent: "codex" | "claude";
    appSessionIds?: Set<string>;
    providerSessionIds?: Set<string>;
    providerShorts?: Set<string>;
  }) {
    const result = this.reconciliation.reconcileAdapterSessions({
      sessions: this.readSessions(),
      ...input,
    });
    let deleted = 0;
    for (const id of result.removeSessionIds) deleted += Number(this.removeStoredSession(id));
    return { deleted };
  }

  snapshot(limit = DEFAULT_AI_SESSION_SNAPSHOT_LIMIT): AiSessionsSnapshot {
    const sessions = this.list().slice(0, limit);
    return this.snapshotFromSessions(sessions);
  }

  boundSnapshot(appSessions: AppSessionPresenceCandidate[] = [], limit = DEFAULT_AI_SESSION_SNAPSHOT_LIMIT): AiSessionsSnapshot {
    const appSessionIds = new Set(
      appSessions
        .filter((session) => typeof session.status !== "string" || session.status === "running")
        .map((session) => (typeof session.id === "string" ? session.id.trim() : ""))
        .filter(Boolean),
    );
    const sessions = this.list()
      .filter((session) => session.appSessionId
        ? appSessionIds.has(session.appSessionId)
        : session.creationSource === "ai-session" && Boolean(session.providerSessionId))
      .slice(0, limit);
    return this.snapshotFromSessions(sessions);
  }

  private snapshotFromSessions(sessions: AiSessionStatus[]): AiSessionsSnapshot {
    return {
      runningCount: sessions.filter((session) => session.status === "running").length,
      waitingCount: sessions.filter((session) => session.status === "waiting").length,
      staleCount: 0,
      sessions: sessions.map((session) => summaryForHeartbeat(this.projectConversationAttachments(session))),
      updatedAt: nowIso(),
    };
  }

  prune() {
    const result = this.reconciliation.prune({ sessions: this.readSessions(), now: Date.now(), retentionMs: this.retentionMs });
    for (const id of result.removeSessionIds) this.removeStoredSession(id);
  }

  ingestTranscriptLine(id: string, line: string, state: AiSessionTranscriptState) {
    return this.transcriptService.ingestLine(this, id, line, state);
  }

  createFromTranscript(agent: "codex" | "claude", transcriptPath: string, options: { providerSessionId?: string; cwd?: string } = {}) {
    return this.transcriptService.createFromTranscript(this, agent, transcriptPath, options);
  }

  private emitChange(reason: string) {
    if (this.changeBatchDepth > 0) {
      this.pendingChangeReason ||= reason;
      return;
    }
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
        lastMessageItemId: session.lastMessageItemId,
        status: "running",
        phase: session.phase === "unknown" ? "thinking" : session.phase,
        transcriptPath: process.transcriptPath || session.transcriptPath,
      });
    }
    return matched;
  }

}

export function createAiSessionRegistry(options: RegistryOptions = {}) {
  return new AiSessionRegistry(options);
}

export function scanRecentTranscripts(registry = createAiSessionRegistry(), agents: readonly AiSessionAgent[] = ["claude"]) {
  return scanDiscoveredRecentTranscripts(registry, agents);
}

export function reconcileActiveAiProcesses(
  registry = createAiSessionRegistry(),
  agents: readonly AiSessionAgent[] = ["claude"],
  commandRunner: AiSessionDiscoveryCommandRunner = sourceDiscoveryCommandOutput,
) {
  return reconcileDiscoveredActiveAiProcesses(registry, agents, commandRunner);
}

export function scanClaudeAppSessionBindings(
  registry = createAiSessionRegistry(),
  appSessions: AppSessionBindingCandidate[] = [],
  claudeHome?: string,
) {
  return scanDiscoveredClaudeAppSessionBindings(registry, appSessions, claudeHome);
}
