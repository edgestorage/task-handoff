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
import { isRetainedAiSessionAttachment, materializeAiSessionAttachments } from "./ai-session-attachments";
import { OpenCodeClient, type OpenCodeConnection, type OpenCodePermissionRule, type OpenCodePromptPart } from "./opencode/client";
import {
  openCodeErrorText,
  openCodePartDelta,
  openCodeRetryActivity,
  projectOpenCodePart,
  projectOpenCodeSession,
  type OpenCodeProjection,
} from "./opencode/projector";
import {
  OpenCodeSessionErrorEventPropertiesSchema,
  OpenCodeSessionStatusEventPropertiesSchema,
  type OpenCodeGlobalEvent,
  type OpenCodeMessage,
  type OpenCodeSession,
} from "./opencode/wire";

export type OpenCodeSessionBridgeOptions = {
  connection: () => OpenCodeConnection | Promise<OpenCodeConnection>;
  workspaceRoots: () => string[] | Promise<string[]>;
  onMessageDelta?: (event: { sessionId: string; providerSessionId: string; turnId: string; itemId: string; delta: string }) => void;
  onTimelineItemDelta?: (event: { sessionId: string; providerSessionId: string; turnId: string; itemId: string; field: "output"; delta: string }) => void;
  onEventSourceClose?: () => void;
  onDiagnostic?: (event: Record<string, unknown>) => void;
  onProviderLifecycleTransition?: (event: {
    session: AiSessionStatus;
    disposition: "closed" | "cleared";
  }) => void | Promise<void>;
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
  private readonly pendingPartDeltas = new Map<string, Map<string, { partID: string; messageID: string; field: string; delta: string }>>();
  private readonly retryWarningsBySession = new Map<string, { turnId: string; message: string }>();
  private readonly timelineListeners = new Set<AiSessionProviderTimelineItemListener>();
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>();
  private eventAbort?: AbortController;
  private reconnectTimer?: NodeJS.Timeout;
  private discoveryRefresh?: Promise<void>;
  private reconnectAttempt = 0;
  private closed = false;
  constructor(private readonly registry: AiSessionRegistry, private readonly options: OpenCodeSessionBridgeOptions) {
    this.client = new OpenCodeClient(options.connection);
  }

  async ensureReady() {
    await this.client.health();
    this.startEventStream();
  }

  async refresh(_context: AiSessionDiscoveryContext) {
    if (this.discoveryRefresh) return this.discoveryRefresh;
    const refresh = this.refreshAllSessions();
    this.discoveryRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.discoveryRefresh === refresh) this.discoveryRefresh = undefined;
    }
  }

  private async refreshAllSessions() {
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
    const created = await this.client.createSession(input.cwd, model, openCodePermissionRules(input.permissionMode));
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
    this.registry.applyRealtimeEvent(session.id, {
      kind: "model-selection",
      modelSelection: selection,
      observedAt: new Date().toISOString(),
    });
    return selection;
  }

  async updateReasoningEffort(session: AiSessionStatus, effort: AiSessionReasoningEffort) {
    if (!session.providerSessionId || !session.cwd) throw aiSessionControlError("AI_SESSION_NOT_FOUND", "OpenCode session identity is missing.", 404);
    if (session.status === "running" || session.status === "waiting") throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_CONFLICT", "Reasoning effort cannot be changed while a turn is active.", 409);
    const selection = this.pendingSettingsBySession.get(session.providerSessionId)?.modelSelection ?? session.modelSelection;
    if (!selection) throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNKNOWN", "The current OpenCode model is unknown.", 409);
    if (!this.modelRef(selection, effort)) throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNSUPPORTED", "OpenCode reasoning variant is unavailable.", 409);
    this.pendingSettingsBySession.set(session.providerSessionId, { modelSelection: selection, reasoningEffort: effort });
    this.registry.applyRealtimeEvent(session.id, {
      kind: "reasoning-effort",
      reasoningEffort: effort,
      observedAt: new Date().toISOString(),
    });
    return effort;
  }

  async renameSession(session: AiSessionStatus, title: string) {
    if (!session.providerSessionId || !session.cwd) {
      throw aiSessionControlError("AI_SESSION_RENAME_UNSUPPORTED", "OpenCode session identity is incomplete.", 409);
    }
    const updated = await this.client.renameSession(session.providerSessionId, session.cwd, title);
    await this.reconcile(updated.id, updated.directory, updated, "ai-session");
    const actual = this.registry.getByProviderSessionId(this.agent, session.providerSessionId)?.title;
    if (actual !== title) {
      throw aiSessionControlError("AI_SESSION_RENAME_NOT_CONFIRMED", "OpenCode did not confirm the requested session title.", 502);
    }
    return { title: actual, authority: "provider" as const };
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
    const messageId = await this.submitMessage(session, input);
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "send-ack",
      activeTurnId: messageId,
      providerTurnId: messageId,
      userPrompt: input.message,
      userMessage: { id: messageId, text: input.message, attachments: input.userMessageAttachments || [] },
      status: "running",
      phase: "thinking",
      source: "realtime",
    }) || session;
    return { session: updated, provider: this.agent, action: "send", turnId: messageId, providerTurnId: messageId };
  }

  async steerMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const messageId = await this.submitMessage(session, input);
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "user-message",
      activeTurnId: session.activeTurnId,
      providerTurnId: session.activeTurnId,
      userPrompt: input.message,
      userMessage: { id: messageId, text: input.message, attachments: input.userMessageAttachments || [] },
      status: "running",
      phase: "thinking",
      source: "realtime",
    }) || session;
    return { session: updated, provider: this.agent, action: "steer", turnId: updated.activeTurnId, providerTurnId: session.activeTurnId };
  }

  private async submitMessage(session: AiSessionStatus, input: AiSessionSendInput) {
    if (!session.providerSessionId || !session.cwd || !input.messageId) {
      throw aiSessionControlError("AI_SESSION_SEND_INVALID", "OpenCode session, cwd, and message identity are required.", 409);
    }
    const parts = await promptParts(session.cwd, input);
    if (input.permissionMode) await this.client.setPermission(session.providerSessionId, session.cwd, openCodePermissionRules(input.permissionMode));
    const pending = this.pendingSettingsBySession.get(session.providerSessionId);
    const selection = pending?.modelSelection || session.modelSelection;
    const model = selection ? this.modelRef(selection, pending?.reasoningEffort || session.reasoningEffort) : undefined;
    // Compatibility for OpenCode v1.18.21: prompt_async persists prompts
    // submitted during an active run and promotes them in its next loop step.
    await this.client.promptAsync(session.providerSessionId, session.cwd, input.messageId, parts, model);
    this.scheduleReconcile(session.providerSessionId, session.cwd);
    return input.messageId;
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
    await this.refreshProjection(session.providerSessionId, session.cwd);
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
    const projection = await this.refreshProjection(providerSessionId, directory, supplied);
    const existing = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    return this.registry.applyAdapterSnapshot({
      ...projection.snapshot,
      lineage: this.lineageBySession.get(providerSessionId) || projection.snapshot.lineage,
      creationSource: existing?.creationSource || creationSource || "ai-session",
      source: "adapter-snapshot",
    });
  }

  private async refreshProjection(providerSessionId: string, directory: string, supplied?: OpenCodeSession) {
    const [session, statuses, messages, permissions] = await Promise.all([
      supplied || this.client.getSession(providerSessionId, directory),
      this.client.status(directory),
      this.client.messages(providerSessionId, directory),
      this.client.permissions(directory),
    ]);
    this.directoryBySession.set(providerSessionId, session.directory);
    const observedProjection = projectOpenCodeSession({ session, status: statuses[providerSessionId], messages, permissions, projectModelSelection: this.options.projectModelSelection });
    const pending = this.pendingSettingsBySession.get(providerSessionId);
    let projection = observedProjection;
    if (pending) {
      const observed = observedProjection.snapshot.modelSelection;
      const observedEffort = observedProjection.snapshot.reasoningEffort;
      if (observed?.modelEntityId === pending.modelSelection.modelEntityId
        && observed.modelName === pending.modelSelection.modelName
        && observedEffort === pending.reasoningEffort) {
        this.pendingSettingsBySession.delete(providerSessionId);
      } else {
        projection = {
          ...observedProjection,
          snapshot: {
            ...observedProjection.snapshot,
            modelSelection: pending.modelSelection,
            ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
          },
        };
      }
    }
    this.projectionBySession.set(providerSessionId, projection);
    return projection;
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
      // The SSE stream has no replay cursor. A session created while this
      // connection was down would not be in directoryBySession, so reconnect
      // must perform discovery rather than only refreshing known sessions.
      await this.refresh({ registry: this.registry, appSessions: [] });
      return;
    }
    const properties = event.payload.properties;
    const info = asRecord(properties.info);
    const part = asRecord(properties.part);
    const sessionID = stringValue(properties.sessionID)
      || stringValue(info.sessionID)
      || stringValue(part.sessionID)
      || (event.payload.type.startsWith("session.") ? stringValue(info.id) : "");
    if (!sessionID) return;
    if (event.payload.type === "session.deleted") {
      await this.discardSession(sessionID, "cleared");
      return;
    }
    if (event.payload.type === "session.updated" && sessionInfoArchived(properties)) {
      await this.discardSession(sessionID, "closed");
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
    const projectedSession = this.registry.getByProviderSessionId(this.agent, sessionID);
    if (event.payload.type === "session.status" && projectedSession) {
      const parsed = OpenCodeSessionStatusEventPropertiesSchema.safeParse(properties);
      const status = parsed.success ? parsed.data.status : undefined;
      if (status?.type === "retry") {
        const turnId = projectedSession.activeTurnId;
        if (turnId) {
          this.retryWarningsBySession.set(sessionID, { turnId, message: status.message });
          this.publishTimelineItem(projectedSession.id, sessionID, openCodeRetryActivity(turnId, status.message));
          this.registry.applyRealtimeEvent(projectedSession.id, {
            kind: "lifecycle",
            activeTurnId: turnId,
            status: "running",
            phase: "thinking",
            source: "realtime",
          });
        }
      } else if (status?.type === "busy" || status?.type === "idle") {
        this.clearRetryWarning(projectedSession.id, sessionID);
      }
    }
    if (event.payload.type === "session.error" && projectedSession) {
      const parsed = OpenCodeSessionErrorEventPropertiesSchema.safeParse(properties);
      const error = parsed.success ? openCodeErrorText(parsed.data.error) : undefined;
      if (error) {
        const turnId = projectedSession.activeTurnId;
        this.clearRetryWarning(projectedSession.id, sessionID);
        this.registry.applyRealtimeEvent(projectedSession.id, turnId ? {
          kind: "turn-completed",
          activeTurnId: turnId,
          providerTurnId: turnId,
          status: "failed",
          error,
          source: "realtime",
        } : {
          kind: "session-error",
          error,
          source: "realtime",
        });
      }
    }
    if (event.payload.type === "message.updated") {
      const messageID = stringValue(info.id);
      const role = stringValue(info.role);
      const projection = this.projectionBySession.get(sessionID);
      if (messageID && projection && role === "user") {
        projection.messageById.set(messageID, { turnId: messageID, role });
      } else if (messageID && projection && role === "assistant") {
        const parentID = stringValue(info.parentID);
        const parent = parentID ? projection.messageById.get(parentID) : undefined;
        if (parent) projection.messageById.set(messageID, { turnId: parent.turnId, role });
      }
    }
    if (event.payload.type === "message.part.delta") {
      const rawDelta = {
        partID: stringValue(properties.partID) || "",
        messageID: stringValue(properties.messageID) || "",
        field: stringValue(properties.field) || "",
        delta: stringValue(properties.delta) || "",
      };
      if (!this.publishPartDelta(sessionID, rawDelta) && rawDelta.partID && rawDelta.messageID && rawDelta.field === "text" && rawDelta.delta) {
        const message = this.projectionBySession.get(sessionID)?.messageById.get(rawDelta.messageID);
        if (message?.role === "assistant") {
          const pending = this.pendingPartDeltas.get(sessionID) || new Map();
          const previous = pending.get(rawDelta.partID);
          if (!previous || previous.messageID === rawDelta.messageID) {
            pending.set(rawDelta.partID, { ...rawDelta, delta: `${previous?.delta || ""}${rawDelta.delta}`.slice(0, 1_000_000) });
            while (pending.size > 500) pending.delete(pending.keys().next().value as string);
            this.pendingPartDeltas.set(sessionID, pending);
          }
        }
      }
    }
    if (event.payload.type === "message.part.updated") {
      const messageID = stringValue(part.messageID);
      const projection = this.projectionBySession.get(sessionID);
      const message = messageID ? projection?.messageById.get(messageID) : undefined;
      if (message?.role === "assistant" && projectedSession) {
        const partID = stringValue(part.id);
        const partType = stringValue(part.type);
        if (partID && partType) projection?.partById.set(partID, { ...message, messageId: messageID, type: partType });
        const item = projectOpenCodePart(part as never, message.turnId);
        if (item) this.publishTimelineItem(projectedSession.id, sessionID, item);
        const pending = partID ? this.pendingPartDeltas.get(sessionID)?.get(partID) : undefined;
        if (pending) {
          this.pendingPartDeltas.get(sessionID)?.delete(partID);
          if (!stringValue(part.text)) this.publishPartDelta(sessionID, pending);
        }
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

  private clearRetryWarning(sessionId: string, providerSessionId: string) {
    const warning = this.retryWarningsBySession.get(providerSessionId);
    if (!warning) return;
    this.retryWarningsBySession.delete(providerSessionId);
    this.publishTimelineItem(sessionId, providerSessionId, openCodeRetryActivity(warning.turnId, warning.message, "completed"));
  }

  private publishPartDelta(providerSessionId: string, event: { partID: string; messageID: string; field: string; delta: string }) {
    const projection = this.projectionBySession.get(providerSessionId);
    const delta = openCodePartDelta(event, projection?.partById || new Map());
    const session = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (!delta || !session) return false;
    if (delta.kind === "message") {
      this.options.onMessageDelta?.({ sessionId: session.id, providerSessionId, turnId: delta.turnId, itemId: delta.itemId, delta: delta.delta });
    } else {
      this.options.onTimelineItemDelta?.({ sessionId: session.id, providerSessionId, turnId: delta.turnId, itemId: delta.itemId, field: delta.field, delta: delta.delta });
    }
    return true;
  }

  private forget(providerSessionId: string) {
    this.directoryBySession.delete(providerSessionId);
    this.projectionBySession.delete(providerSessionId);
    this.lineageBySession.delete(providerSessionId);
    this.pendingSettingsBySession.delete(providerSessionId);
    this.pendingPartDeltas.delete(providerSessionId);
    this.retryWarningsBySession.delete(providerSessionId);
    const timer = this.reconcileTimers.get(providerSessionId);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(providerSessionId);
  }

  private async discardSession(providerSessionId: string, disposition?: "closed" | "cleared") {
    const projected = this.registry.getByProviderSessionId(this.agent, providerSessionId);
    if (projected) this.registry.discard(projected.id);
    this.forget(providerSessionId);
    if (projected && disposition) await this.options.onProviderLifecycleTransition?.({ session: projected, disposition });
  }

  private async reconcileMissingSessions(activeSessionIds: Set<string>, roots: string[]) {
    for (const session of this.registry.all()) {
      if (session.agent !== this.agent || !session.providerSessionId || !session.cwd) continue;
      if (!withinRoots(session.cwd, roots) || activeSessionIds.has(session.providerSessionId)) continue;
      try {
        const providerSession = await this.client.getSession(session.providerSessionId, session.cwd);
        if (providerSession.time.archived || !withinRoots(providerSession.directory, roots)) {
          await this.discardSession(session.providerSessionId, "closed");
          continue;
        }
        await this.reconcile(providerSession.id, providerSession.directory, providerSession, session.creationSource);
      } catch (error) {
        if (isNotFound(error)) {
          await this.discardSession(session.providerSessionId, "cleared");
          continue;
        }
        this.options.onDiagnostic?.({ code: "OPENCODE_SESSION_CONVERGENCE_FAILED", providerSessionId: session.providerSessionId, error: errorText(error) });
      }
    }
  }
}

function openCodePermissionRules(mode?: import("@task-handoff/protocol/ai-sessions").AiSessionPermissionMode): OpenCodePermissionRule[] | undefined {
  if (!mode) return undefined;
  if (mode === "full-access") return [{ permission: "*", pattern: "*", action: "allow" }];
  if (mode === "auto-review") return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
  ];
  return [{ permission: "*", pattern: "*", action: "ask" }];
}

async function promptParts(cwd: string, input: AiSessionSendInput): Promise<OpenCodePromptPart[]> {
  const parts: OpenCodePromptPart[] = [{ type: "text", text: input.message }];
  for (const attachment of input.attachments || []) {
    if (attachment.source.type === "inline") {
      parts.push({ type: "file", mime: attachment.mime, filename: attachment.name, url: `data:${attachment.mime};base64,${attachment.source.data}` });
      continue;
    }
    if (isRetainedAiSessionAttachment(attachment)) {
      const retained = materializeAiSessionAttachments([attachment], cwd)[0];
      parts.push({ type: "file", mime: retained.mime, filename: retained.name, url: pathToFileURL(retained.path).href });
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
