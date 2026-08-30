import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AiSessionLineage, AiSessionStatus, AiSessionTimelineItem } from "@task-handoff/protocol/ai-sessions";
import {
  aiSessionControlError,
  type AiSessionActionResult,
  type AiSessionApprovalDecision,
  type AiSessionControlProvider,
  type AiSessionProviderCreateInput,
  type AiSessionProviderForkInput,
  type AiSessionProviderTimelineItemListener,
  type AiSessionSendInput,
} from "./ai-session-control";
import type { AiSessionModelSelection, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionDiscoveryContext, AiSessionDiscoveryProvider } from "./ai-session-discovery";
import type { AiSessionRegistry } from "./ai-session-registry";
import { OpenCodeClient, type OpenCodeConnection, type OpenCodePromptPart } from "./opencode/client";
import { openCodePartDelta, projectOpenCodePart, projectOpenCodeSession, type OpenCodeProjection } from "./opencode/projector";
import type { OpenCodeGlobalEvent, OpenCodeMessage, OpenCodeSession } from "./opencode/wire";

export type OpenCodeSessionBridgeOptions = {
  connection: () => OpenCodeConnection | Promise<OpenCodeConnection>;
  workspaceRoots: () => string[] | Promise<string[]>;
  onMessageDelta?: (event: { sessionId: string; providerSessionId: string; turnId: string; itemId: string; delta: string }) => void;
  onEventSourceClose?: () => void;
  onDiagnostic?: (event: Record<string, unknown>) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  resolveModelSelection?: (selection: AiSessionModelSelection) => { providerID: string; modelID: string } | undefined;
  projectModelSelection?: (providerID: string, modelID: string) => AiSessionModelSelection | undefined;
};

export class OpenCodeSessionBridge implements AiSessionControlProvider, AiSessionDiscoveryProvider {
  readonly agent = "opencode";
  readonly id = "opencode-session-discovery";
  private readonly client: OpenCodeClient;
  private readonly directoryBySession = new Map<string, string>();
  private readonly projectionBySession = new Map<string, OpenCodeProjection>();
  private readonly lineageBySession = new Map<string, AiSessionLineage>();
  private readonly pendingSettingsBySession = new Map<string, { modelSelection: AiSessionModelSelection; reasoningEffort?: AiSessionReasoningEffort }>();
  private readonly timelineListeners = new Set<AiSessionProviderTimelineItemListener>();
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>();
  private eventAbort?: AbortController;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private closed = false;
  private readonly warnedVersions = new Set<string>();

  constructor(private readonly registry: AiSessionRegistry, private readonly options: OpenCodeSessionBridgeOptions) {
    this.client = new OpenCodeClient(options.connection);
  }

  async ensureReady() {
    const health = await this.client.health();
    if (!VERIFIED_OPENCODE_VERSIONS.has(health.version) && !this.warnedVersions.has(health.version)) {
      this.warnedVersions.add(health.version);
      this.options.onDiagnostic?.({ code: "OPENCODE_VERSION_UNVERIFIED", version: health.version });
    }
    this.startEventStream();
  }

  async refresh(_context: AiSessionDiscoveryContext) {
    await this.ensureReady();
    const roots = (await this.options.workspaceRoots()).map((root) => path.resolve(root));
    const activeSessionIds = new Set<string>();
    try {
      let cursor: string | undefined;
      do {
        const page = await this.client.listGlobalSessions(cursor);
        for (const session of page.data) {
          if (!session.time.archived && withinRoots(session.directory, roots)) {
            activeSessionIds.add(session.id);
            await this.reconcile(session.id, session.directory, session, "ai-session");
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      this.options.onDiagnostic?.({ code: "OPENCODE_GLOBAL_DISCOVERY_FAILED", error: errorText(error) });
      for (const root of roots) {
        const sessions = await this.client.listSessions(root);
        for (const session of sessions) {
          if (!session.time.archived && withinRoots(session.directory, roots)) {
            activeSessionIds.add(session.id);
            await this.reconcile(session.id, session.directory, session, "ai-session");
          }
        }
      }
    }
    await this.reconcileMissingSessions(activeSessionIds, roots);
  }

  async createSession(input: AiSessionProviderCreateInput) {
    await this.ensureReady();
    const model = input.modelSelection ? this.modelRef(input.modelSelection, input.reasoningEffort) : undefined;
    if (input.modelSelection && !model) throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_INVALID", "OpenCode model selection is unavailable.", 409);
    const created = await this.client.createSession(input.cwd, model);
    await this.reconcile(created.id, created.directory, created, "ai-session");
    return { providerSessionId: created.id, cwd: created.directory, creationSource: "ai-session" as const, modelSelection: input.modelSelection, reasoningEffort: input.reasoningEffort };
  }

  async readSession(providerSessionId: string) {
    await this.ensureReady();
    await this.reconcile(providerSessionId, await this.resolveDirectory(providerSessionId), undefined, "ai-session");
  }

  async resumeSession(providerSessionId: string, _modelSelection?: AiSessionModelSelection, _reasoningEffort?: AiSessionReasoningEffort) {
    await this.readSession(providerSessionId);
  }

  async updateModelSelection(session: AiSessionStatus, selection: AiSessionModelSelection) {
    if (!session.providerSessionId || !session.cwd) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "OpenCode session identity is missing.", 404);
    if (session.status === "running" || session.status === "waiting") throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_CONFLICT", "Model cannot be changed while a turn is active.", 409);
    const pending = this.pendingSettingsBySession.get(session.providerSessionId);
    const reasoningEffort = pending?.reasoningEffort ?? session.reasoningEffort;
    if (!this.modelRef(selection, reasoningEffort)) throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_INVALID", "OpenCode model selection is unavailable.", 409);
    this.pendingSettingsBySession.set(session.providerSessionId, { modelSelection: selection, reasoningEffort });
    return selection;
  }

  async updateReasoningEffort(session: AiSessionStatus, effort: AiSessionReasoningEffort) {
    if (!session.providerSessionId || !session.cwd) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "OpenCode session identity is missing.", 404);
    if (session.status === "running" || session.status === "waiting") throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_CONFLICT", "Reasoning effort cannot be changed while a turn is active.", 409);
    const selection = this.pendingSettingsBySession.get(session.providerSessionId)?.modelSelection ?? session.modelSelection;
    if (!selection) throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNKNOWN", "The current OpenCode model is unknown.", 409);
    if (!this.modelRef(selection, effort)) throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNSUPPORTED", "OpenCode reasoning variant is unavailable.", 409);
    this.pendingSettingsBySession.set(session.providerSessionId, { modelSelection: selection, reasoningEffort: effort });
    return effort;
  }

  async activeSessionExists(providerSessionId: string) {
    try {
      await this.ensureReady();
      const session = await this.client.getSession(providerSessionId, await this.resolveDirectory(providerSessionId));
      return !session.time.archived;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async archiveSession(providerSessionId: string) {
    const directory = await this.resolveDirectory(providerSessionId);
    await this.client.archiveSession(providerSessionId, directory);
    const projected = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (projected) this.registry.discard(projected.id);
    this.forget(providerSessionId);
  }

  async deleteSession(providerSessionId: string) {
    const directory = await this.resolveDirectory(providerSessionId);
    await this.client.deleteSession(providerSessionId, directory);
    const projected = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (projected) this.registry.discard(projected.id);
    this.forget(providerSessionId);
  }

  async unsubscribeSession(providerSessionId: string) {
    this.forget(providerSessionId);
  }

  async forkSession(input: AiSessionProviderForkInput) {
    const providerSessionId = input.source.providerSessionId;
    if (!providerSessionId) throw aiSessionControlError("AI_SESSION_FORK_UNSUPPORTED", "OpenCode session has no provider identity.", 409);
    const directory = input.cwd || input.source.cwd || await this.resolveDirectory(providerSessionId);
    const messages = await this.client.messages(providerSessionId, input.source.cwd || directory);
    const messageID = input.providerThroughTurnId ? nextUserMessageId(messages, input.providerThroughTurnId) : undefined;
    const forked = await this.client.forkSession(providerSessionId, directory, messageID);
    const lineage = { kind: "fork" as const, parentProviderSessionId: providerSessionId, throughTurnId: input.throughTurnId };
    this.lineageBySession.set(forked.id, lineage);
    await this.reconcile(forked.id, forked.directory, forked, "ai-session");
    return {
      providerSessionId: forked.id,
      cwd: forked.directory,
      creationSource: "ai-session" as const,
      lineage,
    };
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    if (!session.providerSessionId || !session.cwd || !input.messageId) {
      throw aiSessionControlError("AI_SESSION_SEND_INVALID", "OpenCode session, cwd, and message identity are required.", 409);
    }
    const parts = await promptParts(session.cwd, input);
    const pending = this.pendingSettingsBySession.get(session.providerSessionId);
    const selection = pending?.modelSelection || session.modelSelection;
    const model = selection ? this.modelRef(selection, pending?.reasoningEffort || session.reasoningEffort) : undefined;
    await this.client.promptAsync(session.providerSessionId, session.cwd, input.messageId, parts, model);
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "send-ack",
      activeTurnId: input.messageId,
      providerTurnId: input.messageId,
      userPrompt: input.message,
      userMessage: { id: input.messageId, text: input.message, attachments: input.userMessageAttachments || [] },
      status: "running",
      phase: "thinking",
      source: "realtime",
    }) || session;
    this.scheduleReconcile(session.providerSessionId, session.cwd);
    return { session: updated, provider: this.agent, action: "send", turnId: input.messageId, providerTurnId: input.messageId };
  }

  private modelRef(selection: AiSessionModelSelection, effort?: AiSessionReasoningEffort) {
    const resolved = this.options.resolveModelSelection?.(selection);
    if (!resolved) return undefined;
    return { ...resolved, ...(effort ? { variant: effort } : {}) };
  }

  async interrupt(session: AiSessionStatus): Promise<AiSessionActionResult> {
    if (!session.providerSessionId || !session.cwd) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "OpenCode session identity is missing.", 404);
    await this.client.abort(session.providerSessionId, session.cwd);
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "turn-completed",
      activeTurnId: session.activeTurnId,
      providerTurnId: session.activeTurnId,
      status: "idle",
      phase: "unknown",
      source: "realtime",
    }) || session;
    this.scheduleReconcile(session.providerSessionId, session.cwd);
    return { session: updated, provider: this.agent, action: "interrupt", turnId: session.activeTurnId, providerTurnId: session.activeTurnId };
  }

  async resolveApproval(session: AiSessionStatus, decision: AiSessionApprovalDecision): Promise<AiSessionActionResult> {
    if (decision === "skip") {
      throw aiSessionControlError("AI_SESSION_APPROVAL_UNSUPPORTED", "OpenCode has no equivalent for skipping a permission request.", 409);
    }
    if (!session.providerSessionId || !session.cwd) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "OpenCode session identity is missing.", 404);
    await this.reconcile(session.providerSessionId, session.cwd);
    const permission = this.projectionBySession.get(session.providerSessionId)?.pendingPermission;
    if (!permission) throw aiSessionControlError("AI_SESSION_APPROVAL_NOT_FOUND", "No pending OpenCode permission request was found.", 404);
    await this.client.replyPermission(permission.id, session.cwd, decision === "allow" ? "once" : "reject");
    await this.reconcile(session.providerSessionId, session.cwd);
    const updated = this.registry.get(session.id) || session;
    return { session: updated, provider: this.agent, action: "approval", decision };
  }

  async timeline(session: AiSessionStatus) {
    if (!session.providerSessionId || !session.cwd) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "OpenCode session identity is missing.", 404);
    await this.reconcile(session.providerSessionId, session.cwd);
    return {
      sessionId: session.id,
      providerSessionId: session.providerSessionId,
      items: this.projectionBySession.get(session.providerSessionId)?.timeline || [],
      generatedAt: new Date().toISOString(),
    };
  }

  async turnTimeline(session: AiSessionStatus, turnId: string) {
    const timeline = await this.timeline(session);
    return { sessionId: session.id, turnId, items: timeline.items.filter((item) => item.turnId === turnId), generatedAt: timeline.generatedAt };
  }

  subscribeTimelineItems(listener: AiSessionProviderTimelineItemListener) {
    this.timelineListeners.add(listener);
    return () => this.timelineListeners.delete(listener);
  }

  timelineCapabilities() {
    return { sessionRead: true, turnRead: true, liveItems: true };
  }

  close() {
    this.closed = true;
    this.eventAbort?.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
    this.reconcileTimers.clear();
  }

  private async reconcile(providerSessionId: string, directory: string, supplied?: OpenCodeSession, creationSource?: "ai-session" | "app-session") {
    const [session, statuses, messages, permissions] = await Promise.all([
      supplied || this.client.getSession(providerSessionId, directory),
      this.client.status(directory),
      this.client.messages(providerSessionId, directory),
      this.client.permissions(directory),
    ]);
    this.directoryBySession.set(providerSessionId, session.directory);
    const projection = projectOpenCodeSession({ session, status: statuses[providerSessionId], messages, permissions, projectModelSelection: this.options.projectModelSelection });
    const pending = this.pendingSettingsBySession.get(providerSessionId);
    if (pending) {
      const observed = projection.snapshot.modelSelection;
      const observedEffort = projection.snapshot.reasoningEffort;
      if (observed?.modelEntityId === pending.modelSelection.modelEntityId
        && observed.modelName === pending.modelSelection.modelName
        && observedEffort === pending.reasoningEffort) {
        this.pendingSettingsBySession.delete(providerSessionId);
      }
    }
    this.projectionBySession.set(providerSessionId, projection);
    const existing = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    return this.registry.applyAdapterSnapshot({
      ...projection.snapshot,
      lineage: this.lineageBySession.get(providerSessionId) || projection.snapshot.lineage,
      creationSource: existing?.creationSource || creationSource || "ai-session",
      source: "adapter-snapshot",
    });
  }

  private async resolveDirectory(providerSessionId: string) {
    const known = this.directoryBySession.get(providerSessionId) || this.registry.getByProviderSessionId(this.agent, providerSessionId)?.cwd;
    if (known) return known;
    let cursor: string | undefined;
    do {
      const page = await this.client.listGlobalSessions(cursor);
      const found = page.data.find((session) => session.id === providerSessionId);
      if (found) {
        this.directoryBySession.set(providerSessionId, found.directory);
        return found.directory;
      }
      cursor = page.nextCursor;
    } while (cursor);
    throw aiSessionControlError("AI_SESSION_NOT_FOUND", `OpenCode session ${providerSessionId} was not found.`, 404);
  }

  private startEventStream() {
    if (this.closed || this.eventAbort || this.reconnectTimer) return;
    const abort = new AbortController();
    this.eventAbort = abort;
    void this.client.subscribeGlobal((event) => this.onGlobalEvent(event), abort.signal).then(
      () => this.onEventStreamClosed(abort, undefined),
      (error) => this.onEventStreamClosed(abort, error),
    );
  }

  private onEventStreamClosed(abort: AbortController, error: unknown) {
    if (this.eventAbort !== abort) return;
    this.eventAbort = undefined;
    this.options.onEventSourceClose?.();
    if (this.closed || abort.signal.aborted) return;
    this.options.onDiagnostic?.({ code: "OPENCODE_EVENT_STREAM_CLOSED", error: errorText(error), attempt: this.reconnectAttempt + 1 });
    const base = this.options.reconnectBaseMs ?? 250;
    const max = this.options.reconnectMaxMs ?? 10_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startEventStream();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async onGlobalEvent(event: OpenCodeGlobalEvent) {
    this.reconnectAttempt = 0;
    if (event.payload.type === "server.connected" || event.payload.type === "sync") {
      await this.reconcileTracked();
      return;
    }
    const properties = event.payload.properties;
    const sessionID = stringValue(properties.sessionID)
      || stringValue(asRecord(properties.info).id)
      || stringValue(asRecord(properties.part).sessionID);
    if (!sessionID) return;
    if (event.payload.type === "session.deleted") {
      this.discardSession(sessionID);
      return;
    }
    if (event.payload.type === "session.updated" && sessionInfoArchived(properties)) {
      this.discardSession(sessionID);
      return;
    }
    const directory = event.directory || this.directoryBySession.get(sessionID);
    if (!directory) return;
    const roots = (await this.options.workspaceRoots()).map((root) => path.resolve(root));
    if (!withinRoots(directory, roots)) {
      const projected = this.registry.getByProviderSessionId(this.agent, sessionID);
      if (projected) this.registry.discard(projected.id);
      this.forget(sessionID);
      return;
    }
    this.directoryBySession.set(sessionID, directory);
    if (event.payload.type === "message.part.delta") {
      const delta = openCodePartDelta({
        partID: stringValue(properties.partID) || "",
        messageID: stringValue(properties.messageID) || "",
        field: stringValue(properties.field) || "",
        delta: stringValue(properties.delta) || "",
      }, this.projectionBySession.get(sessionID)?.turnByMessageId || new Map());
      const projected = this.registry.getByProviderSessionId(this.agent, sessionID);
      if (delta && projected) this.options.onMessageDelta?.({ sessionId: projected.id, providerSessionId: sessionID, ...delta });
    }
    if (event.payload.type === "message.part.updated") {
      const part = asRecord(properties.part);
      const messageID = stringValue(part.messageID);
      const turnId = messageID ? this.projectionBySession.get(sessionID)?.turnByMessageId.get(messageID) : undefined;
      const projectedSession = this.registry.getByProviderSessionId(this.agent, sessionID);
      if (turnId && projectedSession) {
        const item = projectOpenCodePart(part as never, turnId);
        if (item) this.publishTimelineItem(projectedSession.id, sessionID, item);
      }
    }
    this.scheduleReconcile(sessionID, directory);
  }

  private scheduleReconcile(sessionID: string, directory: string) {
    if (this.reconcileTimers.has(sessionID)) return;
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(sessionID);
      void this.reconcile(sessionID, directory).catch((error) => {
        this.options.onDiagnostic?.({ code: "OPENCODE_RECONCILE_FAILED", providerSessionId: sessionID, error: errorText(error) });
      });
    }, 25);
    timer.unref?.();
    this.reconcileTimers.set(sessionID, timer);
  }

  private publishTimelineItem(sessionId: string, providerSessionId: string, item: AiSessionTimelineItem) {
    for (const listener of this.timelineListeners) listener({ sessionId, providerSessionId, item });
  }

  private async reconcileTracked() {
    await Promise.all([...this.directoryBySession.entries()].map(async ([sessionID, directory]) => {
      try {
        await this.reconcile(sessionID, directory);
      } catch (error) {
        this.options.onDiagnostic?.({ code: "OPENCODE_RECONCILE_FAILED", providerSessionId: sessionID, error: errorText(error) });
      }
    }));
  }

  private forget(providerSessionId: string) {
    this.directoryBySession.delete(providerSessionId);
    this.projectionBySession.delete(providerSessionId);
    this.lineageBySession.delete(providerSessionId);
    this.pendingSettingsBySession.delete(providerSessionId);
    const timer = this.reconcileTimers.get(providerSessionId);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(providerSessionId);
  }

  private discardSession(providerSessionId: string) {
    const projected = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (projected) this.registry.discard(projected.id);
    this.forget(providerSessionId);
  }

  private async reconcileMissingSessions(activeSessionIds: Set<string>, roots: string[]) {
    for (const session of this.registry.all()) {
      if (session.agent !== this.agent || !session.providerSessionId || !session.cwd) continue;
      if (!withinRoots(session.cwd, roots) || activeSessionIds.has(session.providerSessionId)) continue;
      try {
        const providerSession = await this.client.getSession(session.providerSessionId, session.cwd);
        if (providerSession.time.archived || !withinRoots(providerSession.directory, roots)) {
          this.discardSession(session.providerSessionId);
          continue;
        }
        await this.reconcile(providerSession.id, providerSession.directory, providerSession, session.creationSource);
      } catch (error) {
        if (isNotFound(error)) {
          this.discardSession(session.providerSessionId);
          continue;
        }
        this.options.onDiagnostic?.({ code: "OPENCODE_SESSION_CONVERGENCE_FAILED", providerSessionId: session.providerSessionId, error: errorText(error) });
      }
    }
  }
}

const VERIFIED_OPENCODE_VERSIONS = new Set(["1.18.20", "1.18.21"]);

async function promptParts(cwd: string, input: AiSessionSendInput): Promise<OpenCodePromptPart[]> {
  const parts: OpenCodePromptPart[] = [{ type: "text", text: input.message }];
  for (const attachment of input.attachments || []) {
    if (attachment.source.type === "inline") {
      parts.push({ type: "file", mime: attachment.mime, filename: attachment.name, url: `data:${attachment.mime};base64,${attachment.source.data}` });
      continue;
    }
    if (!path.isAbsolute(attachment.source.path)) {
      throw aiSessionControlError("AI_SESSION_ATTACHMENT_PATH_INVALID", "OpenCode runtime-path attachments must be absolute.", 400);
    }
    const relative = path.relative(cwd, attachment.source.path);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw aiSessionControlError("AI_SESSION_ATTACHMENT_PATH_INVALID", "OpenCode runtime-path attachments must remain inside the session workspace.", 400);
    }
    parts.push({ type: "file", mime: attachment.mime, filename: attachment.name, url: pathToFileURL(attachment.source.path).href });
  }
  return parts;
}

function nextUserMessageId(messages: OpenCodeMessage[], throughUserMessageId: string) {
  const ordered = [...messages].sort((left, right) => left.info.time.created - right.info.time.created);
  const index = ordered.findIndex((message) => message.info.id === throughUserMessageId && message.info.role === "user");
  if (index < 0) throw aiSessionControlError("AI_SESSION_FORK_TURN_NOT_FOUND", "OpenCode Fork boundary was not found.", 404);
  return ordered.slice(index + 1).find((message) => message.info.role === "user")?.info.id;
}

function withinRoots(directory: string, roots: string[]) {
  const resolved = path.resolve(directory);
  return roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sessionInfoArchived(properties: Record<string, unknown>) {
  return typeof asRecord(asRecord(properties.info).time).archived === "number";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "statusCode" in error
    && (error as { statusCode?: unknown }).statusCode === 404;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error || "OpenCode stream ended.");
}

export { OpenCodeClient } from "./opencode/client";
export * from "./opencode/wire";
export * from "./opencode/projector";
