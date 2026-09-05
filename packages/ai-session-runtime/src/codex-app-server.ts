import { AI_SESSION_DEFAULT_REASONING_EFFORT, AiSessionReasoningEffortSchema, AiSessionTimelineSchema, AiSessionTurnTimelineSchema, type AiSessionCommandInput, type AiSessionCommandResult, type AiSessionModelSelection, type AiSessionReasoningEffort, type AiSessionStatus, type AiSessionTimelineItem } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionApprovalDecision, AiSessionControlProvider, AiSessionProviderCreateInput, AiSessionProviderCreateResult, AiSessionProviderForkInput, AiSessionProviderForkResult, AiSessionProviderTimelineItemListener, AiSessionSendInput } from "./ai-session-control";
import { aiSessionControlError } from "./ai-session-control";
import type { AiSessionDiscoveryContext, AiSessionDiscoveryProvider } from "./ai-session-discovery";
import type { AiSessionRegistry } from "./ai-session-registry";
import { CodexAppServerClient, type CodexAppServerClientOptions } from "./codex-app-server/client/client";
import type { CodexAppServerClientLike } from "./codex-app-server/client/contract";
import type { CodexDynamicToolCall, CodexDynamicToolCallResult, CodexDynamicToolSpec, CodexThreadStartOptions } from "./codex-app-server/client/contract";
import { CodexAppServerConnectionManager } from "./codex-app-server/client/connection-manager";
import type { CodexAppServerEvent, CodexThread, CodexThreadStatus } from "./codex-app-server/protocol/types";
import { CodexAppServerApprovalCoordinator } from "./codex-app-server/session/approval-coordinator";
import { CodexAppServerSessionBinding, type CodexAppSession } from "./codex-app-server/session/binding";
import { CodexAppServerSessionControl } from "./codex-app-server/session/control";
import { codexPermissionOverrides } from "./codex-app-server/session/control";
import { CodexAppServerSessionDiscovery } from "./codex-app-server/session/discovery";
import { CodexAppServerSessionProjector } from "./codex-app-server/session/projector";
import { CodexTimelineStore } from "./codex-app-server/session/timeline-store";
import { CodexAppServerMentions } from "./codex-app-server/mentions";
import { codexItemTimeline, codexThreadTimeline, mergeCodexTimelineItems } from "./codex-app-server/protocol/timeline";

export { CodexAppServerClient } from "./codex-app-server/client/client";
type CodexAppServerBridgeOptions = {
  allowSpawn?: boolean;
  createClient?: (options: CodexAppServerClientOptions) => CodexAppServerClientLike;
  ensureAppSessions?: () => Promise<CodexAppSession[]>;
  onEventSourceClose?: () => void;
  onMessageDelta?: (event: {
    sessionId: string;
    providerSessionId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }) => void;
  onTimelineItem?: (event: { sessionId: string; providerSessionId: string; item: AiSessionTimelineItem }) => void;
  timelineStorePath?: string;
  threadStartDefaults?: Pick<CodexThreadStartOptions, "model" | "modelProvider">;
  resolveModelSelection?: (selection: AiSessionModelSelection) => Pick<CodexThreadStartOptions, "model" | "modelProvider">;
  projectModelSelection?: (modelProvider: string, model: string) => AiSessionModelSelection | undefined;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  dynamicTools?: CodexDynamicToolSpec[];
  onDynamicToolCall?: (call: CodexDynamicToolCall) => Promise<CodexDynamicToolCallResult>;
};

export type { CodexAppServerClientLike } from "./codex-app-server/client/contract";

export class CodexAppServerSessionBridge implements AiSessionControlProvider, AiSessionDiscoveryProvider {
  readonly id = "codex-app-server";
  readonly agent = "codex";
  private readonly binding = new CodexAppServerSessionBinding();
  private readonly connection: CodexAppServerConnectionManager;
  private readonly approvalCoordinator: CodexAppServerApprovalCoordinator;
  private readonly control: CodexAppServerSessionControl;
  private readonly discovery: CodexAppServerSessionDiscovery;
  private readonly projector: CodexAppServerSessionProjector;
  private readonly mentions: CodexAppServerMentions;
  private readonly timelineStore?: CodexTimelineStore;
  private readonly injectedClient?: CodexAppServerClientLike;
  private readonly options: CodexAppServerBridgeOptions;
  private readonly timelineItemListeners = new Set<AiSessionProviderTimelineItemListener>();
  private readonly timelineSourceByThread = new Map<string, "adapter-store" | "codex-native">();
  private directCreateRequests = 0;
  private readonly pendingThreadSettings = new Set<string>();

  constructor(
    private readonly registry: AiSessionRegistry,
    clientOrOptions: CodexAppServerClientLike | CodexAppServerBridgeOptions = {},
    injectedOptions: CodexAppServerBridgeOptions = {},
  ) {
    if ("start" in clientOrOptions && "listLoadedThreadIds" in clientOrOptions) {
      this.injectedClient = clientOrOptions;
      this.options = { allowSpawn: true, ...injectedOptions };
    } else {
      this.options = clientOrOptions;
    }
    this.timelineStore = this.options.timelineStorePath
      ? new CodexTimelineStore(this.options.timelineStorePath)
      : undefined;
    this.connection = new CodexAppServerConnectionManager({
      injectedClient: this.injectedClient,
      createClient: (options) => this.createClient(options),
      threadResumeOptions: (threadId) => {
        const session = this.registry.getByProviderSessionId("codex", threadId);
        const selection = session?.modelSelection;
        return {
          ...(selection ? this.options.resolveModelSelection?.(selection) : {}),
          ...(session?.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
        };
      },
      onEvent: (event) => this.applyProviderEvent(event),
      onInvalidate: () => {
        this.timelineSourceByThread.clear();
        this.options.onEventSourceClose?.();
        this.approvalCoordinator?.resetConnection();
        this.projector?.resetConnection();
        this.mentions?.resetConnection();
      },
    });
    this.approvalCoordinator = new CodexAppServerApprovalCoordinator({
      registry,
      currentClient: () => this.connection.client,
      readyClient: () => this.requireReadyClient(),
      readyThreadClient: (threadId) => this.requireReadyThreadClient(threadId),
      findSession: (threadId) => this.registry.getByProviderSessionId("codex", threadId),
      applyThreadSnapshot: (thread) => this.upsertThread(thread, { bindAppSession: true }),
    });
    this.projector = new CodexAppServerSessionProjector({
      registry,
      findSession: (threadId) => this.registry.getByProviderSessionId("codex", threadId),
      clearApprovalSession: (sessionId) => this.approvalCoordinator.clearSession(sessionId),
      attachApprovalLifecycle: (sessionId, lifecycle) => this.approvalCoordinator.attachLifecycle(sessionId, lifecycle),
      latestApprovalSummary: (sessionId) => this.approvalCoordinator.latestForSession(sessionId)?.summary,
      threadForkSupported: () => this.connection.client?.threadForkCapabilities?.().fullHistory === true,
      projectModelSelection: this.options.projectModelSelection,
      onMessageDelta: (event) => this.options.onMessageDelta?.(event),
      onTimelineItem: (event) => {
        if (this.timelineHistorySource(event.providerSessionId) === "adapter-store") {
          this.timelineStore?.upsert(event.providerSessionId, event.item);
        }
        this.options.onTimelineItem?.(event);
        for (const listener of this.timelineItemListeners) listener(event);
      },
    });
    this.mentions = new CodexAppServerMentions({
      readyClient: () => this.requireReadyClient(),
      readyThreadClient: (threadId) => this.requireReadyThreadClient(threadId),
      connectionEpoch: () => this.connection.epoch,
    });
    this.control = new CodexAppServerSessionControl({
      registry,
      readyThreadClient: (threadId) => this.requireReadyThreadClient(threadId),
      validateReferences: (session, references) => this.mentions.validateReferences(session, references),
    });
    this.discovery = new CodexAppServerSessionDiscovery({
      applyThreadSnapshot: (thread) => this.upsertThread(thread, { bindAppSession: true }),
      recoverableThreadIds: () => this.registry.list()
        .filter((session) => (
          session.agent === "codex"
          && Boolean(session.providerSessionId)
          && session.actions?.send !== false
          && session.actions?.close !== false
        ))
        .map((session) => session.providerSessionId as string),
      reconcileLoadedThreadIds: (client, loadedThreadIds) => {
        const connection = this.connection.connectionFor(client);
        if (connection) this.connection.reconcileLoadedThreadIds(connection, loadedThreadIds);
      },
      ensureThreadSubscribed: (client, threadId) => {
        const connection = this.connection.connectionFor(client);
        return connection
          ? this.connection.ensureThreadSubscribed(connection, threadId)
          : Promise.resolve(undefined);
      },
    });
  }

  subscribeTimelineItems(listener: AiSessionProviderTimelineItemListener) {
    this.timelineItemListeners.add(listener);
    return () => this.timelineItemListeners.delete(listener);
  }

  timelineCapabilities() {
    const client = this.connection.client;
    const reads = Boolean(client?.listThreadItems || (this.timelineStore && client?.readThread));
    return { sessionRead: reads, turnRead: reads, liveItems: true };
  }

  retainTimelineHistory(providerSessionIds: Iterable<string>) {
    return this.timelineStore?.retain(providerSessionIds) || 0;
  }

  private timelineHistorySource(providerSessionId: string): "adapter-store" | "codex-native" {
    return this.timelineSourceByThread.get(providerSessionId) || "adapter-store";
  }

  async sync(appSessions: CodexAppSession[] = []) {
    const previousSocketPath = this.binding.socketPath;
    const previousCommand = this.binding.command;
    const socketPath = this.binding.update(appSessions);
    const command = this.binding.command;
    if (!this.injectedClient && !socketPath && !this.options.allowSpawn) {
      this.stop();
      return;
    }
    if (!this.injectedClient && (
      !this.connection.client
      || previousSocketPath !== socketPath
      || previousCommand !== command
    )) {
      this.connection.configure(socketPath, command);
    } else if (this.injectedClient && !this.connection.client) {
      this.connection.configure();
    }
    if (!this.connection.client) {
      return;
    }
    let ready;
    try {
      ready = await this.connection.ready({ respectRetry: true });
    } catch {
      return;
    }
    if (!ready || !this.connection.isCurrent(ready)) return;
    try {
      await this.discovery.sync(ready.client, () => this.connection.isCurrent(ready));
    } catch {
      this.connection.markUnhealthy(ready);
    }
  }

  async refresh(context: AiSessionDiscoveryContext) {
    await this.sync(context.appSessions);
  }

  stop() {
    this.connection.stop();
    this.binding.clear();
  }

  supportsThreadSettingsUpdate() {
    return this.connection.current()?.client.supportsThreadSettingsUpdate?.() === true;
  }

  async sendMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.control.sendMessage(session, input);
  }

  async createSession(input: AiSessionProviderCreateInput): Promise<AiSessionProviderCreateResult> {
    const client = await this.requireReadyClient();
    if (!client.startThread) {
      throw aiSessionControlError("AI_SESSION_CREATE_UNSUPPORTED", "Codex app-server does not support thread creation.", 400);
    }
    this.directCreateRequests += 1;
    try {
      const requestedModel = input.modelSelection
        ? this.options.resolveModelSelection?.(input.modelSelection)
        : undefined;
      if (input.modelSelection && !requestedModel) {
        throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_INVALID", "Codex model selection is unavailable.", 409);
      }
      const requestedReasoningEffort = input.reasoningEffort ?? AI_SESSION_DEFAULT_REASONING_EFFORT;
      const thread = await client.startThread({
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        ...this.options.threadStartDefaults,
        ...requestedModel,
        ...(client.supportsPaginatedTimeline?.() ? { historyMode: "paginated" as const } : {}),
        permissions: codexPermissionOverrides(input.permissionMode),
        reasoningEffort: requestedReasoningEffort,
        ...(this.options.dynamicTools?.length ? { dynamicTools: this.options.dynamicTools } : {}),
      });
      const providerSessionId = typeof thread.id === "string" ? thread.id.trim() : "";
      const cwd = typeof thread.cwd === "string" ? thread.cwd.trim() : "";
      if (!providerSessionId || !cwd) {
        throw aiSessionControlError("AI_SESSION_CREATE_INVALID_RESPONSE", "Codex app-server returned an invalid thread identity.", 502);
      }
      // thread/start creates the thread and subscribes this connection to it. Record that
      // authoritative fact before the first turn so the restart-recovery path does not mistake
      // a newly created thread for an unloaded persisted thread and call thread/resume.
      this.connection.registerStartedThread(client, providerSessionId);
      this.recordTimelineHistorySource(thread);
      this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session" });
      return {
        providerSessionId,
        cwd,
        creationSource: "ai-session",
        ...(() => {
          const modelSelection = this.actualModelSelection(thread, input.modelSelection);
          const reasoningEffort = this.actualReasoningEffort(thread, requestedReasoningEffort);
          return {
            ...(modelSelection ? { modelSelection } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          };
        })(),
      };
    } finally {
      this.directCreateRequests -= 1;
    }
  }

  async updateModelSelection(session: AiSessionStatus, selection: AiSessionModelSelection) {
    const threadId = session.providerSessionId;
    if (!threadId || !session.modelSelection) {
      throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_UNKNOWN", "The current Codex provider is unknown.", 409);
    }
    if (selection.modelEntityId !== session.modelSelection.modelEntityId) {
      throw aiSessionControlError("AI_SESSION_PROVIDER_SWITCH_REQUIRES_NEW_SESSION", "Codex provider changes require a new session.", 409);
    }
    if (this.pendingThreadSettings.has(session.id)) {
      throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_CONFLICT", "A model change is already pending.", 409);
    }
    this.pendingThreadSettings.add(session.id);
    try {
      const client = await this.requireReadyThreadClient(threadId);
      if (!client.updateThreadSettings || client.supportsThreadSettingsUpdate?.() !== true) {
        throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_UNSUPPORTED", "This Codex version does not support model switching.", 409);
      }
      const updated = await client.updateThreadSettings(threadId, { model: selection.modelName });
      if (!updated.model) {
        throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE", "Codex reported no model after updating thread settings.", 502);
      }
      const expectedProvider = this.options.resolveModelSelection?.(selection)?.modelProvider;
      if (updated.modelProvider && expectedProvider && updated.modelProvider !== expectedProvider) {
        throw aiSessionControlError("AI_SESSION_PROVIDER_SWITCH_REQUIRES_NEW_SESSION", "Codex changed to an unexpected provider.", 409);
      }
      const actualSelection = updated.modelProvider
        ? this.options.projectModelSelection
          ? this.options.projectModelSelection(updated.modelProvider, updated.model)
          : expectedProvider === updated.modelProvider ? { ...selection, modelName: updated.model } : undefined
        : { ...selection, modelName: updated.model };
      if (!actualSelection) {
        throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE", "Codex reported an unknown model provider.", 502);
      }
      this.registry.applyRealtimeEvent(session.id, {
        kind: "model-selection",
        modelSelection: actualSelection,
        observedAt: new Date().toISOString(),
      });
      return actualSelection;
    } finally {
      this.pendingThreadSettings.delete(session.id);
    }
  }

  async updateReasoningEffort(session: AiSessionStatus, effort: AiSessionReasoningEffort) {
    const threadId = session.providerSessionId;
    if (!threadId) {
      throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNKNOWN", "The Codex thread identity is unknown.", 409);
    }
    if (this.pendingThreadSettings.has(session.id)) {
      throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_CONFLICT", "A thread setting change is already pending.", 409);
    }
    this.pendingThreadSettings.add(session.id);
    try {
      const client = await this.requireReadyThreadClient(threadId);
      if (!client.updateThreadSettings || client.supportsThreadSettingsUpdate?.() !== true) {
        throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_UNSUPPORTED", "This Codex version does not support reasoning effort changes.", 409);
      }
      const updated = await client.updateThreadSettings(threadId, { effort });
      const actual = AiSessionReasoningEffortSchema.safeParse(updated.effort);
      if (!actual.success) {
        throw aiSessionControlError("AI_SESSION_REASONING_EFFORT_INVALID_RESPONSE", "Codex reported an invalid reasoning effort.", 502);
      }
      this.registry.applyRealtimeEvent(session.id, {
        kind: "reasoning-effort",
        reasoningEffort: actual.data,
        observedAt: new Date().toISOString(),
      });
      return actual.data;
    } finally {
      this.pendingThreadSettings.delete(session.id);
    }
  }

  async forkSession(input: AiSessionProviderForkInput): Promise<AiSessionProviderForkResult> {
    const sourceProviderSessionId = input.source.providerSessionId;
    if (!sourceProviderSessionId) {
      throw aiSessionControlError("AI_SESSION_FORK_SOURCE_INVALID", "Fork source has no provider identity.", 409);
    }
    const client = await this.requireReadyThreadClient(sourceProviderSessionId);
    const capability = client.threadForkCapabilities?.();
    if (!client.forkThread || capability?.fullHistory !== true || (input.providerThroughTurnId && capability.throughTurn !== true)) {
      throw aiSessionControlError("AI_SESSION_FORK_UNSUPPORTED", "Codex app-server does not support the requested Fork operation.", 409);
    }
    try {
      const requestedModel = input.source.modelSelection
        ? this.options.resolveModelSelection?.(input.source.modelSelection)
        : undefined;
      if (input.source.modelSelection && !requestedModel) {
        throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_UNAVAILABLE", "The source Codex provider is no longer available.", 409);
      }
      const requestedReasoningEffort = input.source.reasoningEffort ?? AI_SESSION_DEFAULT_REASONING_EFFORT;
      const thread = await client.forkThread({
        threadId: sourceProviderSessionId,
        ...(input.providerThroughTurnId ? { lastTurnId: input.providerThroughTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...requestedModel,
        reasoningEffort: requestedReasoningEffort,
      });
      const providerSessionId = typeof thread.id === "string" ? thread.id.trim() : "";
      const cwd = typeof thread.cwd === "string" ? thread.cwd.trim() : "";
      if (!providerSessionId || providerSessionId === sourceProviderSessionId || !cwd) {
        throw aiSessionControlError("AI_SESSION_FORK_INVALID_RESPONSE", "Codex app-server returned an invalid Fork thread.", 502);
      }
      const lineage = {
        kind: "fork" as const,
        parentProviderSessionId: sourceProviderSessionId,
        ...(input.throughTurnId ? { throughTurnId: input.throughTurnId } : {}),
      };
      this.connection.registerStartedThread(client, providerSessionId);
      this.recordTimelineHistorySource(thread);
      this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session", lineage });
      return {
        providerSessionId,
        cwd,
        creationSource: "ai-session",
        lineage,
        modelSelection: this.actualModelSelection(thread, input.source.modelSelection),
        reasoningEffort: this.actualReasoningEffort(thread, requestedReasoningEffort),
      };
    } catch (error) {
      if (error && typeof error === "object" && "rpcCode" in error && error.rpcCode === -32601) {
        this.registry.patch(input.source.id, {
          actions: { ...input.source.actions, fork: false },
        });
        throw aiSessionControlError("AI_SESSION_FORK_UNSUPPORTED", "Codex app-server does not support Fork.", 409);
      }
      throw error;
    }
  }

  async readSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (!client.readThread) throw aiSessionControlError("AI_SESSION_READ_UNSUPPORTED", "Codex app-server does not support thread reads.", 400);
    const thread = await client.readThread(providerSessionId, { includeTurns: true });
    if (!thread) throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "Codex thread was not found.", 404);
    this.recordTimelineHistorySource(thread);
    this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session" });
  }

  async timeline(session: AiSessionStatus) {
    return this.readTimeline(session);
  }

  async turnTimeline(session: AiSessionStatus, turnId: string) {
    const turn = session.turns?.find((candidate) => candidate.id === turnId || candidate.providerTurnId === turnId);
    if (!turn) {
      throw aiSessionControlError("AI_SESSION_TURN_NOT_FOUND", "AI session turn was not found.", 404);
    }
    const providerTurnId = turn.providerTurnId || turn.id;
    const timeline = await this.readTimeline(session, providerTurnId, turn.id);
    return AiSessionTurnTimelineSchema.parse({
      sessionId: session.id,
      turnId: turn.id,
      items: timeline.items,
      generatedAt: timeline.generatedAt,
    });
  }

  private async readTimeline(session: AiSessionStatus, providerTurnId?: string, publicTurnId?: string) {
    if (session.agent !== "codex" || !session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_TIMELINE_UNSUPPORTED", "Only Codex app-server sessions support Timeline reads.", 400);
    }
    const client = await this.requireReadyThreadClient(session.providerSessionId);
    const matchesTurn = (turnId: string) => !providerTurnId || turnId === providerTurnId || turnId === publicTurnId;
    const realtimeItems = this.projector.realtimeTimelineItems(session.providerSessionId)
      .filter((entry) => matchesTurn(entry.turnId));
    const source = this.timelineHistorySource(session.providerSessionId);
    if (source === "adapter-store") {
      if (!client.readThread || !this.timelineStore) {
        throw aiSessionControlError("AI_SESSION_TIMELINE_UNSUPPORTED", "Codex adapter Timeline history is unavailable.", 409);
      }
      const durableItems = this.timelineStore.items(session.providerSessionId)
        .filter((item) => matchesTurn(item.turnId));
      const thread = await client.readThread(session.providerSessionId, { includeTurns: true });
      if (!thread) throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "Codex thread was not found.", 404);
      const timeline = codexThreadTimeline(
        session.id,
        session.providerSessionId,
        thread,
        new Date().toISOString(),
        realtimeItems,
      );
      return AiSessionTimelineSchema.parse({
        ...timeline,
        items: mergeCodexTimelineItems(
          timeline.items.filter((item) => matchesTurn(item.turnId)),
          durableItems,
        ),
      });
    }
    const persistedItems = await client.listThreadItems?.(session.providerSessionId, providerTurnId);
    if (!persistedItems) {
      throw aiSessionControlError("AI_SESSION_TIMELINE_UNSUPPORTED", "Codex native Timeline history became unavailable.", 409);
    }
    return AiSessionTimelineSchema.parse(codexItemTimeline(
      session.id,
      session.providerSessionId,
      persistedItems,
      new Date().toISOString(),
      realtimeItems,
    ));
  }

  async resumeSession(providerSessionId: string, modelSelection?: AiSessionModelSelection, reasoningEffort?: AiSessionReasoningEffort) {
    const client = await this.requireReadyClient();
    if (client.unarchiveThread) await client.unarchiveThread(providerSessionId);
    const requestedModel = modelSelection ? this.options.resolveModelSelection?.(modelSelection) : undefined;
    if (modelSelection && !requestedModel) {
      throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_UNAVAILABLE", "The Codex provider for this session is no longer available.", 409);
    }
    const thread = client.resumeThread
      ? await client.resumeThread(providerSessionId, { ...requestedModel, reasoningEffort: reasoningEffort ?? AI_SESSION_DEFAULT_REASONING_EFFORT })
      : client.readThread ? await client.readThread(providerSessionId, { includeTurns: true }) : undefined;
    if (!thread) throw aiSessionControlError("AI_SESSION_RESUME_UNSUPPORTED", "Codex app-server could not resume the thread.", 409);
    this.recordTimelineHistorySource(thread);
    this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session" });
  }

  async archiveSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (!client.archiveThread) throw aiSessionControlError("AI_SESSION_CLOSE_UNSUPPORTED", "Codex app-server does not support thread archive.", 400);
    await client.archiveThread(providerSessionId);
  }

  private actualModelSelection(thread: CodexThread, requested?: AiSessionModelSelection) {
    if (typeof thread.model !== "string" || typeof thread.modelProvider !== "string") return requested;
    if (!this.options.projectModelSelection) return requested;
    const actual = this.options.projectModelSelection?.(thread.modelProvider, thread.model);
    if (!actual) {
      // An unmanaged Codex default has no public model entity to project. This is
      // valid when the caller did not request a managed selection; keep the
      // session model unknown instead of inventing a cross-boundary identity.
      if (!requested) return undefined;
      throw aiSessionControlError("AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE", "Codex reported an unknown model provider.", 502);
    }
    if (requested && (requested.modelEntityId !== actual.modelEntityId || requested.modelName !== actual.modelName)) {
      this.options.onDiagnostic?.({
        code: "AI_SESSION_MODEL_SELECTION_RECONCILED",
        requested,
        actual,
      });
    }
    return actual;
  }

  private actualReasoningEffort(thread: CodexThread, requested?: AiSessionReasoningEffort) {
    const actual = AiSessionReasoningEffortSchema.safeParse(thread.reasoningEffort);
    if (!actual.success) return requested;
    if (requested && requested !== actual.data) {
      this.options.onDiagnostic?.({
        code: "AI_SESSION_REASONING_EFFORT_RECONCILED",
        requested,
        actual: actual.data,
      });
    }
    return actual.data;
  }

  async activeSessionExists(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (client.activeThreadExists) return client.activeThreadExists(providerSessionId);
    if (client.listThreads) {
      return (await client.listThreads()).some((thread) => thread.id === providerSessionId);
    }
    throw aiSessionControlError("AI_SESSION_READ_UNSUPPORTED", "Codex app-server cannot verify active threads.", 400);
  }

  async deleteSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (!client.deleteThread) throw aiSessionControlError("AI_SESSION_DELETE_UNSUPPORTED", "Codex app-server does not support thread deletion.", 400);
    await client.deleteThread(providerSessionId);
  }

  async unsubscribeSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    await client.unsubscribeThread?.(providerSessionId);
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.control.startMessage(session, input);
  }

  async steerMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.control.steerMessage(session, input);
  }

  async interrupt(session: AiSessionStatus): Promise<AiSessionActionResult> {
    return this.control.interrupt(session);
  }

  async resolveApproval(session: AiSessionStatus, decision: AiSessionApprovalDecision): Promise<AiSessionActionResult> {
    return this.approvalCoordinator.resolve(session, decision);
  }

  mentionCatalog(session: AiSessionStatus) {
    return this.mentions.catalog(session);
  }

  searchMentionFiles(session: AiSessionStatus, query: string) {
    return this.mentions.searchFiles(session, query);
  }

  async executeCommand(session: AiSessionStatus, input: AiSessionCommandInput): Promise<AiSessionCommandResult> {
    if (session.agent !== "codex" || !session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Only Codex app-server sessions support commands.", 400);
    }
    if ((input.command === "review" || input.command === "compact") && (session.status === "running" || session.status === "waiting")) {
      throw aiSessionControlError("AI_SESSION_BUSY", `${input.command} is unavailable while the session is busy.`, 409);
    }
    const threadId = session.providerSessionId;
    const client = await this.requireReadyThreadClient(threadId);
    if (input.command === "review") {
      if (!client.startReview) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support review.", 409);
      const result = await client.startReview(threadId);
      return { command: input.command, turnId: result.turnId };
    }
    if (input.command === "compact") {
      if (!client.compactThread) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support compaction.", 409);
      await client.compactThread(threadId);
      return { command: input.command };
    }
    if (input.command === "rename") {
      if (!client.setThreadName) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support renaming threads.", 409);
      await client.setThreadName(threadId, input.argument || "");
      return { command: input.command, value: input.argument };
    }
    if (input.argument) {
      if (!client.setThreadGoal) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support goals.", 409);
      await client.setThreadGoal(threadId, input.argument);
      return { command: input.command, value: input.argument };
    }
    if (!client.getThreadGoal) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support goals.", 409);
    const result = await client.getThreadGoal(threadId);
    const goal = result.goal && typeof result.goal === "object" ? result.goal as Record<string, unknown> : undefined;
    return { command: input.command, value: typeof goal?.objective === "string" ? goal.objective : "No active goal." };
  }

  private createClient(options: CodexAppServerClientOptions) {
    const configured = { ...options, onDynamicToolCall: this.options.onDynamicToolCall };
    return this.options.createClient ? this.options.createClient(configured) : new CodexAppServerClient(configured);
  }

  private applyProviderEvent(event: CodexAppServerEvent) {
    if (event.type === "thread") {
      this.upsertThread(event.thread, {
        bindAppSession: true,
        creationSource: this.directCreateRequests > 0 ? "ai-session" : undefined,
      });
      return;
    }
    if (event.type === "approval-request") {
      this.approvalCoordinator.register(event.request);
      return;
    }
    if (event.type === "thread-name") {
      const session = this.registry.getByProviderSessionId("codex", event.threadId);
      if (session) {
        this.registry.applyAdapterSnapshot({
          source: "adapter-snapshot",
          agent: "codex",
          appId: session.appId,
          appSessionId: session.appSessionId,
          providerSessionId: event.threadId,
          title: event.name,
        });
      }
      return;
    }
    this.projector.apply(event);
  }

  private upsertThread(thread: CodexThread, options: { bindAppSession: boolean; creationSource?: AiSessionStatus["creationSource"] }) {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id || thread.ephemeral === true) {
      return;
    }
    this.recordTimelineHistorySource(thread);
    const appSessionId = options.bindAppSession ? this.binding.appSessionIdForThread(id) : undefined;
    this.projector.applyThreadSnapshot(thread, { appSessionId, creationSource: options.creationSource });
  }

  private recordTimelineHistorySource(thread: CodexThread) {
    if (typeof thread.id !== "string") return;
    const source = thread.historyMode === "paginated" ? "codex-native" : "adapter-store";
    this.timelineSourceByThread.set(thread.id, source);
  }

  private async requireReadyClient() {
    try {
      const ready = await this.readyConnection();
      if (ready) return ready.client;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw aiSessionControlError("AI_SESSION_CONTROL_NOT_CONNECTED", error instanceof Error ? error.message : "Codex app-server is not connected.", 503);
    }
    throw aiSessionControlError("AI_SESSION_CONTROL_NOT_CONNECTED", "Codex app-server is not connected.", 503);
  }

  private async requireReadyThreadClient(threadId: string) {
    try {
      const ready = await this.readyConnection();
      if (!ready) {
        throw new Error("Codex app-server is not connected.");
      }
      return await this.connection.ensureThreadReady(ready, threadId);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw aiSessionControlError(
        "AI_SESSION_THREAD_RESUME_FAILED",
        error instanceof Error ? error.message : "Codex thread could not be resumed.",
        409,
      );
    }
  }

  /** Re-establishes the runtime-owned provider before a user control action. */
  private async readyConnection() {
    let firstError: unknown;
    if (this.connection.client) {
      try {
        return await this.connection.ready();
      } catch (error) {
        firstError = error;
      }
    }
    if (!this.options.ensureAppSessions) {
      if (firstError) throw firstError;
      throw new Error("Codex app-server is not connected.");
    }
    const appSessions = await this.options.ensureAppSessions();
    await this.sync(appSessions);
    return this.connection.ready();
  }

}
